/**
 * 书阁 · 启动自愈测试（P1-1）
 *
 * 原则：**用真实制造损坏来验证**，不 mock fs。
 * 每个用例都在 os.tmpdir() 下的独立临时库上跑，绝不碰 ~/.dsh/dsh-manuscript。
 *
 * 跑：node scripts/test-health.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { checkLibraryHealth, healLibrary, STAGING_MIN_AGE_MS } from '../lib/health.js'

let pass = 0
let fail = 0
const failures = []

function check(name, fn) {
  try {
    const detail = fn()
    pass += 1
    console.log(`✓ ${name}`)
    if (detail) console.log(`    ${detail}`)
  } catch (e) {
    fail += 1
    failures.push({ name, error: e })
    console.log(`✗ ${name}`)
    console.log(`    ${e?.message || String(e)}`)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const tmpRoots = []
function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'ms-health-'))
  tmpRoots.push(dir)
  return dir
}

/** 造一个健康的库：3 条条目 / 2 册（各带 MANUAL+TOC）。 */
function makeHealthyLibrary({ entries = 3, volumes = ['vol-01', 'vol-02'] } = {}) {
  const root = makeTmp()
  mkdirSync(join(root, 'entries'), { recursive: true })
  mkdirSync(join(root, 'volumes'), { recursive: true })
  mkdirSync(join(root, 'runs'), { recursive: true })

  for (let i = 1; i <= entries; i += 1) {
    const entry = { id: `e-${String(i).padStart(3, '0')}`, title: `条目 ${i}` }
    writeFileSync(join(root, 'entries', `${entry.id}.json`), JSON.stringify(entry, null, 2), 'utf8')
  }
  for (const v of volumes) {
    mkdirSync(join(root, 'volumes', v), { recursive: true })
    writeFileSync(join(root, 'volumes', v, 'MANUAL.md'), `# ${v}\n`, 'utf8')
    writeFileSync(join(root, 'volumes', v, 'TOC.md'), `# ${v} TOC\n`, 'utf8')
  }

  const library = {
    version: 1,
    generatedAt: new Date().toISOString(),
    counts: { total: entries, archived: entries, real: entries, entries },
    volumes: volumes.map((id) => ({ id, name: id, chapters: 1, entries: 0 })),
  }
  writeFileSync(join(root, 'library.json'), JSON.stringify(library, null, 2), 'utf8')
  return root
}

/** 把某个路径的 mtime 往前拨，制造"老残留"。 */
function age(path, ms) {
  const t = new Date(Date.now() - ms)
  utimesSync(path, t, t)
}

// ═══════════════════════════════════════════════════════════════════
// ① 正常库 → healthy
// ═══════════════════════════════════════════════════════════════════

check('正常库 → healthy，无 issue', () => {
  const root = makeHealthyLibrary()
  const r = checkLibraryHealth(root)
  assert(r.ok === true, `期望 ok=true，实际 ${r.ok}`)
  assert(r.level === 'healthy', `期望 healthy，实际 ${r.level}`)
  assert(r.issues.length === 0, `期望 0 issue，实际 ${r.issues.length}：${JSON.stringify(r.issues)}`)
  assert(r.facts.libraryJsonExists === true, 'libraryJsonExists 应为 true')
  assert(r.facts.libraryJsonParsable === true, 'libraryJsonParsable 应为 true')
  assert(r.facts.declaredEntries === 3, `declaredEntries 期望 3，实际 ${r.facts.declaredEntries}`)
  assert(r.facts.actualEntryFiles === 3, `actualEntryFiles 期望 3，实际 ${r.facts.actualEntryFiles}`)
  assert(r.facts.volumesOnDisk === 2, `volumesOnDisk 期望 2，实际 ${r.facts.volumesOnDisk}`)
  assert(Array.isArray(r.facts.stagingDirs) && r.facts.stagingDirs.length === 0, 'stagingDirs 应为空数组')
  assert(r.facts.orphanRuns === 0, `orphanRuns 期望 0，实际 ${r.facts.orphanRuns}`)
  return `counts ${r.facts.declaredEntries}=${r.facts.actualEntryFiles} · ${r.facts.volumesOnDisk} 册 · healthy`
})

// ═══════════════════════════════════════════════════════════════════
// ② 删 library.json → broken + 建议 rebuild
// ═══════════════════════════════════════════════════════════════════

