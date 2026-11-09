#!/usr/bin/env node
/**
 * lib/library.js「归属册兜底」的测试 —— D-12 事故回归（2026-11-06）。
 *
 * ## 事故原貌
 *
 * 真实库 `~/.dsh/dsh-manuscript/entries/` 有 428 个条目文件，其中 7 个**没有
 * `volume` 字段**（字段集是 id/distilled/source/claim/authority/confidence/title/
 * status/provenance/committedAt，provenance 还是空对象）。它们写在 `commit.js`
 * 加兜底之前，于是永久成了孤儿：
 *
 *   · `allEntries.filter((e) => e.volume === def.id)` 不认它们 → 不进任何册
 *   · `manual_read` / `manual_toc` / `manual_recall` 全翻不到
 *   · 只有 `manual_trace`（按 id 直读）能中 → "抽查两条能查到"完全证明不了库是好的
 *   · counts.entries 是 428，目录里只有 394，差额 7 一直没人报
 *
 * ## 本文件锁定的行为
 *
 *   ① 缺 volume 的 **current** 条目 → 进 vol-05 收件箱，且**真写回磁盘**
 *   ② volume 非法（vol-99）→ 同样进 vol-05，原值留痕在 volumeFallbackFrom
 *   ③ 缺 volume 的 **expired** 条目 → 补上归属但仍**不进目录**（退役是人工决定）
 *   ④ counts.entries 与 catalogLoss().catalogEntries 不再有差额
 *   ⑤ 复跑幂等：created=0、不再触发兜底、目录逐条一致、时间戳不被改写
 *
 * ## 硬约束（写测试时自己踩过的坑）
 *
 *   · 绝不碰真实库：一切走 mkdtempSync + opts.root，并在开头把
 *     DSH_MANUSCRIPT_ROOT 指向临时目录，万一有代码漏传 root 也写不到真库。
 *   · 断言"写回磁盘"必须**重新从磁盘读**，不能读内存里的 library 对象 ——
 *     只在内存里改正是本次事故的成因形态（重建也救不回来）。
 */

import { buildLibrary, catalogLoss, defaultLibraryRoot, toSummary } from '../lib/library.js'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
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
const sandbox = mkdtempSync(join(tmpdir(), 'volfallback-'))
process.env.DSH_MANUSCRIPT_ROOT = sandbox
const root = join(sandbox, 'lib')
mkdirSync(root, { recursive: true })

const entriesDir = join(root, 'entries')
mkdirSync(entriesDir, { recursive: true })

const readEntry = (id) => JSON.parse(readFileSync(join(entriesDir, id + '.json'), 'utf8'))
const entryFiles = () => readdirSync(entriesDir).filter((f) => f.endsWith('.json')).sort()

/**
 * 三条夹具，正好覆盖任务里点名的三种形态：
 *   noVolume      缺 volume + current      → 必须进目录（这是本次事故的主体）
 *   noVolumeExpired 缺 volume + expired    → 补字段，但不得回到目录
 *   badVolume      volume='vol-99' 非法    → 同样兜底，原值留痕
 *   paddedVolume   volume='  vol-01  '     → 归属对但写法不规范，归位而非进收件箱
 *   另有 validVolume 作为**阴性对照**：合法归属必须一个字都不动。
 */
const FIXTURES = {
  noVolume: {
    id: 'e-d-0265c7682b',
    distilled: true,
    source: 'session',
    claim: '缺 volume 的 current 条目，原本在盘上却不在任何一册目录里',
    authority: 'L2',
    confidence: 'high',
    title: '缺 volume 的条目（事故主体）',
    status: 'current',
    provenance: {},
    committedAt: '2026-11-02T01:00:00.000Z',
    // 这一条带证据，用来验证"evidence 会被渲染进人读的 MANUAL.md"
    evidence: { tools: ['write', 'bash'], files: ['选型.md'] },
  },
  noVolumeExpired: {
    id: 'e-1ee89f3e10',
    claim: '缺 volume 的 expired 条目：骨架已退役，补字段也不许回目录',
    title: '缺 volume 的已退役条目',
    status: 'expired',
    provenance: {},
  },
  badVolume: {
    id: 'e-9bad000001',
    volume: 'vol-99',
    claim: 'volume 指向一个根本不存在的册，等价于没有归属',
    title: 'volume 非法（vol-99）的条目',
    status: 'current',
    provenance: {},
  },
  validVolume: {
    id: 'e-0valid00001',
    volume: 'vol-01',
    chapter: 'ch-demo-hardware',
    claim: '合法归属的条目，兜底逻辑必须一个字都不动它',
    title: '合法归属的条目（阴性对照）',
    status: 'current',
    provenance: {},
  },
  /**
   * 第四种形态（写测试时自己想到的边界，也真的会掉出目录）：
   * volume=' vol-01 ' —— 归属是对的，但归档循环用的是严格相等
   * `e.volume === def.id`，带空白就匹配不上，结果同样是"在盘上却翻不到"。
   * 处理方式与兜底不同：归位到 'vol-01'，**不进收件箱**、不打 volumeFallback。
   */
  paddedVolume: {
    id: 'e-9pad0000001',
    volume: '  vol-01  ',
    chapter: 'ch-demo-hardware',
    claim: 'volume 归属正确但两边带空白，严格相等匹配不上，同样会掉出目录',
    title: 'volume 带空白的条目',
    status: 'current',
    provenance: {},
  },
}

