/**
 * 书阁 · 启动自愈：诊断 + 安全修复
 *
 * 职责边界（第一性判断）：
 *   · 这里是**只读诊断器 + 极保守的清理器**，不是修复器。
 *   · 它能证明"库不一致"，但**不能证明"哪一边是对的"** ——
 *     所以绝不自己重建 library.json，绝不删任何条目。
 *   · 唯一允许删除的是**过期的临时残留**（.staging-* / .tmp-*），
 *     且必须同时满足：在库根目录下、是目录/文件本身、年龄超过 1 小时。
 *
 * 为什么默认 dryRun：一个"发现问题就自动修"的库，坏掉时会把好数据一起修没。
 * 删除必须由调用方显式说 `dryRun: false`。
 */

import {
  readFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  statSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { isMarkdownLibrary, markdownHealth } from './markdown-library.js'

/** 临时残留必须比这个年龄更老才会被清理 —— 防误删正在写入的 staging。 */
export const STAGING_MIN_AGE_MS = 60 * 60 * 1000

/** 条目 JSON 抽样解析上限。全量解析在万条级别会拖慢启动。 */
export const MAX_ENTRY_PARSE_SAMPLES = 50

/** runs/ 报告扫描上限，防止异常目录拖死启动。 */
const MAX_RUN_REPORTS = 2000

/** 单类问题最多展开多少条 detail（避免刷屏日志）。 */
const MAX_ISSUES_PER_CODE = 20

/**
 * 内容损毁判定：连续 N 个问号，或问号占比超过 RATIO。
 *
 * 为什么需要这条：编码损坏后正文会变成 `???`，而 `"???"` 是**完全合法的 JSON 字符串**，
 * 语法检查、JSON.parse、字段存在性检查全部通过 —— 数据看着"完好"，实际已经是空壳。
 * 这是唯一能被自动识别出来的"看起来有、其实没有"。
 *
 * 取值依据（2026-11-02 实测本机 217 条）：真损坏的 7 条问号占比 ≥ 34%，
 * 正常中文/英文条目最高不到 5%（`?` 只在疑问句尾出现）。阈值取 30% 留足余量。
 */
const DAMAGE_RUN_QUESTION = 3
const DAMAGE_RATIO = 0.3

/** 内容损毁判定的最小文本长度：太短的字符串算占比没有意义。 */
const DAMAGE_MIN_LEN = 8

/** 临时残留的命名约定。 */
const TEMP_PREFIXES = ['.staging-', '.tmp-']

/** 问题码 → 人话。集中一处，便于 UI / 日志复用。 */
export const ISSUE_TEXT = {
  'root-missing': '库根目录不存在',
  'library-missing': 'library.json 不存在',
  'library-unparsable': 'library.json 无法解析（可能被截断）',
  'library-shape': 'library.json 结构异常（缺 volumes/counts）',
  'entries-dir-missing': 'entries/ 目录不存在',
  'entry-count-mismatch-missing': '声明的条目数大于磁盘上的文件数（有文件丢失）',
  'entry-count-mismatch-extra': '磁盘上的条目文件多于声明数（有孤儿文件）',
  'entry-unparsable': '条目 JSON 无法解析',
  'entry-not-in-catalog': '条目在磁盘上但不在任何册的目录里（翻不到、查不到）',
  'entry-content-damaged': '条目正文疑似编码损坏（大段问号替身，内容已丢失）',
  'volume-manual-missing': '分册缺少 MANUAL.md',
  'volume-toc-missing': '分册缺少 TOC.md',
  'staging-residue': '存在临时残留目录（进程可能被中断）',
  'runs-failed': 'runs/ 中有失败报告',
  'health-check-failed': '健康检查自身失败',
}

/** 建一条 issue。detail 必须是可核对的事实，不是推测。 */
function issue(code, severity, detail, fixable = false) {
  return { code, severity, detail, fixable }
}

/** 安全读目录；不存在或不是目录一律返回 []。 */
function listDir(path) {
  try {
    if (!existsSync(path)) return []
    const info = statSync(path)
    if (!info.isDirectory()) return []
    return readdirSync(path)
  } catch {
    return []
  }
}

/** 只统计直接子目录（不跟随符号链接）。 */
function countSubdirs(path) {
  let count = 0
  for (const name of listDir(path)) {
    try {
      const full = join(path, name)
      const info = lstatSync(full)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) count += 1
    } catch {
      // 单条目读不到不影响整体计数
    }
  }
  return count
}

