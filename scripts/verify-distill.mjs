#!/usr/bin/env node
/**
 * verify-distill.mjs — LLM 提炼轨的独立验收
 *
 * 定位：不信任 prompt 作者的自述，用真实会话 + 对抗样本主动打。
 * 只读产品代码；所有实验在 os.tmpdir()；绝不碰 ~/.dsh/dsh-manuscript。
 *
 * 用法：
 *   node scripts/verify-distill.mjs                  # 全量（自动检测 distill.js 是否就绪）
 *   node scripts/verify-distill.mjs --only=digest    # 只验压缩质量
 *   node scripts/verify-distill.mjs --only=parse     # 只验防幻觉
 *   node scripts/verify-distill.mjs --only=pipeline  # 只验失败隔离
 *   node scripts/verify-distill.mjs --samples=10     # 抽样数量（默认 10）
 *   node scripts/verify-distill.mjs --save-samples   # 把 digest 样本落盘供人工阅读
 *
 * 退出码：0 = 无 FAIL；1 = 有 FAIL；2 = 脚本自身崩溃
 *
 * ── 本脚本的四块断言 ──────────────────────────────────────────
 *   ① digest 压缩：<6KB + **含实质内容**（不是只剩元信息）
 *   ② parseProposals 防幻觉：7 类对抗样本，重点拦"数字对不上"
 *   ③ pipeline 失败隔离：单批失败不拖垮全局 / 连续 3 次失败跳过 / dryRun 零调用
 *   ④ 真实 LLM 调用（若拿得到）：耗时 + 产出质量人工判读
 */

import fs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = nodePath.dirname(fileURLToPath(import.meta.url))
const PLUGIN = nodePath.resolve(HERE, '..')
const LIB = nodePath.join(PLUGIN, 'lib')
const REAL_LIBRARY_ROOT = nodePath.join(os.homedir(), '.dsh', 'dsh-manuscript')

const P = {
  distill: nodePath.join(LIB, 'distill.js'),
  pipeline: nodePath.join(LIB, 'pipeline.js'),
  scan: nodePath.join(LIB, 'scan.js'),
  triage: nodePath.join(LIB, 'triage.js'),
}

const DIGEST_LIMIT = 6 * 1024          // 任务书红线：6KB
const TMP = []

// ─────────────────────────── 结果收集 ───────────────────────────
const RESULTS = []
let CUR = null
const suite = (name, note = '') => { CUR = { name, note, cases: [] }; RESULTS.push(CUR) }

function record(name, status, detail) {
  if (!CUR) throw new Error('先 suite()')
  CUR.cases.push({ name, status, detail })
  // 【2026-11-09】新增 INFO：只记录事实、不构成判据的条目。它**不计入通过数** ——
  // 否则"打印了两个数字"会被算成一条通过的断言，虚抬总数。
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : status === 'INFO' ? 'ℹ' : '○'
  console.log(`  ${icon} [${status}] ${name}`)
  if (detail) console.log(`      ${detail}`)
}
const assertCase = (name, cond, ok, bad) => { record(name, cond ? 'PASS' : 'FAIL', cond ? ok : bad); return !!cond }
const skipCase = (name, why) => record(name, 'SKIP', why)

function cleanup() {
  for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { } }
  TMP.length = 0
}
function mkTmp(tag) {
  const d = fs.mkdtempSync(nodePath.join(os.tmpdir(), `p1distill-${tag}-`))
  const a = nodePath.resolve(d), b = nodePath.resolve(REAL_LIBRARY_ROOT)
  if (a === b || a.startsWith(b + nodePath.sep) || b.startsWith(a + nodePath.sep)) {
    throw new Error(`拒绝在真实书库附近做实验：${a}`)
  }
  TMP.push(d)
  return d
}

const modCache = new Map()
async function load(p) {
  if (!fs.existsSync(p)) return null
  const key = p + ':' + fs.statSync(p).mtimeMs
  if (modCache.has(key)) return modCache.get(key)
  const m = await import(pathToFileURL(p).href + `?t=${fs.statSync(p).mtimeMs}`)
  modCache.set(key, m)
  return m
}

// ─────────────────────────── 语料准备 ───────────────────────────
async function loadCorpus() {
  const scan = await load(P.scan)
  const triage = await load(P.triage)
  if (!scan || !triage) return { ok: false, why: '缺 scan.js 或 triage.js' }
  const r = scan.scanSessions()
  const t = triage.triageAll(r.sessions)
  return { ok: true, sessions: t.enriched, raw: r.sessions, counts: t.counts }
}

/**
 * 跨形态抽样：最长 / 最短 / 多轮 / 一次性 / 中等，覆盖真实差异。
 * 不用随机数（结果要可复现），用确定性规则挑极值 + 分位。
 */
function pickSpanningSessions(enriched, n) {
  const real = enriched.filter((s) => s.category === 'real')
  if (!real.length) return []
  // ⚠ 字段坑：扫描器产物里**没有 `turns`**，轮次字段是 `turnEnds`。
  //   写 `s.turns` 会得到 undefined，排序全变 NaN → 抽样退化成"原顺序前 N 个"。
  //   本脚本第一版就栽在这里（标称"最多轮次"抽到只有 5 轮的会话）。已修。
  const turnsOf = (s) => s.turnEnds ?? s.turns ?? 0
  const byCalls = [...real].sort((a, b) => a.toolCalls - b.toolCalls)
  const picked = []
  const push = (s, why) => {
    if (!s || picked.some((p) => p.session.sid === s.sid)) return
    picked.push({ session: s, why })
  }

  // 极值
  push(byCalls[byCalls.length - 1], '最长（toolCalls 最大）')
  push(byCalls[0], '最短（toolCalls 最小）')
  // 多轮 vs 一次性（用 turnEnds 排序）
  push([...real].filter((s) => s.shape === 'multi-turn').sort((a, b) => turnsOf(b) - turnsOf(a))[0], '最多轮次')
  push([...real].filter((s) => s.shape === 'one-shot').sort((a, b) => b.toolCalls - a.toolCalls)[0], '最大的一次性任务')
  // 高失败率（踩坑多，最能考验 digest 是否保留教训）
  push([...real].filter((s) => s.toolErrors > 0 && s.toolCalls > 40)
    .sort((a, b) => (b.toolErrors / (b.toolCalls || 1)) - (a.toolErrors / (a.toolCalls || 1)))[0], '工具失败率最高')
  // 交付物多 / 零交付物
  push([...real].sort((a, b) => b.deliverables - a.deliverables)[0], '交付物最多')
  push([...real].filter((s) => s.deliverables === 0 && s.toolCalls > 50).sort((a, b) => b.toolCalls - a.toolCalls)[0], '高调用但零交付')
  // 分位填充
  const qs = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]
  for (const q of qs) {
    const idx = Math.min(byCalls.length - 1, Math.floor(q * byCalls.length))
    push(byCalls[idx], `p${Math.round(q * 100)} 分位`)
    if (picked.length >= n) break
  }
  return picked.slice(0, n)
}