for (const [name, e] of Object.entries(FIXTURES)) {
  writeFileSync(join(entriesDir, e.id + '.json'), JSON.stringify(e, null, 2), 'utf8')
}
const beforeBytes = Object.fromEntries(
  Object.entries(FIXTURES).map(([name, e]) => [name, JSON.stringify(readEntry(e.id), null, 2)])
)

// triaged 给空数组：本测试要验的是"盘上已有条目怎么被救回来"，
// 与从会话派生新条目无关。这样 created 恒为 0，任何新条目都是 bug。
const EMPTY_TRIAGED = []

console.log('\n── 0. 沙箱与前置事实 ──')

check('默认根目录被重定向到临时目录（绝不碰真实库）', () => {
  assert(!defaultLibraryRoot().includes(join('.dsh', 'dsh-manuscript')), `默认根仍指向真实库：${defaultLibraryRoot()}`)
  assert(defaultLibraryRoot() === sandbox, `默认根应为 ${sandbox}，实际 ${defaultLibraryRoot()}`)
  return `DSH_MANUSCRIPT_ROOT=${defaultLibraryRoot()}`
})

check('前置：三条夹具确实没有合法归属（否则测的是空气）', () => {
  const nv = readEntry(FIXTURES.noVolume.id)
  const ne = readEntry(FIXTURES.noVolumeExpired.id)
  const bv = readEntry(FIXTURES.badVolume.id)
  assert(!('volume' in nv), 'noVolume 不该有 volume 字段')
  assert(!('volume' in ne), 'noVolumeExpired 不该有 volume 字段')
  assert(bv.volume === 'vol-99', `badVolume.volume=${bv.volume}`)
  assert(JSON.stringify(nv.provenance) === '{}', 'noVolume 的 provenance 应保持空对象（真实事故形态）')
  return '2 条缺 volume（current/expired 各一）+ 1 条 vol-99 + 1 条带空白'
})

console.log('\n── 1. 第一次构建：兜底 + 落盘 ──')

let built
check('构建成功且报告了兜底条数（不静默）', () => {
  built = buildLibrary(EMPTY_TRIAGED, { root })
  assert(built.volumeFallback === 3, `期望兜底 3 条（2 缺 + 1 非法），实际 ${built.volumeFallback}`)
  assert(Array.isArray(built.volumeFallbacks), 'volumeFallbacks 明细缺失')
  assert(built.volumeFallbacks.length === 3, `明细长度应为 3，实际 ${built.volumeFallbacks.length}`)
  // 带空白那条不算兜底，单独计 —— 两件事混成一个数字就分不清性质了
  assert(built.volumeNormalized === 1, `volumeNormalized 应为 1，实际 ${built.volumeNormalized}`)
  return `volumeFallback=${built.volumeFallback} · volumeNormalized=${built.volumeNormalized} · 明细 ${built.volumeFallbacks.map((v) => v.id).join(',')}`
})

check('★ 归一化真的写回了磁盘（本次修复的关键，不是只在内存里改）', () => {
  const nv = readEntry(FIXTURES.noVolume.id)
  assert(nv.volume === 'vol-05', `磁盘上 volume=${JSON.stringify(nv.volume)}，未写回`)
  assert(nv.volumeFallback === true, 'volumeFallback 标记未落盘')
  assert(nv.volumeFallbackFrom === null, `原本没有 volume，应记 null（"不知道"），实际 ${JSON.stringify(nv.volumeFallbackFrom)}`)
  assert(typeof nv.volumeFallbackAt === 'string' && nv.volumeFallbackAt.length > 0, 'volumeFallbackAt 缺失')
  return `volume=${nv.volume} · from=${JSON.stringify(nv.volumeFallbackFrom)} · 标记已落盘`
})

