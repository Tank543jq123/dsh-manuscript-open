#!/usr/bin/env node
/**
 * T1 提炼轨的**端到端**测试（2026-11-08 新增）。
 *
 * ## 为什么以前的测试没发现这个问题
 *
 * 已有的 test-distill（44 项）测的是"单批提炼 + 输出校验"，test-adjudicate
 * 测的是裁决，test-pipeline 测的是编排。每一环都绿，但**没有任何一个测试
 * 把 runDistill 的完整链子跑一遍**：提案 → 归属会话 → 组装条目 → 裁决 →
 * 入册 → 建库。所以下面这个缺陷活了很久：
 *
 *   `pickBestSource()` 在"批内只有 1 个会话"时 `return sids[0]` —— 返回**字符串**，
 *   而调用方按对象取 `picked.sid` → `undefined` → `proposalsToEntries` 把
 *   所有"没有 sid 的提案"跳过 → 接口仍回 `ok:true / proposals:1`，
 *   但 `entries: []`，界面上点"入册"什么都不会发生。**产出被静默丢弃。**
 *
 * 单会话批次一点都不罕见：队列只剩 1 个，或 makeBatches 的尾巴（3+3+1）。
 *
 * ## 这个测试怎么跑
 *
 * 用一个**假 LLM**（`llm.stream()` 是生成器）走真实 HTTP 路由，
 * 全程不联网、不花钱、不需要 key。
 */

import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'

import { writeSessionFixture } from './lib/session-fixture.mjs'

const TMP = mkdtempSync(join(tmpdir(), 'ms-t1-e2e-'))
const LIB_ROOT = join(TMP, 'library')
const SESSIONS_ROOT = join(TMP, 'sessions')
process.env.DSH_MANUSCRIPT_ROOT = LIB_ROOT
process.env.DSH_SESSIONS_ROOT = SESSIONS_ROOT
process.env.DSH_WORKSPACE_JSON = join(TMP, 'no-such-workspace.json')
mkdirSync(LIB_ROOT, { recursive: true })
mkdirSync(SESSIONS_ROOT, { recursive: true })

// 只种一个会话 —— 正是"批内只有 1 个 sid"的触发条件
// 最先被 queue 选中的那个（createdAt 最新）—— 用来测"单会话批次"
writeSessionFixture(SESSIONS_ROOT, {
  sid: 'session-t1',
  projectDir: '-D-proj-demo-hardware',
  cwd: 'D:\\proj\\demo-hardware',
  title: '嘉立创2.0双排针选型',
  turns: 2,
  createdAt: Date.parse('2026-11-05T10:00:00.000Z'),
})
// 第二批：三个不同主题的会话，用来测"批内多会话 → 按标题归到正确来源"
writeSessionFixture(SESSIONS_ROOT, {
  sid: 's-eda',
  projectDir: '-D-proj-kicad',
  cwd: 'D:\\proj\\kicad-lib',
  title: 'KiCad 封装库迁移',
  createdAt: Date.parse('2026-11-04T10:00:00.000Z'),
})
writeSessionFixture(SESSIONS_ROOT, {
  sid: 's-plug',
  projectDir: '-D-proj-dsh',
  cwd: 'D:\\proj\\dsh-plugin',
  title: 'dsh 插件槽位调试',
  createdAt: Date.parse('2026-11-03T10:00:00.000Z'),
})
writeSessionFixture(SESSIONS_ROOT, {
  sid: 's-model',
  projectDir: '-D-proj-llm',
  cwd: 'D:\\proj\\llm-env',
  title: '本地模型量化对比',
  createdAt: Date.parse('2026-11-02T10:00:00.000Z'),
})
// 留给"并发两次提炼"用例：它必须还没被提炼过，否则队列为空、两次调用都不会阻塞
writeSessionFixture(SESSIONS_ROOT, {
  sid: 's-slow',
  projectDir: '-D-proj-slow',
  cwd: 'D:\\proj\\slow-work',
  title: '慢任务：导出汇总表',
  createdAt: Date.parse('2026-11-01T10:00:00.000Z'),
})