check('删 library.json → broken，heal 建议 rebuild 且不写文件', () => {
  const root = makeHealthyLibrary()
  rmSync(join(root, 'library.json'))

  const r = checkLibraryHealth(root)
  assert(r.ok === false, `期望 ok=false，实际 ${r.ok}`)
  assert(r.level === 'broken', `期望 broken，实际 ${r.level}`)
  assert(r.issues.some((i) => i.code === 'library-missing'), '缺 library-missing issue')
  assert(r.facts.libraryJsonExists === false, 'libraryJsonExists 应为 false')

  // heal 必须只建议，不自己重建
  const h = healLibrary(root, { dryRun: false })
  assert(h.action === 'rebuild', `期望 action=rebuild，实际 ${h.action}`)
  assert(h.removed.length === 0, 'rebuild 路径不应删任何东西')
  assert(existsSync(join(root, 'library.json')) === false, 'heal 不应自己写 library.json')
  // 条目文件必须原样在
  assert(existsSync(join(root, 'entries', 'e-001.json')), '条目文件不应被动')
  return 'broken → advice rebuild · 未写 library.json · 条目完好'
})

// ═══════════════════════════════════════════════════════════════════
// ③ entries/ 加孤儿文件 → warn，dryRun 下文件仍在
// ═══════════════════════════════════════════════════════════════════

check('entries/ 孤儿文件 → warn；dryRun 下绝不删除', () => {
  const root = makeHealthyLibrary({ entries: 3 })
  writeFileSync(
    join(root, 'entries', 'e-orphan.json'),
    JSON.stringify({ id: 'e-orphan', title: '孤儿' }, null, 2),
    'utf8'
  )

  const r = checkLibraryHealth(root)
  assert(r.level === 'warn', `期望 warn，实际 ${r.level}`)
  assert(r.ok === true, 'warn 仍应 ok=true（能跑，只是不干净）')
  const miss = r.issues.find((i) => i.code === 'entry-count-mismatch-extra')
  assert(miss, `缺 entry-count-mismatch-extra，实际 ${JSON.stringify(r.issues.map((i) => i.code))}`)
  assert(miss.severity === 'warn', '孤儿应是 warn 不是 error')
  assert(miss.fixable === false, '孤儿文件不应标 fixable（永不自动删）')
  assert(r.facts.declaredEntries === 3 && r.facts.actualEntryFiles === 4, '计数应为 3 vs 4')

  // dryRun（默认）→ 文件必须还在
  const h = healLibrary(root)
  assert(h.dryRun === true, '默认必须是 dryRun=true')
  assert(h.removed.length === 0, 'dryRun 不应删任何东西')
  assert(existsSync(join(root, 'entries', 'e-orphan.json')), 'dryRun 后孤儿文件必须存在')

  // 即使显式 dryRun:false，也**不许**删条目
  const h2 = healLibrary(root, { dryRun: false })
  assert(h2.removed.length === 0, `非 dryRun 也不应删条目，实际删了 ${JSON.stringify(h2.removed)}`)
  assert(existsSync(join(root, 'entries', 'e-orphan.json')), '★红线：孤儿条目文件必须仍在')
  return '孤儿只报告 · dryRun=true 默认 · 显式 false 也不删条目'
})

// ═══════════════════════════════════════════════════════════════════
// ④ .staging-old/ → warn，非 dryRun 下被清理
// ═══════════════════════════════════════════════════════════════════

check('.staging-old/ → warn；dryRun 保留，非 dryRun 清理', () => {
  const root = makeHealthyLibrary()
  const staging = join(root, '.staging-old')
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(staging, 'partial.json'), '{"half":', 'utf8')
  age(staging, STAGING_MIN_AGE_MS + 5 * 60 * 1000) // 拨到 1 小时前

  const r = checkLibraryHealth(root)
  assert(r.level === 'warn', `期望 warn，实际 ${r.level}`)
  const residue = r.issues.find((i) => i.code === 'staging-residue')
  assert(residue, `缺 staging-residue，实际 ${JSON.stringify(r.issues.map((i) => i.code))}`)
  assert(residue.fixable === true, '过期 staging 应标 fixable=true')
  assert(r.facts.stagingDirs.includes('.staging-old'), 'stagingDirs 应含 .staging-old')

  // dryRun：只报告
  const dry = healLibrary(root, { dryRun: true })
  assert(dry.wouldRemove.includes('.staging-old'), `dryRun 应报告将删，实际 ${JSON.stringify(dry)}`)
  assert(existsSync(staging) === true, 'dryRun 后 .staging-old 必须还在')

  // 非 dryRun：真删
  const real = healLibrary(root, { dryRun: false })
  assert(real.removed.includes('.staging-old'), `应真删，实际 removed=${JSON.stringify(real.removed)}`)
  assert(existsSync(staging) === false, '非 dryRun 后 .staging-old 应被清理')
  // 清完应回 healthy
  const after = checkLibraryHealth(root)
  assert(after.level === 'healthy', `清理后应 healthy，实际 ${after.level}`)
  return 'dryRun 只报告 · 非 dryRun 清理 · 清完回 healthy'
})