check('兜底不得篡改内容字段（claim/title/provenance/status 原样）', () => {
  const nv = readEntry(FIXTURES.noVolume.id)
  const orig = FIXTURES.noVolume
  assert(nv.claim === orig.claim, 'claim 被改了')
  assert(nv.title === orig.title, 'title 被改了')
  assert(nv.status === orig.status && nv.status === 'current', `status 被改成 ${nv.status}`)
  assert(JSON.stringify(nv.provenance) === '{}', 'provenance 被改了（不得凭空造来源）')
  assert(nv.committedAt === orig.committedAt, 'committedAt 被改了')
  assert(nv.confidence === orig.confidence && nv.authority === orig.authority, '置信度/权威等级被改了')
  return 'claim/title/status/provenance/committedAt 全部原样'
})

check('坏条目文件被计数并透出（多设备同步的半写文件）', () => {
  // 【2026-11-08】原来只有一个空 catch：坏 JSON 永久停在盘上、永远不进目录，
  // 而界面上没有任何提示。现在 counts.invalidEntries / summary.invalidEntries 都要有。
  // 用**独立临时库**验证，避免影响本文件后续对主夹具库状态的断言。
  const iso = mkdtempSync(join(tmpdir(), 'ms-invalid-'))
  try {
    buildLibrary(EMPTY_TRIAGED, { root: iso })
    const f = join(iso, 'entries', 'e-halfwritten.json')
    writeFileSync(f, '{"id":"e-halfwritten",')
    const r = buildLibrary(EMPTY_TRIAGED, { root: iso })
    assert(r.invalidEntryFiles.includes('e-halfwritten.json'), `invalidEntryFiles=${JSON.stringify(r.invalidEntryFiles)}`)
    assert(r.library.counts.invalidEntries === 1, `counts.invalidEntries=${r.library.counts.invalidEntries}`)
    const s = toSummary(r.library)
    assert(s.invalidEntries === 1, `summary.invalidEntries=${s.invalidEntries}`)
    return '坏文件被计数：counts + summary 都能看到，且不阻断建库'
  } finally {
    rmSync(iso, { recursive: true, force: true })
  }
})

check('MANUAL.md 渲染 evidence（2026-11-08 新增）', () => {
  // 夹具里条目带 evidence 的那条，应该在人读的 Markdown 里看到"证据："
  const md = readFileSync(join(root, 'volumes', 'vol-05', 'MANUAL.md'), 'utf8')
  assert(/证据：/.test(md), 'MANUAL.md 里没有渲染 evidence')
  assert(/工具 |文件 /.test(md), 'evidence 只有前缀没有内容')
  return `MANUAL.md 含 ${(md.match(/^证据：/gm) || []).length} 行证据`
})

check('非法 volume 保留原值以便回滚（不丢信息）', () => {
  const bv = readEntry(FIXTURES.badVolume.id)
  assert(bv.volume === 'vol-05', `应兜底到 vol-05，实际 ${JSON.stringify(bv.volume)}`)
  assert(bv.volumeFallbackFrom === 'vol-99', `原值应留痕 vol-99，实际 ${JSON.stringify(bv.volumeFallbackFrom)}`)
  assert(/vol-99/.test(bv.volumeFallbackReason || ''), `原因里应写明非法值，实际 ${bv.volumeFallbackReason}`)
  return `vol-99 → vol-05，原值留痕在 volumeFallbackFrom`
})

check('合法归属的条目一个字都没动（阴性对照）', () => {
  const vv = readEntry(FIXTURES.validVolume.id)
  assert(vv.volume === 'vol-01', `volume 被改成 ${vv.volume}`)
  assert(vv.volumeFallback === undefined, '合法条目不该被打上 volumeFallback 标记')
  assert(JSON.stringify(vv, null, 2) === beforeBytes.validVolume, '合法条目的内容发生了漂移')
  return 'vol-01 原样保留，未被兜底逻辑触碰'
})