/** 假 LLM：返回一条结构合法、不带数字（数字要溯源，假数据里没有）的结论。 */
const VALID = {
  entries: [
    {
      title: '双排针选型要先按载流降额再比价格',
      claim: '选型时先按额定电流的八成降额核对接触电阻，再比较价格与交期，否则大电流下温升会超标。',
      confidence: 'high',
      tags: ['选型', '连接器'],
    },
    // 纯名词堆 → parseProposals 单条淘汰（进 dropped），用来验证"淘汰会被上报"
    { title: '封装 符号库 版本 缓存', claim: '这是一条纯名词堆的假标题，用来验证单条淘汰会被上报而不是静默消失。', confidence: 'high' },
  ],
}
// 第二批：三条里有一条标题是纯名词堆（parseProposals 会单条淘汰）。
// 这里顺带验证"被淘汰的提案要被上报"，而不是人间蒸发。
const MULTI = {
  entries: [
    { title: 'KiCad 封装库迁移先冻结符号版本', claim: '迁移前先冻结符号版本并重建缓存，否则旧封装引用会指向已删除的符号而报错，迁移必须分批做。', confidence: 'high' },
    // claim 25 字：能过 parse 的 ≥20 门槛，但过不了 adjudicate 的 ≥40 → 应被 auto-reject，
    // 因此**不能**出现在返回给调用方的 entries 里（否则界面点"入册"就把它写进库了）
    { title: '这条例子会被自动裁决拒掉', claim: '选型时先按额定电流八成降额，再比较价格。', confidence: 'high' },
    { title: 'dsh 插件槽位 key 必须与行 id 一致', claim: '插件管理页的配置入口 key 必须是包名加行 id，否则插件装上了但在设置里看不到，必须逐行核对。', confidence: 'high' },
  ],
}
let llmCalls = 0
let slowMode = false
const fakeLlm = {
  stream: async function* () {
    llmCalls += 1
    if (slowMode) await new Promise((r) => setTimeout(r, 400))
    yield { type: 'text-delta', text: JSON.stringify(llmCalls === 1 ? VALID : MULTI) }
  },
}

const { apply } = await import('../lib/index.js')

const routes = []
const mockCtx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  tools: { register() { return () => {} } },
  systemPrompt: { getSectionOrder() { return 3100 }, section() { return () => {} } },
  webServer: { register(r) { routes.push(r); return () => {} } },
  llm: fakeLlm,
  effect(fn) { const d = fn && fn(); return typeof d === 'function' ? d : () => {} },
  on() { return () => {} },
  inject(d, cb) { cb(mockCtx); return {} },
  get() { return undefined },
}
await apply(mockCtx)

const exact = new Map()
const prefixes = []
for (const r of routes) {
  if (r.kind === 'prefix') prefixes.push(r)
  else exact.set(r.path, r)
}
prefixes.sort((a, b) => b.path.length - a.path.length)