check('新鲜的 .staging-*（未满 1 小时）绝不被删', () => {
  const root = makeHealthyLibrary()
  const fresh = join(root, '.staging-live')
  mkdirSync(fresh, { recursive: true })
  writeFileSync(join(fresh, 'wip.json'), '{}', 'utf8') // 刚创建，未拨时间

  const h = healLibrary(root, { dryRun: false })
  assert(!h.removed.includes('.staging-live'), '新鲜的 staging 不应被删')
  assert(existsSync(fresh) === true, '★正在写的 staging 必须保留')
  const kept = h.kept.find((k) => k.name === '.staging-live')
  assert(kept, '应记录到 kept 并说明原因')
  return `保留原因：${kept.reason}`
})

// ═══════════════════════════════════════════════════════════════════
// ⑤ library.json 截断 → broken
// ═══════════════════════════════════════════════════════════════════

check('library.json 被截断 → broken + 不可解析', () => {
  const root = makeHealthyLibrary()
  const p = join(root, 'library.json')
  const full = readFileSync(p, 'utf8')
  writeFileSync(p, full.slice(0, Math.floor(full.length / 2)), 'utf8') // 模拟断电截断

  const r = checkLibraryHealth(root)
  assert(r.ok === false, '截断应 ok=false')
  assert(r.level === 'broken', `期望 broken，实际 ${r.level}`)
  assert(r.facts.libraryJsonExists === true, '文件仍在 → exists=true')
  assert(r.facts.libraryJsonParsable === false, '应判为不可解析')
  assert(r.issues.some((i) => i.code === 'library-unparsable'), '缺 library-unparsable')

  const h = healLibrary(root, { dryRun: false })
  assert(h.action === 'rebuild', `期望 rebuild，实际 ${h.action}`)
  return '截断 → broken · 建议 rebuild · 不自行覆盖'
})

// ═══════════════════════════════════════════════════════════════════
// ⑥ 其它：缺条目 / 坏条目 / 分册缺 md / 失败报告 / 根目录不存在
// ═══════════════════════════════════════════════════════════════════

check('声明数 > 实际文件 → error（有文件丢失）', () => {
  const root = makeHealthyLibrary({ entries: 3 })
  rmSync(join(root, 'entries', 'e-003.json')) // 人为误删

  const r = checkLibraryHealth(root)
  assert(r.level === 'broken', `缺文件应 broken，实际 ${r.level}`)
  const miss = r.issues.find((i) => i.code === 'entry-count-mismatch-missing')
  assert(miss, '缺 entry-count-mismatch-missing')
  assert(miss.severity === 'error', '缺文件应是 error')
  assert(r.facts.declaredEntries === 3 && r.facts.actualEntryFiles === 2, '应为 3 vs 2')

  const h = healLibrary(root, { dryRun: false })
  assert(h.advice.some((a) => a.includes('条目永不自动删除')), '应提示不自动删条目')
  return '3 声明 vs 2 实际 → broken · 只建议人工核对'
})

check('条目 JSON 损坏 → error，且不自动删', () => {
  const root = makeHealthyLibrary({ entries: 3 })
  const bad = join(root, 'entries', 'e-002.json')
  writeFileSync(bad, '{"broken":', 'utf8')

  const r = checkLibraryHealth(root)
  assert(r.issues.some((i) => i.code === 'entry-unparsable'), '缺 entry-unparsable')
  const h = healLibrary(root, { dryRun: false })
  assert(existsSync(bad) === true, '★坏条目也不许自动删')
  assert(h.removed.length === 0, '不应删任何条目')
  return '坏条目只报告 · 文件保留'
})