/** 从 library.json 里取"声明了多少条目"。多口径兜底，取不到返回 0。 */
function declaredEntryCount(library) {
  if (!library || typeof library !== 'object') return 0
  const counts = library.counts
  if (counts && Number.isFinite(counts.entries)) return counts.entries
  if (Number.isFinite(library.entries)) return library.entries
  // 最后兜底：各册 entries 求和
  const volumes = Array.isArray(library.volumes) ? library.volumes : []
  let sum = 0
  for (const v of volumes) {
    if (v && Number.isFinite(v.entries)) sum += v.entries
  }
  return sum
}

/**
 * 从 library.json 收集"目录里可见"的条目 id 集合。
 *
 * 为什么必须做这件事：`counts.entries` 只是磁盘文件数的投影，
 * 而**检索（manual_recall）和阅读（manual_read）两条路径都只走 chapterList**。
 * 所以"文件在 + 计数对"完全不代表"Agent 能查到" —— 这两件事必须分开验证。
 *
 * 返回 null 表示**这个库没有可供判断的目录结构**（老版本/测试夹具）。
 * 此时调用方必须跳过判定，否则会对一个根本没有目录概念的库误报满屏孤儿。
 *
 * @param {object} library
 * @returns {Set<string>|null}
 */
function catalogEntryIds(library) {
  const volumes = Array.isArray(library?.volumes) ? library.volumes : []
  let sawCatalog = false
  const ids = new Set()
  for (const v of volumes) {
    if (!v || !Array.isArray(v.chapterList)) continue
    sawCatalog = true
    for (const c of v.chapterList) {
      for (const e of Array.isArray(c?.entries) ? c.entries : []) {
        if (e && e.id != null) ids.add(String(e.id))
      }
    }
  }
  return sawCatalog ? ids : null
}

/**
 * 判断一条条目的正文是否已被编码损坏（变成了问号替身）。
 *
 * 只看 title + claim：这两个字段是 Agent 检索与阅读时实际读到的内容，
 * 其他字段损坏不影响可用性，不值得刷一条 issue。
 *
 * @param {object} e 条目对象
 * @returns {boolean}
 */
function looksDamaged(e) {
  const text = `${e?.title || ''} ${e?.claim || ''}`.trim()
  if (text.length < DAMAGE_MIN_LEN) return false
  const run = new RegExp(`\\?{${DAMAGE_RUN_QUESTION},}`).test(text)
  const ratio = (text.match(/\?/g) || []).length / text.length
  return run || ratio > DAMAGE_RATIO
}

/** 数 runs/ 里 status=failed 的报告。解析不了的文件跳过（那是另一种问题，不在这里报）。 */
function countFailedRuns(root) {
  const runsDir = join(root, 'runs')
  const files = listDir(runsDir).filter((f) => f.endsWith('.json')).slice(0, MAX_RUN_REPORTS)
  let failed = 0
  for (const f of files) {
    try {
      const report = JSON.parse(readFileSync(join(runsDir, f), 'utf8'))
      if (report && (report.status === 'failed' || report.ok === false)) failed += 1
    } catch {
      // 坏报告不算 failed，它属于解析问题
    }
  }
  return failed
}

/** 找出根目录下的临时残留（只认直接子项，不下钻）。 */
export function findTempResidue(root) {
  const found = []
  for (const name of listDir(root)) {
    const matched = TEMP_PREFIXES.some((p) => name.startsWith(p))
    if (!matched) continue
    const full = join(root, name)
    try {
      const info = lstatSync(full)
      found.push({
        name,
        path: full,
        isDirectory: info.isDirectory(),
        isSymbolicLink: info.isSymbolicLink(),
        mtimeMs: info.mtimeMs,
        ageMs: Date.now() - info.mtimeMs,
      })
    } catch {
      // 读不到就跳过，不猜
    }
  }
  return found
}