// ─────────────────────────── ① 压缩质量 ───────────────────────────
/**
 * 「压缩后还有实质内容吗」的机器判据。
 * 不只看字节数，要看 digest 里是否出现了**可提炼的语义材料**：
 *  - 人类原始指令的片段（prompt）
 *  - 工具名 + 参数/命令的痕迹
 *  - 交付物/结论的痕迹
 * 如果只有「5轮 136次调用」这类计数，就是失败的压缩。
 */
function analyzeDigestInfo(digest, session) {
  const d = String(digest || '')
  const facts = {
    bytes: Buffer.byteLength(d, 'utf8'),
    chars: d.length,
    lines: d.split('\n').length,
    hasCounters: /轮|次调用|turn|toolCalls/.test(d),
    // 语义材料的存在性
    hasToolNames: false,
    hasQuotedContent: false,     // 引号/代码块里的原始内容
    hasPaths: false,             // 文件路径
    hasCommands: false,          // 命令行痕迹
    hasDeliverables: /交付|deliverable|present/i.test(d),
    hasConclusionish: /结论|完成|结果|原因|因为|踩坑|失败|错误/i.test(d),
    echoOfPrompt: 0,             // 与首条人类指令的重合字符数
    toolNameHits: [],
  }
  // 工具名命中：用会话里真实出现过的工具名去 digest 里找
  const names = Object.keys(session.toolNameCount || {})
  for (const nm of names) {
    if (nm.length >= 3 && d.includes(nm)) { facts.hasToolNames = true; facts.toolNameHits.push(nm) }
  }
  facts.hasQuotedContent = /[`"「『].{6,}[`"」』]/.test(d) || /```/.test(d)
  facts.hasPaths = /[A-Za-z]:\\|\/[\w.-]+\/|\.(json|js|mjs|md|py|txt)\b/.test(d)
  facts.hasCommands = /\b(pwsh|node|git|npm|Get-|gr[eE]p|Select-String|Invoke-)\b/i.test(d)

  // 与原始 prompt 的粗略重合（取 prompt 前 200 字的 20 字符片段做集合）
  const prompt = String(session.firstPromptSeed || '')
  if (prompt.length >= 20) {
    const seen = new Set()
    const step = 20
    for (let i = 0; i + step <= Math.min(prompt.length, 400); i += step) seen.add(prompt.slice(i, i + step))
    let hit = 0
    for (const frag of seen) if (d.includes(frag)) hit += frag.length
    facts.echoOfPrompt = hit
  }
  return facts
}

/** 判定：是否「只剩元信息」 */
function verdictOf(facts) {
  const semanticSignals = [
    facts.hasToolNames,
    facts.hasQuotedContent,
    facts.hasPaths,
    facts.hasCommands,
    facts.echoOfPrompt > 0,
  ].filter(Boolean).length
  return {
    semanticSignals,
    // 至少 2 类语义信号才算"有实质内容"
    substantive: semanticSignals >= 2,
  }
}

async function suiteDigest(corpus, sampleN, saveSamples) {
  suite('① renderSessionDigest 压缩质量', `红线 <${DIGEST_LIMIT / 1024}KB，且不得只剩元信息`)

  const distill = await load(P.distill)
  if (!distill) { skipCase('① 全部', 'lib/distill.js 尚未出现'); return null }
  if (typeof distill.renderSessionDigest !== 'function') {
    skipCase('① 全部', `distill.js 未导出 renderSessionDigest（实际导出：${Object.keys(distill).join(', ')}）`)
    return null
  }

  const picked = pickSpanningSessions(corpus.sessions, sampleN)
  if (!picked.length) { skipCase('① 全部', '无 real 会话可抽'); return null }

  const rows = []
  for (const { session, why } of picked) {
    // 补一个 firstPromptSeed 供重合判断（用扫描器已给的 firstPromptChars 只够长度，这里取 title+project）
    session.firstPromptSeed = `${session.title || ''} ${session.project || ''}`
    let digest = null, err = null
    try { digest = distill.renderSessionDigest(session, {}) } catch (e) { err = e }
    if (err) {
      rows.push({ session, why, bytes: null, err: err.message })
      record(`抽样 ${session.sid.slice(0, 12)}`, 'FAIL', `renderSessionDigest 抛错：${err.message}`)
      continue
    }
    const f = analyzeDigestInfo(digest, session)
    const v = verdictOf(f)
    rows.push({ session, why, digest, facts: f, verdict: v, bytes: f.bytes })
  }

  const ok = rows.filter((r) => r.bytes != null)

  // 断言 1：每个都 < 6KB
  {
    const over = ok.filter((r) => r.bytes > DIGEST_LIMIT)
    assertCase('digest 全部 < 6KB',
      over.length === 0,
      `${ok.length} 个样本全部 ≤ ${DIGEST_LIMIT}B（最大 ${Math.max(...ok.map((r) => r.bytes))}B）`,
      `${over.length} 个超限：` + over.map((r) => `${r.session.sid.slice(0, 8)}=${r.bytes}B(${r.session.toolCalls}调用)`).join(', '))
  }

  // 断言 2：不得"只剩元信息"
  //
  // 【2026-11-07 修正】原断言对所有样本一视同仁，会误伤"本来就没有内容"的会话。
  // 实测反例 session-9bb12f88：turnEnds=2 · toolCalls=0 · deliverables=0 ·
  // humanTextTotal=41 字 · lastEndReason=error —— 这是一次"问了句问题、模型掉线了"
  // 的会话，磁盘上真实存在的信息就是那 41 个字。它的 digest 454B、信号 0/5
  // 不是压缩失败，而是**忠实反映了原文确实没什么可提炼**。
  //
  // 把这种会话判为失败，等于要求压缩器无中生有 —— 那恰恰是我们最反对的行为
  // （见 SYSTEM_PROMPT 的"返回空数组是可接受的"）。
  //
  // 所以豁免条件要显式写出来：**没有工具调用 且 没有交付物 且 人类输入极短**。
  // 三者同时成立才是真正的"空会话"；缺任何一条都说明有料可压，仍按原标准判。
  {
    const isVacuous = (s) =>
      (s.toolCalls ?? 0) === 0 &&
      (s.deliverables ?? 0) === 0 &&
      (s.humanTextTotal ?? 0) < 200
    const hollowAll = ok.filter((r) => !r.verdict.substantive)
    const vacuous = hollowAll.filter((r) => isVacuous(r.session))
    const hollow = hollowAll.filter((r) => !isVacuous(r.session))
    const exemptNote = vacuous.length
      ? `（另有 ${vacuous.length} 个空会话已豁免：` +
        vacuous.map((r) => `${r.session.sid.slice(0, 8)}(0调用/0交付/${r.session.humanTextTotal}字)`).join(', ') +
        '）'
      : ''
    assertCase('digest 含实质内容（不是只剩计数元信息）',
      hollow.length === 0,
      `${ok.length - vacuous.length} 个有料样本均检出 ≥2 类语义信号${exemptNote}`,
      `${hollow.length} 个样本疑似只剩元信息：` +
      hollow.map((r) => `${r.session.sid.slice(0, 8)}(信号${r.verdict.semanticSignals}/5, ${r.bytes}B, ${r.session.toolCalls}调用/${r.session.deliverables}交付/${r.session.humanTextTotal}字)`).join(', '))
  }

  // 断言 3：大会话的压缩率要合理（不能把 136 次调用的会话压成 200 字节）
  {
    const big = ok.filter((r) => r.session.toolCalls >= 80)
    if (big.length) {
      const tooSmall = big.filter((r) => r.bytes < 800)
      assertCase('大会话（≥80 调用）压后仍有足够体量（≥800B）',
        tooSmall.length === 0,
        big.map((r) => `${r.session.toolCalls}调用→${r.bytes}B`).join(', '),
        `过小：` + tooSmall.map((r) => `${r.session.sid.slice(0, 8)} ${r.session.toolCalls}调用仅${r.bytes}B`).join(', '))
    } else skipCase('大会话体量', '样本中无 ≥80 调用的会话')
  }

  // 断言 4（关键）：有工具失败的会话，digest 必须把失败/踩坑留下来
  // 若 digest 丢掉了失败信息，LLM 就只能"编"或"讲正确的废话"——这是命脉。
  {
    const withErr = ok.filter((r) => (r.session.toolErrors || 0) > 0)
    if (!withErr.length) {
      skipCase('digest 保留失败/踩坑信息', '样本中无带工具失败的会话')
    } else {
      const lost = withErr.filter((r) => !/失败|报错|错误|失败样本|error|failed|❌|踩坑/i.test(r.digest))
      record('digest 中的失败信息保留情况（事实）', 'INFO',
        `${withErr.length} 个带失败会话中，${withErr.length - lost.length} 个保留了失败痕迹；` +
        `失败次数：${withErr.map((r) => r.session.toolErrors).join('/')}`)
      assertCase('有工具失败的会话，digest 必须保留失败/踩坑信息',
        lost.length === 0,
        `全部 ${withErr.length} 个都保留了失败痕迹（含失败工具名/失败样本/报错描述）`,
        `${lost.length} 个丢了失败信息：` +
        lost.map((r) => `${r.session.sid.slice(0, 8)}(toolErrors=${r.session.toolErrors})`).join(', ') +
        ' → LLM 拿不到"哪里出过错"，只能产出泛泛而谈')
    }
  }

  // 断言 5（关键）：digest 必须能看出"人类到底要什么"
  {
    const noNeed = ok.filter((r) => !/需求|人类消息|【/.test(r.digest))
    assertCase('digest 结构化（含【需求演进】等分段，便于 LLM 定位）',
      noNeed.length === 0,
      `全部 ${ok.length} 个都有结构化分段（【需求演进】/【做了什么】/【结果】）`,
      `${noNeed.length} 个没有结构化分段，像一坨文本：` +
      noNeed.map((r) => r.session.sid.slice(0, 8)).join(', '))
  }

  // 统计表
  console.log('')
  console.log('  ┌ 抽样明细 ─────────────────────────────────────────────')
  console.log('  │ 会话           调用  轮次  交付   形态         原字节      压缩后   压缩率   语义信号')
  for (const r of rows) {
    const s = r.session
    const ratio = r.bytes != null ? ((r.bytes / (s.bytes || 1)) * 100).toFixed(2) + '%' : '—'
    console.log('  │ ' +
      String(s.sid.slice(0, 12)).padEnd(14) +
      String(s.toolCalls).padStart(5) +
      String(s.turns ?? s.turnEnds).padStart(6) +
      String(s.deliverables).padStart(5) +
      '  ' + String(s.shape || '').padEnd(12) +
      String(s.bytes).padStart(9) +
      String(r.bytes ?? 'ERR').padStart(9) +
      String(ratio).padStart(9) +
      (r.verdict ? String(r.verdict.semanticSignals) + '/5' : '').padStart(10))
  }
  console.log('  └──────────────────────────────────────────────────────')

  // 落盘样本供人工阅读
  if (saveSamples && ok.length) {
    const dir = nodePath.join(PLUGIN, '_work')
    try { fs.mkdirSync(dir, { recursive: true }) } catch { }
    // 挑 3 个最有代表性的：最长、多轮、一次性
    const picks = [
      ok.find((r) => r.why.includes('最长')),
      ok.find((r) => r.why.includes('最多轮次')),
      ok.find((r) => r.why.includes('一次性')),
    ].filter(Boolean)
    const use = picks.length >= 3 ? picks : ok.slice(0, 3)
    for (const [i, r] of use.entries()) {
      const file = nodePath.join(dir, `p1-distill-sample-${i + 1}.txt`)
      fs.writeFileSync(file,
        `# 压缩样本 ${i + 1}：${r.session.sid}\n` +
        `# 选取理由：${r.why}\n` +
        `# 原会话：${r.session.toolCalls} 次调用 / ${r.session.turns ?? r.session.turnEnds} 轮 / ` +
        `${r.session.deliverables} 交付物 / ${r.session.shape} / 原始文件 ${r.session.bytes} 字节\n` +
        `# 压缩后：${r.bytes} 字节\n` +
        `# 标题：${r.session.title || '(无)'}\n` +
        `${'─'.repeat(70)}\n\n${r.digest}\n`, 'utf8')
    }
    console.log(`  已落盘 ${use.length} 个样本到 _work/p1-distill-sample-*.txt`)
  }

  return { rows, ok }
}

// ─────────────────────────── ② 防幻觉 ───────────────────────────
/**
 * 7 类对抗样本。重点是第 5 条：claim 里编造 digest 中不存在的数字。
 *
 * 设计原则：每条都给出「为什么该拦」，便于判 FAIL 时定位。
 */
async function suiteParse(corpus) {
  suite('② parseProposals 防幻觉（对抗样本）', '最危险：编造数字')

  const distill = await load(P.distill)
  if (!distill) { skipCase('② 全部', 'lib/distill.js 尚未出现'); return }

  const fnName = ['parseProposals', 'parseDistillOutput', 'parseProposal']
    .find((n) => typeof distill[n] === 'function')
  if (!fnName) {
    skipCase('② 全部', `distill.js 未导出解析函数（实际导出：${Object.keys(distill).filter((k) => typeof distill[k] === 'function').join(', ')}）`)
    return
  }
  record('解析函数已定位', 'INFO', `使用 ${fnName}(rawText, opts)`)

  // ⚠ 真实契约（读源码得知，务必对齐）：
  //   parseProposals(rawText, opts) → { ok:boolean, proposals?:[], reason?:string }
  //   · LLM 输出顶层键是 **entries**（不是 proposals）
  //   · 数字溯源靠 opts.digest 的原始文本，不是 opts.session 字段
  //   · 只有 |n|>=100 或非整数才强校验（1–2 位数字属量词，放过）
  //   · 一次最多 3 条，>3 判"拆分过度"
  //   · 内容不合格 → 单条进 dropped；**数字编造从 2026-11-09 起也走单条淘汰**
  const DIGEST = `会话：I2C 从机中断里不要调阻塞日志
轮次 5 · 工具调用 136 次 · 交付物 3 个
工具使用：pwsh 80、read 40、write 16
结论：在 ISR 里调用 printf 导致 HardFault；改用环形缓冲后恢复。
路径：C:\\proj\\i2c.c`

  const call = (raw) => {
    try { return distill[fnName](raw, { digest: DIGEST }) }
    catch (e) { return { ok: false, reason: 'THREW: ' + (e.message || String(e)), threw: true } }
  }
  /** 归一化：统一成 { ok, list, reason, dropped } */
  //
  // 【2026-11-07】补 dropped。新语义下"某条不合格"不再表现为 ok=false，
  // 而是 ok=true + 该条进 dropped。不把它透出来的话，验收脚本会误判成
  // "坏条目被原样通过了" —— 实际上它被淘汰了，只是报告位置变了。
  const norm = (r) => {
    if (!r || typeof r !== 'object') return { ok: false, list: [], reason: '返回值非对象', dropped: [] }
    const list = Array.isArray(r.proposals) ? r.proposals
      : Array.isArray(r.entries) ? r.entries
        : Array.isArray(r) ? r : []
    return {
      ok: r.ok !== false,
      list,
      reason: r.reason || '',
      dropped: Array.isArray(r.dropped) ? r.dropped : [],
      threw: !!r.threw,
    }
  }

  const legalEntry = {
    title: '中断内禁止调用阻塞日志',
    claim: '在 I2C 从机中断里调用 printf 会触发 HardFault，应改为环形缓冲延迟输出，避免占用中断栈。',
    why: '该会话出现 HardFault，改用环形缓冲后恢复。',
    confidence: 'high',
    tags: ['I2C', 'ISR'],
  }

  // ── 用例 1：合法 JSON ──
  {
    const a = norm(call(JSON.stringify({ entries: [legalEntry] })))
    assertCase('②-1 合法 JSON 应通过',
      a.ok && a.list.length === 1,
      `接受 1 条（title=${a.list[0]?.title}）`,
      `应接受却被拒：ok=${a.ok} reason="${a.reason}" list=${a.list.length}`)
  }

  // ── 用例 2：```json 围栏 ──
  {
    const a = norm(call('```json\n' + JSON.stringify({ entries: [legalEntry] }) + '\n```'))
    assertCase('②-2 ```json 围栏包裹应容错通过',
      a.ok && a.list.length === 1,
      '正确剥离围栏并解析',
      `未容错：ok=${a.ok} reason="${a.reason}" list=${a.list.length}`)
  }

  // ── 用例 3：缺 claim ──
  //
  // 【2026-11-07 语义变更】旧口径：缺 claim → 整批拒绝。
  // 新口径：缺 claim 是**这一条**的问题 → 只淘汰它，整批仍是 ok（产出 0 条）。
  // 断言仍然要求「这一条不被采纳」，但不再要求 ok=false。
  // 理由见 lib/distill.js 里 dropped 的注释：单条内容不合格不该拖垮整批，
  // 实测 70.5% 的历史失败是这类可由单条淘汰解决的问题。
  {
    const a = norm(call(JSON.stringify({ entries: [{ title: '中断内禁止调用阻塞日志', confidence: 'high', tags: [] }] })))
    const droppedReason = (a.dropped || []).map((d) => d.reason).join(' ')
    assertCase('②-3 缺 claim 字段应被淘汰并说明原因',
      a.list.length === 0 && /claim/i.test(droppedReason),
      `淘汰该条，reason="${droppedReason}"`,
      `缺字段未被正确拒绝：ok=${a.ok} list=${a.list.length} dropped=${JSON.stringify(a.dropped || [])}`)
  }

  // ── 用例 4：名词堆标题 ──
  {
    const nouny = { ...legalEntry, title: '关于I2C的问题' }
    const a = norm(call(JSON.stringify({ entries: [nouny] })))
    const droppedReason = (a.dropped || []).map((d) => d.reason).join(' ')
    // 新口径：名词堆被单条淘汰（不再整批失败）
    const rejected = a.list.length === 0 && /名词堆|title/.test(droppedReason)
    assertCase('②-4 名词堆标题应被淘汰并说明原因',
      rejected,
      `淘汰该条：${droppedReason}`,
      `名词堆原样通过：ok=${a.ok} list=${JSON.stringify(a.list.slice(0, 1))} dropped=${JSON.stringify(a.dropped || [])}`)
  }

  // ── 用例 5（重点）：编造大数字 ──
  {
    const forged = { ...legalEntry, claim: '在 I2C 从机中断里调用 printf 导致 HardFault；该会话共有 500 次工具调用、12 个交付物。' }
    const a = norm(call(JSON.stringify({ entries: [forged] })))
    const leak = a.list.find((p) => /500/.test(String(p.claim || '')))
    // 【2026-11-09 语义变更】整批拒绝 → 单条淘汰。
    // 断言的核心没变：**编造的那条绝不能进 list**；变了的是不再要求 ok=false。
    const droppedReason = (a.dropped || []).map((d) => d.reason).join(' ')
    assertCase('②-5 claim 编造大数字（digest=136，claim 说 500）必须被丢掉',
      !leak && a.list.length === 0 && /500/.test(droppedReason),
      `丢掉了，dropped="${droppedReason}"`,
      leak
        ? `**漏了**：伪造 500 次的原样通过 → ${JSON.stringify(leak).slice(0, 200)}`
        : `未进 dropped：ok=${a.ok} reason="${a.reason}" dropped=${JSON.stringify(a.dropped || [])}`)
  }

  // ── 用例 5b：编造小数字（应被放过，因为 <100 属量词）──
  {
    const forged = { ...legalEntry, claim: '该会话共 7 次工具调用、0 个交付物，验证了 ISR 阻塞问题。' }
    const a = norm(call(JSON.stringify({ entries: [forged] })))
    // 已知设计：1-2 位数字不校验，所以这条**预期放行**。记录事实而非判失败。
    // 【2026-11-08 修】原来两种相反结果都写进 PASS —— 用例不可能失败。
    // 既然设计是"<100 的数字不校验、应放行"，那就断言它真的放行。
    assertCase('②-5b 编造小数字（7 次/0 交付）——设计上应放行',
      a.ok === true,
      '如设计预期：<100 的数字不校验（属量词范畴），放行',
      `被数字校验拦住：${a.reason || ''}（比预期更严）`)
  }

  // ── 用例 5c：编造小数（非整数应被校验）──
  {
    const forged = { ...legalEntry, claim: '该会话共 136 次工具调用，错误率 87.5% 说明 ISR 阻塞极严重。' }
    const a = norm(call(JSON.stringify({ entries: [forged] })))
    assertCase('②-5c 编造小数（87.5% 在 digest 中不存在）应被拒绝',
      !a.ok || !a.list.some((p) => /87\.5/.test(String(p.claim || ''))),
      a.ok ? '未拦截但…' : `拦住了，reason="${a.reason}"`,
      `**漏了**：伪造小数原样通过 → ${JSON.stringify(a.list[0] || {}).slice(0, 200)}`)
  }

  // ── 用例 5d：数字真实（不应误杀）──
  {
    const truthful = { ...legalEntry, claim: '该会话 136 次工具调用中出现 HardFault，改用环形缓冲后恢复，交付 3 个成果。' }
    const a = norm(call(JSON.stringify({ entries: [truthful] })))
    assertCase('②-5d 数字与 digest 一致时不应误杀（防过严）',
      a.ok && a.list.length === 1,
      '正确放行（136 / 3 均可在 digest 找到）',
      `误杀：ok=${a.ok} reason="${a.reason}"`)
  }

  // ── 用例 6：中文散文 ──
  {
    const a = norm(call('好的，我来分析这个会话。这个会话展示了 ISR 中阻塞调用的危害，建议在中断里避免使用 printf。以上是我的分析。'))
    assertCase('②-6 返回中文解释而非 JSON 应被拒绝',
      !a.ok && a.list.length === 0,
      `拒绝，reason="${a.reason}"`,
      `把散文当条目接受：ok=${a.ok} list=${JSON.stringify(a.list).slice(0, 160)}`)
  }

  // ── 用例 7：空 entries ──
  {
    const a = norm(call(JSON.stringify({ entries: [] })))
    assertCase('②-7 空 entries 应被接受（"没东西可提炼"是合法的）',
      a.ok && a.list.length === 0,
      '正确接受空结果',
      `空结果被当错误：ok=${a.ok} reason="${a.reason}"`)
  }

  // ── 用例 8：完全非法 JSON ──
  {
    const a = norm(call('{ this is not json ]'))
    assertCase('②-8 完全非法 JSON 应被拒绝且不崩',
      !a.ok && a.list.length === 0 && !a.threw,
      `拒绝，reason="${a.reason}"`,
      `非法 JSON 仍产出或抛错：ok=${a.ok} threw=${a.threw}`)
  }

  // ── 用例 9：条目过多（两级：略超截断、超得多才拒绝）──
  //
  // 【2026-11-08 修】原来这条断言"6 条必须被拒绝"，而实现从 2026-11-02 起就是
  // 两级：4-6 条截断保留前 3、>6 条整批拒绝（见 parseProposals 的注释：
  // "宁可少要一条，不要整批浪费一次调用"）。用例早就过期了，一直在报失败，
  // 而没人看这个脚本 —— 这里按当前设计拆成两条可失败的断言。
  {
    const six = { entries: Array.from({ length: 6 }, (_, i) => ({ ...legalEntry, title: `中断内禁止阻塞调用第${i}条` })) }
    const a = norm(call(JSON.stringify(six)))
    assertCase('②-9a 单批 6 条应截断保留前 3 条（不整批丢弃）',
      a.ok && a.list.length === 3,
      `截断到 3 条（ok=${a.ok}）`,
      `未按设计截断：ok=${a.ok} list=${a.list.length} reason=${a.reason || ''}`)

    const seven = { entries: Array.from({ length: 7 }, (_, i) => ({ ...legalEntry, title: `中断内禁止阻塞调用第${i}条` })) }
    const b = norm(call(JSON.stringify(seven)))
    assertCase('②-9b 单批 >6 条应整批拒绝（模型跑偏）',
      !b.ok,
      `拒绝，reason="${b.reason}"`,
      `7 条被放行：list=${b.list.length}`)
  }

  // ── 用例 10：空字符串 ──
  {
    const a = norm(call(''))
    assertCase('②-10 空输出应被拒绝',
      !a.ok && a.list.length === 0,
      `拒绝，reason="${a.reason}"`,
      `空输入被接受：ok=${a.ok}`)
  }
}

// ─────────────────────────── ③ pipeline 失败隔离 ───────────────────────────
async function suitePipeline(corpus) {
  suite('③ pipeline 失败隔离', '单批失败不拖垮全局 / 连续失败跳过 / dryRun 零 LLM 调用')

  const pl = await load(P.pipeline)
  if (!pl) { skipCase('③ 全部', 'lib/pipeline.js 尚未出现'); return }
  const fns = Object.keys(pl).filter((k) => typeof pl[k] === 'function')
  record('pipeline 导出函数', 'INFO', fns.join(', ') || '(无)')

  // ⚠ 真实契约（读源码得知）：
  //   runDistillPass(queue, {llm, distillBatch, batchSize, dryRun, root})
  //   → { runId, status, batches, proposals, failures, usage, plan }
  //   · dryRun === true **或** 缺 opts.llm → 直接降级为 dry-run，零调用
  //   · 未注入 distillBatch 且非 dryRun → 明确抛错（不假装成功）
  const runName = ['runDistillPass', 'runPipeline', 'runDistill']
    .find((n) => typeof pl[n] === 'function')
  if (!runName) {
    skipCase('③ 隔离测试', `未找到流水线入口，导出为：${fns.join(', ')}`)
    return
  }
  record('流水线入口已定位', 'INFO', `${runName}()`)

  const sessions = corpus.sessions.filter((s) => s.category === 'real').slice(0, 6)
  if (sessions.length < 3) { skipCase('③ 隔离测试', '真实会话不足'); return }

  const fakeLlm = { stream: async function* () { yield { type: 'text-delta', text: '{"entries":[]}' } } }

  // ── 3a：第 2 批抛错，其余批正常 ──
  {
    let calls = 0
    const mockDistill = async (batch) => {
      calls += 1
      if (calls === 2) throw new Error('模拟第 2 批 LLM 超时')
      return {
        ok: true,
        proposals: [{ title: `批次${calls}产出的经验条目`, claim: '这是一条模拟的、长度足够的 claim 文本用于测试。', confidence: 'medium', tags: [] }],
        rawText: '{}',
      }
    }
    let out = null, threw = null
    try {
      out = await pl[runName](sessions, {
        llm: fakeLlm, distillBatch: mockDistill, batchSize: 2, root: mkTmp('pipe-a'),
      })
    } catch (e) { threw = e }

    assertCase('③-1 第 2 批抛错时流水线整体不崩',
      !threw,
      `未抛出；status=${out?.status}`,
      `第 2 批失败导致整体抛出：${threw && threw.message}`)

    if (!threw) {
      const failures = out?.failures || []
      const props = out?.proposals || []
      record('③-1b 失败批被记录（事实）', 'INFO',
        `共 ${calls} 批调用；failures=${failures.length}；proposals=${props.length}；` +
        `failures 明细=${JSON.stringify(failures).slice(0, 200)}`)
      assertCase('③-2 其余批仍正常完成（失败被隔离）',
        props.length > 0 && failures.length > 0,
        `${props.length} 条产出保留、${failures.length} 批失败被记录 → 隔离生效`,
        `未实现隔离：proposals=${props.length} failures=${failures.length}（期望产出>0 且 失败>0）`)
    }
  }

  // ── 3b：失败会话应被记住（用于下次跳过）──
  {
    const out = await (async () => {
      let n = 0
      const mock = async () => { n += 1; throw new Error('持续失败') }
      try {
        return await pl[runName](sessions, {
          llm: fakeLlm, distillBatch: mock, batchSize: 1, root: mkTmp('pipe-b'),
        })
      } catch (e) { return { _threw: e } }
    })()

    // 【2026-11-08 修】原来"抛错"与"正常返回"两条分支都记 PASS，
    // 于是流水线整体崩溃也算绿，而真正的断言 ③-4 只在 else 里执行 —— 抛错时被静默跳过。
    // 现在：抛错 = FAIL；③-4 无条件执行。
    const failures3 = out?._threw ? [] : (out?.failures || [])
    assertCase('③-3 全批失败时应返回结果，而不是整体崩溃',
      !out?._threw,
      `返回了结果：failures=${failures3.length} / ${out?.batches} 批；status=${out?.status}`,
      `整体抛错：${out?._threw?.message || ''}`)
    if (!out?._threw) {
      assertCase('③-4 全批失败时不崩溃且记录完整',
        Array.isArray(failures3) && failures3.length > 0,
        `${failures3.length} 批失败全部记录`,
        `失败未记录：${JSON.stringify(out)?.slice(0, 200)}`)

      // 失败会话的 sid 是否被记下来（供上层累计跳过）
      const hasSid = failures3.some((f) => f && (f.sids || f.sid || f.sessionIds))
      record('③-4b 失败记录含会话标识（供上层累计跳过）',
        hasSid ? 'PASS' : 'SKIP',
        hasSid ? `样例：${JSON.stringify(failures3[0]).slice(0, 160)}` : `失败项未带 sid：${JSON.stringify(failures3[0]).slice(0, 160)}`)
    }
  }

  // ── 3c：失败上限（mergeFailureCounts 是否支持累计跳过）──
  {
    if (typeof pl.mergeFailureCounts === 'function') {
      // ⚠ 真实契约：mergeFailureCounts(failures, prev = Map, proposals = []) → Map
      //   failures: [{ sids:[...] }]；prev 是上一轮的 Map；成功产出会清零
      const victim = sessions[0].sid
      let prev = new Map()
      for (let i = 0; i < 3; i++) {
        prev = pl.mergeFailureCounts([{ batchIndex: i, sids: [victim], error: { message: 'x' } }], prev, [])
      }
      const v = prev instanceof Map ? prev.get(victim) : prev?.[victim]
      record('③-5 失败计数可累积（事实）', 'INFO',
        `同一会话 3 轮 merge 后计数 = ${v}（返回类型 ${prev instanceof Map ? 'Map' : typeof prev}）`)
      assertCase('③-6 失败计数能累计到 3（支持"连续 3 次跳过"策略）',
        Number(v) >= 3,
        `累计 ${v} 次，上层可据此跳过`,
        `计数未正确累积：victim=${victim} 得到 ${JSON.stringify(v)}`)

      // 成功产出应清零 —— 这是"已证明能提"的正面信号
      const afterOk = pl.mergeFailureCounts([], prev, [{ sid: victim }])
      const v2 = afterOk instanceof Map ? afterOk.get(victim) : afterOk?.[victim]
      assertCase('③-6b 成功产出后失败计数清零（避免误伤已恢复的会话）',
        !v2,
        `清零成功（现在为 ${v2 ?? 'undefined'}）`,
        `成功后计数仍为 ${v2} —— 会把已恢复的会话永久跳过`)
    } else {
      skipCase('③-5 失败计数累积', 'pipeline.js 未导出 mergeFailureCounts')
    }
  }

  // ── 3d：dryRun 零 LLM 调用 ──
  {
    let streamCalls = 0
    let distillCalls = 0
    const spyLlm = { stream: async function* () { streamCalls += 1; yield { type: 'text-delta', text: '{}' } } }
    const mockDistill = async () => { distillCalls += 1; return { ok: true, proposals: [], rawText: '{}' } }
    let out = null, threw = null
    try {
      out = await pl[runName](sessions, {
        llm: spyLlm, distillBatch: mockDistill, batchSize: 2, dryRun: true, root: mkTmp('pipe-dry'),
      })
    } catch (e) { threw = e }
    assertCase('③-7 dryRun:true 时零次 LLM 调用',
      streamCalls === 0 && distillCalls === 0 && !threw,
      `llm.stream=${streamCalls} 次、distillBatch=${distillCalls} 次（均 0）；status=${out?.status}`,
      `**dryRun 仍调用 LLM**：stream=${streamCalls} distill=${distillCalls} threw=${threw && threw.message}`)
    assertCase('③-8 dryRun 仍给出预演计划（plan）',
      !!out?.plan,
      `plan.calls=${out?.plan?.calls} batches=${out?.plan?.batches?.length} sCount=${out?.plan?.sessionCount}`,
      `未返回 plan：${JSON.stringify(out)?.slice(0, 200)}`)
  }

  // ── 3e：未注入 distillBatch 且非 dryRun → 必须明确报错 ──
  {
    let threw = null
    try {
      await pl[runName](sessions, { llm: fakeLlm, batchSize: 2, root: mkTmp('pipe-nodistill') })
    } catch (e) { threw = e }
    assertCase('③-9 未注入 distillBatch 且非 dryRun 时明确报错（不假装成功）',
      !!threw,
      `正确抛错：${threw && threw.message.slice(0, 80)}`,
      '静默返回了"成功但空"的结果 —— 会让上层误以为提炼跑过了')
  }
}

// ─────────────────────────── ④ 端到端（mock LLM）───────────────────────────
/**
 * 拿不到真实 ctx.llm 时的替代方案：mock 三类典型返回，走完整 distillBatch 链路。
 * 这不是替代真实 LLM 验证，而是验证 **prompt 组装 → stream 收集 → 解析 → 条目** 的管线。
 *
 * 三类 mock：
 *   good     —— 基于真实 digest 里的数字与内容，构造合法条目 → 应通过
 *   forged   —— 数字编造（digest 是 136，说 500）→ 必须被拦
 *   offTopic —— 返回散文/无关内容 → 必须被拒
 */
async function suiteEndToEnd(corpus) {
  suite('④ 端到端链路（mock LLM，验证 prompt→stream→parse 全链路）',
    '真实 ctx.llm 拿不到时，用 mock 验证管线正确性')

  const distill = await load(P.distill)
  if (!distill) { skipCase('④ 全部', 'lib/distill.js 尚未出现'); return }
  if (typeof distill.distillBatch !== 'function') {
    skipCase('④ 全部', 'distill.js 未导出 distillBatch')
    return
  }

  // 挑一个中等会话（digest 不会太大，便于人工核对数字）
  const session = corpus.sessions
    .filter((s) => s.category === 'real' && s.toolCalls >= 20 && s.toolCalls < 400)
    .sort((a, b) => b.qualityScore - a.qualityScore)[0]
  if (!session) { skipCase('④ 全部', '无合适会话'); return }

  const digest = distill.renderSessionDigest(session, {})
  record('④-0 取样会话', 'INFO',
    `${session.sid.slice(0, 12)} · ${session.toolCalls}调用/${session.turnEnds}轮 · digest ${Buffer.byteLength(digest)}B`)

  // 从 digest 里抽出真实出现的大数字，供 good 用例使用
  const realNums = (digest.match(/\d{3,}/g) || []).slice(0, 4)
  record('④-0b digest 中的大数字（用于构造"真实"claim）', 'INFO',
    realNums.length ? realNums.join(', ') : '(无 3 位以上数字)')

  // 通用 llm mock 工厂：把给定文本按 chunk 吐出来
  function mockLlm(text) {
    let streamed = 0
    return {
      _calls: 0,
      _streamed: 0,
      stream(opts) {
        this._calls += 1
        this._lastOpts = opts
        const self = this
        return (async function* () {
          // 分片吐出，模拟真实流式（每 40 字符一片）
          for (let i = 0; i < text.length; i += 40) {
            streamed += 40
            self._streamed += 40
            yield { type: 'text-delta', text: text.slice(i, i + 40) }
          }
        })()
      },
    }
  }

  // ── 4a：good —— 合法条目，数字真实 ──
  {
    const goodEntry = {
      title: '中断内禁止调用阻塞日志',
      claim: `该会话共 ${session.toolCalls} 次工具调用，核心教训是中断上下文里不要做阻塞 IO。`,
      why: '会话中出现了与此相关的排查过程。',
      confidence: 'medium',
      tags: ['ISR'],
    }
    const llm = mockLlm(JSON.stringify({ entries: [goodEntry] }))
    let res = null, err = null
    try { res = await distill.distillBatch([session], { llm, maxSessionsPerCall: 1 }) }
    catch (e) { err = e }

    assertCase('④-1 good：合法条目端到端产出成功',
      !err && res && !res.error && (res.proposals || []).length === 1,
      `产出 1 条；llm.stream 被调用 ${llm._calls} 次，流式吐出 ${llm._streamed} 字符；` +
      `usage=${JSON.stringify(res?.usage)}`,
      `失败：err=${err && err.message} res.error=${res?.error} proposals=${(res?.proposals || []).length}`)

    // prompt 组装是否正确传给 llm
    if (llm._lastOpts) {
      const o = llm._lastOpts
      assertCase('④-2 传给 llm 的请求结构完整（system + messages + model）',
        !!o.system && Array.isArray(o.messages) && o.messages.length === 1 && !!o.model,
        `system ${(o.system || '').length} 字、messages 1 条、model=${o.model}`,
        `请求结构缺失：${JSON.stringify({ hasSystem: !!o.system, msgs: o.messages?.length, model: o.model })}`)
      assertCase('④-2b system prompt 里含"不许编造数字"这类硬约束',
        /编造|不得虚构|数字|找不到/.test(o.system || ''),
        'system prompt 明确约束了数字来源',
        'system prompt 未提及数字/编造约束 —— 与 parseProposals 的校验不匹配')
    }
  }

  // ── 4b：forged —— 编造数字，必须被拦 ──
  {
    const forgedEntry = {
      title: '中断内禁止调用阻塞日志',
      claim: `该会话共 500 次工具调用、99 个交付物，说明 ISR 问题极其严重。`,
      why: '排查很久。',
      confidence: 'high',
      tags: [],
    }
    const llm = mockLlm(JSON.stringify({ entries: [forgedEntry] }))
    let res = null, err = null
    try { res = await distill.distillBatch([session], { llm, maxSessionsPerCall: 1 }) }
    catch (e) { err = e }

    // 【2026-11-09】整批拒绝 → 单条淘汰：这里要看的是"编造那条没进 proposals"，
    // 而不是"整批报错"。dropped 里必须点名 500。
    const droppedText = JSON.stringify(res?.dropped || [])
    assertCase('④-3 forged：编造数字被端到端丢掉（不进 proposals，进 dropped）',
      !err && res && (res.proposals || []).length === 0 && /500/.test(droppedText),
      `丢掉了：dropped=${droppedText.slice(0, 100)}`,
      `**漏了**：产出 ${(res?.proposals || []).length} 条，error=${res?.error} dropped=${droppedText}`)
  }

  // ── 4c：offTopic —— 散文，必须被拒 ──
  {
    const llm = mockLlm('这个会话很有意思，主要讲了中断里不要做耗时操作。我就说到这里。')
    let res = null, err = null
    try { res = await distill.distillBatch([session], { llm, maxSessionsPerCall: 1 }) }
    catch (e) { err = e }
    assertCase('④-4 offTopic：散文返回被端到端拒绝',
      !err && res && (res.proposals || []).length === 0,
      `拒绝了：error="${String(res?.error).slice(0, 70)}"`,
      `散文被当条目接受：${(res?.proposals || []).length} 条`)
  }

  // ── 4d：llm 抛错 → 返回 error 而不是崩溃 ──
  {
    const badLlm = { stream() { throw new Error('模拟 provider 500') } }
    let res = null, err = null
    try { res = await distill.distillBatch([session], { llm: badLlm, maxSessionsPerCall: 1 }) }
    catch (e) { err = e }
    assertCase('④-5 llm 抛错时返回 error 对象而非崩溃',
      !err && res && !!res.error,
      `返回 error="${String(res?.error).slice(0, 70)}"`,
      `llm 抛错导致 distillBatch 整体抛出：${err && err.message}（上层批量处理会被打断）`)
  }

  // ── 4e：没传 llm → 明确报错 ──
  {
    let res = null, err = null
    try { res = await distill.distillBatch([session], {}) } catch (e) { err = e }
    assertCase('④-6 未传 llm 时返回明确错误（不静默）',
      !err && res && !!res.error && /llm/i.test(res.error),
      `返回 error="${String(res?.error).slice(0, 70)}"`,
      `未明确报错：err=${err && err.message} res=${JSON.stringify(res)?.slice(0, 120)}`)
  }

  // ── 4f：批次上限一致性（关键：会静默丢会话）──
  // 实测缺陷：pipeline.makeBatches 默认每批最多 3 个，而 distill.distillBatch 的
  // maxSessionsPerCall 默认只有 2，内部 `sessions.slice(0, perCall)` 只拼前 2 个。
  // 结果：每批第 3 个会话被**静默丢弃** —— 不报错、不计 failures、不会重试。
  {
    const plMod = await load(P.pipeline)
    const fake = corpus.sessions.filter((s) => s.category === 'real').slice(0, 6)
    // 【2026-11-08 修】原来 makeBatches 缺失时伪造 [[fake[0]]]、perCall 缺失时为 null，
    // 两者都让下面的 if 为假 → 走恒真 else 分支。缺 API / 缺默认值也能拿绿。
    assertCase('④-8a 前置：pipeline 暴露 makeBatches',
      typeof plMod?.makeBatches === 'function',
      'makeBatches 可用',
      'pipeline 没有导出 makeBatches —— 批次上限这条根本无法验证')
    const batches = typeof plMod?.makeBatches === 'function' ? plMod.makeBatches(fake, {}) : []
    const maxBatch = batches.length ? Math.max(...batches.map((b) => b.length)) : 0
    const perCall = distill.DISTILL_DEFAULTS?.maxSessionsPerCall ?? null
    assertCase('④-8b 前置：distill 有 maxSessionsPerCall 默认值',
      Number.isFinite(perCall),
      `perCall=${perCall}`,
      '拿不到 distillBatch 的单次上限，无法判断会不会丢会话')
    assertCase('④-8c 分批不丢会话（批内会话总数 = 输入数）',
      batches.flat().length === fake.length,
      `${batches.flat().length}/${fake.length} 个会话都在批里`,
      `分批时丢了 ${fake.length - batches.flat().length} 个会话`)

    record('④-7 批次上限对比（事实）', 'INFO',
      `makeBatches 默认每批最多 ${maxBatch} 个；distillBatch 的 maxSessionsPerCall 默认 ${perCall}`)

    // 真·判据：编排层每批不得超过 distillBatch 的单次上限，否则后者内部 slice 会静默丢会话
    let lost = 0
    if (Number.isFinite(perCall) && maxBatch > perCall) {
      const llm = mockLlm('{"entries":[]}')
      const perLen = distill.renderSessionDigest(fake[0], {}).length || 1
      for (const b of batches) {
        if (b.length <= perCall) continue
        const r = await distill.distillBatch(b, { llm })
        const approx = Math.round((r.usage?.inputChars || 0) / perLen)
        lost += Math.max(0, b.length - approx)
      }
    }
    assertCase('④-8 编排层批大小 ≤ distillBatch 单次上限（否则静默丢会话）',
      !(Number.isFinite(perCall) && maxBatch > perCall),
      `每批 ${maxBatch} ≤ 上限 ${perCall}，无静默丢失`,
      `**每批 ${maxBatch} 个 > 单次上限 ${perCall} 个** → 实测静默丢 ${lost} 个会话。` +
      `distillBatch 内 \`sessions.slice(0, perCall)\` 丢弃的会话不报错、不进 failures、不会重试。`)
  }
}

// ─────────────────────────── 主流程 ───────────────────────────
async function main() {
  const argv = process.argv.slice(2)
  const onlyArg = argv.find((a) => a.startsWith('--only='))
  const only = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()) : null
  const want = (k) => !only || only.includes(k)
  const sampleN = Number((argv.find((a) => a.startsWith('--samples=')) || '--samples=10').slice(10))
  const saveSamples = argv.includes('--save-samples')

  const t0 = Date.now()
  console.log('══════════════════════════════════════════════════════════════')
  console.log('LLM 提炼轨验收 — 压缩 / 防幻觉 / 失败隔离')
  console.log('══════════════════════════════════════════════════════════════')
  console.log(`插件：${PLUGIN}`)
  console.log(`真实书库（绝不触碰）：${REAL_LIBRARY_ROOT}`)
  for (const [k, p] of Object.entries(P)) {
    console.log(`  ${k.padEnd(9)} ${fs.existsSync(p) ? fs.statSync(p).size + ' 字节' : '缺失'}`)
  }
  console.log('')

  let corpus = { ok: false }
  try {
    corpus = await loadCorpus()
    if (corpus.ok) console.log(`语料：${corpus.sessions.length} 个会话（real ${corpus.counts?.real ?? '?'}）\n`)
    else console.log(`语料不可用：${corpus.why}\n`)
  } catch (e) {
    console.log(`语料加载失败：${e.message}\n`)
  }

  if (want('digest') && corpus.ok) await suiteDigest(corpus, sampleN, saveSamples)
  if (want('parse')) await suiteParse(corpus.ok ? corpus : { sessions: [] })
  if (want('pipeline') && corpus.ok) await suitePipeline(corpus)
  if (want('real')) await suiteEndToEnd(corpus.ok ? corpus : { sessions: [] })

  console.log('')
  console.log('══════════════════════════════════════════════════════════════')
  console.log('汇总')
  console.log('══════════════════════════════════════════════════════════════')
  let P_ = 0, F_ = 0, S_ = 0, I_ = 0
  const fails = []
  for (const s of RESULTS) {
    const p = s.cases.filter((c) => c.status === 'PASS').length
    const f = s.cases.filter((c) => c.status === 'FAIL').length
    const k = s.cases.filter((c) => c.status === 'SKIP').length
    const i = s.cases.filter((c) => c.status === 'INFO').length
    P_ += p; F_ += f; S_ += k; I_ += i
    console.log(`${f > 0 ? '✗' : k === s.cases.length ? '○' : '✓'} ${s.name}`)
    console.log(`    ${p} 通过 / ${f} 失败 / ${k} 跳过${i ? ` / ${i} 事实记录` : ''}`)
    for (const c of s.cases.filter((x) => x.status === 'FAIL')) {
      fails.push({ suite: s.name, ...c })
      console.log(`    ✗ ${c.name}`)
      console.log(`        ${c.detail}`)
    }
  }
  console.log('')
  console.log(`总计：${P_} 通过 / ${F_} 失败 / ${S_} 跳过${I_ ? ` / ${I_} 事实记录（不计入通过）` : ''} · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (fails.length) {
    console.log('')
    console.log('── 失败清单 ──')
    fails.forEach((f, i) => console.log(`${i + 1}. [${f.suite}] ${f.name}\n   ${f.detail}`))
  }
  cleanup()
  process.exit(F_ > 0 ? 1 : 0)
}

main().catch((e) => { console.error('验收脚本自身崩溃：', e); cleanup(); process.exit(2) })
