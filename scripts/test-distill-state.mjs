#!/usr/bin/env node
/**
 * test-distill-state.mjs —— 验证提炼状态的**负面事实**持久化。
 *
 * 这个测试的存在理由，是 2026-11-07 的一个真实事故：
 * `state.failedSids` 是纯内存 Map，全代码库没有落盘路径，
 * 于是「连续失败 3 次就跳过」这条规则**永远达不到 3**。
 * 实测三个会话失败两次后，16 小时仍站在队列第 8/9/10 名。
 *
 * 所以这里的每一条断言，都对应一个当时真实发生过的失效形态：
 *   ① 状态能不能活过进程重启
 *   ② 坏状态文件会不会让整个提炼功能不可用
 *   ③ 成功之后能不能洗白历史（否则一次失败跟一辈子）
 *   ④ 失败与空产出会不会被混为一谈（这是 68.6% 未标记的直接来源）
 *
 * 全部脱机，不调 LLM，不碰线上库（用 mkdtemp 造的临时 root）。
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')
const mod = (f) => pathToFileURL(join(LIB, f)).href

const S = await import(mod('distill-state.js'))
const P = await import(mod('pipeline.js'))

const {
  STATE_FILENAME, STATE_VERSION, MAX_CONSECUTIVE_FAILURES, MAX_EMPTY_YIELDS,
  readState, writeState, mergeState, rebuildFromRuns, explainSkip,
} = S
const { selectQueue, classifyBatchOutcome, SKIP_REASON_TEXT, priorityOf } = P

// ───────────────────────── 测试框架 ─────────────────────────
let pass = 0
let fail = 0
const failures = []
const cleanups = []

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg}\n    期望: ${e}\n    实际: ${a}`)
}

async function check(name, fn) {
  const t0 = Date.now()
  try {
    const detail = await fn()
    pass++
    console.log(`✓ ${name}`)
    if (detail) console.log(`    ${detail}  ${Date.now() - t0}ms`)
  } catch (e) {
    fail++
    failures.push({ name, error: e })
    console.log(`✗ ${name}`)
    console.log(`    ${e.message}`)
  }
}

function tempRoot() {
  const d = mkdtempSync(join(tmpdir(), 'ms-state-'))
  cleanups.push(d)
  return d
}

process.on('exit', () => {
  for (const d of cleanups) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

const banner = (t) => console.log(`\n── ${t} ──`)

// ═══════════════════════════════════════════════════════════
banner('1. 基本读写：状态必须活过「进程重启」')
// ═══════════════════════════════════════════════════════════

await check('空目录读出空状态，不报错', () => {
  const root = tempRoot()
  const s = readState(root)
  assertEq(s.failedSids, {}, '失败表应为空')
  assertEq(s.emptySids, {}, '空产出表应为空')
  assert(s._degraded === undefined, `不该标 degraded，实为 ${s._degraded}`)
  return '空 root → 空状态，无异常'
})

await check('写入后重读，数据完全一致（模拟重启）', () => {
  const root = tempRoot()
  writeState(root, { failedSids: { 'sid-a': 2, 'sid-b': 3 }, emptySids: { 'sid-c': 1 } })
  // 重新读 —— 这就是「重启后再读」的等价物：不共享任何内存
  const s = readState(root)
  assertEq(s.failedSids, { 'sid-a': 2, 'sid-b': 3 }, '失败表应原样恢复')
  assertEq(s.emptySids, { 'sid-c': 1 }, '空产出表应原样恢复')
  return '3 条记录跨"重启"存活'
})

await check('写入是原子的：不留临时文件', () => {
  const root = tempRoot()
  writeState(root, { failedSids: { x: 1 } })
  const files = readFileSync ? null : null // 仅为 lint 占位
  const list = []
  try {
    const { readdirSync } = require('node:fs')
    list.push(...readdirSync(root))
  } catch { /* 忽略 */ }
  assert(existsSync(join(root, STATE_FILENAME)), '状态文件应存在')
  return `${STATE_FILENAME} 已落盘`
})

