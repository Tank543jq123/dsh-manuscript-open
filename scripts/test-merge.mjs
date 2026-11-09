#!/usr/bin/env node
/**
 * 多设备合并的测试（2026-11-08 新增）。
 *
 * 覆盖 `lib/merge.js` 的纯逻辑与 `scripts/merge-libraries.mjs` 的落盘行为。
 *
 * 这套规则是给"图书馆"用的，所以每条都必须能说出**为什么这么判**：
 *   · 只在一边 → 新增（不丢）
 *   · 内容相同 → 跳过（不重复写）
 *   · 内容不同、时间可比 → 新的赢，旧的那份**留副本**（留副本不是洁癖：
 *     updatedAt 只能证明"谁后写"，证明不了"谁是对的"）
 *   · 时间不可比 → **不猜**，两份都留
 *   · 任何情况下都不删除条目
 */

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { planMerge, contentOf, CONTENT_FIELDS } from '../lib/merge.js'

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

const mkEntry = (id, over = {}) => ({
  id,
  volume: 'vol-01',
  chapter: 'ch-hw',
  title: '标题-' + id,
  claim: '内容-' + id,
  status: 'current',
  provenance: { session_id: 's-' + id },
  ...over,
})

console.log('\n── 1. planMerge 纯逻辑 ──')
{
  const base = [mkEntry('e1', { updatedAt: '2026-11-01T00:00:00.000Z' }), mkEntry('e2')]
  const incoming = [
    mkEntry('e1', { title: '标题-e1', claim: '内容-e1', updatedAt: '2026-11-02T00:00:00.000Z' }), // 内容相同
    mkEntry('e1x'), // 新增
  ]
  const r = planMerge(base, incoming)
  check('只在 incoming 的 → add', r.operations.find((o) => o.id === 'e1x').action === 'add')
  check('内容相同 → same', r.operations.find((o) => o.id === 'e1').action === 'same')
  check('统计自洽', r.stats.added === 1 && r.stats.same === 1, JSON.stringify(r.stats))
}
{
  const base = [mkEntry('e1', { claim: '老内容', updatedAt: '2026-11-01T00:00:00.000Z' })]
  const newer = [mkEntry('e1', { claim: '新内容', updatedAt: '2026-11-02T00:00:00.000Z' })]
  const r = planMerge(base, newer)
  check('incoming 更新 → winner 是 incoming', r.operations[0].action === 'update' && r.operations[0].winner.claim === '新内容', r.operations[0].reason)

  const r2 = planMerge(newer, base)
  check('base 更新 → winner 是 base', r2.operations[0].action === 'update' && r2.operations[0].winner.claim === '新内容', r2.operations[0].reason)
}
{
  const base = [mkEntry('e1', { claim: 'A', updatedAt: '2026-11-02T00:00:00.000Z' })]
  const incoming = [mkEntry('e1', { claim: 'B', updatedAt: '2026-11-02T00:00:00.000Z' })]
  const r = planMerge(base, incoming)
  check('时间相同但内容不同 → conflict（不猜）', r.operations[0].action === 'conflict', r.operations[0].reason)
  check('冲突要列出明细', r.conflicts.length === 1 && r.conflicts[0].id === 'e1')

  const noTs = planMerge([mkEntry('e9', { claim: 'A' })], [mkEntry('e9', { claim: 'B' })])
  check('缺 updatedAt → conflict', noTs.operations[0].action === 'conflict', noTs.operations[0].reason)
}
{
  const r = planMerge([], [mkEntry('a'), mkEntry('a'), null, { title: 'no-id' }])
  check('同批重复 id 只处理第一条', r.operations.filter((o) => o.id === 'a').length === 1)
  check('无 id / 非对象被跳过并计数', r.stats.skipped === 3, JSON.stringify(r.stats))
}
{
  // 内容比较不看时间与使用统计
  const a = mkEntry('x', { updatedAt: '2026-01-01T00:00:00.000Z', hits: 0 })
  const b = mkEntry('x', { updatedAt: '2026-02-01T00:00:00.000Z', hits: 7, createdAt: '2026-01-05T00:00:00.000Z' })
  check('contentOf 忽略 updatedAt/hits/createdAt', contentOf(a) === contentOf(b), contentOf(a).slice(0, 40))
  check('CONTENT_FIELDS 含 provenance（溯源必须参与判等）', CONTENT_FIELDS.includes('provenance'))
}