/**
 * 只诊断，不改任何文件。
 *
 * @param {string} root 库根目录
 * @returns {{
 *   ok: boolean,
 *   level: 'healthy'|'warn'|'broken',
 *   issues: {code:string, severity:'warn'|'error', detail:string, fixable:boolean}[],
 *   facts: {
 *     libraryJsonExists:boolean, libraryJsonParsable:boolean,
 *     declaredEntries:number, actualEntryFiles:number, volumesOnDisk:number,
 *     stagingDirs:string[], orphanRuns:number
 *   }
 * }}
 */
export function checkLibraryHealth(root) {
  // 2026-11-12：Markdown 真相层与旧 JSON 库的体检判据完全不同。
  // 在这里分流，调用方（启动自愈、/summary、UI）无需知道存储格式。
  try {
    if (isMarkdownLibrary(root)) return markdownHealth(root)
  } catch {
    // 判定失败就落回旧 JSON 体检：宁可报"库坏了"，也不让启动路径抛错。
  }
  const facts = {
    libraryJsonExists: false,
    libraryJsonParsable: false,
    declaredEntries: 0,
    actualEntryFiles: 0,
    /** 不在任何册目录里、因此翻不到也查不到的条目数（"看不见的损失"） */
    uncatalogedEntries: 0,
    /** 正文疑似编码损坏的条目数（"看得见但其实没有内容"） */
    damagedEntries: 0,
    /** 已主动退役的条目数（骨架退役；不在目录里是设计如此，不算损失） */
    retiredEntries: 0,
    volumesOnDisk: 0,
    stagingDirs: [],
    orphanRuns: 0,
  }
  const issues = []

  try {
    if (!root || !existsSync(root)) {
      issues.push(issue('root-missing', 'error', `库根目录不存在：${root || '(空)'}`))
      return finish(facts, issues)
    }

    // ── ① library.json：存在 + 可解析 + 结构像个总账 ──
    const libraryPath = join(root, 'library.json')
    facts.libraryJsonExists = existsSync(libraryPath)
    let library = null
    if (!facts.libraryJsonExists) {
      issues.push(
        issue('library-missing', 'error', `找不到 ${libraryPath}`, false)
      )
    } else {
      try {
        library = JSON.parse(readFileSync(libraryPath, 'utf8'))
        facts.libraryJsonParsable = library !== null && typeof library === 'object'
        if (!facts.libraryJsonParsable) {
          issues.push(issue('library-unparsable', 'error', 'library.json 解析结果不是对象'))
        } else {
          const hasVolumes = Array.isArray(library.volumes)
          const hasCounts = library.counts && typeof library.counts === 'object'
          if (!hasVolumes && !hasCounts) {
            issues.push(
              issue(
                'library-shape',
                'error',
                'library.json 既没有 volumes 数组也没有 counts 对象'
              )
            )
          }
        }
      } catch (e) {
        facts.libraryJsonParsable = false
        issues.push(
          issue(
            'library-unparsable',
            'error',
            `解析失败：${e?.message || String(e)}`
          )
        )
      }
    }

    if (facts.libraryJsonParsable && library) {
      facts.declaredEntries = declaredEntryCount(library)
    }

    // ── ② entries/：文件数 + 抽样解析（这是最核心的一致性判据）──
    const entriesDir = join(root, 'entries')
    const entryFiles = listDir(entriesDir).filter((f) => f.endsWith('.json'))
    facts.actualEntryFiles = entryFiles.length

    if (facts.declaredEntries > 0 && !existsSync(entriesDir)) {
      issues.push(
        issue(
          'entries-dir-missing',
          'error',
          `声明 ${facts.declaredEntries} 条，但 entries/ 目录整个不存在`
        )
      )
    } else if (
      facts.libraryJsonParsable &&
      facts.declaredEntries !== facts.actualEntryFiles
    ) {
      const diff = facts.declaredEntries - facts.actualEntryFiles
      if (diff > 0) {
        issues.push(
          issue(
            'entry-count-mismatch-missing',
            'error',
            `library.json 声明 ${facts.declaredEntries} 条，磁盘只有 ${facts.actualEntryFiles} 个文件，缺 ${diff} 个`
          )
        )
      } else {
        issues.push(
          issue(
            'entry-count-mismatch-extra',
            'warn',
            `library.json 声明 ${facts.declaredEntries} 条，磁盘有 ${facts.actualEntryFiles} 个文件，多出 ${-diff} 个孤儿文件`
          )
        )
      }
    }

    // 抽样解析：取文件名排序后前 N 个，结果可复现
    const samples = entryFiles.slice().sort().slice(0, MAX_ENTRY_PARSE_SAMPLES)
    let unparsable = 0
    const badNames = []
    for (const name of samples) {
      try {
        JSON.parse(readFileSync(join(entriesDir, name), 'utf8'))
      } catch {
        unparsable += 1
        if (badNames.length < MAX_ISSUES_PER_CODE) badNames.push(name)
      }
    }
    if (unparsable > 0) {
      issues.push(
        issue(
          'entry-unparsable',
          'error',
          `${unparsable}/${samples.length} 个抽样条目无法解析：${badNames.join('、')}`
        )
      )
    }

    // ── ③-b 交叉一致性：文件在不在盘上 ≠ Agent 能不能翻到 ──
    //
    // 【为什么必须有这一段】2026-11-02 实测事故：7 条条目文件真实存在、
    // 也被计入 counts.entries=217，但不在任何册的 chapterList 里。结果：
    //   · 目录注入显示"已入册 217 条"，Agent 实际只能翻到 210 条
    //   · manual_recall 检索不到，会如实回答"手册无记录"——**把"坏了"说成"真没有"**
    //   · 而 health 只比 declared==actual（217==217），两处都对 → 报 healthy
    // 这个漏报比丢内容本身更危险：它让"我到底丢了多少"无从判断。
    //
    // 所以这里补两条独立判定，且**只报 warn**：
    // 丢失可以接受（手册是摘录，不是归档），但必须标出来，不能假装完好。
    const catalog = facts.libraryJsonParsable ? catalogEntryIds(library) : null
    if (catalog) {
      const uncataloged = []
      const damaged = []
      let retired = 0
      for (const name of entryFiles.slice().sort()) {
        const id = name.slice(0, -5)
        let parsed = null
        try {
          parsed = JSON.parse(readFileSync(join(entriesDir, name), 'utf8'))
        } catch {
          parsed = null // 解析失败已由上面 ② 报过，这里不重复计
        }
        // 【2026-11-03 骨架退役】expired 是**主动退役**，不是丢失。
        // 它不在目录里是设计如此，不能和"意外翻不到"混为一谈 ——
        // 混在一起会让体检天天误报，最后没人再看它。
        const isRetired = parsed && parsed.status === 'expired'
        if (isRetired) {
          retired += 1
        } else if (!catalog.has(id)) {
          if (uncataloged.length < MAX_ISSUES_PER_CODE) uncataloged.push(id)
        }
        if (parsed && looksDamaged(parsed)) {
          if (damaged.length < MAX_ISSUES_PER_CODE) damaged.push(id)
        }
      }
      facts.uncatalogedEntries = uncataloged.length
      facts.damagedEntries = damaged.length
      facts.retiredEntries = retired

      if (facts.uncatalogedEntries > 0) {
        issues.push(
          issue(
            'entry-not-in-catalog',
            'warn',
            `${facts.uncatalogedEntries}/${entryFiles.length} 条条目不在任何册的目录里：` +
              `文件在、计数也算，但目录翻不到、manual_recall 查不到。` +
              `共 ${catalog.size} 条可见，${facts.uncatalogedEntries} 条不可见` +
              `（${uncataloged.join('、')}）。需人工决定归册或隔离，本检查不自动处理`
          )
        )
      }
      if (facts.damagedEntries > 0) {
        issues.push(
          issue(
            'entry-content-damaged',
            'warn',
            `${facts.damagedEntries} 条条目正文疑似编码损坏（成片问号，内容已丢失）：` +
              `${damaged.join('、')}。JSON 合法、字段齐全，语法检查查不出，需人工确认`
          )
        )
      }
    } else {
      // 目录结构不可判断（老库/测试夹具没有 chapterList）—— 明确跳过，不猜
      facts.uncatalogedEntries = null
      facts.damagedEntries = null
      facts.retiredEntries = null
    }

    // ── ③ volumes/：每册要有 MANUAL.md + TOC.md ──
    const volumesDir = join(root, 'volumes')
    facts.volumesOnDisk = countSubdirs(volumesDir)
    const missingManual = []
    const missingToc = []
    for (const name of listDir(volumesDir)) {
      let isDir = false
      try {
        const info = lstatSync(join(volumesDir, name))
        isDir = info.isDirectory() && !info.isSymbolicLink()
      } catch {
        isDir = false
      }
      if (!isDir) continue
      if (!existsSync(join(volumesDir, name, 'MANUAL.md'))) {
        if (missingManual.length < MAX_ISSUES_PER_CODE) missingManual.push(name)
      }
      if (!existsSync(join(volumesDir, name, 'TOC.md'))) {
        if (missingToc.length < MAX_ISSUES_PER_CODE) missingToc.push(name)
      }
    }
    if (missingManual.length > 0) {
      issues.push(
        issue(
          'volume-manual-missing',
          'warn',
          `${missingManual.length} 册缺 MANUAL.md：${missingManual.join('、')}`
        )
      )
    }
    if (missingToc.length > 0) {
      issues.push(
        issue(
          'volume-toc-missing',
          'warn',
          `${missingToc.length} 册缺 TOC.md：${missingToc.join('、')}`
        )
      )
    }

    // ── ④ 临时残留（可修：只清过期的）──
    const residue = findTempResidue(root)
    facts.stagingDirs = residue.map((r) => r.name)
    if (residue.length > 0) {
      const stale = residue.filter((r) => r.ageMs >= STAGING_MIN_AGE_MS)
      const fresh = residue.length - stale.length
      issues.push(
        issue(
          'staging-residue',
          'warn',
          `${residue.length} 个临时残留（${stale.length} 个已超过 1 小时可清理，${fresh} 个正在写不动它）：${facts.stagingDirs.join('、')}`,
          stale.length > 0
        )
      )
    }

    // ── ⑤ runs/ 失败报告 ──
    facts.orphanRuns = countFailedRuns(root)
    if (facts.orphanRuns > 0) {
      issues.push(
        issue(
          'runs-failed',
          'warn',
          `runs/ 中有 ${facts.orphanRuns} 份 status=failed 的报告（需人工看，不自动处理）`
        )
      )
    }

    return finish(facts, issues)
  } catch (e) {
    // 诊断器自己出错时也要给出可用的返回，不能让启动路径炸掉
    issues.push(
      issue('health-check-failed', 'error', `健康检查异常：${e?.message || String(e)}`)
    )
    return finish(facts, issues)
  }
}

