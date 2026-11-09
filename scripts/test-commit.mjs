#!/usr/bin/env node
/**
 * lib/commit.js 的测试。
 *
 * 这个模块负责"把裁决通过的条目真正写进书库"，是整条链路的落盘点。
 * 它出错后果最严重：
 *   · counts 与磁盘不一致 → health 报 broken
 *   · 覆盖已有条目 → 人工修正过的东西丢失
 *   · 写入不该存在的字段 → buildLibrary 重建时被抹掉，看起来"数据丢了"
 *
 * ## 【结构真相 · 2026-11-02 搞错过的】
 *
 * library.json 的真实结构是：
 *   { version, generatedAt, counts, stages, byVolume, volumes }
 *
 * **没有顶层 entries 数组** —— 条目明细的真相在 entries/ 目录里。
 *
 * 我一度以为"entries 数组被清空"是数据损坏，于是写了"从磁盘重建数组"的代码，
 * 还加了"数组不能清空"的回归测试，甚至真的往 library.json 里写入过这个字段。
 * 那全是基于错误假设：这个字段本来就不该存在，buildLibrary 每次重建都会移除它。
 *
 * 所以本文件的夹具按**真实结构**造，绝不造 entries 数组。
 */

import { commitEntries, readLibraryJson } from '../lib/commit.js'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const failures = []
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`✓ ${name}${extra ? '  ' + extra : ''}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`✗ ${name}${extra ? '  ' + extra : ''}`)
  }
}

/**
 * 造一个**符合真实结构**的最小书库。
 * library.json 里没有 entries 数组，只有 counts / stages / byVolume / volumes。
 */
function mkLib(root, ids = ['e-old']) {
  mkdirSync(join(root, 'entries'), { recursive: true })
  mkdirSync(join(root, 'runs'), { recursive: true })
  for (const id of ids) {
    writeFileSync(join(root, 'entries', id + '.json'), JSON.stringify({ id, title: '旧条目 ' + id }), 'utf8')
  }
  writeFileSync(
    join(root, 'library.json'),
    JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      counts: { entries: ids.length, real: ids.length },
      stages: { distilled: 0 },
      byVolume: {},
      volumes: [],
    }),
    'utf8'
  )
}

const diskCount = (root) => readdirSync(join(root, 'entries')).filter((f) => f.endsWith('.json')).length

console.log('\n── 1. 基本写入 ──')

let root = mkdtempSync(join(tmpdir(), 'c1-'))
mkLib(root)
let r = commitEntries(
  [
    { id: 'e-new1', title: '新条目一', claim: '内容一' },
    { id: 'e-new2', title: '新条目二', claim: '内容二' },
  ],
  { root }
)
check('入册 2 条成功', r.ok && r.written === 2, `written=${r.written} skipped=${r.skipped}`)

let lib = readLibraryJson(root)
check('磁盘文件数 +2', diskCount(root) === 3, `${diskCount(root)} 个`)
check('counts.entries 同步更新', lib.counts.entries === 3, `counts=${lib.counts.entries}`)
check('旧条目文件仍在', existsSync(join(root, 'entries', 'e-old.json')))
check('新条目文件已写', existsSync(join(root, 'entries', 'e-new1.json')))
check(
  '新条目有 committedAt',
  JSON.parse(readFileSync(join(root, 'entries', 'e-new1.json'), 'utf8')).committedAt !== undefined
)

// 【结构回归】绝不能往 library.json 里塞 entries 数组
check('不写顶层 entries 数组（真实结构回归）', lib.entries === undefined, `entries=${typeof lib.entries}`)
check('保留原有 volumes 字段', Array.isArray(lib.volumes))

console.log('\n── 2. 不覆盖已有数据（最关键）──')

r = commitEntries([{ id: 'e-old', title: '试图覆盖旧条目', claim: '不应该覆盖' }], { root })
check('ID 冲突自动避让', r.ok && r.ids[0] !== 'e-old', `新 id=${r.ids[0]}`)

// 注意：上一句已经入册过一次 e-old，所以这次 uniqueId 会给到 e-old-2，
// 而 e-old.json 本身必须原封不动。直接读原文件验证。
const oldFile = JSON.parse(readFileSync(join(root, 'entries', 'e-old.json'), 'utf8'))
// mkLib 造的 title 是 '旧条目 ' + id（带 id 后缀），断言要用实际值
check('旧条目文件未被改', oldFile.title === '旧条目 e-old', JSON.stringify(oldFile.title))
check('避让后的新 id 确实不同', r.ids[0] === 'e-old-2', `id=${r.ids[0]}`)
check('原文件与新文件同时存在', existsSync(join(root, 'entries', 'e-old.json')) && existsSync(join(root, 'entries', 'e-old-2.json')))

console.log('\n── 3. 总账里没有 entries 字段时也不受影响 ──')

root = mkdtempSync(join(tmpdir(), 'c2-'))
mkLib(root, ['d1', 'd2', 'd3'])
lib = readLibraryJson(root)
check('夹具符合真实结构（无 entries 字段）', lib.entries === undefined)

r = commitEntries([{ id: 'new1', title: '新入册条目', claim: '内容' }], { root })
lib = readLibraryJson(root)
check('无 entries 字段时仍能正确入册', r.ok && r.written === 1, `written=${r.written}`)
check('磁盘总数正确（3 旧 + 1 新）', diskCount(root) === 4, `${diskCount(root)} 个`)
check('counts 与磁盘一致', lib.counts.entries === diskCount(root), `counts=${lib.counts.entries} 磁盘=${diskCount(root)}`)
check('仍未写入 entries 字段', lib.entries === undefined)
rmSync(root, { recursive: true, force: true })

console.log('\n── 4. 拒绝危险操作 ──')

root = mkdtempSync(join(tmpdir(), 'c3-'))
mkdirSync(join(root, 'entries'), { recursive: true })
writeFileSync(join(root, 'library.json'), '{"broken":', 'utf8')
r = commitEntries([{ id: 'x', title: 't', claim: 'c' }], { root })
check('总账损坏时拒绝写入', r.ok === false && /缺失或损坏/.test(r.reason), r.reason)
check('拒绝时不留文件', diskCount(root) === 0)
rmSync(root, { recursive: true, force: true })

root = mkdtempSync(join(tmpdir(), 'c4-'))
mkdirSync(join(root, 'entries'), { recursive: true })
r = commitEntries([{ id: 'y', title: 't', claim: 'c' }], { root })
check('总账缺失时同样拒绝', r.ok === false && /缺失或损坏/.test(r.reason), r.reason)
rmSync(root, { recursive: true, force: true })

console.log('\n── 5. 边界与安全 ──')

root = mkdtempSync(join(tmpdir(), 'c5-'))
mkLib(root)
check('空数组安全', commitEntries([], { root }).written === 0)
check('null 安全', commitEntries(null, { root }).written === 0)
check('非对象元素被过滤', commitEntries([null, 42, 'x'], { root }).written === 0)

commitEntries([{ id: 'seq1', title: '顺序第一条', claim: '内容' }], { root })
commitEntries([{ id: 'seq2', title: '顺序第二条', claim: '内容' }], { root })
check(
  '连续入册累积不覆盖',
  existsSync(join(root, 'entries', 'seq1.json')) && existsSync(join(root, 'entries', 'seq2.json'))
)
check('连续入册后 counts 仍一致', readLibraryJson(root).counts.entries === diskCount(root))

console.log('\n── 6. ID 清洗 ──')

const weird = commitEntries([{ id: 'a/b\\c d:e', title: '怪 ID 测试条目', claim: '内容' }], { root })
check('怪字符被清洗', weird.ok && weird.written === 1, `id=${weird.ids[0]}`)
check('清洗后无路径分隔符', !/[/\\:]/.test(weird.ids[0] || ''), weird.ids[0])
rmSync(root, { recursive: true, force: true })

console.log('\n── 7. 归属册兜底：绝不制造孤儿（2026-11-02 事故回归）──')

root = mkdtempSync(join(tmpdir(), 'c7-'))
mkLib(root)
r = commitEntries(
  [
    { id: 'noVol', title: '没有 volume 的条目', claim: '内容' },
    { id: 'blankVol', title: 'volume 是空白的条目', claim: '内容', volume: '   ' },
  ],
  { root }
)
check('无 volume 条目仍可入册', r.ok && r.written === 2, `written=${r.written}`)
const noVol = JSON.parse(readFileSync(join(root, 'entries', 'noVol.json'), 'utf8'))
const blankVol = JSON.parse(readFileSync(join(root, 'entries', 'blankVol.json'), 'utf8'))
check('无 volume → 兜底进收件箱 vol-05', noVol.volume === 'vol-05', `volume=${JSON.stringify(noVol.volume)}`)
check('空白 volume → 同样兜底 vol-05', blankVol.volume === 'vol-05', `volume=${JSON.stringify(blankVol.volume)}`)
check('兜底条目被标记 needsReview', noVol.needsReview === true, `needsReview=${noVol.needsReview}`)

// 有 volume 的条目必须原样保留，不能被兜底逻辑改写覆盖
r = commitEntries([{ id: 'hasVol', title: '已有卷的条目', claim: '内容', volume: 'vol-01' }], { root })
const hasVol = JSON.parse(readFileSync(join(root, 'entries', 'hasVol.json'), 'utf8'))
check('已有 volume 不被覆盖', hasVol.volume === 'vol-01', `volume=${JSON.stringify(hasVol.volume)}`)

// ★核心断言：入册后不该产生"在盘上但不在目录里"的条目
const libAfter = readLibraryJson(root)
check(
  '入册未改变 counts 一致性（兜底不破坏计数）',
  libAfter.counts.entries === diskCount(root),
  `counts=${libAfter.counts.entries} disk=${diskCount(root)}`
)
rmSync(root, { recursive: true, force: true })

console.log('\n── 6. 入册口的最小校验（2026-11-07 实测修复）──')

// 【实测缺陷】POST /distill/commit body {"entries":[{"title":"缺字段"}]}
// 曾返回 200 written:1 ids:[""]，并在磁盘上写出隐藏文件 entries/.json：
// 计入 counts、ls 看不见、人工清理也注意不到。
root = mkdtempSync(join(tmpdir(), 'c6-'))
mkLib(root)
const diskBefore = diskCount(root)

r = commitEntries([{ title: '缺字段' }], { root })
check('缺 claim 的条目被拒', r.ok && r.written === 0 && r.skipped === 1, `written=${r.written} skipped=${r.skipped}`)
check('被拒时说明原因', r.rejected?.[0]?.reason === '缺 claim', JSON.stringify(r.rejected))
check('被拒条目不留文件（尤其不产生 .json）', diskCount(root) === diskBefore && !existsSync(join(root, 'entries', '.json')), `disk ${diskBefore} -> ${diskCount(root)}`)

r = commitEntries([{ title: '   ', claim: '有内容' }], { root })
check('空白 title 被拒', r.written === 0 && r.rejected?.[0]?.reason === '缺 title', JSON.stringify(r.rejected))

r = commitEntries([{ title: '纯中文 id 条目', claim: '内容', volume: 'vol-01', id: '中文编号' }], { root })
check('纯中文 id 不再退化成 .json', r.written === 1 && /^e-[0-9a-f]{12}$/.test(r.ids[0] || ''), `id=${r.ids[0]}`)
check('该条目文件名是正常 id', existsSync(join(root, 'entries', (r.ids[0] || '') + '.json')), r.ids[0])

const derived = commitEntries([{ title: '另一条纯中文', claim: '也该得到确定性 id', volume: 'vol-01' }], { root })
check('无 id 的中文条目也得到确定性 id', derived.written === 1 && /^e-[0-9a-f]{12}$/.test(derived.ids[0] || ''), `id=${derived.ids[0]}`)

rmSync(root, { recursive: true, force: true })

console.log('\n── 7. 幂等：同一条内容不重复入册（2026-11-07 实测修复）──')

// 【实测缺陷】同一条 proposal 连提交两次，得到 e-xxx 与 e-xxx-2 两条内容相同的条目。
// 根因：冲突时 uniqueId 抢先加后缀，使后面那句 byId.has(id) 的去重分支永远不成立。
root = mkdtempSync(join(tmpdir(), 'c7-'))
mkLib(root)

const once = { id: 'e-dup', title: '重复提交测试', claim: '这段内容应该只入册一次', volume: 'vol-01' }
r = commitEntries([once], { root })
check('首次入册成功', r.written === 1 && r.skipped === 0, `written=${r.written}`)
const firstId = r.ids[0]

r = commitEntries([once], { root })
check('同一条再提交 → 跳过', r.written === 0 && r.skipped === 1, `written=${r.written} skipped=${r.skipped}`)
check('跳过时说明撞到了哪条', r.duplicates?.[0]?.existingId === firstId, JSON.stringify(r.duplicates))
check('库里仍只有一份', diskCount(root) === 2, `disk=${diskCount(root)}（1 条夹具 + 1 条新条目）`)

// 换 id 但内容相同，同样应判重：判重看内容，不看调用方给的 id
r = commitEntries([{ ...once, id: 'e-dup-other-id' }], { root })
check('换 id 但内容相同 → 仍然跳过', r.written === 0 && r.skipped === 1, `written=${r.written}`)

// 同一批次里的两条相同内容
r = commitEntries([{ title: '批内重复', claim: '同一批里出现两次' }, { title: '批内重复', claim: '同一批里出现两次' }], { root })
check('同一批内的重复只写一条', r.written === 1 && r.skipped === 1, `written=${r.written} skipped=${r.skipped}`)

// 反向：id 相同但内容不同 → 仍按避让写入（既有行为不能丢）
r = commitEntries([{ id: 'e-dup', title: '内容不同的另一条', claim: '这条必须被写进去' }], { root })
check('同 id 不同内容仍按后缀避让写入', r.written === 1 && r.ids[0] === firstId + '-2', `id=${r.ids[0]}`)

rmSync(root, { recursive: true, force: true })

console.log('\n── 8. 危险 id 一律改用内容派生的 id（2026-11-08）──')

// 【实测缺陷】只处理了"清洗后为空"一种情况，仍有四种 id 能写出坏文件名：
//   `.hidden`（隐藏文件，ls 看不见）、`..`、200 字符（超 NAME_MAX）、`CON`（Windows 设备名）
// 内容本身合法，坏的是调用方随手给的名字 —— 所以改 id，不拒绝入册。
root = mkdtempSync(join(tmpdir(), 'c8-'))
mkLib(root)

const badIds = ['.hidden', '..', '../escape', 'CON', 'x'.repeat(200)]
for (const id of badIds) {
  r = commitEntries([{ id, title: '标题-' + id.slice(0, 6), claim: '内容内容内容内容' }], { root })
  check(`危险 id ${JSON.stringify(id.slice(0, 10))} 被改用派生 id`,
    r.written === 1 && /^e-[0-9a-f]{12}$/.test(r.ids[0] || ''),
    `id=${r.ids[0]}`)
}
const names = readdirSync(join(root, 'entries')).filter((f) => f.endsWith('.json'))
check('没有产生隐藏文件/怪文件名', names.every((f) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.json$/.test(f)), JSON.stringify(names.slice(0, 5)))
check('文件名长度都在 NAME_MAX 安全范围', names.every((f) => f.length <= 70), `最长 ${Math.max(...names.map((f) => f.length))}`)

// 反向：正常 id 必须原样保留（不能"一刀切"全改成哈希）
r = commitEntries([{ id: 'e-normal-id', title: '正常 id 条目', claim: '内容内容内容内容' }], { root })
check('正常 id 不被改写', r.ids[0] === 'e-normal-id', r.ids[0])

rmSync(root, { recursive: true, force: true })

console.log('\n── 9. 设备标识与时间戳（多设备同步要用）──')
root = mkdtempSync(join(tmpdir(), 'c9-'))
mkLib(root)

// 设备标识：默认取主机名，可由 DSH_MANUSCRIPT_DEVICE 覆盖
const savedDevice = process.env.DSH_MANUSCRIPT_DEVICE
process.env.DSH_MANUSCRIPT_DEVICE = '  书房·PC1  '
const { deviceId } = await import('../lib/identity.js')
check('deviceId 读环境变量并裁空白', deviceId() === '书房·PC1', JSON.stringify(deviceId()))
process.env.DSH_MANUSCRIPT_DEVICE = 'x'.repeat(100)
check('deviceId 超长裁剪到 64', deviceId().length === 64, String(deviceId().length))

r = commitEntries([{ title: '设备标识测试', claim: '这条用来验证入册会写入设备标识与时间戳。', volume: 'vol-01' }], { root })
const rec = JSON.parse(readFileSync(join(root, 'entries', (r.ids[0] || 'x') + '.json'), 'utf8'))
check('入册写入 origin.device', typeof rec.origin?.device === 'string' && rec.origin.device.length > 0, JSON.stringify(rec.origin))
check('入册写入 createdAt 与 updatedAt', !!rec.createdAt && !!rec.updatedAt, `${rec.createdAt} / ${rec.updatedAt}`)
check('时间戳是合法 ISO 时间', !Number.isNaN(Date.parse(rec.createdAt)) && !Number.isNaN(Date.parse(rec.updatedAt)))

// 【语义边界】入册是**只追加**：同 id、不同内容不会覆盖旧条目，而是生成 -2 后缀的新条目。
// 所以 updatedAt 记的是"这条被写入的时间"，不是编辑历史；要改已有条目得走同步层的更新路径
// （尚未实现，见 docs/输出格式.md 的"还缺的"）。这里把这个边界钉住，免得将来误以为能改。
const before = Date.parse(rec.updatedAt)
await new Promise((res) => setTimeout(res, 5))
r = commitEntries([{ id: r.ids[0], title: '设备标识测试（改）', claim: '改写之后应该生成新条目，而不是覆盖旧的那条。', volume: 'vol-01' }], { root })
check('同 id 不同内容 → 生成新条目而不是覆盖', r.written === 1 && r.ids[0] !== rec.id, `${rec.id} -> ${r.ids[0]}`)
const rec2 = JSON.parse(readFileSync(join(root, 'entries', (r.ids[0] || 'x') + '.json'), 'utf8'))
check('新条目有自己的 updatedAt', Date.parse(rec2.updatedAt) >= before, `${rec.updatedAt} -> ${rec2.updatedAt}`)
const stillOld = JSON.parse(readFileSync(join(root, 'entries', rec.id + '.json'), 'utf8'))
check('旧条目原样保留（只追加、不覆盖）', stillOld.title === '设备标识测试', stillOld.title)

// 调用方显式给 origin 时不能被覆盖
r = commitEntries([{ title: '外部来源', claim: '模拟另一台设备同步过来的条目，origin 必须保留。', volume: 'vol-01', origin: { device: 'device-b' } }], { root })
const rec3 = JSON.parse(readFileSync(join(root, 'entries', (r.ids[0] || 'x') + '.json'), 'utf8'))
check('显式 origin 被保留（同步来的条目不会被打上本机标签）', rec3.origin?.device === 'device-b', JSON.stringify(rec3.origin))

if (savedDevice === undefined) delete process.env.DSH_MANUSCRIPT_DEVICE
else process.env.DSH_MANUSCRIPT_DEVICE = savedDevice
rmSync(root, { recursive: true, force: true })

console.log('\n' + '═'.repeat(74))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail) {
  console.log('失败用例：')
  for (const f of failures) console.log('  ✗ ' + f)
}
console.log('═'.repeat(74))
process.exit(fail ? 1 : 0)
