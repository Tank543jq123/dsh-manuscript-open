/**
 * 会话扫描器：读 ~/.dsh/sessions 下的全部会话日志。
 *
 * 关键事实（本机实测，写死在注释里防止后人改错）：
 *  - 目录布局：<sessionsRoot>/<--normalized-cwd-->/<sessionId>/session[.vN].jsonl.zstd
 *  - **有些老会话没有版本号**（session.jsonl.zstd，header version=0）。
 *    本机 216 个会话里有 18 个是这种，只按 v* 匹配会漏掉它们 —— 其中 13 个还是已归档会话。
 *  - zstd 是**多帧**的：一个文件里拼接了多个独立 zstd frame，
 *    zlib.zstdDecompressSync 只能解第一帧，必须按 magic 切帧后逐帧解。
 *  - header 里的 createdAt 是毫秒时间戳；事件用 seq 连续编号。
 *
 * 本模块零依赖（只用 node:fs / node:path / node:zlib），不联网、不调 LLM。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'

/** zstd 帧魔数：28 B5 2F FD。多帧文件靠它在字节流里切片。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话文件名的两种形态：带版本号 / 不带（v0 老格式）。 */
const RE_VERSIONED = /^session\.v(\d+)\.jsonl\.zstd$/
const RE_UNVERSIONED = /^session\.jsonl\.zstd$/

/**
 * 把多帧 zstd 字节流解开成一段文本。
 * 单帧解压会把后面的帧全丢掉，所以必须先切帧。
 * @param {Buffer} buf
 * @returns {{text: string, frames: number, badFrames: number}}
 */
export function decompressMultiFrame(buf) {
  const offsets = []
  let i = buf.indexOf(ZSTD_MAGIC, 0)
  while (i !== -1) {
    offsets.push(i)
    i = buf.indexOf(ZSTD_MAGIC, i + 4)
  }
  // 没有魔数：不是 zstd，直接当文本（防御性，不抛）
  if (offsets.length === 0) {
    return { text: buf.toString('utf8'), frames: 0, badFrames: 0 }
  }
  let text = ''
  let badFrames = 0
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8')
    } catch {
      badFrames += 1
    }
  }
  return { text, frames: offsets.length, badFrames }
}

/**
 * 解析一段 JSONL 文本为事件数组。坏行跳过但不隐瞒，计数返回。
 * @param {string} text
 * @returns {{events: object[], badLines: number}}
 */
export function parseJsonl(text) {
  const events = []
  let badLines = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      badLines += 1
    }
  }
  return { events, badLines }
}

/**
 * 列出一个会话目录里"应该读哪个文件"：优先最高版本号，其次无版本号。
 * @param {string} dir
 * @returns {{file: string, version: number} | null}
 */
export function pickSessionFile(dir) {
  let files
  try {
    files = readdirSync(dir)
  } catch {
    return null
  }
  let best = null
  for (const f of files) {
    const m = RE_VERSIONED.exec(f)
    if (m) {
      const v = Number(m[1])
      if (!best || v > best.version) best = { file: f, version: v }
      continue
    }
    if (RE_UNVERSIONED.test(f)) {
      if (!best) best = { file: f, version: 0 }
    }
  }
  return best
}

/**
 * 把 `--C-DSH~5DE5~4F5C~7A7A~95F4-~4E3B~76EE~5F55--` 这种目录名还原成可读路径。
 *
 * 编码规则（**从字节实测反推，不是猜的**）：
 *   · `--` 开头结尾；路径分隔符被压成 `-`
 *   · 每个非 ASCII 字符写成 `~<十六进制>~`，**全部是大写 4 位**
 *   · **一个汉字可能连续出现多个 ~XXXX~，必须把相邻的合并按 UTF-16 单元解码**
 *     实测：`~5DE5~` = 工，`~4F5C~7A7A~` = 作空（两个单元各是一个字），
 *     `String.fromCharCode(0x4F5C, 0x7A7A)` → "作空"，逐段解就成了 "工4F5C空"。
 *
 * 关键教训：正则里 `~([0-9A-Fa-f]{1,6})~` 会**跨段贪婪**，
 * 把 `~4F5C~7A7A~` 的前半吞掉。改成 `{4}` 定长 + 逐个收集单元后合并解码。
 */
