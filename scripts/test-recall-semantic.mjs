#!/usr/bin/env node
/**
 * 语义二路召回回归测试（2026-11-12 新增）。
 *
 * ## 它锁住什么
 *
 * 「换个说法也能查到」这件事，只有在**不破坏 fail-closed** 的前提下才算数。
 * 所以这个脚本同时钉三组事实：
 *   ① 同义改写：关键词路 0 命中时，语义路能把真条目补回来；
 *   ② 负控：英文/数字负控、纯中文域外负控仍然 0 条 —— 语义路不能当后门；
 *   ③ 关键词路不受影响：关键词有命中时，结果与 `matchEntries` 逐条一致，
 *      且全部标 `match: 'keyword'`，语义一条都不许插到前面。
 *
 * ## 为什么用夹具而不是真实库
 *
 * 真实库会持续变化（现在 321 条，还会涨）。用固定夹具才能让
 * 「0.15 阈值 + 2 个 bigram」这类数值口径在换机器后仍可复现；
 * 真实库上的标定数字写在交付报告里，不在断言里。
 *
 * 夹具刻意复刻真实分布：插件/服务这类词出现 3 次以上（常见词），
 * 重启/装完只出现 1–2 次（稀有词），并混入骨架条目与英文技术条目。
 */

import { performance } from 'node:perf_hooks'
import {
  matchEntries,
  searchEntries,
  semanticRecall,
  buildSemanticIndex,
  getSemanticIndex,
  SEMANTIC_COS_MIN,
  SEMANTIC_MIN_BIGRAM_HITS,
} from '../lib/index.js'

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

/** 造一条真实形状的条目。 */
function entry(id, title, claim, extra = {}) {
  return {
    id,
    title,
    claim,
    volume: 'vol-03',
    chapter: 'ch-01',
    confidence: 'medium',
    authority: 'L2',
    status: 'current',
    ...extra,
  }
}

/**
 * 夹具语料（10 条）。
 *
 * 语言分布刻意做成「关键词路会失败、语义路要成功」：
 *   查询「装完插件要重启服务吗」→ 插件/服务 是常见 bigram（df=3），
 *   重启/装完 只是普通词，长查询凑不够 2 个稀有词 → 关键词 0 命中；
 *   语义路却能靠 4 个 bigram 的重合找到 e-plugin-hmr。
 */
function makeEntries() {
  return [
    entry(
      'e-plugin-hmr',
      'DSH 插件热加载：装完刷新页面就生效',
      '插件装进正在运行的 profile 后无需重启整个服务进程，HMR 会热挂载新的客户端清单。'
    ),
    entry(
      'e-plugin-install',
      '安装 dsh-workbuddy-connect 插件',
      '插件安装完成后该 profile 已被热挂载，服务不用重启，刷新页面即可看到入口。'
    ),
    entry(
      'e-plugin-ui',
      '插件里自造的 h() 虚拟对象直接给 React 渲染会报错',
      '插件客户端要把节点交给宿主渲染器，服务端不要持有 React 元素。'
    ),
    entry(
      'e-oom',
      '本地 27B 模型长时间运行后系统内存持续增长并最终 OOM',
      '本地模型跑久了系统内存涨到 70% 后 OOM，不是显存不足；定时重启推理服务可缓解。'
    ),
    entry(
      'e-pin',
      '嘉立创2.0双排针选型',
      '2.0mm 双排针 2x10P 选型与立创商城料号，用于验证标题级召回。'
    ),
    entry(
      'e-skeleton',
      '会话统计骨架：一次多轮排查',
      '35 轮 · 498 次工具调用 · 0 个交付物 · （多轮讨论）',
      { confidence: 'speculation', authority: 'L3' }
    ),
    entry(
      'e-agentb',
      'web_search 依赖 agentbrowser 子进程，会以 exit code 1 崩溃',
      '调用 web_search 时 agentbrowser exited with code 1，栈顶在 httpx/_urlparse.py。'
    ),
    entry(
      'e-wechat',
      'dsh-schedule 把提醒注入当前会话而非微信',
      '微信推送需要另外接推送桥，定时任务的提醒本身不会送到微信。'
    ),
    entry(
      'e-subagent',
      'subagent 工具存在深度上限，主会话内不能再派生子代理',
      'delegation depth 为 1 时子代理不能再派生下一层，主会话内也无法再派生子代理。'
    ),
    entry(
      'e-trash',
      '受精确字数约束的文案，需要实际统计来验证',
      '文案长度不能凭感觉写，要用脚本统计字符数；这条与本次查询无关，用于制造常见 bigram。'
    ),
  ]
}