check('volume 带空白的条目：归位而非进收件箱（容易被漏掉的第四种形态）', () => {
  const pv = readEntry(FIXTURES.paddedVolume.id)
  assert(pv.volume === 'vol-01', `应归位成 'vol-01'，实际 ${JSON.stringify(pv.volume)}`)
  assert(pv.volumeFallback === undefined, '归属本来就对，不该打 volumeFallback')
  assert(pv.volumeNormalizedFrom === '  vol-01  ', `原值应留痕，实际 ${JSON.stringify(pv.volumeNormalizedFrom)}`)
  assert(pv.status === 'current', 'status 不该被改')
  // 关键：它必须真的出现在 vol-01 的目录里（严格相等匹配得到）
  const v01 = built.library.volumes.find((v) => v.id === 'vol-01')
  const ids = []
  for (const c of v01.chapterList || []) for (const e of c.entries || []) ids.push(e.id)
  assert(ids.includes(FIXTURES.paddedVolume.id), `归位后仍不在 vol-01 目录里：${ids.join(',')}`)
  return `'  vol-01  ' → 'vol-01' · 已在 vol-01 目录里可见`
})

check('兜底条目被标 needsReview（进收件箱就要有人看）', () => {
  const nv = readEntry(FIXTURES.noVolume.id)
  assert(nv.needsReview === true, `needsReview=${JSON.stringify(nv.needsReview)}`)
  return 'needsReview=true'
})

console.log('\n── 2. 目录可见性：翻得到 / 翻不到 ──')

check('缺 volume 的 current 条目出现在 vol-05 目录里，且 manual 可见', () => {
  const v05 = built.library.volumes.find((v) => v.id === 'vol-05')
  assert(v05, 'library.volumes 里没有 vol-05')
  assert(v05.entries > 0, `vol-05 条目数为 ${v05.entries}`)
  const ids = []
  for (const c of v05.chapterList) for (const e of c.entries || []) ids.push(e.id)
  assert(ids.includes(FIXTURES.noVolume.id), `vol-05 章节目录里没有 ${FIXTURES.noVolume.id}，实际 ${ids.join(',')}`)
  assert(ids.includes(FIXTURES.badVolume.id), `vol-99 那条也没进 vol-05，实际 ${ids.join(',')}`)
  return `vol-05 有 ${v05.entries} 条，含 2 条兜底条目`
})

check('原册（vol-01）条目数没被兜底污染', () => {
  const v01 = built.library.volumes.find((v) => v.id === 'vol-01')
  assert(v01, '没有 vol-01')
  // 2 条：合法对照 + 带空白归位那条（后者本该在 vol-01，兜底不应把它拉进收件箱）
  assert(v01.entries === 2, `vol-01 应为 2 条，实际 ${v01.entries}`)
  return `vol-01 = ${v01.entries} 条（合法条目 + 归位条目）`
})

check('★ 缺 volume 的 expired 条目仍在盘上，但**不在目录里**', () => {
  const id = FIXTURES.noVolumeExpired.id
  assert(existsSync(join(entriesDir, id + '.json')), `文件不见了（红线①：永不删除条目）`)
  const e = readEntry(id)
  assert(e.status === 'expired', `status 被改成 ${e.status}（红线：不许改 status）`)
  // 字段补上了（进收件箱是对的），但不得因此回到目录
  assert(e.volume === 'vol-05', `expired 条目也应补上归属，实际 ${JSON.stringify(e.volume)}`)

  const catalogIds = new Set()
  for (const v of built.library.volumes) for (const c of v.chapterList || []) for (const x of c.entries || []) catalogIds.add(x.id)
  assert(!catalogIds.has(id), `expired 条目出现在目录里了：${id}`)
  assert(existsSync(join(entriesDir, id + '.json')), '文件在断言过程中消失了')
  return '文件在盘上 · status=expired · 不在任何 chapterList'
})

console.log('\n── 3. 口径自洽：不再有看不见的差额 ──')

check('counts.entries 与 catalogLoss().catalogEntries 无差额', () => {
  const loss = catalogLoss(built.library)
  const declared = built.library.counts.entries
  assert(declared === 5, `counts.entries 应为 5，实际 ${declared}`)
  assert(loss.catalogEntries === 4, `可翻条数应为 4（5 条 - 1 条退役），实际 ${loss.catalogEntries}`)
  assert(loss.retiredEntries === 1, `退役计数应为 1，实际 ${loss.retiredEntries}`)
  assert(loss.uncatalogedEntries === 0, `仍有 ${loss.uncatalogedEntries} 条在盘上却翻不到（本次事故形态）`)
  assert(
    loss.catalogEntries + loss.uncatalogedEntries + loss.retiredEntries === declared,
    `口径不自洽：${loss.catalogEntries} + ${loss.uncatalogedEntries} + ${loss.retiredEntries} ≠ ${declared}`
  )
  return `声明 ${declared} = 可翻 ${loss.catalogEntries} + 不可查 ${loss.uncatalogedEntries} + 退役 ${loss.retiredEntries}`
})