/** 汇总成最终结果。level 由最严重的问题决定。 */
function finish(facts, issues) {
  let level = 'healthy'
  if (issues.some((i) => i.severity === 'error')) level = 'broken'
  else if (issues.length > 0) level = 'warn'
  return {
    // ok = "没有 error"。warn 仍算 ok —— 它可跑，只是不干净。
    ok: level !== 'broken',
    level,
    issues,
    facts,
  }
}

/**
 * 这个目录到底是不是一个书库？
 *
 * 区分两种"缺 library.json"：
 *   · 有 entries/ 或 volumes/  → 是**损坏的库**，值得建议 rebuild
 *   · 三者都没有             → **根本不是库**，直接拒绝，别给 rebuild 建议
 *
 * 后者很重要：如果 root 被误指到任意空目录，返回 rebuild 会诱导调用方
 * 在那儿建出一个空库，而用户真正的库还在别处、毫发无损却看不见了。
 */
function looksLikeLibrary(root) {
  for (const marker of ['library.json', 'entries', 'volumes']) {
    if (existsSync(join(root, marker))) return true
  }
  return false
}

/**
 * 安全自愈。**默认 dryRun**，只有显式 `{dryRun:false}` 才动文件。
 *
 * 会做的：
 *   · 清理超过 1 小时的 .staging-* / .tmp-*（库根目录的直接子项）
 *
 * 不会做的（红线，永不自动执行）：
 *   · 删除 entries/ 下任何条目（孤儿文件只报告）
 *   · 删除 volumes/ 下任何分册
 *   · 删除 runs/ 下任何报告
 *   · 重建 / 覆盖 library.json（只返回 advice: 'rebuild'）
 *
 * @param {string} root 库根目录
 * @param {{dryRun?: boolean}} [opts]
 */
