#!/usr/bin/env node
/**
 * 检索语料污染过滤的测试 —— N-04 事故回归（2026-11-06）。
 *
 * ## 事故原貌
 *
 * D-12 修好之后，7 条原本「掉出目录」的条目重新可见（**这个修复必须保留**）。
 * 但这 7 条正文里 50%–73.5% 是问号（编码损坏）。它们一旦进入检索语料，
 * 就会把真结果挤下去 ——
 *
 *   查 `"NAS Gitea 部署"`，修复前 top3：
 *     1. [损坏] e-d-1924e23378  "????NAS??? Gitea ????:???????,???????"
 *     2. [损坏] e-distill-edfed6c2  "?? NAS ??? Gitea ?????"
 *     3. e-session6a13d  "Gitea 本地服务手动启动不会常驻…"   ← 真结果被挤到第 3
 *
 * ## 本文件锁定的行为（方案 c：双条件跳过）
 *
 *   A = `volumeFallback === true`（归属是系统猜的，不可信）
 *   B = 内容损坏（正文问号占比过高 / 连续问号）
 *
 *   **A && B → 排除出检索语料**；A 或 B 单独成立 → **不排除**。
 *
 * 同时锁定三条红线：
 *   · 被排除的条目**仍留在目录里**（manual_toc 看得见 —— 绝不撤销 D-12）
 *   · 被排除的条目**仍能 manual_read**（数据一条不丢）
 *   · 正常条目召回结果**逐条不变**
 *
 * ## 为什么测试里要自己造 snapshot
 *
 * `matchEntries` 只吃 `snapshot.summary.volumes`，不读磁盘。所以这里造最小夹具，
 * 不碰真实库、不依赖本机会话数。真实数据验证另见 `_qa-shuge-2/recall-compare.mjs`。
 */

import { matchEntries, isRecallPolluted, isContentDamaged, RECALL_DAMAGE_RATIO } from '../lib/index.js'
import { toSummary, buildLibrary } from '../lib/library.js'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
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

// ── 沙箱：任何情况下都不许落到真实库 ──────────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), 'recallfilter-'))
process.env.DSH_MANUSCRIPT_ROOT = sandbox

// ─────────────────────────────────────────────
// 夹具：一个最小 snapshot
//   vol-05 = 收件箱（兜底条目的去处）
//   vol-01 = 正常册
// ─────────────────────────────────────────────
/** 造一个条目。默认是「正常内容」；传 ratio 造指定问号占比的正文。 */
function mkEntry(id, { title, claim, volumeFallback = false, ratio = null, len = 40 } = {}) {
  let text = claim || title || ''
  if (ratio != null) {
    // 按目标占比构造：n 个问号 + (len-n) 个汉字
    const qs = Math.round(len * ratio)
    text = '?'.repeat(qs) + '启'.repeat(Math.max(0, len - qs))
  }
  return { id, title: title || text.slice(0, 20), claim: text, volumeFallback }
}

const NORMAL_A = mkEntry('e-normal-aaa', { title: 'Gitea 本地服务手动启动不会常驻', claim: 'Gitea 本地服务手动启动不会常驻，重启后 3000 端口离线' })
const NORMAL_B = mkEntry('e-normal-bbb', { title: '评估飞牛Gitea的Agent技能', claim: '评估飞牛 Gitea 的 Agent 技能是否值得接入' })
const NORMAL_C = mkEntry('e-normal-ccc', { title: 'Gitea 服务器账号密码查询', claim: 'Gitea 服务器账号密码查询方式与凭据位置' })

// 坏且兜底 → 必须排除
const BAD_FALLBACK_1 = mkEntry('e-bad-fb-111', { ratio: 0.735, len: 151, volumeFallback: true })
const BAD_FALLBACK_2 = mkEntry('e-bad-fb-222', { ratio: 0.5, len: 234, volumeFallback: true })

// 兜底但内容正常 → 不得排除（只有 A）
const FB_OK = mkEntry('e-fb-ok-333', { title: 'Gitea 备份脚本部署经验', claim: 'Gitea 备份脚本部署，每日增量归档到一个独立磁盘', volumeFallback: true })