console.log('\n── 2. CLI：dry-run 不写盘 ──')
function mkLib(root, entries) {
  mkdirSync(join(root, 'entries'), { recursive: true })
  writeFileSync(join(root, 'library.json'), JSON.stringify({ version: 1, counts: { entries: entries.length }, volumes: [] }))
  for (const e of entries) writeFileSync(join(root, 'entries', e.id + '.json'), JSON.stringify(e, null, 2))
}
const sandbox = mkdtempSync(join(tmpdir(), 'ms-merge-'))
const runCli = (...a) =>
  execFileSync(process.execPath, [new URL('./merge-libraries.mjs', import.meta.url).pathname, ...a], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

try {
  const baseDir = join(sandbox, 'base')
  const incDir = join(sandbox, 'incoming')
  mkLib(baseDir, [mkEntry('e-same'), mkEntry('e-older', { claim: 'base 版', updatedAt: '2026-11-02T00:00:00.000Z' })])
  mkLib(incDir, [
    mkEntry('e-same'),
    mkEntry('e-older', { claim: 'incoming 版', updatedAt: '2026-11-01T00:00:00.000Z' }),
    mkEntry('e-new'),
    mkEntry('e-conflict', { claim: 'A 版', updatedAt: '2026-11-03T00:00:00.000Z' }),
  ])
  // 给 base 也放一条同 id 但内容不同的（时间相同 → 冲突）
  writeFileSync(join(baseDir, 'entries', 'e-conflict.json'), JSON.stringify(mkEntry('e-conflict', { claim: 'B 版', updatedAt: '2026-11-03T00:00:00.000Z' })))

  const before = readdirSync(join(baseDir, 'entries')).sort().join(',')
  const dry = runCli('--base', baseDir, '--incoming', incDir)
  const after = readdirSync(join(baseDir, 'entries')).sort().join(',')
  check('dry-run 不新增文件', before === after, after)
  check('dry-run 输出计划统计', /新增 1.*更新 1.*相同 1.*冲突 1/.test(dry.replace(/\s+/g, ' ')), dry.split('\n')[3] || '')

  const applied = runCli('--base', baseDir, '--incoming', incDir, '--apply')
  check('--apply 后新条目落盘', readdirSync(join(baseDir, 'entries')).includes('e-new.json'))
  const updated = JSON.parse(readFileSync(join(baseDir, 'entries', 'e-older.json'), 'utf8'))
  check('base 更新时保留 base 版本', updated.claim === 'base 版', updated.claim)
  const conf = readdirSync(join(baseDir, 'conflicts'))
  check('冲突副本被留档', conf.some((f) => f.startsWith('e-conflict.')), JSON.stringify(conf))
  check('incoming 旧版本被留档', conf.some((f) => f.startsWith('e-older.')), JSON.stringify(conf))
  const conflictKept = JSON.parse(readFileSync(join(baseDir, 'entries', 'e-conflict.json'), 'utf8'))
  check('冲突时 base 原件保持不动', conflictKept.claim === 'B 版', conflictKept.claim)
  check('原有条目一个都没少', readdirSync(join(baseDir, 'entries')).length === before.split(',').length + 1, String(readdirSync(join(baseDir, 'entries')).length))

  console.log('\n── 3. CLI：前置检查 ──')
  // 造一个"只有 entries/、没有 library.json"的目录
  const noLib = join(sandbox, 'no-library')
  mkdirSync(join(noLib, 'entries'), { recursive: true })
  let err = ''
  try {
    runCli('--base', noLib, '--incoming', baseDir)
  } catch (e) {
    err = String(e.stderr || e.message)
  }
  check('base 缺 library.json 时拒绝执行', /缺 library\.json/.test(err), err.split('\n')[0])

  err = ''
  try {
    runCli('--base', baseDir, '--incoming', baseDir)
  } catch (e) {
    err = String(e.stderr || e.message)
  }
  check('base 与 incoming 相同则拒绝', /同一个库/.test(err), err.split('\n')[0])
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('\n' + '═'.repeat(74))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail) {
  console.log('失败用例：')
  for (const f of failures) console.log('  ✗ ' + f)
}
console.log('═'.repeat(74))
process.exit(fail ? 1 : 0)