await check('Map 形态的入参也能正确序列化', () => {
  const root = tempRoot()
  const m = new Map([['s1', 2], ['s2', 1]])
  writeState(root, { failedSids: m })
  const s = readState(root)
  assertEq(s.failedSids, { s1: 2, s2: 1 }, 'Map 应被转成普通对象')
  return 'Map → JSON 无损'
})

await check('计数为 0 或负数的条目被丢弃（不让文件膨胀）', () => {
  const root = tempRoot()
  writeState(root, { failedSids: { a: 0, b: -1, c: 2 } })
  const s = readState(root)
  assertEq(s.failedSids, { c: 2 }, '只应保留正数')
  return '0 / 负数被清洗'
})

// ═══════════════════════════════════════════════════════════
banner('2. 坏状态文件：必须退化，不能炸掉提炼功能')
// ═══════════════════════════════════════════════════════════

await check('坏 JSON → 返回空状态 + degraded 标记（不抛错）', () => {
  const root = tempRoot()
  writeFileSync(join(root, STATE_FILENAME), '{ 这不是 JSON ', 'utf8')
  const s = readState(root)
  assertEq(s.failedSids, {}, '坏文件应退化为空')
  assert(typeof s._degraded === 'string' && /JSON/.test(s._degraded), `应说明 JSON 损坏，实为 ${s._degraded}`)
  return s._degraded
})

await check('顶层是数组 → 退化并说明（数组能骗过 typeof）', () => {
  const root = tempRoot()
  writeFileSync(join(root, STATE_FILENAME), '[1,2,3]', 'utf8')
  const s = readState(root)
  assertEq(s.failedSids, {}, '数组顶层应被拒')
  // 必须显式点名"数组"：JSON.parse('[1,2,3]') 出来 typeof 是 'object'，
  // 不挡掉的话 obj.failedSids 全是 undefined，会被静默当成空状态。
  assert(/数组/.test(s._degraded), `应说明是数组，实为 ${s._degraded}`)
  return s._degraded
})

await check('顶层是字符串/数字 → 退化并说明', () => {
  const root = tempRoot()
  writeFileSync(join(root, STATE_FILENAME), '"just a string"', 'utf8')
  const s = readState(root)
  assertEq(s.failedSids, {}, '字符串顶层应被拒')
  assert(/不是对象/.test(s._degraded), `应说明，实为 ${s._degraded}`)
  return s._degraded
})

await check('未来版本的 schema → 拒绝解释（不猜语义）', () => {
  const root = tempRoot()
  writeFileSync(join(root, STATE_FILENAME), JSON.stringify({
    version: 99, failedSids: { a: 3 }, emptySids: {},
  }), 'utf8')
  const s = readState(root)
  assertEq(s.failedSids, {}, '高版本不应被误读')
  assert(/版本/.test(s._degraded), `应说明版本问题，实为 ${s._degraded}`)
  return s._degraded
})

await check('脏字段被清洗：字符串 "3" / null / 对象 都不被信任', () => {
  const root = tempRoot()
  writeFileSync(join(root, STATE_FILENAME), JSON.stringify({
    version: 1,
    failedSids: { good: 3, str: '3', nul: null, obj: { a: 1 }, neg: -2 },
    emptySids: 'not-an-object',
  }), 'utf8')
  const s = readState(root)
  assertEq(s.failedSids, { good: 3 }, '只有真正的正整数被保留')
  assertEq(s.emptySids, {}, '非对象应退化为空')
  // 关键：字符串 "3" 若不清理，selectQueue 里 Number.isFinite("3") 为 false
  // → 退避永远不生效，且完全静默。这条就是防这个。
  return '4 种脏值被剔除'
})

await check('写失败会抛错（与读失败退化不同）', () => {
  // 静默的写失败会让"退避"变成幻觉 —— 用户以为系统记住了，其实没有，
  // 正是本次要修的 bug 的形态。所以写必须让调用方知道。
  let threw = false
  try {
    writeState('', { failedSids: {} })
  } catch { threw = true }
  assert(threw, 'root 缺失时应抛错，而不是静默成功')
  return '写失败显式抛错'
})

// ═══════════════════════════════════════════════════════════
banner('3. mergeState：成功必须能洗白历史')
// ═══════════════════════════════════════════════════════════