/** 造 snapshot（形状与 state.snapshot.summary 一致）。 */
function makeSnapshot(entries = makeEntries()) {
  return {
    summary: {
      volumes: [
        {
          id: 'vol-03',
          no: 'VOL.03',
          name: 'DSH 插件开发',
          chapters: [{ slug: 'ch-01', title: '混合', entries }],
        },
      ],
    },
  }
}

// ── ① 同义改写：关键词 0 命中 → 语义补回 ───────────────────────────
check('同义改写「装完插件要重启服务吗」关键词 0 命中（前提）', () => {
  const hits = matchEntries(makeSnapshot(), '装完插件要重启服务吗', 5)
  assert(hits.length === 0, '夹具前提不成立，关键词就命中了：' + JSON.stringify(hits.map((h) => h.id)))
  return '0 命中'
})

check('同义改写经语义路召回 e-plugin-hmr，且标注 semantic', () => {
  const hits = searchEntries(makeSnapshot(), '装完插件要重启服务吗', 5)
  const hit = hits.find((h) => h.id === 'e-plugin-hmr')
  assert(hit, '未召回 e-plugin-hmr，实际：' + JSON.stringify(hits.map((h) => h.id)))
  assert(hit.match === 'semantic', '来源标注应为 semantic，实际：' + hit.match)
  assert(Number.isFinite(hit.semanticScore) && hit.semanticScore >= SEMANTIC_COS_MIN,
    '余弦应达阈值，实际：' + hit.semanticScore)
  return '余弦 ' + hit.semanticScore.toFixed(3)
})

check('同义改写「插件服务重启怎么办」也能召回（换词序）', () => {
  const hits = searchEntries(makeSnapshot(), '插件服务重启怎么办', 5)
  const hit = hits.find((h) => h.id === 'e-plugin-hmr')
  assert(hit, '未召回 e-plugin-hmr，实际：' + JSON.stringify(hits.map((h) => h.id)))
  return '余弦 ' + hit.semanticScore.toFixed(3)
})

// ── ② 负控：语义路不能成为 fail-closed 的后门 ──────────────────────
const NEG_LATIN = ['Docker exit code 137', 'Vulkan 投机解码参数', 'Nuxt 3 SSR 缓存']
for (const q of NEG_LATIN) {
  check(`负控「${q}」仍返回 0 条`, () => {
    const hits = searchEntries(makeSnapshot(), q, 8)
    assert(hits.length === 0, '应无命中，实际：' + JSON.stringify(hits.map((h) => h.title)))
    return '0 条'
  })
}

const NEG_CJK = ['量子引力波怎么观测', '红烧肉要炖多久才软', '股票分红怎么交税', '恐龙为什么灭绝']
for (const q of NEG_CJK) {
  check(`纯中文域外负控「${q}」语义路 0 条`, () => {
    const sem = semanticRecall(makeSnapshot(), q, 8)
    assert(sem.length === 0, '语义路应 0 条，实际：' + JSON.stringify(sem.map((h) => h.title)))
    const hits = searchEntries(makeSnapshot(), q, 8).filter((h) => h.match === 'semantic')
    assert(hits.length === 0, '二路检索不应有语义命中，实际：' + JSON.stringify(hits.map((h) => h.title)))
    return '0 条'
  })
}

check('单 bigram 巧合被覆盖门槛挡住（反例：笔记）', () => {
  // 「笔记」只在 e-pin 的 claim（选型笔记）里出现；旧原型会靠它拿到高分。
  // 这里用一条只在「笔记」上重合的查询，验证 SEMANTIC_MIN_BIGRAM_HITS 生效。
  const sem = semanticRecall(makeSnapshot(), '笔记本散热风扇一直转', 8)
  assert(sem.length === 0, '不应靠单个 bigram 命中，实际：' + JSON.stringify(sem.map((h) => h.title)))
  return `要求 ≥${SEMANTIC_MIN_BIGRAM_HITS} 个 bigram`
})

// ── ③ 关键词路不受影响 ────────────────────────────────────────────
check('短查询「插件」：与 matchEntries 逐条一致，全标 keyword', () => {
  const snap = makeSnapshot()
  const kw = matchEntries(snap, '插件', 3)
  const two = searchEntries(snap, '插件', 3)
  assert(kw.length > 0, '夹具前提不成立：关键词「插件」应命中')
  assert(JSON.stringify(two.map((h) => h.id)) === JSON.stringify(kw.map((h) => h.id)),
    `二路结果应与关键词一致：kw=${JSON.stringify(kw.map((h) => h.id))} two=${JSON.stringify(two.map((h) => h.id))}`)
  assert(two.every((h) => h.match === 'keyword'), '关键词命中不得被标成 semantic')
  return kw.length + ' 条'
})

