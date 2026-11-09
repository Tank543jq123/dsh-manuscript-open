/**
 * 书阁 · 提炼流水线测试
 *
 * 原则：**用真实语料跑选取规则**（224 个会话），用 mock 跑失败路径。
 * 绝不调用真实 LLM。
 *
 * 跑：node scripts/test-pipeline.mjs
 */

import {
  selectQueue,
  makeBatches,
  runDistillPass,
  proposalsToEntries,
  mergeFailureCounts,
  buildRunReport,
  planDistill,
  priorityOf,
  estimateQueueChars,
  MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MAX_SESSIONS_PER_BATCH,
  DEFAULT_MAX_CHARS_PER_BATCH,
} from '../lib/pipeline.js'
import { scanSessions } from '../lib/scan.js'
import { triageAll } from '../lib/triage.js'

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

async function checkAsync(name, fn) {
  try {
    const detail = await fn()
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

// ─────────────────────────────────────────────────────────────
// 真实语料
// ─────────────────────────────────────────────────────────────
let triaged = null
try {
  const scanned = scanSessions()
  triaged = triageAll(scanned.sessions).enriched
} catch (e) {
  console.log(`⚠ 无法扫描真实语料（${e?.message}），改用合成语料`)
}

/** 合成语料：真实扫描不可用时兜底，保证测试仍可跑 */
function syntheticCorpus() {
  const out = []
  const add = (i, spec) => {
    out.push({
      sid: `syn-${i}`,
      title: spec.title || `会话 ${i}`,
      category: spec.category,
      admission: spec.admission,
      shape: spec.shape,
      qualityScore: spec.qualityScore ?? 5,
      deliverables: spec.deliverables ?? 0,
      turnEnds: spec.turnEnds ?? 1,
      toolCalls: spec.toolCalls ?? 10,
      humanTextTotal: spec.humanTextTotal ?? 1000,
      humanTextAvgLen: spec.humanTextAvgLen ?? 500,
      createdAt: '2026-10-01T00:00:00.000Z',
      project: 'demo',
    })
  }
  // 5 个 strong multi-turn
  for (let i = 0; i < 5; i += 1) {
    add(`strong-${i}`, { category: 'real', admission: 'strong', shape: 'multi-turn', qualityScore: 8, deliverables: 3, turnEnds: 6 })
  }
  // 8 个 weak multi-turn
  for (let i = 0; i < 8; i += 1) {
    add(`weak-${i}`, { category: 'real', admission: 'weak', shape: 'multi-turn', qualityScore: 5, turnEnds: 4 })
  }
  // 6 个 one-shot
  for (let i = 0; i < 6; i += 1) {
    add(`oneshot-${i}`, { category: 'real', admission: 'weak', shape: 'one-shot', qualityScore: 4, turnEnds: 1 })
  }
  // 噪声：empty + smoke
  for (let i = 0; i < 4; i += 1) {
    add(`empty-${i}`, { category: 'empty', admission: 'noise', shape: 'unknown', qualityScore: 0 })
  }
  for (let i = 0; i < 3; i += 1) {
    add(`smoke-${i}`, { category: 'smoke', admission: 'noise', shape: 'unknown', qualityScore: 0 })
  }
  return out
}

const corpus = triaged && triaged.length > 0 ? triaged : syntheticCorpus()
const usingReal = Boolean(triaged && triaged.length > 0)

// ═══════════════════════════════════════════════════════════════
console.log(`\n语料：${usingReal ? '真实' : '合成'} · ${corpus.length} 个会话`)
const noiseCount = corpus.filter((s) => s.admission === 'noise').length
const realCount = corpus.filter((s) => s.category === 'real').length
console.log(`      真实 ${realCount} · 噪声 ${noiseCount}\n`)
// ═══════════════════════════════════════════════════════════════

// ① noise 全被排除
check('① 真实语料：noise 一个都不进队列', () => {
  const { queue, skipped, stats } = selectQueue(corpus, {}, { maxSessions: 1000 })
  const noiseInQueue = queue.filter((s) => s.admission === 'noise' || s.category !== 'real')
  assert(noiseInQueue.length === 0, `队列里混进 ${noiseInQueue.length} 个噪声`)

  // 所有 noise 都必须出现在 skipped 里，且理由可读
  const skippedSids = new Set(skipped.map((s) => s.sid))
  const noise = corpus.filter((s) => s.admission === 'noise' || s.category !== 'real')
  const missing = noise.filter((s) => !skippedSids.has(s.sid))
  assert(missing.length === 0, `${missing.length} 个噪声没出现在 skipped 里`)

  for (const item of skipped) {
    assert(typeof item.reason === 'string' && item.reason.length > 0, `skipped 缺 reason: ${JSON.stringify(item)}`)
    assert(typeof item.detail === 'string' && item.detail.length > 0, `skipped 缺人话 detail: ${JSON.stringify(item)}`)
    assert(item.detail !== item.reason, 'detail 必须是给人看的说明，不能等于 code')
  }
  return `队列 ${queue.length} · 跳过 ${skipped.length}（噪声 ${noise.length} 全部带理由）`
})

// ② 已提炼的不再提
check('② 已提炼的会话不进队列', () => {
  const distilled = new Set(corpus.filter((s) => s.category === 'real').slice(0, 3).map((s) => s.sid))
  const { queue, skipped } = selectQueue(corpus, { distilledSids: distilled }, { maxSessions: 1000 })
  const leaked = queue.filter((s) => distilled.has(s.sid))
  assert(leaked.length === 0, `${leaked.length} 个已提炼的又进了队列`)
  const reasons = skipped.filter((s) => s.reason === 'already-distilled')
  assert(reasons.length === distilled.size, `already-distilled 计数应为 ${distilled.size}，实际 ${reasons.length}`)
  return `${distilled.size} 个已提炼正确跳过`
})

// ③ 连续失败 3 次跳过
check('③ 连续失败 3 次的会话被跳过（2 次的仍重试）', () => {
  const real = corpus.filter((s) => s.category === 'real')
  assert(real.length >= 2, '需要至少 2 个真实会话')
  const [a, b] = real

  const failedSids = new Map([
    [a.sid, MAX_CONSECUTIVE_FAILURES], // 正好 3 次 → 跳过
    [b.sid, MAX_CONSECUTIVE_FAILURES - 1], // 2 次 → 还该重试
  ])
  const { queue, skipped } = selectQueue(corpus, { failedSids }, { maxSessions: 1000 })

  assert(!queue.some((s) => s.sid === a.sid), '失败 3 次的仍在队列里')
  assert(queue.some((s) => s.sid === b.sid), '失败 2 次的不该被跳过')
  const item = skipped.find((s) => s.sid === a.sid)
  assert(item && item.reason === 'too-many-failures', '缺 too-many-failures 理由')
  assert(item.detail.includes('3'), `理由里应说明次数：${item.detail}`)
  return `3 次跳过 / 2 次重试 · 理由「${item.detail}」`
})

// ④ 单轮上限
check('④ 单轮上限生效，超出的标 over-limit', () => {
  const { queue, skipped, stats } = selectQueue(corpus, {}, { maxSessions: 5 })
  assert(queue.length === 5, `上限 5，实际 ${queue.length}`)
  assert(stats.maxSessions === 5, 'stats.maxSessions 不对')
  const over = skipped.filter((s) => s.reason === 'over-limit')
  const expectedOver = Math.max(0, stats.eligible - 5)
  assert(over.length === expectedOver, `over-limit 计数应为 ${expectedOver}，实际 ${over.length}`)
  return `队列 5 · over-limit ${over.length}`
})

// ⑤ 默认上限是 20
check(`⑤ 默认上限 = ${DEFAULT_MAX_SESSIONS}`, () => {
  const { queue, stats } = selectQueue(corpus, {})
  assert(stats.maxSessions === DEFAULT_MAX_SESSIONS, `默认上限应为 ${DEFAULT_MAX_SESSIONS}，实际 ${stats.maxSessions}`)
  assert(queue.length <= DEFAULT_MAX_SESSIONS, '队列超默认上限')
  return `队列 ${queue.length} / 上限 ${DEFAULT_MAX_SESSIONS}`
})

// ⑥ 优先级排序正确
check('⑥ 优先级：strong > weak，multi-turn > one-shot', () => {
  const { queue } = selectQueue(corpus, {}, { maxSessions: 1000 })
  assert(queue.length >= 2, '队列太短无法验证排序')

  // 优先级必须单调不增
  for (let i = 1; i < queue.length; i += 1) {
    const prev = priorityOf(queue[i - 1])
    const cur = priorityOf(queue[i])
    assert(prev >= cur, `第 ${i} 位优先级 ${cur} 高于前一位 ${prev}`)
  }

  // 若有 strong，它必须全部排在 weak 之前
  const lastStrong = queue.map((s) => s.admission).lastIndexOf('strong')
  const firstWeak = queue.map((s) => s.admission).indexOf('weak')
  if (lastStrong >= 0 && firstWeak >= 0) {
    assert(lastStrong < firstWeak, 'strong 没有全部排在 weak 之前')
  }

  const top = queue[0]
  return `首位 ${top.sid}（${top.admission}/${top.shape}/q=${top.qualityScore}，分 ${priorityOf(top)}）`
})

// ⑦ 确定性（同输入同输出）
check('⑦ 同输入两次选取结果一致（可复现）', () => {
  const a = selectQueue(corpus, {}, { maxSessions: 10 }).queue.map((s) => s.sid)
  const b = selectQueue(corpus, {}, { maxSessions: 10 }).queue.map((s) => s.sid)
  assert(JSON.stringify(a) === JSON.stringify(b), '两次结果不一致')
  return `10 个 sid 完全一致`
})

// ⑧ 分批不超限
check('⑧ makeBatches 不超会话数上限', () => {
  const queue = selectQueue(corpus, {}, { maxSessions: 1000 }).queue
  const batches = makeBatches(queue, { maxSessionsPerBatch: 3, maxCharsPerBatch: 1e9 })
  for (const b of batches) {
    assert(b.length <= 3, `某批有 ${b.length} 个会话，超过上限 3`)
  }
  const flat = batches.flat()
  assert(flat.length === queue.length, `分批丢会话：${flat.length} vs ${queue.length}`)
  // 不重不漏
  const sids = new Set(flat.map((s) => s.sid))
  assert(sids.size === queue.length, '分批出现重复')
  return `${queue.length} 会话 → ${batches.length} 批`
})

check('⑧b makeBatches 不超字符上限', () => {
  const queue = selectQueue(corpus, {}, { maxSessions: 1000 }).queue
  const maxChars = 5000
  const batches = makeBatches(queue, { maxSessionsPerBatch: 99, maxCharsPerBatch: maxChars })
  for (const b of batches) {
    const chars = estimateQueueChars(b)
    // 单会话独占批可以超（那是已知的不可分单元）
    if (b.length > 1) {
      assert(chars <= maxChars, `某批 ${b.length} 会话 / ${chars} 字符，超上限 ${maxChars}`)
    }
  }
  const flat = batches.flat()
  assert(flat.length === queue.length, '分批丢会话')
  return `${batches.length} 批 · 每批 ≤ ${maxChars} 字符`
})

check('⑧c 单会话自身超预算时独占一批（不丢）', () => {
  const huge = { sid: 'huge', humanTextTotal: 999999, humanTextAvgLen: 999999, turnEnds: 50, category: 'real', admission: 'strong' }
  const small = { sid: 'small', humanTextTotal: 100, humanTextAvgLen: 100, turnEnds: 1, category: 'real', admission: 'weak' }
  const batches = makeBatches([huge, small], { maxSessionsPerBatch: 9, maxCharsPerBatch: 1000 })
  assert(batches.length === 2, `应分成 2 批，实际 ${batches.length}`)
  assert(batches[0].length === 1 && batches[0][0].sid === 'huge', '超大会话应独占首批')
  assert(batches[1].some((s) => s.sid === 'small'), '小会话不该被丢')
  return '超大会话独占 1 批，小会话另起 1 批'
})

check('⑧d 默认分批参数生效', () => {
  const queue = selectQueue(corpus, {}, { maxSessions: 1000 }).queue
  const batches = makeBatches(queue)
  for (const b of batches) {
    assert(b.length <= DEFAULT_MAX_SESSIONS_PER_BATCH, `超默认会话上限 ${DEFAULT_MAX_SESSIONS_PER_BATCH}`)
    if (b.length > 1) {
      assert(estimateQueueChars(b) <= DEFAULT_MAX_CHARS_PER_BATCH, `超默认字符上限`)
    }
  }
  return `${batches.length} 批 · 默认 ${DEFAULT_MAX_SESSIONS_PER_BATCH} 会话 / ${DEFAULT_MAX_CHARS_PER_BATCH} 字符`
})

// ⑨ dryRun 不调 LLM
await checkAsync('⑨ dryRun 完全不调用 LLM', async () => {
  let called = 0
  const queue = selectQueue(corpus, {}, { maxSessions: 10 }).queue
  const result = await runDistillPass(queue, {
    llm: { chat: () => { throw new Error('不该被调用') } },
    dryRun: true,
    distillBatch: async () => {
      called += 1
      return []
    },
  })
  assert(called === 0, `dryRun 却调用了 ${called} 次 distillBatch`)
  assert(result.status === 'dry-run', `status 应为 dry-run，实际 ${result.status}`)
  assert(result.proposals.length === 0, 'dryRun 不该产出 proposals')
  assert(result.usage.calls === 0, 'dryRun 不该有调用计数')
  assert(result.plan.sessionCount === queue.length, 'plan.sessionCount 不对')
  return `0 次调用 · 预演 ${result.plan.sessionCount} 会话 / ${result.plan.calls} 次调用 / ${result.plan.totalChars} 字符`
})

await checkAsync('⑨b llm 为 null 时自动降级为 dry-run', async () => {
  let called = 0
  const queue = selectQueue(corpus, {}, { maxSessions: 5 }).queue
  const result = await runDistillPass(queue, {
    llm: null,
    distillBatch: async () => {
      called += 1
      return []
    },
  })
  assert(called === 0, 'llm=null 却调用了 distillBatch')
  assert(result.status === 'dry-run', 'status 应为 dry-run')
  return '零 LLM → 自动预演，不调用'
})

await checkAsync('⑨c 预演报告能让用户看到"提多少/几次调用"', async () => {
  const queue = selectQueue(corpus, {}, { maxSessions: 20 }).queue
  const result = await runDistillPass(queue, { dryRun: true })
  const p = result.plan
  assert(p.sessionCount > 0, 'sessionCount 应 > 0')
  assert(p.calls > 0, 'calls 应 > 0')
  assert(Array.isArray(p.willDistill) && p.willDistill.length === p.sessionCount, 'willDistill 数量不对')
  assert(Array.isArray(p.batches) && p.batches.length === p.calls, 'batches 数量应等于 calls')
  for (const w of p.willDistill) {
    assert(w.sid != null, 'willDistill 项缺 sid')
    assert(typeof w.priority === 'number', 'willDistill 项缺 priority')
  }
  return `待提炼 ${p.sessionCount} 个 · ${p.calls} 次调用 · ${p.totalChars} 字符`
})

// ⑩ ★ 一批失败不影响其他批
await checkAsync('⑩★ 单批失败不影响其他批（核心）', async () => {
  const queue = selectQueue(corpus, {}, { maxSessions: 9 }).queue
  assert(queue.length >= 6, `需要至少 6 个会话，实际 ${queue.length}`)

  const batches = makeBatches(queue, { maxSessionsPerBatch: 3, maxCharsPerBatch: 1e9 })
  assert(batches.length >= 2, '至少需要 2 批')

  let batchNo = 0
  const result = await runDistillPass(queue, {
    llm: { chat: async () => 'ok' },
    distillBatch: async (batch) => {
      const idx = batchNo
      batchNo += 1
      // 第 1 批（index 1）故意失败
      if (idx === 1) throw new Error('模拟批次失败：模型超时')
      return batch.map((s) => ({ sid: s.sid, title: `提炼:${s.title}`, claim: '结论' }))
    },
    maxSessionsPerBatch: 3,
    maxCharsPerBatch: 1e9,
  })

  assert(result.failures.length === 1, `应有 1 个失败批，实际 ${result.failures.length}`)
  assert(result.status === 'partial', `status 应为 partial，实际 ${result.status}`)

  // 其他批必须都有产出
  const expectedSuccess = batches.length - 1
  const expectedProposals = batches.filter((_, i) => i !== 1).reduce((a, b) => a + b.length, 0)
  assert(result.proposals.length === expectedProposals, `应产出 ${expectedProposals} 条，实际 ${result.proposals.length}`)
  assert(result.usage.calls === batches.length, `调用次数应为 ${batches.length}，实际 ${result.usage.calls}`)

  const failedSids = result.failures[0].sids
  assert(Array.isArray(failedSids) && failedSids.length > 0, '失败批应记录 sids')
  assert(result.failures[0].error.message.includes('模拟批次失败'), '应保留原始错误信息')

  return `${batches.length} 批 · 1 批失败 · 其余产出 ${result.proposals.length} 条（未受影响）`
})

await checkAsync('⑩b 全部批失败也不抛错，status=failed', async () => {
  const queue = selectQueue(corpus, {}, { maxSessions: 6 }).queue
  const result = await runDistillPass(queue, {
    llm: {},
    distillBatch: async () => {
      throw new Error('全挂')
    },
    maxSessionsPerBatch: 2,
  })
  assert(result.status === 'failed', `status 应为 failed，实际 ${result.status}`)
  assert(result.proposals.length === 0, '不该有产出')
  assert(result.failures.length > 0, '应记录失败')
  return `${result.failures.length} 批全失败 · 未抛出异常`
})

// ⑪ 失败计数合并
check('⑪ 失败计数正确累加与清零', () => {
  const prev = new Map([['a', 2], ['b', 1]])
  const failures = [{ sids: ['a', 'c'] }, { sids: ['c'] }]
  const proposals = [{ sid: 'b' }] // b 本轮成功了 → 清零
  const next = mergeFailureCounts(failures, prev, proposals)

  assert(next.get('a') === 3, `a 应为 3，实际 ${next.get('a')}`)
  assert(next.get('c') === 2, `c 应为 2，实际 ${next.get('c')}`)
  assert(!next.has('b'), 'b 成功后应被清零')
  return `a:2→3 · c:0→2 · b:1→清除`
})

check('⑪b 达到 3 次后下一轮真的被跳过（端到端）', () => {
  const real = corpus.filter((s) => s.category === 'real')
  const target = real[0]

  // 模拟连续 3 轮失败
  let counts = new Map()
  for (let round = 0; round < 3; round += 1) {
    counts = mergeFailureCounts([{ sids: [target.sid] }], counts, [])
  }
  assert(counts.get(target.sid) === 3, `应累计到 3，实际 ${counts.get(target.sid)}`)

  const { queue, skipped } = selectQueue(corpus, { failedSids: counts }, { maxSessions: 1000 })
  assert(!queue.some((s) => s.sid === target.sid), '失败 3 次后仍在队列')
  assert(skipped.some((s) => s.sid === target.sid && s.reason === 'too-many-failures'), '缺跳过记录')
  return `连续失败 3 轮 → 第 4 轮被跳过`
})

// ⑫-b 溯源必须是「已知批次」，不能是轮转猜测（2026-11-04 修复）
check('⑫-b proposal 带 provenance.session_ids → 溯源标记为 batch', () => {
  const session = corpus.find((s) => s.category === 'real')
  const proposals = [
    {
      sid: session.sid,
      title: '带批次来源的结论',
      claim: '这是一条可溯源的结论，来源是已知批次',
      confidence: 'high',
      provenance: { session_ids: [session.sid, 'other-sid'] },
    },
  ]
  const entries = proposalsToEntries(proposals, { triaged: corpus })
  const e = entries[0]
  assert(Array.isArray(e.provenance.session_ids), 'session_ids 必须保留')
  assert(e.provenance.session_ids.length === 2, `session_ids 应有 2 个，实际 ${e.provenance.session_ids.length}`)
  assert(e.provenance.source_kind === 'batch', `source_kind 应为 batch，实际 ${e.provenance.source_kind}`)
  return `source_kind=${e.provenance.source_kind} · ids=${e.provenance.session_ids.length}`
})

check('⑫-c 无批次信息的 proposal → 明确标 guessed（不冒充精确）', () => {
  const session = corpus.find((s) => s.category === 'real')
  const entries = proposalsToEntries(
    [{ sid: session.sid, title: '无批次的结论', claim: '这条没有批次信息所以来源是猜的' }],
    { triaged: corpus }
  )
  const e = entries[0]
  assert(e.provenance.source_kind === 'guessed', `应标 guessed，实际 ${e.provenance.source_kind}`)
  assert(Array.isArray(e.provenance.session_ids), 'session_ids 至少含自身 sid')
  return `source_kind=${e.provenance.source_kind}`
})


check('⑫ proposals → 条目：溯源完整、不落盘', () => {
  const session = corpus.find((s) => s.category === 'real')
  const proposals = [
    {
      sid: session.sid,
      title: '提炼出的结论',
      claim: '这是一个真结论',
      why: '因为实测',
      confidence: 'high',
      provider: 'test',
      model: 'mock',
      runId: 'distill-x',
    },
    // 无 sid 的应被丢弃（无法溯源）
    { title: '无主孤儿', claim: 'x' },
  ]
  const entries = proposalsToEntries(proposals, { triaged: corpus })

  assert(entries.length === 1, `应产出 1 条（无 sid 的丢弃），实际 ${entries.length}`)
  const e = entries[0]
  assert(e.provenance.session_id === session.sid, '溯源 sid 不对')
  assert(e.claim === '这是一个真结论', 'claim 不对')
  assert(e.authority === 'L2', `authority 应为 L2（LLM 参与），实际 ${e.authority}`)
  assert(e.distilled === true, '应标记 distilled')
  assert(e.distilledBy.provider === 'test', '应保留 provider 留痕')
  assert(e.id && e.id.startsWith('e-'), 'id 形状不对')
  assert(e.volume, '必须有归属册（兜底收件箱）')
  assert(e.needsReview === false, '有 claim 且有 confidence 不需要 review')
  return `1 条 · id=${e.id} · volume=${e.volume} · authority=${e.authority}`
})

check('⑫b 提炼无结论 → needsReview=true，不冒充 high', () => {
  const session = corpus.find((s) => s.category === 'real')
  const entries = proposalsToEntries([{ sid: session.sid }], { triaged: corpus })
  assert(entries.length === 1, '应产出 1 条')
  const e = entries[0]
  assert(e.confidence === 'speculation', `无结论时 confidence 应为 speculation，实际 ${e.confidence}`)
  assert(e.needsReview === true, '无结论应 needsReview=true')
  return `confidence=${e.confidence} · needsReview=${e.needsReview}`
})

// ⑬ 运行报告
check('⑬ 运行报告格式对齐 library.js 的 run 报告', () => {
  const passResult = {
    runId: 'distill-20261102-120000-abcdef',
    status: 'partial',
    batches: 3,
    proposals: [{ sid: 'a' }, { sid: 'b' }],
    failures: [{ batchIndex: 2, sids: ['c'], error: { name: 'Error', message: 'boom' } }],
    usage: { calls: 3, promptChars: 1000, completionChars: 200, totalChars: 1200 },
    durationMs: 4567,
    dryRun: false,
  }
  const report = buildRunReport(passResult, { queue: [{ sid: 'a' }, { sid: 'b' }, { sid: 'c' }] })

  // 必须与 library.js 同构的字段
  for (const key of ['runId', 'startedAt', 'finishedAt', 'status', 'counts', 'stagingDir', 'error', 'durationMs']) {
    assert(key in report, `报告缺字段 ${key}`)
  }
  assert(report.status === 'partial', 'status 不对')
  assert(report.counts.entries === 2, 'counts.entries 应为 proposals 数')
  assert(report.counts.failedBatches === 1, 'failedBatches 不对')
  assert(report.counts.failedSessions === 1, 'failedSessions 不对')
  assert(report.error && report.error.batches.length === 1, 'error 应带失败批次明细')
  assert(report.stagingDir === null, 'stagingDir 应为 null')
  // 必须能被 JSON 序列化（会被写进 runs/）
  const json = JSON.stringify(report)
  assert(json.length > 0 && JSON.parse(json).runId === report.runId, '不可序列化')
  return `counts=${JSON.stringify(report.counts)}`
})

check('⑬b 全成功时 error=null', () => {
  const report = buildRunReport({
    runId: 'r1',
    status: 'ok',
    batches: 1,
    proposals: [{ sid: 'a' }],
    failures: [],
    durationMs: 10,
  })
  assert(report.error === null, 'error 应为 null')
  return 'error=null'
})

// ⑭ 空输入不炸
check('⑭ 空输入全部安全返回', () => {
  const q = selectQueue([], {}, {})
  assert(q.queue.length === 0 && q.skipped.length === 0, '空输入应返回空')
  assert(makeBatches([]).length === 0, '空队列分批应为空')
  assert(proposalsToEntries([], {}).length === 0, '空 proposals 应返回空')
  assert(proposalsToEntries(null, {}).length === 0, 'null proposals 应安全')
  const b = selectQueue(null, {}, {})
  assert(b.queue.length === 0, 'null triaged 应安全')
  return '空/null 输入均安全'
})

await checkAsync('⑭b 未注入 distillBatch 且非 dryRun → 明确报错', async () => {
  let threw = false
  try {
    await runDistillPass([{ sid: 'a' }], { llm: {} })
  } catch (e) {
    threw = true
    assert(e.message.includes('distillBatch'), '错误信息应说明缺 distillBatch')
  }
  assert(threw, '缺 distillBatch 时应明确抛错，而不是假装成功')
  return '明确抛错，不伪造成功'
})

// ⑮ 依赖注入可用（mock 即插即用）
await checkAsync('⑮ distillBatch 可完全 mock（零真实调用）', async () => {
  const queue = selectQueue(corpus, {}, { maxSessions: 4 }).queue
  let receivedLlm = null
  let batchCount = 0
  const result = await runDistillPass(queue, {
    llm: { fake: true },
    provider: 'mock-provider',
    model: 'mock-model',
    distillBatch: async (batch, ctx2) => {
      batchCount += 1
      receivedLlm = ctx2.llm
      assert(ctx2.provider === 'mock-provider', 'provider 没传进去')
      assert(ctx2.model === 'mock-model', 'model 没传进去')
      return batch.map((s) => ({ sid: s.sid, claim: 'mock 结论' }))
    },
  })
  assert(receivedLlm && receivedLlm.fake === true, 'llm 没透传')
  assert(batchCount === result.batches, '实际调用批次数与报告不一致')
  assert(result.proposals.length === queue.length, '产出数量不对')
  return `${batchCount} 批全部 mock · 产出 ${result.proposals.length} 条`
})

// ⑯ 对齐 lib/distill.js 的真实返回契约
await checkAsync('⑯ 适配 distill.js 契约：error 字段当失败（不抛异常也算失败）', async () => {
  const queue = selectQueue(corpus, {}, { maxSessions: 6 }).queue
  const batches = makeBatches(queue, { maxSessionsPerBatch: 2, maxCharsPerBatch: 1e9 })
  let n = 0
  const result = await runDistillPass(queue, {
    llm: {},
    maxSessionsPerBatch: 2,
    maxCharsPerBatch: 1e9,
    // 模拟 distill.js 的真实约定：不抛异常，失败塞进 error
    distillBatch: async (batch) => {
      const idx = n
      n += 1
      if (idx === 0) {
        return { proposals: [], usage: { inputChars: 500, outputChars: 0, calls: 1 }, error: 'LLM 返回空文本' }
      }
      return {
        proposals: batch.map((s) => ({ sid: s.sid, claim: 'ok' })),
        usage: { inputChars: 900, outputChars: 120, calls: 1 },
        error: null,
      }
    },
  })

  assert(result.failures.length === 1, `error 非空应计为失败，实际 failures=${result.failures.length}`)
  assert(result.status === 'partial', `status 应为 partial，实际 ${result.status}`)
  assert(result.proposals.length > 0, '其他批应正常产出')
  assert(result.failures[0].error.message.includes('LLM 返回空文本'), '应保留 distill 的错误文本')
  return `1 批 error 非空 → 记为失败 · 其余产出 ${result.proposals.length} 条`
})

await checkAsync('⑯b usage 字段对齐 inputChars/outputChars', async () => {
  const queue = selectQueue(corpus, {}, { maxSessions: 2 }).queue
  const result = await runDistillPass(queue, {
    llm: {},
    // 显式放大字符预算，保证 2 个会话进同一批（否则大会话会独占一批，usage 翻倍——那也是对的）
    maxSessionsPerBatch: 9,
    maxCharsPerBatch: 1e9,
    distillBatch: async (batch) => ({
      proposals: batch.map((s) => ({ sid: s.sid, claim: 'ok' })),
      usage: { inputChars: 1234, outputChars: 567, calls: 1, ms: 10 },
      error: null,
    }),
  })
  assert(result.batches === 1, `应合成 1 批，实际 ${result.batches}`)
  assert(result.usage.promptChars === 1234, `inputChars 应映射到 promptChars，实际 ${result.usage.promptChars}`)
  assert(result.usage.completionChars === 567, `outputChars 应映射到 completionChars，实际 ${result.usage.completionChars}`)
  assert(result.usage.totalChars === 1801, `totalChars 应为 1801，实际 ${result.usage.totalChars}`)
  return `inputChars 1234 + outputChars 567 = ${result.usage.totalChars}`
})

// ═══════════════════════════════════════════════════════════════
// 单一真相源：退避阈值曾在本模块与 distill-state.js 各定义一份，
// 改一处忘另一处就是静默漂移（两份注释还会继续声称它们"是同一个语义"）。
console.log('\n── 退避阈值：单一真相源 ──')
{
  const ds = await import('../lib/distill-state.js')
  const pl = await import('../lib/pipeline.js')
  check('pipeline 与 distill-state 导出同一组阈值', () => {
    assert(ds.MAX_CONSECUTIVE_FAILURES === pl.MAX_CONSECUTIVE_FAILURES, `失败阈值不一致：${ds.MAX_CONSECUTIVE_FAILURES} vs ${pl.MAX_CONSECUTIVE_FAILURES}`)
    assert(ds.MAX_EMPTY_YIELDS === pl.MAX_EMPTY_YIELDS, `空产出阈值不一致：${ds.MAX_EMPTY_YIELDS} vs ${pl.MAX_EMPTY_YIELDS}`)
    return `failed=${pl.MAX_CONSECUTIVE_FAILURES} empty=${pl.MAX_EMPTY_YIELDS}`
  })
  const limits = await import('../lib/limits.js')
  check('阈值来自 limits.js', () => {
    assert(limits.MAX_CONSECUTIVE_FAILURES === pl.MAX_CONSECUTIVE_FAILURES, '失败阈值没走 limits.js')
    assert(limits.MAX_EMPTY_YIELDS === pl.MAX_EMPTY_YIELDS, '空产出阈值没走 limits.js')
    return '单一真相源'
  })
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