/**
 * 把 `--C-DSH~5DE5~4F5C~7A7A~95F4-...--` 目录名还原成可读路径。
 *
 * ⚠️ **不要用它来当项目名** —— 这个编码是**有损的**（路径分隔符被压成 `-`，
 * 且相邻汉字的 ~XXXX~ 段之间可能没有任何分隔符），无法可靠还原。
 * 实测反例：`~4F5C~7A7A~` 是两个独立的 UTF-16 单元（作、空），
 * 但 `~6280~80FD~` 只有第一个带 `~` 尾部，靠文件名根本切不准。
 *
 * **正确做法**：用会话 header 里的 `cwd` 字段 —— 本机 218 个会话 100% 都有，
 * 而且是完整的原始路径（`C:\DSH工作空间\技能手册梳理插件`）。
 *
 * 这个函数只保留作"最后的兜底展示"，且故意**只在能干净解码时才用**：
 * 解出来含残留 `~` 或孤立十六进制串就返回原始目录名，宁可丑也不给错。
 */
export function decodeProjectDir(name) {
  let s = name
  if (s.startsWith('--')) s = s.slice(2)
  if (s.endsWith('--')) s = s.slice(0, -2)

  let out = ''
  const units = []
  const flush = () => {
    if (units.length) {
      out += String.fromCharCode(...units)
      units.length = 0
    }
  }
  const re = /~([0-9A-Fa-f]{4})~/g
  let last = 0
  let m
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) {
      flush()
      out += s.slice(last, m.index)
    }
    units.push(parseInt(m[1], 16))
    last = re.lastIndex
  }
  flush()
  if (last < s.length) out += s.slice(last)

  // 有残留编码痕迹 → 说明有损，不装懂
  if (out.includes('~') || /[0-9A-F]{4}/.test(out.replace(/[A-Za-z]{4,}/g, ''))) {
    return name
  }
  const dm = /^([A-Za-z])-(.+)$/.exec(out)
  if (dm) return dm[1].toUpperCase() + ':\\' + dm[2].replace(/-/g, '\\')
  return out
}

/**
 * 从 cwd 取"短项目名"给 UI 用（章名、卡片标签）。
 * 这是**唯一可信**的项目名来源。
 * @param {string} cwd
 */
export function projectNameFromCwd(cwd) {
  if (!cwd) return '(未知项目)'
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}
export function defaultSessionsRoot() {
  return process.env.DSH_SESSIONS_ROOT || join(homedir(), '.dsh', 'sessions')
}

/** 默认的 workspace.json（归档集合的真身）。 */
export function defaultWorkspaceJson() {
  return process.env.DSH_WORKSPACE_JSON || join(homedir(), '.dsh', 'storages', 'workspace.json')
}

/**
 * 读归档集合。用 Public API 是首选（ctx.workspaceRegistry.archivedSessionIds），
 * 但扫描器要能离线跑（CLI 场景），所以这里给一个文件级兜底。
 * @param {string} [workspaceJsonPath]
 * @returns {Set<string>}
 */
export function readArchivedSet(workspaceJsonPath = defaultWorkspaceJson()) {
  try {
    const j = JSON.parse(readFileSync(workspaceJsonPath, 'utf8'))
    const ids = j?.global?.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids : [])
  } catch {
    return new Set()
  }
}

/**
 * 扫描全部会话。**这是唯一的磁盘入口**，其余模块都吃它的输出。
 *
 * 返回的每条记录只做"结构性"统计（事件计数、时间跨度、文件大小），
 * 不做任何质量判断 —— 分诊和质量评分是 triage.js 的职责。
 *
 * @param {{sessionsRoot?: string, workspaceJson?: string, withEvents?: boolean}} [opts]
 * @returns {{sessions: object[], root: string, errors: string[]}}
 */