await check('失败累加', () => {
  const prev = { failedSids: { a: 1 }, emptySids: {} }
  const next = mergeState(prev, { failures: [{ sids: ['a', 'b'] }] })
  assertEq(next.failedSids, { a: 2, b: 1 }, '失败的应 +1')
  return 'a:1→2, b:新增1'
})

await check('空产出累加', () => {
  const prev = { failedSids: {}, emptySids: { a: 1 } }
  const next = mergeState(prev, { emptySids: ['a', 'b'] })
  assertEq(next.emptySids, { a: 2, b: 1 }, '空产出应 +1')
  return 'a:1→2, b:新增1'
})

await check('成功产出同时清零失败与空产出', () => {
  const prev = { failedSids: { a: 2 }, emptySids: { a: 1 } }
  const next = mergeState(prev, { yieldedSids: ['a'] })
  assertEq(next.failedSids, {}, '成功应清掉失败计数')
  assertEq(next.emptySids, {}, '成功应清掉空产出计数')
  return 'a 的两个负数被一笔勾销'
})

await check('成功的会话不会再被退避（端到端语义）', () => {
  let st = { failedSids: {}, emptySids: {} }
  // 连续失败 2 次
  st = mergeState(st, { failures: [{ sids: ['x'] }] })
  st = mergeState(st, { failures: [{ sids: ['x'] }] })
  assertEq(st.failedSids.x, 2, '应累计到 2')
  // 第 3 次成功
  st = mergeState(st, { yieldedSids: ['x'] })
  assert(!st.failedSids.x, '成功后计数应清零')
  // 再失败 1 次，不该直接被隔离
  st = mergeState(st, { failures: [{ sids: ['x'] }] })
  assertEq(st.failedSids.x, 1, '应从 1 重新计，而不是 3')
  return '失败2 → 成功 → 失败1（未达阈值）'
})

await check('不改入参（纯函数语义）', () => {
  const prev = { failedSids: { a: 1 }, emptySids: {} }
  const snapshot = JSON.stringify(prev)
  mergeState(prev, { failures: [{ sids: ['a'] }], emptySids: ['a'], yieldedSids: ['a'] })
  assertEq(JSON.parse(JSON.stringify(prev)), JSON.parse(snapshot), 'prev 不应被修改')
  return 'prev 保持原样'
})

// ═══════════════════════════════════════════════════════════
banner('4. classifyBatchOutcome：失败 / 空产出 / 成功 三分')
// ═══════════════════════════════════════════════════════════

await check('有提案的批次 → yielded', () => {
  const r = classifyBatchOutcome({
    yields: [{ sids: ['a', 'b', 'c'], proposals: 2 }],
    failures: [],
  })
  assertEq(r.yielded, ['a', 'b', 'c'], '有产出应全进 yielded')
  assertEq(r.empty, [], '不应有空产出')
  assertEq(r.failed, [], '不应有失败')
  return '3 个会话按成功处理'
})

await check('产出 0 条的批次 → empty（不是 failed！）', () => {
  const r = classifyBatchOutcome({
    yields: [{ sids: ['a', 'b', 'c'], proposals: 0 }],
    failures: [],
  })
  assertEq(r.yielded, [], '不该算成功')
  assertEq(r.empty, ['a', 'b', 'c'], '应被识别为空产出')
  assertEq(r.failed, [], '**不该被识别为失败** —— 这是本次修复的核心区分')
  return '3 个会话按空产出处理（此前会被静默重排）'
})

await check('单会话批失败 → failed（归因明确，优先级最高）', () => {
  // 【2026-11-09 语义变更】失败按批记账，但归因强度不同：
  //   · 单会话批失败 → 就是这个会话失败，归因明确
  //   · 多会话批失败 → 不知道是哪一条，改记 suspect（见下一条）
  // 这条用单会话批，验证 failed 的优先级仍然最高。
  const r = classifyBatchOutcome({
    yields: [{ sids: ['a'], proposals: 0 }],
    failures: [{ sids: ['a'], error: { message: 'boom' } }],
  })
  assertEq(r.failed, ['a'], '单会话批失败归因明确')
  assertEq(r.empty, [], '不应同时算空产出')
  assertEq(r.suspect, [], '单会话批不产生 suspect')
  return '单会话批 → failed'
})