check('toSummary 也如实透出（面板不会再画满假进度）', () => {
  const s = toSummary(built.library)
  assert(s.catalogEntries === 4, `summary.catalogEntries=${s.catalogEntries}`)
  assert(s.uncatalogedEntries === 0, `summary.uncatalogedEntries=${s.uncatalogedEntries}`)
  assert(s.retiredEntries === 1, `summary.retiredEntries=${s.retiredEntries}`)
  return `面板口径：可翻 ${s.catalogEntries} / 不可查 ${s.uncatalogedEntries} / 退役 ${s.retiredEntries}`
})

check('兜底计数与明细进了 library.json（可 git 追溯，不只是日志）', () => {
  const lib = JSON.parse(readFileSync(join(root, 'library.json'), 'utf8'))
  assert(lib.counts.volumeFallback === 3, `counts.volumeFallback=${lib.counts.volumeFallback}`)
  assert(lib.counts.volumeFallbackTotal === 3, `counts.volumeFallbackTotal=${lib.counts.volumeFallbackTotal}`)
  assert(Array.isArray(lib.volumeFallbacks) && lib.volumeFallbacks.length === 3, 'volumeFallbacks 明细未落盘')
  assert(lib.volumeFallbacks.every((v) => v.to === 'vol-05'), '明细的 to 应全为 vol-05')
  const bad = lib.volumeFallbacks.find((v) => v.id === FIXTURES.badVolume.id)
  assert(bad && bad.from === 'vol-99', `明细里应记录 from=vol-99，实际 ${JSON.stringify(bad)}`)
  return `counts.volumeFallback=${lib.counts.volumeFallback} · 明细 ${lib.volumeFallbacks.length} 条含原值`
})

check('建库凭证 runs/ 里也记了兜底数（每批次可追）', () => {
  const runsDir = join(root, 'runs')
  // runId 形如 run-YYYYMMDD-HHmmss-xxxxxx，按文件名排序即按时间排序
  const files = readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort()
  assert(files.length >= 1, `runs/ 下应有建库凭证，实际 ${files.length}`)
  // 注意：finishReport 是 `...(extra.extra || {})` 平铺，所以 volumeFallback 在**顶层**，
  // 不在 latest.extra 里 —— 第一次写这条断言就写错了地方，记在这里免再审一遍。
  const first = JSON.parse(readFileSync(join(runsDir, files[0]), 'utf8'))
  assert(first.status === 'committed', `凭证 status=${first.status}`)
  assert(first.volumeFallback === 3, `首份凭证 volumeFallback=${JSON.stringify(first.volumeFallback)}`)
  return `${files.length} 份凭证，首批 volumeFallback=3（顶层字段）`
})

console.log('\n── 4. 幂等：复跑不得重复干活 ──')

const firstCatalog = JSON.stringify(built.library.volumes.map((v) => v.chapterList))
const firstFiles = entryFiles()
const firstMtime = statSync(join(entriesDir, FIXTURES.noVolume.id + '.json')).mtimeMs
const firstFallbackAt = readEntry(FIXTURES.noVolume.id).volumeFallbackAt

let again
check('复跑 created=0，条目数不变', () => {
  again = buildLibrary(EMPTY_TRIAGED, { root })
  assert(again.created === 0, `复跑竟然新建了 ${again.created} 条`)
  assert(again.entries === built.entries, `条目数变了：${built.entries} → ${again.entries}`)
  assert(again.kept === 0, `triaged 为空时 kept 应为 0（幂等分支未走到），实际 ${again.kept}`)
  return `created=0 · entries=${again.entries}`
})

check('复跑不再触发兜底（已经归一化过，不会反复打标记）', () => {
  assert(again.volumeFallback === 0, `复跑又兜底了 ${again.volumeFallback} 条（说明没写回磁盘或判据不稳）`)
  assert(again.volumeFallbacks.length === 0, '复跑仍有明细')
  const lib = JSON.parse(readFileSync(join(root, 'library.json'), 'utf8'))
  assert(lib.counts.volumeFallbackTotal === 3, `历史兜底总数应仍为 3，实际 ${lib.counts.volumeFallbackTotal}`)
  return 'volumeFallback=0 · volumeFallbackTotal 仍为 3（区分本次/累计）'
})