// 内容坏但非兜底 → 不得排除（只有 B）
// 构造要点（踩过两次）：
//   ① 损坏归损坏，**还得有能命中的词**，否则测的是"查不到"而不是"没被排除"；
//   ② 可命中的前缀会稀释占比 —— 前缀越长，越可能把整体拉回 50% 以下。
//      这里定死：前缀 ≤ 6 字符可命中词 + 足够多的 `??启` 单元。
const BAD_NOFB = mkEntry('e-bad-nofb-444', {
  title: 'Gitea凭据',
  claim: 'Gitea凭据轮换：' + mkDenseNoRun(40),
  volumeFallback: false,
})

function mkSnapshot(vols) {
  return {
    summary: {
      volumes: vols.map((v) => ({
        id: v.id,
        no: v.no,
        name: v.name,
        inbox: !!v.inbox,
        chapters: [{ slug: 'ch-01', title: v.chapterTitle || '测试章', entries: v.entries }],
      })),
    },
  }
}

const SNAP = mkSnapshot([
  { id: 'vol-05', no: 'VOL.05', name: '未分类收件箱', inbox: true, chapterTitle: '未归章', entries: [BAD_FALLBACK_1, BAD_FALLBACK_2, FB_OK, BAD_NOFB] },
  { id: 'vol-01', no: 'VOL.01', name: '硬件设计', chapterTitle: '正常章', entries: [NORMAL_A, NORMAL_B, NORMAL_C] },
])

const ALL_IDS = [...SNAP.summary.volumes.flatMap((v) => v.chapters.flatMap((c) => c.entries))].map((e) => e.id)

/** 用足够宽的查询，把夹具里所有相关内容都试着召回。 */
function queryAll() {
  // 三块中文 bigram 覆盖夹具里所有正常文本；避免触发 stop-bigram 过滤
  return matchEntries(SNAP, 'Gitea 本地服务 手动启动 常驻 端口 离线 账号密码 查询 评估 飞牛 Agent 技能 备份脚本 部署 增量 归档', 20)
}

// ─────────────────────────────────────────────
// 1. 判据本身（纯函数，不经 matchEntries）
// ─────────────────────────────────────────────
console.log('\n── 1. 判据纯函数 ──')

check('A && B 同时成立 → isRecallPolluted = true', () => {
  assert(isRecallPolluted(BAD_FALLBACK_1), '应判为污染')
  assert(isRecallPolluted(BAD_FALLBACK_2), '应判为污染')
  return '2 条兜底+损坏均命中'
})

check('只有 A（兜底但内容正常）→ isRecallPolluted = false', () => {
  assert(FB_OK.volumeFallback === true, '夹具应先满足条件 A')
  assert(isContentDamaged(FB_OK) === false, '内容应判为正常')
  assert(!isRecallPolluted(FB_OK), '只有 A 不该排除')
  return '兜底 + 正常内容 → 不排除'
})

check('只有 B（内容损坏但非兜底）→ isRecallPolluted = false', () => {
  // 先自证夹具成立：这条必须**真的**被判损坏，否则「不排除」是废话
  assert(isContentDamaged(BAD_NOFB), `夹具没被判损坏（占比 ${(damagedRatio(BAD_NOFB) * 100).toFixed(1)}%），测试前提不成立`)
  assert(BAD_NOFB.volumeFallback === false, '夹具应不满足条件 A')
  assert(!isRecallPolluted(BAD_NOFB), '只有 B 不该排除')
  return `损坏（占比 ${(damagedRatio(BAD_NOFB) * 100).toFixed(0)}%）+ 非兜底 → 不排除`
})

check('正常条目 → 两条判据都不成立', () => {
  for (const e of [NORMAL_A, NORMAL_B, NORMAL_C]) {
    assert(!isContentDamaged(e), `${e.id} 被误判损坏`)
    assert(!isRecallPolluted(e), `${e.id} 被误判污染`)
  }
  return '3 条正常条目均清白'
})

check('volumeFallback 必须是严格 true —— 字符串 "true" 不算', () => {
  const sneaky = { ...mkEntry('e-sneaky', { ratio: 0.9, len: 60 }), volumeFallback: 'true' }
  assert(!isRecallPolluted(sneaky), '字符串 "true" 不该享受兜底语义')
  const one = { ...mkEntry('e-one', { ratio: 0.9, len: 60 }), volumeFallback: 1 }
  assert(!isRecallPolluted(one), '数字 1 不该享受兜底语义')
  return '只认 === true'
})

