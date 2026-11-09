#!/usr/bin/env node
/**
 * 「先翻阅」人工验收台架（2026-11-07 新增）。
 *
 * ## 为什么需要它
 *
 * 项目里唯一"没有它就等于没做成"的判据是 S2：
 * **Agent 拿到目录后，问手册里记过的事，它会先翻正文；问没有的，它明说"手册无记录"。**
 * 这一条没法用单元测试证明 —— 它需要真的有一个 Agent 在跑。但可以先把
 * "Agent 第一轮到底会看到什么"原样打印出来，人一眼就能判断：
 *
 *   · 目录（L1）是否读得懂、有没有把章藏起来
 *   · 首轮预取（L2）对这句问话会不会注入、注入哪几条
 *   · 检索（L3）对同一个问题的命中
 *
 * 这样就不用为了"看一眼"而重启宿主、重开会话。
 *
 * ## 用法
 *
 * ```bash
 * # 看某句问话会触发什么（L2 + L3）
 * node scripts/verify-prefetch.mjs "上次那个插件是怎么装的"
 *
 * # 只看常驻目录（Agent 每一轮都能看到的那段）
 * node scripts/verify-prefetch.mjs --catalog
 *
 * # 拿一组问话批量体检
 * node scripts/verify-prefetch.mjs --suite
 *
 * # 不想临时建库就用现成的（默认在临时目录建，跑完删掉）
 * DSH_MANUSCRIPT_ROOT=~/.dsh/dsh-manuscript node scripts/verify-prefetch.mjs "…"
 * ```
 *
 * 退出码：0 = 体检完成（无论是否命中）；2 = 用法错误。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanSessions } from '../lib/scan.js'
import { triageAll } from '../lib/triage.js'
import { buildLibrary, toSummary } from '../lib/library.js'
import { renderCatalogSection, matchEntries, buildPrefetchDecision } from '../lib/index.js'

const args = process.argv.slice(2)
const wantCatalog = args.includes('--catalog')
const wantSuite = args.includes('--suite')
const question = args.find((a) => !a.startsWith('--'))

if (!question && !wantCatalog && !wantSuite) {
  console.error('用法：node scripts/verify-prefetch.mjs "<你的第一句话>" | --catalog | --suite')
  process.exit(2)
}

const ownRoot = !process.env.DSH_MANUSCRIPT_ROOT
const root = process.env.DSH_MANUSCRIPT_ROOT || mkdtempSync(join(tmpdir(), 'ms-verify-'))

function buildSnapshot() {
  const scanned = scanSessions()
  if (scanned.sessions.length === 0) {
    console.error(`没扫到会话（${scanned.root}）—— 先随便用 DSH 跑一次，或用 DSH_SESSIONS_ROOT 指到真实会话库`)
    process.exit(2)
  }
  const triaged = triageAll(scanned.sessions)
  const built = buildLibrary(triaged.enriched, { root })
  return {
    snapshot: {
      summary: toSummary(built.library),
      library: built.library,
      sessions: triaged.enriched,
      root,
      scanErrors: scanned.errors,
      at: Date.now(),
    },
    scanned,
  }
}

const { snapshot, scanned } = buildSnapshot()

console.log(`# 语料：${scanned.sessions.length} 个会话（解析错误 ${scanned.errors.length}）· 书库 ${root}`)
console.log(`# 条目：${snapshot.summary.entries} 条 · 册：${snapshot.summary.volumes.filter((v) => v.entries > 0).length}`)
console.log('')

/** 把「用户第一句话」包成 buildPrefetchDecision 需要的消息形态。 */
function prefetchFor(text) {
  return buildPrefetchDecision({
    turn: 1,
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    seen: new Set(),
    agentId: 'verify-phantom-agent',
    snapshot,
  })
}

function reportOne(text) {
  console.log('═'.repeat(72))
  console.log(`问：${text}`)
  console.log('')

  const hits = matchEntries(snapshot, text, 8)
  console.log(`L3 检索（manual_recall 会返回的）：${hits.length} 条`)
  for (const [i, h] of hits.entries()) {
    console.log(`  ${i + 1}. [${h.score}分] ${h.volumeName} / ${h.chapterTitle} — ${h.title}`)
  }
  if (hits.length === 0) console.log('  （0 命中 → Agent 应回答「手册无记录」，这是 fail-closed 的正确行为）')

  console.log('')
  const d = prefetchFor(text)
  if (d.injected) {
    console.log('L2 首轮预取：会注入，注入内容如下（这就是 Agent 第一轮额外看到的东西）')
    console.log('─'.repeat(72))
    console.log(d.injected.content[0].text)
    console.log('─'.repeat(72))
  } else {
    console.log('L2 首轮预取：不注入（turn≠1 / 已注入过 / 本句没有足够命中）')
  }
  if (d.injected && hits.length === 0) {
    console.log('')
    console.log('注：L3 是"整句查询"，L2 在整句查不到时会按虚词切段重试（"上次那个插件是怎么装的" → "插件"），')
    console.log('    所以两者条数可以不一致。这是刻意的：整句门槛高、切段兜底宽，两条路互补。')
  }
  console.log('')
}

if (wantCatalog) {
  const cat = renderCatalogSection(snapshot)
  const text = typeof cat.text === 'function' ? cat.text() : cat.text
  console.log('═'.repeat(72))
  console.log('L1 常驻目录（Agent 每一轮都能看到这段，硬上限 200 行 / 25 KB）')
  console.log('═'.repeat(72))
  console.log(text)
  console.log('═'.repeat(72))
  console.log(`体积：${cat.lines} 行 / ${cat.bytes} 字节 · overflow=${cat.overflow}`)
  console.log('')
}

if (wantSuite) {
  // 固定的体检串：两句"手册里应该有"、两句"应该没有"。
  // 前两句若 0 命中，说明检索或语料有问题；后两句若命中，说明 fail-closed 破了。
  const suite = [
    ['插件 安装', true],
    ['模型 部署', true],
    ['HardFault 排查', true],
    ['zzz绝不可能命中的查询字符串qqq', false],
    ['完全不可能命中的词串xyzzy', false],
  ]
  console.log('═'.repeat(72))
  console.log('批量体检（前 3 句应有命中，后 2 句必须 0 命中）')
  console.log('═'.repeat(72))
  let bad = 0
  for (const [q, shouldHit] of suite) {
    const n = matchEntries(snapshot, q, 8).length
    const okFlag = shouldHit ? n > 0 : n === 0
    if (!okFlag) bad += 1
    console.log(`${okFlag ? '✓' : '✗'} ${q} → ${n} 条${shouldHit ? '（应 >0）' : '（应 =0）'}`)
  }
  console.log('')
  if (bad > 0) console.log(`⚠ 有 ${bad} 条不符合预期 —— 要么是这个库里确实没有相关内容，要么是检索阈值有问题。`)
  else console.log('全部符合预期。')
  console.log('')
}

if (question) reportOne(question)

if (ownRoot) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
}