check('分册缺 MANUAL.md / TOC.md → warn', () => {
  const root = makeHealthyLibrary()
  rmSync(join(root, 'volumes', 'vol-01', 'MANUAL.md'))
  rmSync(join(root, 'volumes', 'vol-02', 'TOC.md'))

  const r = checkLibraryHealth(root)
  assert(r.level === 'warn', `期望 warn，实际 ${r.level}`)
  assert(r.issues.some((i) => i.code === 'volume-manual-missing'), '缺 volume-manual-missing')
  assert(r.issues.some((i) => i.code === 'volume-toc-missing'), '缺 volume-toc-missing')
  return 'MANUAL/TOC 缺失分别报 warn'
})

check('runs/ 有 status=failed → 计入 orphanRuns', () => {
  const root = makeHealthyLibrary()
  writeFileSync(join(root, 'runs', 'r1.json'), JSON.stringify({ status: 'failed' }), 'utf8')
  writeFileSync(join(root, 'runs', 'r2.json'), JSON.stringify({ status: 'ok' }), 'utf8')
  writeFileSync(join(root, 'runs', 'r3.json'), JSON.stringify({ ok: false }), 'utf8')

  const r = checkLibraryHealth(root)
  assert(r.facts.orphanRuns === 2, `期望 2 份 failed，实际 ${r.facts.orphanRuns}`)
  assert(r.issues.some((i) => i.code === 'runs-failed'), '缺 runs-failed issue')
  const h = healLibrary(root, { dryRun: false })
  assert(existsSync(join(root, 'runs', 'r1.json')), '★runs 报告永不自动删')
  return 'failed 计数正确 · 报告永不自动删'
})

check('根目录不存在 → broken，不抛异常', () => {
  const r = checkLibraryHealth(join(tmpdir(), 'ms-health-does-not-exist-xyz'))
  assert(r.ok === false, 'ok 应为 false')
  assert(r.level === 'broken', 'level 应为 broken')
  assert(r.issues.some((i) => i.code === 'root-missing'), '缺 root-missing')
  return '不存在的根目录安全返回 broken'
})

check('heal 在不像书库的目录上拒绝动手', () => {
  const empty = makeTmp()
  const h = healLibrary(empty, { dryRun: false })
  assert(h.removed.length === 0, '不应删任何东西')
  assert(h.advice.some((a) => a.includes('未做任何操作')), '应说明未操作')
  return '非书库目录 → 不操作'
})

// ═══════════════════════════════════════════════════════════════════
// ⑧ 交叉一致性：文件在盘上 ≠ Agent 翻得到（2026-11-02 事故回归）
//
// 事故原貌：7 条条目文件真实存在、也计入 counts.entries，但不在任何册的
// chapterList 里。目录注入显示满额数字，而 manual_recall 查不到，
// health 只比 declared==actual 也发现不了。这三条测试锁定修复。
// ═══════════════════════════════════════════════════════════════════

/** 造一个带 chapterList 的库：entries 里放 total 条，其中前 visible 条挂进目录。 */
function makeCatalogLibrary({ total = 4, visible = 3 } = {}) {
  const root = makeTmp()
  mkdirSync(join(root, 'entries'), { recursive: true })
  mkdirSync(join(root, 'volumes', 'vol-01'), { recursive: true })
  mkdirSync(join(root, 'runs'), { recursive: true })

  const inCatalog = []
  for (let i = 1; i <= total; i += 1) {
    const id = `e-${String(i).padStart(3, '0')}`
    writeFileSync(
      join(root, 'entries', `${id}.json`),
      JSON.stringify({ id, title: `正常条目 ${i}`, claim: '这是一条完整的中文结论，内容正常' }, null, 2),
      'utf8'
    )
    if (i <= visible) inCatalog.push({ id, title: `正常条目 ${i}` })
  }

  const library = {
    version: 1,
    generatedAt: new Date().toISOString(),
    counts: { total, archived: total, real: total, entries: total },
    volumes: [
      {
        id: 'vol-03',
        no: 'VOL.03',
        name: '测试册',
        chapters: 1,
        entries: inCatalog.length,
        chapterList: [{ slug: 'ch-01', title: '测试章', entries: inCatalog }],
        inbox: false,
      },
    ],
  }
  writeFileSync(join(root, 'library.json'), JSON.stringify(library, null, 2), 'utf8')
  writeFileSync(join(root, 'volumes', 'vol-01', 'MANUAL.md'), '# v\n', 'utf8')
  writeFileSync(join(root, 'volumes', 'vol-01', 'TOC.md'), '# v\n', 'utf8')
  return root
}