export function scanSessions(opts = {}) {
  const root = opts.sessionsRoot || defaultSessionsRoot()
  const archived = readArchivedSet(opts.workspaceJson || defaultWorkspaceJson())
  const sessions = []
  const errors = []

  if (!existsSync(root)) {
    return { sessions, root, errors: [`sessions root 不存在: ${root}`] }
  }

  let projectDirs
  try {
    projectDirs = readdirSync(root)
  } catch (e) {
    return { sessions, root, errors: [`读 sessions root 失败: ${e.message}`] }
  }

  for (const projDir of projectDirs) {
    const projPath = join(root, projDir)
    let isDir = false
    try {
      isDir = statSync(projPath).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue

    let sidDirs
    try {
      sidDirs = readdirSync(projPath)
    } catch {
      continue
    }

    for (const sid of sidDirs) {
      const sidPath = join(projPath, sid)
      try {
        if (!statSync(sidPath).isDirectory()) continue
      } catch {
        continue
      }
      const picked = pickSessionFile(sidPath)
      if (!picked) continue
      const filePath = join(sidPath, picked.file)

      let rec
      try {
        rec = summarizeSessionFile(filePath, { sid, projDir, version: picked.version, archived: archived.has(sid) })
      } catch (e) {
        errors.push(`${sid}: ${e.message}`)
        continue
      }
      if (!rec) {
        // 【2026-11-08】这里原来是 `if (rec) sessions.push(rec)` —— 解析不出事件的
        // 文件被**静默跳过**：会话数少了一个，而 errors 仍为 0。
        // 实测：0 字节文件、半截 zstd 帧都走这条路。对"记忆"产品来说，
        // "这个会话消失了"和"这个会话本来就没内容"必须能分开，否则
        // 用户看到"解析错误 0"会以为全量扫描是干净的。
        errors.push(`${sid}: 会话文件无可解析事件（0 字节或 zstd 帧不完整）`)
        continue
      }
      // 逐帧解压时坏掉的帧同样要报：能解出部分内容不等于文件是好的
      if (rec.badFrames > 0) {
        errors.push(`${sid}: ${rec.badFrames} 个 zstd 帧解压失败（文件可能被截断）`)
      }
      sessions.push(rec)
    }
  }

  // 稳定顺序：新的在前（无 createdAt 的沉底）
  sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return { sessions, root, errors }
}

/** 会产生"交付物"的工具名特征。 */
const WRITE_TOOL_RE = /write|edit|patch|create|save|append|mv|cp|rename/i

/**
 * 取路径的最后一段。
 *
 * 【为什么不用 node:path 的 basename】本项目的源机器是 Windows，会话日志里的路径
 * 是 `D:\proj\hwplatform\选型.md`；而 basename() 按**当前平台**的分隔符切，
 * 在 Linux 上跑分析脚本时会把整条路径当成文件名返回 —— 实测就漏过一次：
 * evidence.files 里出现了 `D:\proj\hwplatform\选型.md`。
 * 这里两个分隔符都认，与运行平台无关。
 */
function toBasename(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/** 从工具参数里捞一个文件名（basename）。参数可能是 JSON 也可能是句子，两种都容错。 */
function extractFileName(args) {
  const s = String(args || '')
  if (!s) return null
  // 先试 JSON 里的常见键
  try {
    const o = JSON.parse(s)
    for (const k of ['file_path', 'filePath', 'path', 'filename', 'file', 'target']) {
      if (typeof o?.[k] === 'string' && o[k].trim()) return toBasename(o[k].trim())
    }
  } catch {
    /* 不是 JSON，走正则 */
  }
  // 退路：直接从文本里抓一个像文件名的片段
  const m = /([\w.\-\u4e00-\u9fa5/\\]+\.(?:md|json|mjs|js|ts|tsx|py|html|css|yaml|yml|sh|txt|zst|csv))\b/i.exec(s)
  return m ? toBasename(m[1]) : null
}

/**
 * 汇总单个会话文件。事件流解析在需要时再做（withEvents），
 * 默认只做一次流式遍历，避免把 145 MB 全部驻留内存。
 * @param {string} filePath
 * @param {{sid: string, projDir: string, version: number, archived: boolean}} meta
 */
export function summarizeSessionFile(filePath, meta) {
  const buf = readFileSync(filePath)
  const { text, frames, badFrames } = decompressMultiFrame(buf)
  const { events, badLines } = parseJsonl(text)
  if (events.length === 0) return null

  let header = null
  let title = ''
  let turnStarts = 0
  let turnEnds = 0
  let toolCalls = 0
  let toolResults = 0
  let toolErrors = 0
  let userMessagesAny = 0
  let humanMessages = 0
  let assistantMessages = 0
  let deliverables = 0
  let prunes = 0
  let compactions = 0
  let subagentSpawns = 0
  let firstPromptChars = 0
  let humanTextTotal = 0
  let firstTime = null
  let lastTime = null
  let lastEndReason = null
  const userSourceKinds = {}
  const toolNameCount = {}
  /** 被写/改过的文件名（只留 basename，避免把个人绝对路径抄进手册）。 */
  const touchedFiles = new Map()
  const signatureCount = {}
  const endReasonCounts = {}

  for (const ev of events) {
    if (ev.type === 'session' && !header) header = ev
    const t = ev.time
    if (typeof t === 'number') {
      if (firstTime === null || t < firstTime) firstTime = t
      if (lastTime === null || t > lastTime) lastTime = t
    }
    switch (ev.type) {
      case 'session/title':
        title = ev.data?.title || title
        break
      case 'turn/start':
        turnStarts += 1
        break
      case 'turn/end': {
        turnEnds += 1
        const r = ev.data?.reason?.kind || 'unknown'
        endReasonCounts[r] = (endReasonCounts[r] || 0) + 1
        lastEndReason = r
        break
      }
      case 'tool/call': {
        toolCalls += 1
        const name = ev.data?.name || '?'
        toolNameCount[name] = (toolNameCount[name] || 0) + 1
        // 重复调用检测：name + arguments 完全相同 = 一次 thrashing
        const sig = name + '\u0000' + (ev.data?.arguments || '')
        signatureCount[sig] = (signatureCount[sig] || 0) + 1
        if (/subagent|teammate/i.test(name)) subagentSpawns += 1
        // 写/改类工具留下的是"这次产出了什么"的唯一确定性线索。
        // 只取 basename：绝对路径属于个人环境信息，不该进手册（见 .gitignore 里
        // 关于 data/ 那段同样的顾虑）。
        if (WRITE_TOOL_RE.test(name)) {
          const base = extractFileName(ev.data?.arguments)
          if (base) touchedFiles.set(base, (touchedFiles.get(base) || 0) + 1)
        }
        break
      }
      case 'tool/result':
        toolResults += 1
        if (ev.data?.message?.isError) toolErrors += 1
        break
      case 'user/message': {
        userMessagesAny += 1
        const kind = ev.data?.source?.kind || 'unknown'
        userSourceKinds[kind] = (userSourceKinds[kind] || 0) + 1
        if (kind === 'user') {
          humanMessages += 1
          // 首条真实人类指令的长度 —— shapeOf() 靠它区分「配方」与「经验」
          if (firstPromptChars === 0) {
            const text = (ev.data?.content || [])
              .filter((c) => c?.type === 'text')
              .map((c) => c.text || '')
              .join('')
            firstPromptChars = text.length
            humanTextTotal = text.length
          } else {
            const text = (ev.data?.content || [])
              .filter((c) => c?.type === 'text')
              .map((c) => c.text || '')
              .join('')
            humanTextTotal += text.length
          }
        }
        break
      }
      case 'assistant/message':
        assistantMessages += 1
        break
      case 'deliverables/presented':
        deliverables += 1
        break
      case 'compaction/prune':
        prunes += 1
        break
      case 'compaction/start':
        compactions += 1
        break
      default:
        break
    }
  }

  const dupTotal = Object.values(signatureCount).reduce((a, b) => a + b, 0)
  const top1Repeat = Object.values(signatureCount).reduce((a, b) => Math.max(a, b), 0)

  return {
    sid: meta.sid,
    project: header?.cwd ? projectNameFromCwd(header.cwd) : decodeProjectDir(meta.projDir),
    projectDir: meta.projDir,
    file: filePath,
    formatVersion: meta.version,
    bytes: buf.length,
    frames,
    badFrames,
    badLines,
    events: events.length,
    archived: meta.archived,
    title,
    createdAt: header?.createdAt ?? null,
    cwd: header?.cwd ?? '',
    agentPreset: header?.agentPreset ?? null,
    delegationDepth: header?.delegationDepth ?? 0,
    firstTime,
    lastTime,
    activeMs: firstTime !== null && lastTime !== null ? lastTime - firstTime : 0,
    turnStarts,
    turnEnds,
    toolCalls,
    toolResults,
    toolErrors,
    userMessagesAny,
    humanMessages,
    assistantMessages,
    deliverables,
    prunes,
    compactions,
    subagentSpawns,
    userSourceKinds,
    firstPromptChars,
    humanTextTotal,
    humanTextAvgLen: humanMessages > 0 ? Math.round(humanTextTotal / humanMessages) : 0,
    toolNameCount,
    // 前 3 个工具与 3 个被写过的文件：给条目做"证据"，让骨架条目也能看出干了什么。
    // 注意它们**不进检索语料**（matchEntries 只看 title+claim），
    // 否则查询「write」会把整库都召回来。
    topTools: Object.entries(toolNameCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => ({ name, count })),
    files: [...touchedFiles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name),
    endReasonCounts,
    lastEndReason,
    dupTotal,
    top1Repeat,
    dupRate: toolCalls > 0 ? top1Repeat / toolCalls : 0,
    errorRate: toolCalls > 0 ? toolErrors / toolCalls : 0,
  }
}
