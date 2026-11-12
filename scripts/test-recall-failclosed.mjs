#!/usr/bin/env node
/**
 * fail-closed 门槛回归 —— 2026-11-12 优化。
 *
 * 事故（审计 29 问 + 负控实测）：
 *   · 「Docker 容器 exit code 137 内存不足怎么排查」→ 返回一堆 web_search 崩溃条目
 *     （手册里根本没有 Docker 经验，只是都出现了 exit/code）；
 *   · 「myhot 改成本地直发」→ bigram「成本」把 token 成本条目顶到 top1。
 * 修法：查询词按文档频率分「稀有/常见」，长查询至少命中 2 个稀有词；
 * 带英文词/强数字时该词必须真的命中；纯中文长句才允许切段兜底。
 */
import { matchEntries } from '../lib/index.js'

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
function entry(id, title, claim) {
  return { id, title, claim, volume: 'vol-03', chapter: 'ch-01', confidence: 'medium', authority: 'L2' }
}

// 语料刻意做成「真实分布」：成本出现多次（常见词），myhot 出现两次，137 一次都没有。
const entries = [
  entry('e-agentb-1', 'web_search 依赖 agentbrowser 子进程，会以 exit code 1 崩溃',
    '调用 web_search 时 agentbrowser exited with code 1，栈顶在 httpx/_urlparse.py。'),
  entry('e-agentb-2', 'web_search 因 agentbrowser 的 httpx 解析异常直接退出',
    '本次会话 web_search exit code 1，改用 bash 完成检索。'),
  entry('e-cost-1', 'token 成本统计只看会话计量', 'AIHOT 的 token 成本按模型单价与会话轮次估算，myhot 报表里常被误读。'),
  entry('e-cost-2', '成本口径要区分缓存命中', 'moonshot 成本统计里缓存命中不计费；myhot 的日志也没记这层。'),
  entry('e-cost-3', '推理成本与定价', '本地推理的成本主要是电费与时间，云端按 token 计费。'),
  entry('e-plugin-1', '插件装完不用重启', 'DSH 插件支持 HMR 热加载，装入 profile 后刷新页面即可。'),
  entry('e-pin-1', '嘉立创2.0双排针选型', '2.0mm 双排针 2x10P 选型与立创商城料号。'),
  entry('e-oom-1', '本地 27B 模型长时间运行后系统内存持续增长并 OOM',
    '27B/35B 本地模型跑久了系统内存涨到 70% 后 OOM，不是显存问题。'),
]
const snapshot = {
  summary: {
    volumes: [{ id: 'vol-03', no: 'VOL.03', name: 'DSH 插件开发', chapters: [{ slug: 'ch-01', title: '混合', entries }] }],
  },
}

check('Docker exit code 137 不返回 web_search 邻域（负控）', () => {
  const hits = matchEntries(snapshot, 'Docker 容器 exit code 137 内存不足', 3)
  assert(hits.length === 0, '应无命中，实际：' + JSON.stringify(hits.map((h) => h.title)))
})
check('myhot 改成本地直发 不被「成本」带偏（负控）', () => {
  const hits = matchEntries(snapshot, 'myhot 改成本地直发', 3)
  assert(hits.length === 0, '应无命中，实际：' + JSON.stringify(hits.map((h) => h.title)))
})
check('短查询「插件」仍能命中', () => {
  const hits = matchEntries(snapshot, '插件', 3)
  assert(hits.length === 1 && hits[0].id === 'e-plugin-1', '应命中 e-plugin-1，实际：' + JSON.stringify(hits.map((h) => h.id)))
})
check('短查询「排针」仍能命中', () => {
  const hits = matchEntries(snapshot, '排针', 3)
  assert(hits.length === 1 && hits[0].id === 'e-pin-1', '应命中 e-pin-1，实际：' + JSON.stringify(hits.map((h) => h.id)))
})
check('真实问题「本地 27B 模型 为什么 OOM」仍能命中', () => {
  const hits = matchEntries(snapshot, '本地 27B 模型为什么 OOM', 3)
  assert(hits.some((h) => h.id === 'e-oom-1'), '应命中 e-oom-1，实际：' + JSON.stringify(hits.map((h) => h.id)))
})
check('带英文词但确实存在时照常命中', () => {
  const hits = matchEntries(snapshot, 'web_search exit code', 3)
  assert(hits.some((h) => h.id === 'e-agentb-1'), '应命中 e-agentb-1，实际：' + JSON.stringify(hits.map((h) => h.id)))
})

console.log('\n' + '='.repeat(60))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail > 0) {
  for (const f of failures) console.log('  ' + f)
  process.exit(1)
}