// ─────────────────────────────────────────────
// 2. 阈值边界
// ─────────────────────────────────────────────
console.log('\n── 2. 阈值边界（RECALL_DAMAGE_RATIO = ' + RECALL_DAMAGE_RATIO + '）──')

check('阈值常量 = 0.5', () => {
  assert(RECALL_DAMAGE_RATIO === 0.5, `期望 0.5，实际 ${RECALL_DAMAGE_RATIO}`)
  return '0.5'
})

/*
 * 边界测试的构造要点：
 *   isContentDamaged 的第一条判据是「连续 3 个问号」。
 *   要单独测**占比**判据，必须让问号**不连续** —— 否则永远是 run 判据先命中，
 *   占比阈值形同虚设，测了个寂寞。
 *
 * 注意 `?x?x?x…` 交替构造的占比**上限只有 50%**（偶数位全占满也就一半），
 * 想造 >50% 必须换密度更高的单元 —— 用 `??x` 重复：密度 2/3，
 * 且**永远不会出现连续 3 个问号**，正好绕开 run 判据。
 * 第一版就在这翻了车：用交替法造 55%，实际只得到 50%，断言直接挂掉。
 */
function mkInterleaved(ratio, len = 40) {
  const qs = Math.round(len * ratio)
  let s = ''
  let used = 0
  for (let i = 0; i < len; i++) {
    if (used < qs && i % 2 === 0) { s += '?'; used++ } else s += '启'
  }
  return s
}

/** 高密度但无连续 3 问号：重复 `??x`，密度 2/3。 */
function mkDenseNoRun(units = 10) {
  return '启' + '??启'.repeat(units) // 开头加一个非问号，避免以 ?? 收尾接标题空格时凑成 3 连
}

/** 夹具自检：断言「只有 B」那条**真的**被判损坏，防止夹具漂移让测试失去意义。 */
function damagedRatio(e) {
  const text = `${e.title || ''} ${e.claim || ''}`.trim()
  return (text.match(/\?/g) || []).length / text.length
}


check('刚好 40% 且问号不连续 → 不判损坏（未超阈值）', () => {
  const text = mkInterleaved(0.4)
  const e = { title: text.slice(0, 20), claim: text, volumeFallback: true }
  const actual = (e.claim.match(/\?/g) || []).length / e.claim.length
  assert(!/\?{3,}/.test(text), `构造失败：出现了连续问号 ${actual}`)
  assert(!isContentDamaged(e), `40%（实际 ${(actual * 100).toFixed(1)}%）不该判损坏`)
  assert(!isRecallPolluted(e), '不损坏 → 不排除')
  return `40% → 不排除（实际 ${(actual * 100).toFixed(1)}%）`
})

check('刚好 50% 且问号不连续 → 不判损坏（等于阈值，用 > 不是 >=）', () => {
  const text = mkInterleaved(0.5, 40)
  const e = { title: text.slice(0, 20), claim: text, volumeFallback: true }
  const actual = (e.claim.match(/\?/g) || []).length / e.claim.length
  assert(!isContentDamaged(e), `恰好 50% 不该判损坏（判据是严格大于），实际 ${actual}`)
  return '50% 恰好 → 不排除'
})

check('超过 50% 且问号不连续 → 判损坏 → 排除', () => {
  const text = mkDenseNoRun(10) // 20 个问号 / 31 字符 ≈ 64.5%
  const e = { title: text.slice(0, 20), claim: text, volumeFallback: true }
  const full = e.title + ' ' + e.claim
  const actual = (full.match(/\?/g) || []).length / full.length
  assert(!/\?{3,}/.test(full), '构造失败：出现了连续 3 个问号，测的就不是占比判据了')
  assert(actual > 0.5, `构造失败：占比 ${actual} 应 > 0.5`)
  assert(isContentDamaged(e), `超过 50%（实际 ${(actual * 100).toFixed(1)}%）应判损坏`)
  assert(isRecallPolluted(e), '损坏 + 兜底 → 应排除')
  return `${(actual * 100).toFixed(1)}% 且无连续问号 → 排除（占比判据独立生效）`
})