check('条目在盘上但不在目录里 → warn，且如实暴露差额', () => {
  const root = makeCatalogLibrary({ total: 4, visible: 3 })
  const r = checkLibraryHealth(root)
  // declared 与 actual 相等（4 == 4），旧判据在这里会放行 —— 正是漏报的原因
  assert(r.facts.declaredEntries === 4 && r.facts.actualEntryFiles === 4, '本例中计数应当相等（这才是盲区）')
  assert(r.level === 'warn', `期望 warn，实际 ${r.level}`)
  const iss = r.issues.find((i) => i.code === 'entry-not-in-catalog')
  assert(iss, `缺 entry-not-in-catalog，实际 ${JSON.stringify(r.issues.map((i) => i.code))}`)
  assert(iss.severity === 'warn', '不可查应是 warn（丢失可接受，但必须标出来）')
  assert(iss.fixable === false, '★绝不自动处理条目（红线：永不自动删除）')
  assert(r.facts.uncatalogedEntries === 1, `uncatalogedEntries 期望 1，实际 ${r.facts.uncatalogedEntries}`)
  return `4 条在盘 / 3 条可翻 → 报 1 条不可查 · 仍 ok=${r.ok}`
})

check('条目正文变成问号替身 → warn（JSON 合法，语法检查查不出）', () => {
  const root = makeCatalogLibrary({ total: 3, visible: 3 })
  // 典型损坏形态：中文全被替换成问号，但 JSON 完全合法、字段齐全
  writeFileSync(
    join(root, 'entries', 'e-001.json'),
    JSON.stringify(
      {
        id: 'e-001',
        title: '?? NAS ??? Gitea ???????? Gitea ?????',
        claim: '??? NAS ????? Gitea ???,??????:?????????????? Gitea ????,??????????????',
      },
      null,
      2
    ),
    'utf8'
  )
  const r = checkLibraryHealth(root)
  assert(r.level === 'warn', `期望 warn，实际 ${r.level}`)
  const iss = r.issues.find((i) => i.code === 'entry-content-damaged')
  assert(iss, `缺 entry-content-damaged，实际 ${JSON.stringify(r.issues.map((i) => i.code))}`)
  assert(r.facts.damagedEntries === 1, `damagedEntries 期望 1，实际 ${r.facts.damagedEntries}`)
  // 关键：不能被当成"不可查"误报 —— 它在目录里，只是内容坏了。两种损失必须分开计。
  assert(r.facts.uncatalogedEntries === 0, `损坏条目不应算作不可查，实际 ${r.facts.uncatalogedEntries}`)
  return '正文损坏被单独识别 · 未误判为不可查'
})

check('库没有 chapterList 结构 → 跳过判定，绝不误报满屏孤儿', () => {
  // makeHealthyLibrary 的 volumes 没有 chapterList 字段（老库/夹具形态）
  const root = makeHealthyLibrary()
  const r = checkLibraryHealth(root)
  assert(r.facts.uncatalogedEntries === null, `无法判断时应为 null，实际 ${r.facts.uncatalogedEntries}`)
  assert(r.facts.damagedEntries === null, `无法判断时应为 null，实际 ${r.facts.damagedEntries}`)
  assert(r.level === 'healthy', `不应因此降级，实际 ${r.level}`)
  assert(!r.issues.some((i) => i.code === 'entry-not-in-catalog'), '不得误报 entry-not-in-catalog')
  return '无目录结构 → facts 置 null · 不误报 · 级别不变'
})

// ═══════════════════════════════════════════════════════════════════
// ⑨ 骨架退役：expired 是主动退役，不能算作"丢失"
//
// 事故背景：14 条骨架被标 expired 后从目录剔除，体检却把它们
// 报成 entry-not-in-catalog，孤儿数从 7 跳到 21。
// 主动退役与意外丢失必须分开计数，否则体检天天误报，最后没人再看。
// ═══════════════════════════════════════════════════════════════════

check('expired 条目不计入"不可查"，单独记为已退役', () => {
  const root = makeCatalogLibrary({ total: 4, visible: 3 })
  // 把第 4 条（本来就不在目录里）标成 expired
  const p4 = join(root, 'entries', 'e-004.json')
  const e4 = JSON.parse(readFileSync(p4, 'utf8'))
  writeFileSync(p4, JSON.stringify({ ...e4, status: 'expired' }, null, 2), 'utf8')

  const r = checkLibraryHealth(root)
  assert(r.facts.retiredEntries === 1, `retiredEntries 期望 1，实际 ${r.facts.retiredEntries}`)
  assert(r.facts.uncatalogedEntries === 0, `expired 不应算作不可查，实际 ${r.facts.uncatalogedEntries}`)
  assert(
    !r.issues.some((i) => i.code === 'entry-not-in-catalog'),
    'expired 条目不得触发 entry-not-in-catalog'
  )
  assert(r.level === 'healthy', `只有退役不应降级，实际 ${r.level}`)
  return '1 条 expired → retiredEntries=1 · uncataloged=0 · 仍 healthy'
})