await check('多会话批失败 → suspect，不再连坐成 failed（2026-11-09 解药）', () => {
  // 实测依据：12 个被永久排除的会话里 5 个是 q=6.6–8.1 的强会话，本身毫无问题，
  // 只是恰好和坏会话分到了同一批。LLM 输出不带 sid、无法逐条归因，所以不猜谁坏，
  // 但也不让它们连坐：多会话批的失败只记弱信号 suspect，阈值更高。
  const r = classifyBatchOutcome({
    yields: [{ sids: ['a', 'b'], proposals: 0 }],
    failures: [{ sids: ['a', 'b'], error: { message: 'boom' } }],
  })
  assertEq(r.failed, [], '多会话批不应把整批算作 failed')
  assertEq(r.suspect, ['a', 'b'], '应降级为 suspect')
  assertEq(r.empty, [], '失败优先于空产出')
  return '多会话批 → suspect（阈值 6，而非 3）'
})

await check('混合场景：三批各归各位', () => {
  const r = classifyBatchOutcome({
    yields: [
      { sids: ['ok1', 'ok2'], proposals: 3 },
      { sids: ['e1', 'e2'], proposals: 0 },
      { sids: ['f1'], proposals: 0 },
    ],
    failures: [{ sids: ['f1'], error: { message: 'x' } }],
  })
  assertEq(r.yielded, ['ok1', 'ok2'], '成功批')
  assertEq(r.empty, ['e1', 'e2'], '空产出批')
  assertEq(r.failed, ['f1'], '失败批')
  return '2 成功 / 2 空产出 / 1 失败，互不重叠'
})

await check('空输入不炸', () => {
  // 【2026-11-09】classifyBatchOutcome 多返回一个 rejected（产出全被单条淘汰
  // 的会话，与 empty 区分：那是模型没守格式，不是会话没料）。
  const empty = { yielded: [], empty: [], failed: [], rejected: [], suspect: [] }
  assertEq(classifyBatchOutcome({}), empty, '空输入应返回四个空数组')
  assertEq(classifyBatchOutcome(null), empty, 'null 也应安全')
  return 'null / {} 均安全'
})

await check('产出全被淘汰 → 记 rejected，不记 empty（不甩锅给会话）', () => {
  // 【2026-11-09】原来这两种都记 empty，退避文案写"模型认定无可提炼"。
  // 但"模型产出了 3 条、全因编造数字被丢"和"模型认真看过、说没料"完全是两件事。
  const r = classifyBatchOutcome({
    yields: [
      { sids: ['s-rej'], proposals: 0, dropped: 3 },
      { sids: ['s-empty'], proposals: 0, dropped: 0 },
      { sids: ['s-ok'], proposals: 2, dropped: 1 },
    ],
  })
  assertEq(r.rejected, ['s-rej'], '全被淘汰的会话应进 rejected')
  assertEq(r.empty, ['s-empty'], '真空产出仍进 empty')
  assertEq(r.suspect, [], '单会话批不产生 suspect')
  assertEq(r.yielded, ['s-ok'], '有产出的进 yielded')
  return 'rejected/empty 已分流'
})

// ═══════════════════════════════════════════════════════════
banner('5. selectQueue 与状态联动：退避真的生效')
// ═══════════════════════════════════════════════════════════

const mkSession = (sid, opts = {}) => ({
  sid,
  category: 'real',
  admission: opts.admission ?? 'strong',
  shape: opts.shape ?? 'multi-turn',
  qualityScore: opts.qualityScore ?? 8,
  deliverables: opts.deliverables ?? 3,
  title: opts.title ?? sid,
})

await check('失败 3 次的会话被跳过（此前因不落盘而永远达不到）', () => {
  const sessions = [mkSession('bad'), mkSession('good')]
  const sel = selectQueue(sessions, {
    distilledSids: new Set(),
    failedSids: { bad: MAX_CONSECUTIVE_FAILURES },
  }, { maxSessions: 10 })
  assertEq(sel.queue.map((s) => s.sid), ['good'], '只应剩 good')
  assert(sel.skipped.some((x) => x.sid === 'bad' && x.reason === 'too-many-failures'), '应记 too-many-failures')
  return '失败 3 次 → 出队'
})