check('刚好 40% 但含连续 ??? → 仍判损坏（run 判据独立生效）', () => {
  const e = { title: '???开头的标题', claim: '???启启启启启启启启启启启启启启启启启启启', volumeFallback: true }
  const ratio = ((e.title + ' ' + e.claim).match(/\?/g) || []).length / (e.title + ' ' + e.claim).length
  assert(ratio < 0.5, `构造失败：占比 ${ratio} 应 < 0.5`)
  assert(isContentDamaged(e), '连续 3 问号应独立触发损坏判定')
  return `占比仅 ${(ratio * 100).toFixed(1)}% 但含 ??? → 排除`
})

check('文本过短（< 8 字）不判损坏 —— 避免误杀短标题', () => {
  const e = { title: '???', claim: '', volumeFallback: true }
  assert(!isContentDamaged(e), '过短文本不该判损坏')
  return '短文本豁免'
})

// ─────────────────────────────────────────────
// 3. 接入 matchEntries 后的实际召回
// ─────────────────────────────────────────────
console.log('\n── 3. matchEntries 实际召回 ──')

check('A && B 的条目不再出现在召回结果里', () => {
  const hits = queryAll()
  const ids = hits.map((h) => h.id)
  assert(!ids.includes(BAD_FALLBACK_1.id), `${BAD_FALLBACK_1.id} 不该被召回`)
  assert(!ids.includes(BAD_FALLBACK_2.id), `${BAD_FALLBACK_2.id} 不该被召回`)
  return `召回 ${hits.length} 条，无兜底+损坏条目`
})

check('只有 A 的条目**仍然**被召回（不误杀）', () => {
  const hits = queryAll()
  const ids = hits.map((h) => h.id)
  assert(ids.includes(FB_OK.id), `兜底但内容正常的 ${FB_OK.id} 被误杀了`)
  return `${FB_OK.id} 仍可召回`
})

check('只有 B 的条目**仍然**被召回（不误杀）', () => {
  // fail-closed 门槛后，关键词堆砌式长查询会被有意过滤；用真实问法验证不误杀。
  const hits = matchEntries(SNAP, 'Gitea 凭据 轮换', 20)
  const ids = hits.map((h) => h.id)
  assert(ids.includes(BAD_NOFB.id), `损坏但非兜底的 ${BAD_NOFB.id} 被误杀了`)
  return `${BAD_NOFB.id} 仍可召回`
})

check('正常条目召回结果不受影响', () => {
  const hits = queryAll()
  const ids = hits.map((h) => h.id)
  for (const e of [NORMAL_A, NORMAL_B, NORMAL_C]) {
    assert(ids.includes(e.id), `${e.id} 丢失`)
  }
  return '3 条正常条目全部召回'
})

check('过滤不缩减 topK 名额 —— 排除后仍有足量结果', () => {
  const hits = matchEntries(SNAP, 'Gitea 部署 服务 端口 离线 账号密码 查询 评估 飞牛 Agent 技能 备份脚本', 3)
  assert(hits.length === 3, `应返回满 3 条，实际 ${hits.length}（过滤在计分前，不该占名额）`)
  assert(!hits.some((h) => h.id.startsWith('e-bad-fb')), 'top3 里仍有被排除条目')
  return `top3 满额且干净：${hits.map((h) => h.id).join(', ')}`
})

check('全部条目都被排除时 → 返回空数组（fail-closed，不是崩）', () => {
  const onlyBad = mkSnapshot([
    { id: 'vol-05', no: 'VOL.05', name: '收件箱', inbox: true, entries: [BAD_FALLBACK_1, BAD_FALLBACK_2] },
  ])
  const hits = matchEntries(onlyBad, 'Gitea 部署 服务 端口 离线', 8)
  assert(hits.length === 0, `应 0 条，实际 ${hits.length}`)
  return '0 命中（由 manual_recall 回「手册无记录」）'
})

// ─────────────────────────────────────────────
// 4. 红线：排除 ≠ 删除（目录/读取都还在）
// ─────────────────────────────────────────────
console.log('\n── 4. 红线：排除不等于删除 ──')