const server = createServer((req, res) => {
  const p = new URL(req.url || '/', 'http://x').pathname
  const r = exact.get(p) || prefixes.find((x) => p === x.path || p.startsWith(x.path + '/'))
  if (!r) { res.writeHead(404); res.end(); return }
  Promise.resolve(r.handler(req, res)).catch((e) => {
    if (!res.headersSent) { res.writeHead(500); res.end(e?.message || String(e)) }
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

function call(method, path, body) {
  return new Promise((resolve) => {
    const data = body == null ? null : JSON.stringify(body)
    const headers = { host: `127.0.0.1:${PORT}`, 'x-dsh-manuscript': '1' }
    if (data) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(data)
    }
    const req = httpRequest({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      const ch = []
      res.on('data', (c) => ch.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString() }))
    })
    req.on('error', (e) => resolve({ status: 0, body: String(e.code || e.message) }))
    if (data) req.write(data)
    req.end()
  })
}
const J = (s) => { try { return JSON.parse(s) } catch { return null } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const failures = []
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✓ ${name}${extra ? '  ' + extra : ''}`) }
  else { fail += 1; failures.push(name); console.log(`✗ ${name}${extra ? '  ' + extra : ''}`) }
}

try {
  // 等首次扫描完成
  let summary = null
  for (let i = 0; i < 40; i += 1) {
    const r = await call('GET', '/dsh-manuscript/api/summary')
    const j = J(r.body)
    if (r.status === 200 && j?.ok) { summary = j; break }
    await sleep(250)
  }
  check('首屏可用（建库完成）', !!summary, summary ? `entries=${summary.entries}` : '40 次轮询仍 503')

  console.log('\n── 1. 单会话批次的归属（这就是被静默丢弃的那条路径）──')
  const run = await call('POST', '/dsh-manuscript/api/distill/run?limit=1')
  const rj = J(run.body)
  check('提炼调用成功', run.status === 200 && rj?.ok === true, `status=${run.status} ok=${rj?.ok} err=${rj?.error}`)
  check('确实调了 LLM', llmCalls >= 1, `calls=${llmCalls}`)
  check('产出了提案（名词堆那条被 parse 单条淘汰）', (rj?.proposals || 0) === 1, `proposals=${rj?.proposals}`)
  check('被 parse 淘汰的提案被上报（不静默）',
    (rj?.droppedProposals || 0) >= 1 && Array.isArray(rj?.droppedReasons),
    `dropped=${rj?.droppedProposals} ${JSON.stringify(rj?.droppedReasons?.[0])}`)
  check(
    '★ 提案被组装成条目（修复前这里恒为 0，产出被静默丢弃）',
    Array.isArray(rj?.entries) && rj.entries.length >= 1,
    `entries=${rj?.entries?.length}`
  )

  const entry = rj?.entries?.[0]
  check('条目带 id', typeof entry?.id === 'string' && entry.id.length > 0, entry?.id)
  check('条目带溯源 sid（不是 guessed）', entry?.provenance?.session_id === 'session-t1', JSON.stringify(entry?.provenance?.session_id))
  check('主来源标为 batch（批次内唯一，精确）', entry?.provenance?.source_kind === 'batch', entry?.provenance?.source_kind)
  check('★ 条目被归册（不是收件箱兜底）', entry?.volume === 'vol-01', `volume=${entry?.volume}`)
  check('★ 条目被归章（与 T0 同一套主题口径）', entry?.chapter === 'ch-hw' && entry?.chapterTitle === '硬件与器件',
    `chapter=${entry?.chapter}/${entry?.chapterTitle}`)
  check('权威等级为 L2（LLM 参与，非人工）', entry?.authority === 'L2', entry?.authority)

  console.log('\n── 2. 裁决：没到 high 的自动通过线就进人工队列 ──')
  const adj = rj?.adjudication
  check('裁决统计自洽', (adj?.stats?.total || 0) === (rj?.entries?.length || 0), JSON.stringify(adj?.stats))
  check('人工队列条目仍是摘要形态（只有 title/claim/warnings）',
    Array.isArray(adj?.needsHuman) && adj.needsHuman.every((x) => x.title && !('id' in x)),
    `needsHuman=${adj?.needsHuman?.length}`)

  console.log('\n── 3. 入册：按 UI 的做法提交完整条目 ──')
  const beforeEntries = summary?.entries || 0
  const commit = await call('POST', '/dsh-manuscript/api/distill/commit', { entries: rj?.entries || [] })
  const cj = J(commit.body)
  check('入册成功', commit.status === 200 && cj?.ok === true && cj.written === 1,
    `written=${cj?.written} skipped=${cj?.skipped} rejected=${JSON.stringify(cj?.rejected)}`)
  check('入册后条目落盘（不是只回 ok）',
    readdirSync(join(LIB_ROOT, 'entries')).filter((f) => f.endsWith('.json')).length >= beforeEntries + 1,
    `磁盘 ${readdirSync(join(LIB_ROOT, 'entries')).length} 个`)

  const after = J((await call('GET', '/dsh-manuscript/api/summary')).body)
  check('summary.entries 增加 1', (after?.entries || 0) === beforeEntries + 1, `${beforeEntries} -> ${after?.entries}`)
  const chTitles = (after?.volumes || []).flatMap((v) => (v.chapters || []).map((c) => c.title))
  check('入册后没出现「未归章」（T1 与 T0 归属一致）', !chTitles.includes('未归章'), JSON.stringify(chTitles))

  console.log('\n── 4. 幂等：同一条再提交一次不该重复 ──')
  const again = J((await call('POST', '/dsh-manuscript/api/distill/commit', { entries: rj?.entries || [] })).body)
  check('第二次提交被跳过', again?.written === 0 && again?.skipped === 1,
    `written=${again?.written} skipped=${again?.skipped} dup=${JSON.stringify(again?.duplicates)}`)

  console.log('\n── 5. 批内多会话：按标题归到正确的来源会话 ──')
  const multi = J((await call('POST', '/dsh-manuscript/api/distill/run?limit=3')).body)
  check('多会话批次也成功', multi?.ok === true && multi?.status !== 'failed', `status=${multi?.status} err=${multi?.error}`)
  check('本批两条提案通过内容校验（第三条 claim 过短被 auto-reject）',
    (multi?.proposals || 0) >= 2, `proposals=${multi?.proposals} entries=${multi?.entries?.length} rejected=${multi?.entriesRejected}`)
  // 【2026-11-08 修复的回归】被 adjudicate 自动拒绝的条目**不能**出现在 entries 里 ——
  // 否则界面上的「入册」会把它一起写进书库（实测曾发生）。
  check('★ 自动拒绝的条目没有混进 entries',
    !(multi?.entries || []).some((e) => String(e.title || '').includes('自动裁决拒掉')),
    JSON.stringify((multi?.entries || []).map((e) => e.title)))
  check('被自动拒绝的条数被显式上报', (multi?.entriesRejected || 0) >= 1, `entriesRejected=${multi?.entriesRejected}`)

  const multiEntries = multi?.entries || []
  const byTitle = new Map(multiEntries.map((e) => [String(e.title || '').slice(0, 8), e]))
  for (const [kw, sid, vol] of [
    ['KiCad', 's-eda', 'vol-04'],
    ['dsh 插件', 's-plug', 'vol-03'],
  ]) {
    const e = multiEntries.find((x) => String(x.title || '').includes(kw))
    check(`「${kw}」条目存在`, !!e, e ? e.title : '缺失')
    if (e) {
      check(`「${kw}」来源会话正确（${sid}）`, e.provenance?.session_id === sid, e.provenance?.session_id)
      check(`「${kw}」归属册正确（${vol}）`, e.volume === vol, e.volume)
      check(`「${kw}」有主题章（不是未归章）`, !!e.chapter && e.chapter !== 'ch-未分类', `${e.chapter}/${e.chapterTitle}`)
    }
  }
  check('同一批内两条条目来源不同（没有都指同一个会话）',
    new Set(multiEntries.map((e) => e.provenance?.session_id)).size === multiEntries.length,
    JSON.stringify(multiEntries.map((e) => e.provenance?.session_id)))

  console.log('\n── 6. 并发两次提炼：第二次必须说"正忙"，不能回 ok:true ──')
  {
    // 【2026-11-08 修复】原来并发时第二次返回 { skipped:true, reason }，
    // 没有 status/busy，路由据此给出 ok:true —— 用户看到"成功"，实际一个字都没提炼。
    slowMode = true
    const [a, b] = await Promise.all([
      call('POST', '/dsh-manuscript/api/distill/run?limit=1'),
      call('POST', '/dsh-manuscript/api/distill/run?limit=1'),
    ])
    slowMode = false
    const ja = J(a.body)
    const jb = J(b.body)
    const busyOne = [ja, jb].find((x) => x?.busy === true)
    const doneOne = [ja, jb].find((x) => x?.busy !== true)
    check('一次成功、一次报 busy', !!busyOne && !!doneOne, `busy=${JSON.stringify(!!busyOne)}`)
    check('★ busy 那次 ok 必须为 false（不能伪装成功）', busyOne?.ok === false, `ok=${busyOne?.ok}`)
    check('busy 那次带 status=busy 与原因', busyOne?.status === 'busy' && /进行中/.test(String(busyOne?.reason || '')), busyOne?.reason)
    check('成功那次照常产出', doneOne?.ok === true, `ok=${doneOne?.ok} status=${doneOne?.status}`)
  }

  console.log('\n── 6-b. ??model= 拼错必须报错，不能静默回落 ──')
  {
    const bad = await call('POST', '/dsh-manuscript/api/distill/run?limit=1&model=gpt-4o')
    const bj = J(bad.body)
    check('未知模型 → 400（不再静默换成当前模型真跑）', bad.status === 400, `status=${bad.status} err=${bj?.error || ''}`)
    check('400 里列出可用模型', Array.isArray(bj?.models) && bj.models.length > 0, JSON.stringify(bj?.models?.slice(0, 3)))
  }

  console.log('\n── 7. 提炼报告落盘 ──')
  const runs = readdirSync(join(LIB_ROOT, 'runs')).filter((f) => f.startsWith('distill-'))
  check('runs/ 下有提炼凭证', runs.length >= 1, runs[0] || '')
} finally {
  server.close()
  rmSync(TMP, { recursive: true, force: true })
}

console.log('\n' + '═'.repeat(74))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail) {
  console.log('失败用例：')
  for (const f of failures) console.log('  ✗ ' + f)
}
console.log('═'.repeat(74))
process.exit(fail ? 1 : 0)