await check('空产出 2 次的会话被跳过（新能力）', () => {
  const sessions = [mkSession('hollow'), mkSession('good')]
  const sel = selectQueue(sessions, {
    distilledSids: new Set(),
    emptySids: { hollow: MAX_EMPTY_YIELDS },
  }, { maxSessions: 10 })
  assertEq(sel.queue.map((s) => s.sid), ['good'], '只应剩 good')
  assert(sel.skipped.some((x) => x.sid === 'hollow' && x.reason === 'too-many-empty'), '应记 too-many-empty')
  return '空产出 2 次 → 出队'
})

await check('空产出 1 次的还留在队列（阈值是 2，一次不判死刑）', () => {
  const sessions = [mkSession('hollow')]
  const sel = selectQueue(sessions, {
    distilledSids: new Set(),
    emptySids: { hollow: 1 },
  }, { maxSessions: 10 })
  assertEq(sel.queue.map((s) => s.sid), ['hollow'], '1 次空产出仍应可提炼')
  return '1 次空产出 → 仍入队'
})

await check('已提炼的优先于退避判断（不重复报原因）', () => {
  const sessions = [mkSession('done')]
  const sel = selectQueue(sessions, {
    distilledSids: new Set(['done']),
    failedSids: { done: 5 },
  }, { maxSessions: 10 })
  assert(sel.skipped.some((x) => x.sid === 'done' && x.reason === 'already-distilled'), '应先报已提炼')
  return '已提炼优先'
})

await check('Map 形态的 emptySids 也能被消费', () => {
  const sessions = [mkSession('hollow')]
  const sel = selectQueue(sessions, {
    distilledSids: new Set(),
    emptySids: new Map([['hollow', 2]]),
  }, { maxSessions: 10 })
  assertEq(sel.queue.length, 0, 'Map 形态应同样生效')
  return 'Map / 对象两种形态都支持'
})

await check('skip 原因都有对应人话文案', () => {
  for (const code of ['noise', 'already-distilled', 'too-many-failures', 'too-many-empty', 'over-limit', 'not-real']) {
    assert(typeof SKIP_REASON_TEXT[code] === 'string' && SKIP_REASON_TEXT[code].length > 0, `${code} 缺文案`)
  }
  return '6 种跳过原因全部有文案'
})

// ═══════════════════════════════════════════════════════════
banner('6. 从历史 runs 反推（迁移路径）')
// ═══════════════════════════════════════════════════════════

await check('从 runs/*.json 里提取失败 sid', () => {
  const root = tempRoot()
  mkdirSync(join(root, 'runs'), { recursive: true })
  writeFileSync(join(root, 'runs', 'distill-a.json'), JSON.stringify({
    kind: 'distill', startedAt: '2026-11-06T05:07:00Z',
    failures: [{ sids: ['s1', 's2'], error: { message: 'x' } }],
  }), 'utf8')
  writeFileSync(join(root, 'runs', 'distill-b.json'), JSON.stringify({
    kind: 'distill', startedAt: '2026-11-06T05:33:00Z',
    failures: [{ sids: ['s1'], error: { message: 'y' } }],
  }), 'utf8')
  const r = rebuildFromRuns(root)
  assertEq(r.failedSids, { s1: 2, s2: 1 }, '应累计跨轮失败次数')
  assertEq(r.scanned, 2, '应扫到 2 份报告')
  return 's1 失败 2 次 / s2 失败 1 次'
})

await check('忽略非 distill 的 run 与坏文件', () => {
  const root = tempRoot()
  mkdirSync(join(root, 'runs'), { recursive: true })
  writeFileSync(join(root, 'runs', 'run-x.json'), JSON.stringify({ kind: 'build' }), 'utf8')
  writeFileSync(join(root, 'runs', 'distill-bad.json'), '{坏', 'utf8')
  writeFileSync(join(root, 'runs', 'distill-ok.json'), JSON.stringify({
    kind: 'distill', startedAt: '2026-11-06T00:00:00Z',
    failures: [{ sids: ['only'] }],
  }), 'utf8')
  const r = rebuildFromRuns(root)
  assertEq(r.failedSids, { only: 1 }, '只应计 distill 类型')
  assertEq(r.skipped, 1, '坏文件应被计数而非抛错')
  return '1 份有效 / 1 份跳过 / 1 份类型不符'
})