check('退役的条目文件绝不删除（红线①）', () => {
  const root = makeCatalogLibrary({ total: 2, visible: 2 })
  writeFileSync(
    join(root, 'entries', 'e-001.json'),
    JSON.stringify({ id: 'e-001', title: '骨架', claim: 'x', status: 'expired' }, null, 2),
    'utf8'
  )
  const r = checkLibraryHealth(root)
  assert(r.facts.retiredEntries === 1, 'retiredEntries 应为 1')
  // 文件必须还在
  assert(existsSync(join(root, 'entries', 'e-001.json')), '★expired 条目的文件必须保留')
  // heal 也不能删它
  const h = healLibrary(root, { dryRun: false })
  assert(h.removed.length === 0, `heal 不应删任何东西，实际删了 ${JSON.stringify(h.removed)}`)
  assert(existsSync(join(root, 'entries', 'e-001.json')), '★heal 后文件仍须存在')
  return 'expired 文件保留 · heal 零删除'
})

// ═══════════════════════════════════════════════════════════════════
// ⑦ 安全检查：heal 永不碰 entries/ volumes/ runs/ 里的东西
// ═══════════════════════════════════════════════════════════════════

check('★红线总检：一次性造齐所有诱因，heal 只删过期 staging', () => {
  const root = makeHealthyLibrary({ entries: 4 })
  // 诱因：孤儿条目 + 坏条目 + 缺 MANUAL + 失败报告 + 老 staging + 新 staging
  writeFileSync(join(root, 'entries', 'e-orphan.json'), '{"id":"e-orphan"}', 'utf8')
  writeFileSync(join(root, 'entries', 'e-001.json'), '{"truncated":', 'utf8')
  rmSync(join(root, 'volumes', 'vol-01', 'MANUAL.md'))
  writeFileSync(join(root, 'runs', 'boom.json'), JSON.stringify({ status: 'failed' }), 'utf8')
  const oldStage = join(root, '.staging-old')
  mkdirSync(oldStage, { recursive: true })
  age(oldStage, STAGING_MIN_AGE_MS + 60_000)
  const newStage = join(root, '.staging-new')
  mkdirSync(newStage, { recursive: true })
  const tmpFile = join(root, '.tmp-cache')
  writeFileSync(tmpFile, 'x', 'utf8')
  age(tmpFile, STAGING_MIN_AGE_MS + 60_000)

  const entriesBefore = readFileSync(join(root, 'entries', 'e-002.json'), 'utf8')
  const volumesBefore = existsSync(join(root, 'volumes', 'vol-01', 'TOC.md'))

  const h = healLibrary(root, { dryRun: false })

  // 只应删这两个
  assert(h.removed.includes('.staging-old'), '应删过期 .staging-old')
  assert(h.removed.includes('.tmp-cache'), '应删过期 .tmp-cache')
  assert(!h.removed.includes('.staging-new'), '不应删新鲜 .staging-new')

  // 知识三区必须原样
  assert(existsSync(join(root, 'entries', 'e-orphan.json')), '★孤儿条目必须还在')
  assert(readFileSync(join(root, 'entries', 'e-002.json'), 'utf8') === entriesBefore, '★正常条目内容未变')
  assert(existsSync(join(root, 'volumes', 'vol-01')), '★分册目录必须还在')
  assert(existsSync(join(root, 'volumes', 'vol-01', 'TOC.md')) === volumesBefore, '★分册文件未变')
  assert(existsSync(join(root, 'runs', 'boom.json')), '★失败报告必须还在')
  assert(existsSync(newStage), '★新鲜 staging 必须还在')

  return `removed=${JSON.stringify(h.removed)} · entries/volumes/runs 零删除`
})

// ═══════════════════════════════════════════════════════════════════
// 清理
// ═══════════════════════════════════════════════════════════════════

for (const dir of tmpRoots) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响结论
  }
}

console.log('')
console.log('═'.repeat(74))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail > 0) {
  console.log('')
  for (const f of failures) {
    console.log(`失败：${f.name}`)
    console.log(`  ${f.error?.stack || f.error}`)
  }
  process.exit(1)
}