check('关键词路已满 topK 时语义一条都不加', () => {
  const snap = makeSnapshot()
  const kw = matchEntries(snap, '双排针怎么选', 1)
  assert(kw.length === 1, '夹具前提不成立：应恰好 1 条关键词命中，实际 ' + kw.length)
  const two = searchEntries(snap, '双排针怎么选', 1)
  assert(two.length === 1 && two[0].id === kw[0].id && two[0].match === 'keyword',
    'topK 已满时不应追加语义项，实际：' + JSON.stringify(two.map((h) => [h.id, h.match])))
  return '未追加'
})

check('关键词路 0 命中、语义也不够格时，结果仍为 0（不硬凑）', () => {
  const hits = searchEntries(makeSnapshot(), '红烧肉要炖多久才软', 8)
  assert(hits.length === 0, '应 0 条，实际：' + JSON.stringify(hits.map((h) => h.title)))
  return '0 条'
})

// ── ④ 索引缓存 / 性能 ─────────────────────────────────────────────
check('索引缓存挂在 snapshot 上，同一快照复用', () => {
  const snap = makeSnapshot()
  const a = getSemanticIndex(snap)
  const b = getSemanticIndex(snap)
  assert(a && a === b, '同一 snapshot 应复用同一索引对象')
  assert(a.n >= 9, '索引条数异常：' + a.n)
  const sym = Object.getOwnPropertySymbols(snap).map(String)
  assert(sym.some((s) => s.includes('semanticIndex')), '索引应缓存到 snapshot 上')
  return `n=${a.n}`
})

check('snapshot 内容变化后索引重建（不会拿旧索引配新数据）', () => {
  const entries = makeEntries()
  const snap = makeSnapshot(entries)
  const before = getSemanticIndex(snap)
  entries.push(entry('e-new', '新加的插件条目', '插件服务设置变更后需要重新扫描。'))
  const after = getSemanticIndex(snap)
  assert(before !== after, '条目变化后应重建索引')
  assert(after.n === before.n + 1, `条数应 +1：before=${before.n} after=${after.n}`)
  return `${before.n} → ${after.n}`
})

check('321 条规模：单次检索 < 300ms（含首次建索引）', () => {
  // 逼近真实规模：320 条互不重复的填充条目 + 1 条插件热加载条目。
  // 填充条目刻意**不含**查询用字（插件/重启/服务/装完），否则它们会把
  // df 顶过 20% 上限 —— 那测的就不是性能，而是夹具自己造的偏态分布。
  const fillers = ['记录', '排查', '流程', '步骤', '数据', '检查', '验证', '结果', '方案', '整理',
    '细节', '说明', '现场', '阶段', '结论', '时间', '窗口', '日志', '配置', '参数',
    '接口', '返回', '错误', '异常', '超时', '边界', '结论', '顺序', '基线', '差异']
  const entries = [makeEntries()[0]]
  for (let i = 0; i < 320; i += 1) {
    const a = fillers[i % fillers.length]
    const b = fillers[(i * 7 + 3) % fillers.length]
    const c = fillers[(i * 13 + 5) % fillers.length]
    entries.push(entry(`e-filler-${i}`, `第${i}项${a}${b}`, `本项${c}${a}的${b}已经${c}，此处只作索引填充。`))
  }
  const snap = makeSnapshot(entries)
  const t0 = performance.now()
  const first = searchEntries(snap, '装完插件要重启服务吗', 8)
  const firstMs = performance.now() - t0
  const t1 = performance.now()
  for (let i = 0; i < 10; i += 1) searchEntries(snap, '装完插件要重启服务吗', 8)
  const avgMs = (performance.now() - t1) / 10
  assert(entries.length >= 320, '语料规模不足：' + entries.length)
  assert(firstMs < 300, `首次检索耗时 ${firstMs.toFixed(1)}ms，应 <300ms`)
  assert(avgMs < 300, `热检索均耗时 ${avgMs.toFixed(1)}ms，应 <300ms`)
  assert(first.length > 0, '大规模语料上语义路应仍有命中')
  return `首次 ${firstMs.toFixed(1)}ms / 均 ${avgMs.toFixed(1)}ms`
})

check('索引条数：污染条目（fallback + 损坏）不进语义语料', () => {
  const entries = makeEntries()
  entries.push(
    entry('e-polluted', '??? ??? 损坏的兜底条目 ???', '??????????', { volumeFallback: true })
  )
  const idx = buildSemanticIndex(makeSnapshot(entries))
  assert(!idx.docs.some((d) => d.entry.id === 'e-polluted'), '污染条目不应进语义索引')
  return '已排除'
})

console.log('\n' + '='.repeat(60))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail > 0) {
  for (const f of failures) console.log('  ' + f)
  process.exit(1)
}