/*
 * 这一段必须走**真实建库**，而不是手造的 snapshot —— 因为要验证的正是
 * 「buildLibrary 写出来的 chapterList 里，这 7 条还在」。
 * 手造 snapshot 证明不了这一点（那是自己造的）。
 */
const root = join(sandbox, 'lib')
mkdirSync(root, { recursive: true })
mkdirSync(join(root, 'entries'), { recursive: true })

/** 写一个条目文件到磁盘（模拟真实库里那 7 条的形态：无合法 volume）。 */
function writeRawEntry(e) {
  writeFileSync(join(root, 'entries', e.id + '.json'), JSON.stringify(e, null, 2))
}

// 缺 volume 的（兜底）+ 内容损坏
//
// ⚠️ 这里的问号是**故意的**：isContentDamaged 的判据就是「成片问号」，
// 本条专门用来验证它能把损坏条目识别出来。
// 但原文里混进了真实的账号名，已替换成中性占位（2026-11-07 清理）。
writeRawEntry({
  id: 'e-raw-badfb',
  title: '????NAS??? Gitea ????:???????,???????',
  claim: '??NAS ?????? user-a ?????????? User-A ??????',
  status: 'current',
  confidence: 'medium',
  authority: 'L1',
  provenance: {},
})
// 缺 volume 的（兜底）+ 内容正常
writeRawEntry({
  id: 'e-raw-okfb',
  title: '正常兜底条目',
  claim: '这条没有 volume 字段，但内容完好，应该照常出现在目录和检索里',
  status: 'current',
  confidence: 'medium',
  authority: 'L1',
  provenance: {},
})

const built = buildLibrary([], { root, dataDir: join(sandbox, 'nodata') })
const summary = toSummary(built.library)

check('排除后条目**仍在 chapterList**（manual_toc 可见，D-12 未撤销）', () => {
  const ids = new Set()
  for (const v of summary.volumes) for (const c of v.chapters || []) for (const e of c.entries || []) ids.add(e.id)
  assert(ids.has('e-raw-badfb'), '兜底+损坏条目掉出目录了 —— D-12 被破坏')
  assert(ids.has('e-raw-okfb'), '兜底+正常条目掉出目录了')
  return `目录可见 ${ids.size} 条，含 e-raw-badfb 与 e-raw-okfb`
})

check('排除后条目文件**仍在磁盘**（manual_read 可读，数据零丢失）', () => {
  const p = join(root, 'entries', 'e-raw-badfb.json')
  const disk = JSON.parse(readFileSync(p, 'utf8'))
  assert(disk.id === 'e-raw-badfb', '磁盘文件缺失或被改写')
  return '磁盘文件原样保留'
})

check('重建后的目录投影**带上** volumeFallback（条件 A 的前提）', () => {
  let found = null
  for (const v of summary.volumes) for (const c of v.chapters || []) for (const e of c.entries || []) if (e.id === 'e-raw-badfb') found = e
  assert(found, '条目不在目录里')
  assert('volumeFallback' in found, 'chapterList 投影缺 volumeFallback 字段 —— 检索层看不到条件 A')
  assert(found.volumeFallback === true, `volumeFallback 应为 true，实际 ${JSON.stringify(found.volumeFallback)}`)
  return '投影已带 volumeFallback=true'
})

check('端到端：真实建库产物 → 兜底+损坏被排除，兜底+正常仍召回', () => {
  const snap = { summary }
  // 用损坏条目的标题片段查（它自己都查不到自己 = 已排除出检索语料）
  const badHits = matchEntries(snap, 'NAS Gitea user-a', 8)
  assert(!badHits.some((h) => h.id === 'e-raw-badfb'), '兜底+损坏条目仍被召回')

  const okHits = matchEntries(snap, '正常兜底条目 内容完好 目录 检索', 8)
  assert(okHits.some((h) => h.id === 'e-raw-okfb'), '兜底+正常条目被误杀了')
  return '端到端通过：坏的不召回、好的照常召回'
})

// ─────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────
rmSync(sandbox, { recursive: true, force: true })

console.log('\n' + '═'.repeat(74))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  · ' + f)
}
console.log('═'.repeat(74))
process.exit(fail === 0 ? 0 : 1)