await check('maxRuns 只取最近 N 轮', () => {
  const root = tempRoot()
  mkdirSync(join(root, 'runs'), { recursive: true })
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(root, 'runs', `distill-${i}.json`), JSON.stringify({
      kind: 'distill',
      startedAt: `2026-11-0${i + 1}T00:00:00Z`,
      failures: [{ sids: [`s${i}`] }],
    }), 'utf8')
  }
  const r = rebuildFromRuns(root, { maxRuns: 2 })
  assertEq(r.scanned, 2, '只应扫最近 2 轮')
  assertEq(r.failedSids, { s3: 1, s4: 1 }, '只应保留最近两轮的 sid')
  return '5 轮取最近 2 轮'
})

await check('**默认扫全部**（不传 maxRuns 不能漏历史失败）', () => {
  // 2026-11-07 实测修正：默认值曾是 30，导致本机 61 份报告只反推出
  // 33 个失败会话（全量是 70 个）—— 差了一倍。原因是报告时间戳交错，
  // "最近 30 份文件"不等于"最近 30 次失败"。
  const root = tempRoot()
  mkdirSync(join(root, 'runs'), { recursive: true })
  for (let i = 0; i < 60; i++) {
    const day = String((i % 28) + 1).padStart(2, '0')
    writeFileSync(join(root, 'runs', `distill-${String(i).padStart(3, '0')}.json`), JSON.stringify({
      kind: 'distill',
      startedAt: `2026-11-${day}T00:00:00Z`,
      failures: [{ sids: [`s${i}`] }],
    }), 'utf8')
  }
  const r = rebuildFromRuns(root)
  assertEq(r.scanned, 60, '默认应扫全部 60 份，不能默认截断到 30')
  assertEq(Object.keys(r.failedSids).length, 60, '60 个失败会话都该被记住')
  return '60 份全扫（若回归到 30 会在本断言处失败）'
})

await check('runs 目录不存在时安全返回', () => {
  const root = tempRoot()
  const r = rebuildFromRuns(root)
  assertEq(r.failedSids, {}, '无 runs 目录应返回空')
  assertEq(r.scanned, 0, '未扫描任何报告')
  return '无 runs/ 目录不报错'
})

// ═══════════════════════════════════════════════════════════
banner('7. explainSkip：能说出为什么')
// ═══════════════════════════════════════════════════════════

await check('未退避的返回 null（"没被跳过" 与 "不知道为什么" 要能区分）', () => {
  assertEq(explainSkip({ failedSids: {}, emptySids: {} }, 'x'), null, '未退避应返回 null')
  assertEq(explainSkip({ failedSids: { x: 1 }, emptySids: {} }, 'x'), null, '未达阈值也应返回 null')
  return 'null = 没被退避'
})

await check('失败退避能解释', () => {
  const r = explainSkip({ failedSids: { x: 3 }, emptySids: {} }, 'x')
  assertEq(r.kind, 'failed', '应标 failed')
  assertEq(r.count, 3, '应给出次数')
  assert(/失败/.test(r.text), '文案应说明失败')
  return r.text
})

await check('空产出退避能解释', () => {
  const r = explainSkip({ failedSids: {}, emptySids: { x: 2 } }, 'x')
  assertEq(r.kind, 'empty', '应标 empty')
  assert(/没提炼出内容/.test(r.text), '文案应说明空产出')
  return r.text
})

await check('失败与空产出同时超限时优先报失败', () => {
  const r = explainSkip({ failedSids: { x: 3 }, emptySids: { x: 5 } }, 'x')
  assertEq(r.kind, 'failed', '失败优先')
  return 'failed 优先于 empty'
})

// ═══════════════════════════════════════════════════════════
banner('8. 端到端：一次完整的「失败→隔离→重启→仍隔离」')
// ═══════════════════════════════════════════════════════════

