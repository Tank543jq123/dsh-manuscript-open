#!/usr/bin/env node
/**
 * 中文短查询召回 + L2 首轮预取 的回归测试（2026-11-07 新增）。
 *
 * ## 为什么单独一个文件
 *
 * 这个缺陷不是"排序不准"，而是**数学上不可能命中**：
 * 旧实现写死 `cjkHits < 3 → 清零`，而 2 字查询只产生 1 个 bigram、3 字只产生 2 个，
 * 于是「插件」「排针」这类查询永远是 0 命中 —— 手册里明明有这些标题。
 * L2 首轮预取复用同一个匹配器，所以也从不触发。
 *
 * 这类"结构性不可达"必须用一个**不依赖真实语料**的夹具钉住，
 * 否则换台机器（会话数不同）就测不出来。
 *
 * 夹具刻意做成：条目只有标题有实词、claim 全是统计串 —— 与 T0 轨的真实产物同构。
 */

import { matchEntries, buildPrefetchDecision, recallFromLongSentence } from '../lib/index.js'

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

/** 造一条与 T0 产物同构的条目：标题有内容，claim 是统计串。 */
const mkEntry = (id, title, volume = 'vol-03') => ({
  id,
  volume,
  chapter: 'ch-x',
  title,
  claim: '3 轮 · 42 次工具调用 · 1 个交付物 · （多轮讨论）',
  confidence: 'speculation',
  authority: 'L3',
  status: 'current',
  provenance: { session_id: 'session-' + id, timestamp: '2026-11-01T00:00:00.000Z' },
})

const entries = [
  mkEntry('e1', '安装更新 dsh-workbuddy-connect 插件'),
  mkEntry('e2', '嘉立创2.0双排针选型'),
  mkEntry('e3', '30字符本地大模型介绍'),
  mkEntry('e4', 'DSH 启动失败排查'),
  mkEntry('e5', '定时工作的脚本怎么改'),
]

const SNAP = {
  summary: {
    volumes: [
      {
        id: 'vol-03',
        no: 'VOL.03',
        name: 'DSH 插件开发',
        entries: entries.length,
        chapters: [{ slug: 'ch-x', title: 'x', entries }],
      },
    ],
  },
}

console.log('\n── 1. 中文短查询必须可达 ──')

for (const [q, expectId] of [
  ['插件', 'e1'],
  ['排针', 'e2'],
  ['选型', 'e2'],
  ['字符', 'e3'],
  ['排查', 'e4'],
  ['定时任务', 'e5'],   // 3 个 bigram：定时 / 时任 / 任务；标题含「定时」与「任务」
]) {
  const hits = matchEntries(SNAP, q, 8)
  check(`"${q}" 能命中（旧实现在这里必然 0）`, hits.length > 0, `${hits.length} 条`)
  check(`"${q}" 的 top1 是包含该词的条目`, hits[0]?.id === expectId, hits[0] ? hits[0].id + ' / ' + hits[0].title : '无')
}

console.log('\n── 2. 精度：不该命中的仍然 0 ──')

for (const q of ['完全不存在的词串', 'zzz绝不可能命中的查询字符串qqq', '这个怎么办', '你好', 'abc']) {
  const hits = matchEntries(SNAP, q, 8)
  check(`"${q}" → 0 命中（fail-closed）`, hits.length === 0, `${hits.length} 条`)
}

console.log('\n── 3. 长句：整句查不到时按虚词切段重试 ──')

const longQ = '上次那个插件是怎么装的'
check('整句直接查不到（覆盖度不够）', matchEntries(SNAP, longQ, 3).length === 0, `${matchEntries(SNAP, longQ, 3).length} 条`)
check('切段兜底能查到「插件」那一条', recallFromLongSentence(SNAP, longQ, 3).some((h) => h.id === 'e1'))
check('切段兜底对无意义长句仍然是 0', recallFromLongSentence(SNAP, 'zzz绝不可能命中的查询字符串qqq', 3).length === 0)

console.log('\n── 4. L2 首轮预取 ──')

const decide = (text, opts = {}) =>
  buildPrefetchDecision({
    turn: 1,
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    seen: opts.seen || new Set(),
    agentId: 'agent-1',
    snapshot: SNAP,
  })

const d1 = decide(longQ)
check('自然语言整句能触发注入', !!d1.injected, d1.injected ? '注入了' : '未注入')
check('注入消息带自己的 source.kind', d1.injected?.source?.kind === 'manual-prefetch', d1.injected?.source?.kind)
check('注入正文不超过 3 条', (d1.injected?.content?.[0]?.text.match(/^· /gm) || []).length <= 3)
check('注入消息排在原消息之前', Array.isArray(d1.messages) && d1.messages[0]?.source?.kind === 'manual-prefetch')

const seen = new Set()
decide(longQ, { seen })
const d2 = decide(longQ, { seen })
check('同一 agent 第二次不再注入', !d2.injected)

const d3 = buildPrefetchDecision({
  turn: 2,
  messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: longQ }] }],
  seen: new Set(),
  agentId: 'agent-2',
  snapshot: SNAP,
})
check('turn=2 不注入', !d3.injected)

check('无意义句子不注入', !decide('你好').injected)

console.log('\n── 5. 防御：畸形入参不抛错 ──')
{
  // buildPrefetchDecision 是导出 API，调用点在 agent/pre-step：
  // 一次抛错就打断整轮对话。实测传 messages:null 会抛 TypeError。
  const bad = [
    ['messages=null', { turn: 1, messages: null, seen: new Set(), agentId: 'a', snapshot: SNAP }],
    ['messages=undefined', { turn: 1, messages: undefined, seen: new Set(), agentId: 'a', snapshot: SNAP }],
    ['seen 缺失', { turn: 1, messages: [], agentId: 'a', snapshot: SNAP }],
    ['snapshot=null', { turn: 1, messages: [], seen: new Set(), agentId: 'a', snapshot: null }],
  ]
  for (const [label, args] of bad) {
    let threw = null
    try { buildPrefetchDecision(args) } catch (e) { threw = e.message }
    check(`${label} → 不抛错`, threw === null, threw || 'ok')
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