export function healLibrary(root, opts = {}) {
  // 默认只报告；只有字面 false 才真删
  const dryRun = opts.dryRun !== false

  const before = checkLibraryHealth(root)
  const removed = []
  const wouldRemove = []
  const kept = []
  const advice = []
  let action = 'none'

  // ── ① 先判断这是不是书库：不是就一律不动手，也不给 rebuild 建议 ──
  // 顺序不能反：若先判 library-missing，随便一个空目录都会拿到 rebuild 建议，
  // 诱导调用方在错误路径建空库，而用户真正的库还在别处却看不见。
  if (!root || !existsSync(root) || !looksLikeLibrary(root)) {
    advice.push('库根目录不存在或不像书库（无 library.json / entries / volumes），未做任何操作。')
    return { ok: false, dryRun, action, removed, wouldRemove, kept, advice, before, after: before }
  }

  // ── ② library.json 缺失/损坏 → 只建议 rebuild，绝不自己写 ──
  const needsRebuild = before.issues.some(
    (i) => i.code === 'library-missing' || i.code === 'library-unparsable' || i.code === 'library-shape'
  )
  if (needsRebuild) {
    action = 'rebuild'
    advice.push('library.json 缺失或损坏：需跑一次完整建库重建总账，本函数不代劳。')
    return {
      ok: false,
      dryRun,
      action,
      removed,
      wouldRemove,
      kept,
      advice,
      before,
      after: before,
    }
  }

  // ── ③ 只清理过期临时残留 ──
  for (const item of findTempResidue(root)) {
    // 符号链接一律不碰：它可能指向库外
    if (item.isSymbolicLink) {
      kept.push({ name: item.name, reason: '符号链接，不清理' })
      continue
    }
    if (item.ageMs < STAGING_MIN_AGE_MS) {
      kept.push({ name: item.name, reason: `未满 1 小时（${Math.round(item.ageMs / 60000)} 分钟），可能正在写` })
      continue
    }
    if (dryRun) {
      wouldRemove.push(item.name)
      continue
    }
    try {
      rmSync(item.path, { recursive: true, force: false })
      removed.push(item.name)
    } catch (e) {
      kept.push({ name: item.name, reason: `删除失败：${e?.message || String(e)}` })
    }
  }

  if (removed.length > 0) action = 'cleanup'
  else if (wouldRemove.length > 0 && dryRun) action = 'cleanup'

  // ── ④ 只报告、不处理的问题，明确写进 advice ──
  for (const i of before.issues) {
    if (i.code === 'entry-count-mismatch-extra' || i.code === 'entry-count-mismatch-missing') {
      advice.push(`${ISSUE_TEXT[i.code]}：${i.detail} —— 条目永不自动删除，请人工核对。`)
    } else if (i.code === 'entry-unparsable') {
      advice.push(`坏条目：${i.detail} —— 不自动删除，需人工确认。`)
    } else if (i.code === 'runs-failed') {
      advice.push(`失败报告：${i.detail}`)
    }
  }

  const after = dryRun ? null : checkLibraryHealth(root)
  return {
    ok: after ? after.level !== 'broken' : before.level !== 'broken',
    dryRun,
    action,
    removed,
    wouldRemove,
    kept,
    advice,
    before,
    after,
  }
}
