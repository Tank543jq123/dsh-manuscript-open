#!/usr/bin/env node
/**
 * 骨架自动退役 —— 2026-11-12 线上「48.6% 条目只有统计骨架」修复的回归。
 *
 * ## 事故形态
 *
 * 真实库 321 条里 156 条（48.6%）的 claim 是
 * `7 轮 · 3 次工具调用 · 0 个交付物 · （多轮讨论）`。其中 **110 条骨架对应的
 * 会话早就有 LLM 提炼出的真结论**，只是骨架从来没人标成 expired ——
 * 于是目录、manual_recall、首轮预取里同时存在「会话有多长」和「会话教会了什么」。
 *
 * ## 本文件锁定的行为
 *
 *   ① 同会话已有 distilled 真结论 → 骨架自动 expired，且不进 chapterList
 *   ② 没有真结论的骨架 → 保持 current（不许为了压数字误退役）
 *   ③ 退役**只改 status 与留痕**：claim/title 一个字不动，文件不删
 *   ④ 幂等：第二次 buildLibrary 的 skeletonRetired = 0，退役不会反复计
 *   ⑤ 别的会话的真结论不会误伤本会话骨架
 *
 * 硬约束：全程 mkdtemp + opts.root，绝不碰真实库。
 */

import { buildLibrary } from '../lib/library.js'
import { isSkeletonEntry } from '../lib/skeleton.js'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const failures = []
function check(name, fn) {
  try {
    const detail = fn()
    pass += 1
    console.log(`✓ ${name}${detail ? '  ' + detail : ''}`)
  } catch (e) {
    fail += 1
    failures.push(`${name} → ${e.message}`)
    console.log(`✗ ${name}\n    ${e.message}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const sandbox = mkdtempSync(join(tmpdir(), 'skeleton-retire-'))
const root = join(sandbox, 'lib')
const entriesDir = join(root, 'entries')
mkdirSync(entriesDir, { recursive: true })

const entry = (id, sid, claim, extra = {}) => ({
  id,
  volume: 'vol-03',
  chapter: 'ch-plugin',
  chapterTitle: '插件安装与升级',
  title: `标题 ${id}`,
  claim,
  confidence: 'high',
  authority: 'L2',
  status: 'current',
  provenance: { session_id: sid },
  ...extra,
})

const FIXTURES = {
  // 有真结论的会话：骨架应当退役
  skelPaired: entry('e-skel-paired', 'sid-paired', '7 轮 · 3 次工具调用 · 0 个交付物 · （多轮讨论）', {
    confidence: 'speculation',
    authority: 'L3',
  }),
  realPaired: entry('e-real-paired', 'sid-paired', '插件热加载不会重载服务端模块，必须重启 DSH 才生效。', {
    distilled: true,
  }),
  // 没有真结论的会话：骨架必须留下
  skelAlone: entry('e-skel-alone', 'sid-alone', '2 轮 · 5 次工具调用 · 1 个交付物', {
    confidence: 'speculation',
    authority: 'L3',
  }),
  // 别的会话的真结论：不得误伤 skelAlone
  realOther: entry('e-real-other', 'sid-other', '另一件事的结论，与 sid-alone 无关。', { distilled: true }),
  // 已退役的骨架：保持原样，不重复计数
  skelExpired: entry('e-skel-expired', 'sid-expired', '1 轮 · 0 次工具调用 · 0 个交付物', {
    status: 'expired',
    retiredAt: '2026-11-01T00:00:00.000Z',
    retiredReason: 'manual',
  }),
  realExpiredSid: entry('e-real-expired', 'sid-expired', '该会话的真结论。', { distilled: true }),
}

for (const e of Object.values(FIXTURES)) {
  writeFileSync(join(entriesDir, e.id + '.json'), JSON.stringify(e, null, 2), 'utf8')
}
const before = Object.fromEntries(
  Object.entries(FIXTURES).map(([k, e]) => [k, JSON.stringify(JSON.parse(readFileSync(join(entriesDir, e.id + '.json'), 'utf8')))])
)
const readEntry = (id) => JSON.parse(readFileSync(join(entriesDir, id + '.json'), 'utf8'))
const catalogIds = (library) => {
  const ids = new Set()
  for (const v of library.volumes || []) {
    for (const ch of v.chapterList || []) for (const e of ch.entries || []) ids.add(e.id)
  }
  return ids
}

console.log('\n── 0. 夹具自检 ──')
check('夹具里的骨架确实能被判据识别', () => {
  assert(isSkeletonEntry(FIXTURES.skelPaired), 'skelPaired 未被识别为骨架')
  assert(isSkeletonEntry(FIXTURES.skelAlone), 'skelAlone 未被识别为骨架')
  assert(!isSkeletonEntry(FIXTURES.realPaired), '真结论被误判为骨架')
  return '3 条骨架 + 3 条真结论'
})

console.log('\n── 1. 第一次构建：只退役「已有真结论」的骨架 ──')
let built
check('骨架退役数与台账一致', () => {
  built = buildLibrary([], { root })
  assert(built.library.counts.skeletonRetired === 1, `skeletonRetired 期望 1（只退役配对的那条），实际 ${built.library.counts.skeletonRetired}`)
  assert(built.library.counts.retired === 2, `retired 期望 2（新退役 1 + 既有 1），实际 ${built.library.counts.retired}`)
  return `skeletonRetired=${built.library.counts.skeletonRetired} · retired=${built.library.counts.retired}`
})
check('★ 配对骨架已 expired，文件仍在盘上', () => {
  const e = readEntry('e-skel-paired')
  assert(e.status === 'expired', `status=${e.status}`)
  assert(e.retiredReason === 'superseded-by-distilled-entry', `retiredReason=${e.retiredReason}`)
  assert(e.replacedBy === 'e-real-paired', `replacedBy=${e.replacedBy}`)
  assert(typeof e.retiredAt === 'string' && e.retiredAt.length > 0, 'retiredAt 缺失')
  assert(existsSync(join(entriesDir, 'e-skel-paired.json')), '条目文件被删了（红线：永不自动删除）')
  return `expired · replacedBy=${e.replacedBy} · 文件保留`
})
check('★ 退役只改状态：claim/title 一个字都没动', () => {
  const e = readEntry('e-skel-paired')
  const orig = JSON.parse(before.skelPaired)
  assert(e.claim === orig.claim, `claim 被改：${orig.claim} → ${e.claim}`)
  assert(e.title === orig.title, `title 被改：${orig.title} → ${e.title}`)
  return 'claim/title 原样'
})
check('无真结论的骨架保持 current', () => {
  const e = readEntry('e-skel-alone')
  assert(e.status === 'current', `status=${e.status}`)
  assert(!e.retiredReason, '不该带 retiredReason')
  return 'skelAlone 仍 current'
})
check('已退役的骨架不被重复改写', () => {
  const e = readEntry('e-skel-expired')
  assert(e.status === 'expired', `status=${e.status}`)
  assert(e.retiredReason === 'manual', `retiredReason 被覆盖：${e.retiredReason}`)
  assert(e.retiredAt === '2026-11-01T00:00:00.000Z', `retiredAt 被覆盖：${e.retiredAt}`)
  return '既有退役留痕原样'
})
check('目录里只剩未配对的骨架 + 真结论', () => {
  const ids = catalogIds(built.library)
  assert(!ids.has('e-skel-paired'), '已退役骨架仍出现在目录')
  assert(!ids.has('e-skel-expired'), '历史 expired 骨架出现在目录')
  assert(ids.has('e-skel-alone'), '未配对骨架被误退役')
  assert(ids.has('e-real-paired'), '真结论不在目录')
  return `目录 ${ids.size} 条`
})

console.log('\n── 2. 幂等：再建一次不该重复退役 ──')
check('第二次构建 skeletonRetired=0，状态不变', () => {
  const again = buildLibrary([], { root })
  assert(again.library.counts.skeletonRetired === 0, `第二次 skeletonRetired=${again.library.counts.skeletonRetired}（应为 0）`)
  assert(again.library.counts.retired === 2, `第二次 retired=${again.library.counts.retired}`)
  const e = readEntry('e-skel-paired')
  assert(e.status === 'expired', '第二次构建把退役回滚了')
  return 'skeletonRetired=0 · 状态稳定'
})

console.log('\n' + '='.repeat(60))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail > 0) {
  for (const f of failures) console.log('  ' + f)
  process.exit(1)
}
try {
  rmSync(sandbox, { recursive: true, force: true })
} catch {
  /* 临时目录清不掉不影响结论 */
}