check('复跑目录逐条完全一致', () => {
  const secondCatalog = JSON.stringify(again.library.volumes.map((v) => v.chapterList))
  assert(secondCatalog === firstCatalog, '两次构建的 chapterList 不一致')
  return '两次 chapterList 字节级一致'
})

check('复跑不改写兜底时间戳（不制造伪变更）', () => {
  const nv = readEntry(FIXTURES.noVolume.id)
  assert(nv.volumeFallbackAt === firstFallbackAt, `volumeFallbackAt 被改写：${firstFallbackAt} → ${nv.volumeFallbackAt}`)
  return `volumeFallbackAt 保持 ${firstFallbackAt}`
})

check('复跑不增删文件（红线①：永不删除条目）', () => {
  const secondFiles = entryFiles()
  assert(secondFiles.length === firstFiles.length, `文件数变了：${firstFiles.length} → ${secondFiles.length}`)
  assert(secondFiles.join(',') === firstFiles.join(','), '文件清单变了')
  for (const f of firstFiles) assert(existsSync(join(entriesDir, f)), `${f} 消失了`)
  return `${secondFiles.length} 个条目文件，一条不少`
})

check('复跑后口径仍然自洽', () => {
  const loss = catalogLoss(again.library)
  assert(loss.uncatalogedEntries === 0, `复跑后出现了 ${loss.uncatalogedEntries} 条不可查`)
  assert(loss.catalogEntries === 4, `catalogEntries=${loss.catalogEntries}`)
  return `可翻 ${loss.catalogEntries} / 不可查 ${loss.uncatalogedEntries}`
})

// ── 收尾 ──────────────────────────────────────────────────────────
try {
  rmSync(sandbox, { recursive: true, force: true })
} catch {
  /* 清理失败不影响结论 */
}

console.log('\n── 8. 预加工册（data/*.json）的章归属 ──')
{
  // 【2026-11-08】实测踩到的坑：预加工册的章 slug 由 `'ch-' + ch.no` 生成，
  // 缺 `no` 字段时**所有条目会挤进同一个 ch-00**。这里钉住这个契约。
  const tmp = mkdtempSync(join(tmpdir(), 'ms-prebuilt-'))
  try {
    const dataDir = join(tmp, 'data')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'vol-06.json'), JSON.stringify({
      id: 'vol-06', no: 'VOL.06', name: '测试册', generatedAt: '2026-11-08T00:00:00.000Z',
      chapters: [
        { no: '01', slug: 'ch-a', title: '甲章', entries: [{ id: 'e-pre-a1', title: '甲一', claim: '甲章的结论一' }] },
        { no: '02', slug: 'ch-b', title: '乙章', entries: [{ id: 'e-pre-b1', title: '乙一', claim: '乙章的结论一' }, { id: 'e-pre-b2', title: '乙二', claim: '乙章的结论二' }] },
      ],
    }))
    const built = buildLibrary([], { root: join(tmp, 'lib'), dataDir })
    const v = built.library.volumes.find((x) => x.id === 'vol-06')
    check('预加工册被载入', () => {
      assert(v && v.entries === 3, v ? `entries=${v.entries}` : '缺册')
      return `entries=${v.entries}`
    })
    check('章按 no 分组（不是全部挤进 ch-00）', () => {
      assert(v.chapters === 2, `chapters=${v.chapters}`)
      return `chapters=${v.chapters}`
    })
    check('章 slug 与数据里的 no 对应', () => {
      const slugs = (v.chapterList || []).map((c) => c.slug).sort().join(',')
      assert(slugs === 'ch-01,ch-02', slugs)
      return slugs
    })
    check('多条目章内条目数正确', () => {
      const ch2 = (v.chapterList || []).find((c) => c.slug === 'ch-02')
      assert(ch2 && ch2.entries.length === 2, ch2 ? String(ch2.entries.length) : '缺章')
      return String(ch2.entries.length)
    })
    check('章标题保留数据里的中文名', () => {
      const ch2 = (v.chapterList || []).find((c) => c.slug === 'ch-02')
      assert(ch2 && ch2.title === '乙章', ch2 ? ch2.title : '缺章')
      return ch2.title
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('\n' + '═'.repeat(74))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail) {
  console.log('失败用例：')
  for (const f of failures) console.log('  ✗ ' + f)
}
console.log('═'.repeat(74))
process.exit(fail ? 1 : 0)