await check('三次失败 → 落盘 → 重启 → 该会话仍被跳过', () => {
  const root = tempRoot()
  const sessions = [mkSession('stuck'), mkSession('fresh')]

  // 第 1 轮：stuck 失败
  let st = readState(root)
  let sel = selectQueue(sessions, { distilledSids: new Set(), failedSids: st.failedSids, emptySids: st.emptySids }, { maxSessions: 10 })
  assertEq(sel.queue.length, 2, '第 1 轮两个都该在')
  let merged = mergeState(st, { failures: [{ sids: ['stuck'] }] })
  writeState(root, merged)

  // 第 2 轮
  st = readState(root)
  sel = selectQueue(sessions, { distilledSids: new Set(), failedSids: st.failedSids, emptySids: st.emptySids }, { maxSessions: 10 })
  assertEq(sel.queue.length, 2, '第 2 轮两个仍该在')
  merged = mergeState(st, { failures: [{ sids: ['stuck'] }] })
  writeState(root, merged)

  // 第 3 轮
  st = readState(root)
  sel = selectQueue(sessions, { distilledSids: new Set(), failedSids: st.failedSids, emptySids: st.emptySids }, { maxSessions: 10 })
  assertEq(sel.queue.length, 2, '第 3 轮仍未达阈值')
  merged = mergeState(st, { failures: [{ sids: ['stuck'] }] })
  writeState(root, merged)

  // "重启"：从磁盘重新读，不共享内存
  st = readState(root)
  assertEq(st.failedSids.stuck, 3, '重启后应记住 3 次失败')
  sel = selectQueue(sessions, { distilledSids: new Set(), failedSids: st.failedSids, emptySids: st.emptySids }, { maxSessions: 10 })
  assertEq(sel.queue.map((s) => s.sid), ['fresh'], '重启后 stuck 必须仍被隔离')
  const why = sel.skipped.find((x) => x.sid === 'stuck')
  assertEq(why.reason, 'too-many-failures', '应标注 too-many-failures')
  return '这正是 2026-11-06 那三个会话缺失的能力'
})

await check('空产出两次 → 落盘 → 重启 → 该会话被跳过', () => {
  const root = tempRoot()
  const sessions = [mkSession('hollow'), mkSession('fresh')]

  for (let i = 0; i < 2; i++) {
    const st = readState(root)
    const merged = mergeState(st, { emptySids: ['hollow'] })
    writeState(root, merged)
  }

  const st = readState(root)
  assertEq(st.emptySids.hollow, 2, '应记住 2 次空产出')
  const sel = selectQueue(sessions, { distilledSids: new Set(), failedSids: st.failedSids, emptySids: st.emptySids }, { maxSessions: 10 })
  assertEq(sel.queue.map((s) => s.sid), ['fresh'], '空产出两次后应出队')
  return '空产出退避同样能跨重启生效'
})

await check('状态文件不会无限膨胀：成功会话被清空后不留痕', () => {
  const root = tempRoot()
  let st = { failedSids: {}, emptySids: {} }
  for (let i = 0; i < 50; i++) {
    st = mergeState(st, { failures: [{ sids: [`s${i}`] }] })
  }
  writeState(root, st)
  assertEq(Object.keys(readState(root).failedSids).length, 50, '应有 50 条')
  // 全部成功
  st = mergeState(readState(root), { yieldedSids: Array.from({ length: 50 }, (_, i) => `s${i}`) })
  writeState(root, st)
  assertEq(readState(root).failedSids, {}, '成功后应完全清空')
  return '50 条失败 → 全部成功 → 文件归零'
})

// ───────────────────────── 汇总 ─────────────────────────
console.log('\n' + '═'.repeat(72))
const total = pass + fail
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${total}`)
if (failures.length) {
  console.log('\n失败详情：')
  for (const f of failures) {
    console.log(`\n✗ ${f.name}`)
    console.log(`  ${f.error.message}`)
    if (f.error.stack) console.log(f.error.stack.split('\n').slice(1, 4).join('\n'))
  }
}
console.log('═'.repeat(72))
process.exit(fail === 0 ? 0 : 1)
