/**
 * 书阁 · 提炼流水线编排
 *
 * 职责边界（第一性判断）：
 *   · 本模块管**编排**：谁该提炼、怎么分批、失败怎么办。
 *   · 不管**怎么提炼**（prompt / LLM 调用 / 输出校验）——那是 lib/distill.js。
 *   · **不落盘**。proposals 产出后交给调用方决定写不写。
 *
 * 为什么编排要单独成模块：
 *   提炼是最贵的一步（真金白银 + 一次几分钟）。选错会话 = 直接烧钱提炼噪声；
 *   一处失败拖垮整轮 = 一条坏数据让 20 个好会话白等。这两件事必须在调用 LLM
 *   之前就决定好，且**可解释**——每个被跳过的会话都要能说出为什么。
 *
 * 零依赖、纯函数（runDistillPass 除了通过注入的 distillBatch 之外不碰 IO）。
 */

// 退避阈值放在 limits.js —— 曾经这里和 distill-state.js 各定义一份，
// 改一处忘另一处就是静默漂移。这里只做转发，保持原有 import 路径可用。
import { MAX_CONSECUTIVE_FAILURES, MAX_EMPTY_YIELDS, MAX_SUSPECTED_FAILURES } from './limits.js'
export { MAX_CONSECUTIVE_FAILURES, MAX_EMPTY_YIELDS, MAX_SUSPECTED_FAILURES } from './limits.js'

/** 单轮默认上限：一次最多提炼多少个会话。 */
export const DEFAULT_MAX_SESSIONS = 20

/** 单批默认会话数上限。 */
export const DEFAULT_MAX_SESSIONS_PER_BATCH = 3

/** 单批默认字符预算。 */
export const DEFAULT_MAX_CHARS_PER_BATCH = 12000

/**
 * 跳过原因的机器码 → 人话。
 * 集中一处，UI / 日志 / 测试都用它，避免同一件事有五种说法。
 */
export const SKIP_REASON_TEXT = {
  noise: '空壳或冒烟会话（无实质内容）',
  'already-distilled': '已提炼过',
  'too-many-failures': '连续失败 3 次，已跳过（不再重试）',
  'too-many-empty': '连续 2 次没提炼出内容，已跳过（模型认定无可提炼）',
  'too-many-rejected': '连续 2 次产出全部被校验淘汰（编造数字/标题不合格），已跳过（模型输出问题，非会话问题）',
  'too-many-suspected': '6 次在多会话批里失败，已跳过（失败按批记账、无法归因到单个会话，阈值放宽以补偿连坐）',
  'over-limit': '超出本轮上限，留待下一轮',
  'not-real': '不是真实会话',
}

/**
 * 连续空产出多少次后跳过。
 *
 * 【为什么需要这个概念 —— 2026-11-07 实测】
 * 「失败」和「空产出」是两件不同的事，此前被混为一谈：
 *   · 失败 = 调用了但出错（JSON 坏、网络断、校验不过）→ 重试有意义
 *   · 空产出 = 调用成功、模型明确返回 {"entries":[]} → 重试大概率还是空
 *
 * 实测：29 轮有 marked 字段的 distill 中 queue 580 / marked 182，
 * 68.6% 会话未被标记；其中 **15 轮 failures=0 却有 184 个会话未标记**。
 * 这些会话不是失败，是模型看完觉得没料。旧逻辑让它们下轮重新入队，
 * 反复占用队首名额 —— 这正是"每轮都是那几张老面孔"的直接来源之一。
 *
 * 阈值 2：一次可能是模型状态差，两次都认为没料就足够可信。
 */

/**
 * 给会话算一个可解释的优先级分。
 *
 * 权重设计理由（按"单位成本能换到多少经验"排序）：
 *   · admission strong 远好于 weak —— strong 有交付物且完成态好，提炼出来才像经验
 *   · multi-turn 好于 one-shot —— 多轮来回里有推理和纠错，那才是经验；
 *     one-shot 是"配方"，价值低且容易提炼成没有上下文的碎片
 *   · qualityScore 直接进分，让"干得漂亮"的会话排前面
 *
 * 注意：score 只用于**排序**，不用于过滤。过滤由 selectQueue 的硬规则做。
 * @param {object} s triage 后的会话
 * @returns {number}
 */
export function priorityOf(s) {
  if (!s) return 0
  let score = 0
  if (s.admission === 'strong') score += 100
  else if (s.admission === 'weak') score += 40
  // noise 不给分：它本来就会被过滤掉，这里只是兜底

  if (s.shape === 'multi-turn') score += 30
  else if (s.shape === 'one-shot') score += 10

  // qualityScore 是 0..10，乘 3 让它有分量但不压过 admission/shape
  const q = Number.isFinite(s.qualityScore) ? s.qualityScore : 0
  score += q * 3

  // 有交付物的会话多给一点：那是"确实产出了东西"的硬证据
  if (Number.isFinite(s.deliverables) && s.deliverables > 0) {
    score += Math.min(10, s.deliverables)
  }
  return Math.round(score * 100) / 100
}

/** 取某个会话的失败次数（failedSids 支持 Map 或普通对象）。 */
function failuresOf(state, sid) {
  const map = state && state.failedSids
  if (!map) return 0
  if (typeof map.get === 'function') {
    const v = map.get(sid)
    return Number.isFinite(v) ? v : 0
  }
  const v = map[sid]
  return Number.isFinite(v) ? v : 0
}

/** 判断 sid 是否已在 distilledSids 里（支持 Set / 数组）。 */
function isDistilled(state, sid) {
  const set = state && state.distilledSids
  if (!set) return false
  if (typeof set.has === 'function') return set.has(sid)
  if (Array.isArray(set)) return set.includes(sid)
  return false
}

/** 取某个 Map 或普通对象里的计数（两个退避计数表共用同一套读法）。 */
function countOf(map, sid) {
  if (!map) return 0
  if (typeof map.get === 'function') {
    const v = map.get(sid)
    return Number.isFinite(v) ? v : 0
  }
  const v = map[sid]
  return Number.isFinite(v) ? v : 0
}

/** 取某个会话的空产出次数（emptySids 支持 Map 或普通对象）。 */
function emptyYieldsOf(state, sid) {
  return countOf(state && state.emptySids, sid)
}

/**
 * 取某个会话"产出全被单条淘汰"的次数。
 *
 * 【为什么与 empty 分开】淘汰（编造数字/名词堆/过长）是**模型这一次没守规矩**，
 * 不是"这个会话没料"。混进 emptySids 会让这类会话在 2 次后就被永久跳过，
 * 而跳过理由是"模型认定无可提炼" —— 把模型的失误栽给会话。
 */
function rejectedOf(state, sid) {
  return countOf(state && state.rejectedSids, sid)
}

/**
 * 取某个会话"多会话批里失败"的累计次数。
 *
 * 与 failedSids 分开的理由见 MAX_SUSPECTED_FAILURES 的注释：多会话批失败无法
 * 逐条归因，用它当"这个会话有问题"的证据太弱，所以阈值更高。
 */
function suspectedOf(state, sid) {
  return countOf(state && state.suspectSids, sid)
}

/**
 * 算一个会话该不该进队列。返回 null 表示可以提，返回字符串表示跳过原因。
 * @param {object} s
 * @param {object} state
 * @returns {string|null} 跳过原因码
 */
function skipReasonFor(s, state) {
  // ① 噪声一律不提：empty / smoke 提炼不出任何经验，只会烧钱
  if (!s || s.category !== 'real' || s.admission === 'noise') {
    return 'not-real'
  }
  // ② 已提炼过的不重复提
  if (isDistilled(state, s.sid)) return 'already-distilled'
  // ③ 连续失败太多次的跳过，避免永远卡在同一个坏会话
  if (failuresOf(state, s.sid) >= MAX_CONSECUTIVE_FAILURES) return 'too-many-failures'
  // ④ 连续空产出的跳过。模型两次都说"没料"，第三次大概率还是没料 ——
  //    留着它只会占掉本该给新会话的队列名额。
  if (emptyYieldsOf(state, s.sid) >= MAX_EMPTY_YIELDS) return 'too-many-empty'
  // ⑤ 连续多次"产出全被淘汰"也退避，但**理由不同**（是模型没守格式，不是会话没料）。
  //    阈值取同一个数：再试下去大概率还是同一个模型问题。
  if (rejectedOf(state, s.sid) >= MAX_EMPTY_YIELDS) return 'too-many-rejected'
  // ⑥ 多会话批里的失败：阈值更高，因为"这批没成"证明不了"这个会话有问题"。
  if (suspectedOf(state, s.sid) >= MAX_SUSPECTED_FAILURES) return 'too-many-suspected'
  return null
}

/**
 * 计算待提炼队列。
 *
 * 规则（全部可解释）：
 *   1. **硬排除** noise（empty / smoke）—— 提炼它们等于给噪声付钱
 *   2. **去重**：已在 distilledSids 的不再提
 *   3. **退避**：连续失败 >= 3 次的跳过
 *   4. **空产出退避**：连续 2 次返回空条目的跳过（2026-11-07 新增）
 *   5. **排序**：priorityOf 降序（strong > weak；multi-turn > one-shot；质量高的优先）
 *   6. **限量**：最多 maxSessions 个，超出的明确标 'over-limit'
 *
 * @param {object[]} triaged triageAll().enriched
 * @param {{lastDistilledAt?:string, distilledSids?:Set<string>|string[], failedSids?:Map<string,number>|object,
 *          emptySids?:Map<string,number>|object}} state
 * @param {{maxSessions?:number}} [opts]
 * @returns {{queue:object[], skipped:object[], stats:object}}
 */
export function selectQueue(triaged, state = {}, opts = {}) {
  const maxSessions = Number.isFinite(opts.maxSessions)
    ? Math.max(0, Math.floor(opts.maxSessions))
    : DEFAULT_MAX_SESSIONS
  const list = Array.isArray(triaged) ? triaged : []

  /** 先排除，再排序，最后限量。顺序不能反：先限量会把高分噪声占掉名额。 */
  const eligible = []
  const skipped = []

  for (const s of list) {
    if (!s || typeof s !== 'object') continue
    const reason = skipReasonFor(s, state)
    if (reason !== null) {
      skipped.push({ sid: s.sid ?? null, reason, detail: SKIP_REASON_TEXT[reason] || reason })
      continue
    }
    eligible.push(s)
  }

  // 排序：优先级降序；同分时用 qualityScore、再退到 sid 保证确定性（可复现）
  eligible.sort((a, b) => {
    const pa = priorityOf(a)
    const pb = priorityOf(b)
    if (pb !== pa) return pb - pa
    const qa = Number.isFinite(a.qualityScore) ? a.qualityScore : 0
    const qb = Number.isFinite(b.qualityScore) ? b.qualityScore : 0
    if (qb !== qa) return qb - qa
    return String(a.sid ?? '').localeCompare(String(b.sid ?? ''))
  })

  const queue = eligible.slice(0, maxSessions)
  for (const s of eligible.slice(maxSessions)) {
    skipped.push({
      sid: s.sid ?? null,
      reason: 'over-limit',
      detail: SKIP_REASON_TEXT['over-limit'],
    })
  }

  // ── 统计：只报事实，不做推断 ──
  const byReason = {}
  for (const item of skipped) {
    byReason[item.reason] = (byReason[item.reason] || 0) + 1
  }
  const stats = {
    total: list.length,
    eligible: eligible.length,
    queued: queue.length,
    skipped: skipped.length,
    maxSessions,
    skippedByReason: byReason,
    /** 队列的形态构成，便于判断这一轮会提炼出什么类型的东西 */
    queuedByAdmission: countBy(queue, (s) => s.admission),
    queuedByShape: countBy(queue, (s) => s.shape),
  }

  return { queue, skipped, stats }
}

/** 简单分组计数。 */
function countBy(items, fn) {
  const out = {}
  for (const item of items) {
    const k = fn(item) ?? 'unknown'
    out[k] = (out[k] || 0) + 1
  }
  return out
}

/**
 * 累加 usage。兼容两套字段命名：
 *   · lib/distill.js 用 `inputChars` / `outputChars`
 *   · 早期约定的 promptChars / completionChars
 * 都映射到同一组累计量，避免调用方拿到全 0。
 */
function accumulateUsage(acc, usage) {
  if (!usage || typeof usage !== 'object') return acc
  const pick = (...keys) => {
    for (const k of keys) {
      if (Number.isFinite(usage[k])) return usage[k]
    }
    return 0
  }
  acc.promptChars += pick('inputChars', 'promptChars')
  acc.completionChars += pick('outputChars', 'completionChars')
  acc.totalChars = acc.promptChars + acc.completionChars
  return acc
}

/**
 * 估算一个会话进 prompt 需要多少字符。
 * 用会话自身已知的尺度当代理，取不到就给一个保守中位数。
 */
function estimateChars(s) {
  if (!s) return 800
  const human = Number.isFinite(s.humanTextTotal) ? s.humanTextTotal : 0
  const avg = Number.isFinite(s.humanTextAvgLen) ? s.humanTextAvgLen : 0
  const turns = Number.isFinite(s.turnEnds) ? s.turnEnds : 0
  // 人类输入总量是最直接的代理；再按轮次补一点结构性开销
  let chars = human > 0 ? human : avg * Math.max(1, turns)
  // 每轮的工具调用名/错误摘要也要占篇幅，粗估每轮 120 字符
  chars += turns * 120
  if (chars <= 0) chars = 800
  return Math.round(chars)
}

/**
 * 分批：把队列切成适合单次 LLM 调用的批次。
 *
 * 两个上限都要守：
 *   · maxSessionsPerBatch —— 一次调用塞太多会话，模型会漏掉后面几个
 *   · maxCharsPerBatch    —— 超长 prompt 会被截断或显著掉质量
 *
 * 单个会话本身就超预算时，**独占一批**（不丢它，也不让它挤掉别人）。
 * @param {object[]} queue
 * @param {{maxSessionsPerBatch?:number, maxCharsPerBatch?:number}} [opts]
 * @returns {object[][]}
 */
export function makeBatches(queue, opts = {}) {
  const maxSessions = Number.isFinite(opts.maxSessionsPerBatch)
    ? Math.max(1, Math.floor(opts.maxSessionsPerBatch))
    : DEFAULT_MAX_SESSIONS_PER_BATCH
  const maxChars = Number.isFinite(opts.maxCharsPerBatch)
    ? Math.max(1, Math.floor(opts.maxCharsPerBatch))
    : DEFAULT_MAX_CHARS_PER_BATCH

  const list = Array.isArray(queue) ? queue.filter(Boolean) : []
  const batches = []
  let current = []
  let currentChars = 0

  for (const s of list) {
    const size = estimateChars(s)

    // 自身就超预算：独占一批，别让它把同批的兄弟挤出去
    if (size >= maxChars) {
      if (current.length > 0) {
        batches.push(current)
        current = []
        currentChars = 0
      }
      batches.push([s])
      continue
    }

    const wouldExceedCount = current.length + 1 > maxSessions
    const wouldExceedChars = currentChars + size > maxChars

    if (current.length > 0 && (wouldExceedCount || wouldExceedChars)) {
      batches.push(current)
      current = []
      currentChars = 0
    }

    current.push(s)
    currentChars += size
  }

  if (current.length > 0) batches.push(current)
  return batches
}

/** 从队列里取预估字符数，供成本估算用。 */
export function estimateQueueChars(queue) {
  const list = Array.isArray(queue) ? queue : []
  let total = 0
  for (const s of list) total += estimateChars(s)
  return total
}

/**
 * 预估一次提炼的成本（不调用任何模型）。
 *
 * 为什么要有这个：用户没配 key 时，至少该看到"待提炼 20 个 / 需要 7 次调用 / 约 8 万字符"，
 * 而不是一个沉默的"无数据"。这是零 LLM 降级体验的核心。
 *
 * @param {object[]} queue
 * @param {{maxSessionsPerBatch?:number, maxCharsPerBatch?:number}} [opts]
 */
export function planDistill(queue, opts = {}) {
  const batches = makeBatches(queue, opts)
  const chars = estimateQueueChars(queue)
  const calls = batches.length
  return {
    /** 会提炼哪些会话（只给标识，不含正文） */
    willDistill: (Array.isArray(queue) ? queue : []).map((s) => ({
      sid: s?.sid ?? null,
      title: s?.title ?? '',
      admission: s?.admission ?? null,
      shape: s?.shape ?? null,
      qualityScore: Number.isFinite(s?.qualityScore) ? s.qualityScore : 0,
      priority: priorityOf(s),
    })),
    sessionCount: (Array.isArray(queue) ? queue : []).length,
    /** LLM 调用次数 = 批次数 */
    calls,
    batches: batches.map((b, i) => ({
      index: i,
      sessions: b.length,
      chars: estimateQueueChars(b),
      sids: b.map((s) => s?.sid ?? null),
    })),
    totalChars: chars,
  }
}

/** 生成本轮 runId：与 library.js 的 `run-<时间戳>-<随机>` 同构，便于 runs/ 里混放。 */export function createRunId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  const rand = Math.random().toString(16).slice(2, 8)
  return `distill-${stamp}-${rand}`
}

/**
 * 跑一轮提炼。
 *
 * 编排纪律（每一条都是为了"一个坏会话不能拖垮整轮"）：
 *   1. **逐批独立**：某批抛错只记该批失败，继续跑下一批
 *   2. **失败计数**：失败批里的会话 failedSids +1
 *   3. **绝不重试到死**：本轮内不重试同一批；跨轮退避由 selectQueue 的
 *      >= 3 次规则接管
 *   4. **dryRun / 无 llm**：完全不调用模型，只返回预演
 *
 * @param {object[]} queue
 * @param {{
 *   llm?: object|null,
 *   provider?: string,
 *   model?: string,
 *   dryRun?: boolean,
 *   onProgress?: Function,
 *   distillBatch?: Function,
 *   maxSessionsPerBatch?: number,
 *   maxCharsPerBatch?: number,
 *   now?: Date,
 * }} opts
 * @returns {Promise<{runId:string, batches:number, proposals:object[], failures:object[], usage:object, durationMs:number, status:string, plan:object, dryRun:boolean}>}
 */
export async function runDistillPass(queue, opts = {}) {
  const t0 = Date.now()
  const now = opts.now instanceof Date ? opts.now : new Date()
  const runId = opts.runId || createRunId(now)
  const list = Array.isArray(queue) ? queue.filter(Boolean) : []
  const dryRun = opts.dryRun === true || !opts.llm
  const distillBatch = opts.distillBatch

  const batches = makeBatches(list, opts)
  const plan = planDistill(list, opts)

  // ── 零 LLM 降级：不调模型，只预演 ──
  if (dryRun) {
    return {
      runId,
      status: 'dry-run',
      dryRun: true,
      batches: batches.length,
      proposals: [],
      failures: [],
      usage: { calls: 0, promptChars: 0, completionChars: 0, totalChars: 0 },
      durationMs: Date.now() - t0,
      plan,
    }
  }

  if (typeof distillBatch !== 'function') {
    // 没注入实现就别假装跑过 —— 明确报错，别返回一个"成功但空"的结果
    throw new Error('[pipeline] runDistillPass 需要注入 distillBatch（或传 dryRun:true 只预演）')
  }

  const proposals = []
  const failures = []
  /** 模型产出但被单条校验淘汰的条目（附原因）。上层要能看到"丢了几条、为什么"。 */
  const dropped = []
  const usage = { calls: 0, promptChars: 0, completionChars: 0, totalChars: 0 }

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i]
    const sids = batch.map((s) => s?.sid ?? null)

    // 进度回调绝不能让编排挂掉
    try {
      opts.onProgress?.({
        phase: 'batch-start',
        index: i,
        total: batches.length,
        sessions: batch.length,
        sids,
      })
    } catch {
      /* 回调抛错是调用方的问题，不影响提炼 */
    }

    try {
      const result = await distillBatch(batch, {
        llm: opts.llm,
        provider: opts.provider,
        model: opts.model,
        runId,
        batchIndex: i,
        batchCount: batches.length,
        maxSessionsPerCall: opts.maxSessionsPerCall,
        timeoutMs: opts.timeoutMs,
        budget: opts.budget,
        signal: opts.signal,
      })
      usage.calls += 1

      // ── 兼容 distillBatch 的两种失败表达 ──
      // lib/distill.js 的约定是**不抛异常**、把失败塞进返回值：
      //   { proposals: [], usage, error: '为什么失败' }
      // 所以"返回了"不等于"成功了"，必须看 error。
      const batchError = result && typeof result === 'object' ? result.error : null
      if (batchError) {
        // 【2026-11-08】distillBatch 在失败时会把"原文前 300 字"塞进 rawHead，
        // 但这里原来只取 error 字符串，rawHead 被就地丢弃 —— 结果 run 报告里
        // 只留一句 "JSON 解析失败：... position 505"，完全无法判断模型到底吐了什么。
        // 实测第一次真实 LLM 提炼就卡在这里。现在原样带出去。
        failures.push({
          batchIndex: i,
          sids,
          error: {
            name: 'DistillError',
            message: String(batchError),
            ...(result && result.rawHead ? { rawHead: String(result.rawHead) } : {}),
          },
        })
        // 失败批也消耗了 token，计进 usage
        accumulateUsage(usage, result && result.usage)
        try {
          opts.onProgress?.({
            phase: 'batch-failed',
            index: i,
            total: batches.length,
            error: { name: 'DistillError', message: String(batchError) },
            sids,
          })
        } catch {
          /* 回调问题不影响编排 */
        }
        continue
      }

      // distillBatch 可能返回 { proposals } 或直接返回数组，两种都接
      const got = Array.isArray(result) ? result : result && Array.isArray(result.proposals) ? result.proposals : []
      // 【2026-11-04 修复溯源】给每条 proposal 打上它所属批次的 sids。
      //
      // 为什么必须在这里做：distillBatch 是**按块**调的，它知道这一块
      // 是哪几个会话，但 LLM 返回的 proposal 本身不带 sid。
      // 原来 index.js 只能用 `okSessions[idx % okSessions.length]` 轮转猜，
      // 实测 20% 的条目被指到完全不相关的会话上（讲 web_search 的条目
      // 指到「B2B market 调研」会话），可溯源性直接被破坏。
      //
      // 这里记录的是**真实的批次归属**：这一批就是这些 sid。
      // 粒度到批（每批 3 会话），比轮转猜测准确得多；要精确到单会话
      // 需要让 LLM 在输出里带来源编号，那是更大的改动。
      // 把本批被淘汰的单条提案也收上来（distillBatch 成功路径从 2026-11-08 起会带）
      if (Array.isArray(result?.dropped)) {
        for (const d of result.dropped) dropped.push({ batchIndex: i, ...d })
      }
      const batchSids = Array.isArray(sids) ? sids.filter(Boolean) : []
      for (const p of got) {
        proposals.push(
          p && typeof p === 'object'
            ? { ...p, provenance: { ...(p.provenance || {}), session_ids: batchSids } }
            : p
        )
      }

      accumulateUsage(usage, result && result.usage)

      try {
        // 【2026-11-09】把本批被**单条淘汰**的条数一起报出去。
        // 原因：一批全部因编造数字/名词堆被丢时 got.length=0 —— 上报方只看到
        // "产出 0 条"，会把它记成 empty（"模型认定无可提炼"），而事实是
        // "模型产出了、但都被校验淘汰了"。两者对重试策略的含义完全相反。
        opts.onProgress?.({
          phase: 'batch-done',
          index: i,
          total: batches.length,
          proposals: got.length,
          dropped: Array.isArray(result?.dropped) ? result.dropped.length : 0,
          sids,
        })
      } catch {
        /* 同上 */
      }
    } catch (e) {
      // ★ 关键：单批失败只记这一批，绝不 throw 出去拖垮整轮
      const error = {
        name: e?.name || 'Error',
        message: e?.message || String(e),
      }
      failures.push({
        batchIndex: i,
        sids,
        error,
      })
      usage.calls += 1

      try {
        opts.onProgress?.({ phase: 'batch-failed', index: i, total: batches.length, error, sids })
      } catch {
        /* 同上 */
      }
    }
  }

  const status = failures.length === 0 ? 'ok' : proposals.length > 0 ? 'partial' : 'failed'

  return {
    runId,
    status,
    dryRun: false,
    batches: batches.length,
    proposals,
    failures,
    // 被单条校验淘汰的提案（附原因）。上层必须能看到，否则"模型产出了 3 条、
    // 只有 2 条合格"这件事对用户不可见 —— 与"不静默"的红线相悖。
    dropped,
    usage,
    durationMs: Date.now() - t0,
    plan,
  }
}

/**
 * 把一轮提炼的失败汇总成新的 failedSids（供下一轮 selectQueue 退避用）。
 * 失败的**累加**，成功的**清零** —— 半失败不在下一轮被无谓重试。
 *
 * @param {object[]} failures runDistillPass().failures
 * @param {Map<string,number>|object} [prev] 上一轮的 failedSids
 * @param {object[]} [proposals] 本轮成功的 proposals（用于把它们从失败表里清掉）
 * @returns {Map<string, number>}
 */
export function mergeFailureCounts(failures, prev = new Map(), proposals = []) {
  const next = new Map()
  // 先继承历史
  if (prev && typeof prev.forEach === 'function') {
    prev.forEach((v, k) => next.set(k, Number.isFinite(v) ? v : 0))
  } else if (prev && typeof prev === 'object') {
    for (const [k, v] of Object.entries(prev)) next.set(k, Number.isFinite(v) ? v : 0)
  }

  for (const f of Array.isArray(failures) ? failures : []) {
    for (const sid of f?.sids || []) {
      if (sid == null) continue
      next.set(sid, (next.get(sid) || 0) + 1)
    }
  }

  // 本轮成功产出的会话，失败计数清零 —— 它已经证明能提了
  for (const p of Array.isArray(proposals) ? proposals : []) {
    const sid = p?.sid ?? p?.provenance?.session_id ?? null
    if (sid != null && next.has(sid)) next.delete(sid)
  }
  return next
}

/**
 * 从 proposals 里取出它对应的会话 sid（兼容几种可能的形状）。
 */
function proposalSid(p) {
  if (!p || typeof p !== 'object') return null
  return p.sid ?? p.sessionId ?? p.provenance?.session_id ?? null
}

/**
 * 把一批的产出结果分成三类：**成功产出 / 空产出 / 失败**。
 *
 * ## 为什么必须有这个函数（2026-11-07 实测事故）
 *
 * 旧代码（index.js ④）只有两条分支：
 *   `if (!b.proposals) continue`  → 不标记
 *   else → 整批标记为已提炼
 *
 * 这里藏着一个致命混淆：**「没有产出」被同时用来表示两种完全无关的情况**
 *   · 模型返回了 {"entries":[]} —— 它认真看过，认为这条会话没有可复用经验
 *   · 这一批调用直接挂了 —— 什么都没发生
 *
 * 两者都不标记，于是都下轮重来。但重试的价值天差地别：
 *   · 空产出：重试大概率还是空（模型判断稳定）→ 不该反复占用队首
 *   · 失败：重试有意义（网络抖、模型抽风）→ 但连续 3 次后也该退避
 *
 * 实测后果：29 轮有 marked 字段的报告里 queue 580 / marked 182，
 * 68.6% 未标记；其中 15 轮 **failures=0 却仍有 184 个会话未标记** ——
 * 这 184 个全都是"空产出"，却按"失败"的方式被无差别重排。
 *
 * ## 契约
 *
 * 输入必须是 runDistillPass 通过 onProgress 回传的 batch 事件。
 * 输出是三个**互斥**的 sid 集合，合起来等于本轮所有跑过的会话：
 *   · yielded —— 这一批产出了提案，该批所有 sid 都算「已提炼」
 *   · empty   —— 这一批调用成功但产出 0 条，该批所有 sid 记一次空产出
 *   · failed  —— 这一批出错，该批所有 sid 记一次失败
 *   · rejected —— 这一批有产出但**全部被单条淘汰**（编造数字/名词堆等），
 *                与 empty（模型认定没料）区分开，避免把"模型没守格式"甩锅给会话
 *
 * @param {{yields?:{sids:string[], proposals:number}[], failures?:object[], ranSids?:string[]}} input
 * @returns {{yielded:string[], empty:string[], failed:string[], rejected:string[], suspect:string[]}}
 */
export function classifyBatchOutcome(input = {}) {
  // 容错：调用方可能传 null（onProgress 未触发、上层提前返回等）。
  // 返回三个空数组而不是抛错 —— 这个函数的职责是"归类"，不是"验参数"；
  // 抛错会让一次异常的 progress 回调把整轮提炼搞挂。
  const src = input && typeof input === 'object' ? input : {}
  const yielded = []
  const empty = []
  const failed = []

  // 【2026-11-09】失败按批记账 → 分"整批失败"与"这一批的会话都算失败"两档。
  //
  // 旧实现把 failures[].sids 全部算作 failed —— 那是**整批连坐**：模型一次没吐
  // JSON，同批 3 个会话一起 +1，连撞 3 轮就集体永久封杀。实测代价：12 个被永久
  // 排除的会话里，5 个是 q=6.6–8.1 的强会话（交付物 1–4 个、工具调用 48–878 次），
  // 它们本身没有任何问题，只是恰好和另一个坏会话分到了同一批。
  //
  // 逐条归因做不到：LLM 的输出不带 sid，无从知道是哪一条"导致"了失败。所以这里
  // 换一个办法 —— **不猜谁坏，但也不再让它们连坐**：批次级失败只记在批次上
  // （`failure` 计数用于观察），会话级计数只按"证据充分"的情形推进：
  //   · 单会话批（batch 里只有 1 个 sid）失败 → 归因明确，照常记 failed
  //   · 多会话批失败 → 不记 failed，改记 `suspect`（弱信号），阈值更高才退避
  const failSids = new Set()
  const suspectSids = new Set()
  for (const failure of Array.isArray(src.failures) ? src.failures : []) {
    const sids = (Array.isArray(failure?.sids) ? failure.sids : []).filter(Boolean)
    if (sids.length === 1) {
      failSids.add(sids[0])
    } else {
      for (const sid of sids) suspectSids.add(sid)
    }
  }
  for (const sid of failSids) failed.push(sid)
  /** 多会话批里的失败：只是"在这一批里没成"，不足以证明这个会话有问题。 */
  const suspect = [...suspectSids].filter((sid) => !failSids.has(sid))

  /** 整批产出都被单条淘汰掉（不是模型说"没料"，是产出不合规）的会话。 */
  const rejected = []

  for (const b of Array.isArray(src.yields) ? src.yields : []) {
    const sids = (Array.isArray(b?.sids) ? b.sids : []).filter(Boolean)
    const count = Number.isFinite(b?.proposals) ? b.proposals : 0
    const droppedCount = Number.isFinite(b?.dropped) ? b.dropped : 0
    for (const sid of sids) {
      // 失败与"疑似失败"都优先：同一 sid 不该既算失败又算产出/空产出
      if (failSids.has(sid) || suspectSids.has(sid)) continue
      if (count > 0) yielded.push(sid)
      // 【2026-11-09】产出 0 条，但这一批**有**被淘汰的条目 → 说明模型确实产出过，
      // 只是都没过校验。与"模型认真看过、认为没料"是两件事：
      //   · 前者：会话可能没问题，是模型这次没守住格式/编了数字 → 值得再试
      //   · 后者：模型判断没料 → 该退避
      // 原来两者都记 empty，退避文案还写"模型认定无可提炼"，是甩锅给会话。
      else if (droppedCount > 0) rejected.push(sid)
      else empty.push(sid)
    }
  }

  return { yielded, empty, failed, rejected, suspect }
}

/**
 * 把 proposals 转成"待入册的条目"。**仍不落盘，只返回数据。**
 *
 * 与 library.js 的 candidateEntryFromSession 保持**同一套字段形状**，
 * 但这里填的是 LLM 提炼后的真结论，并把 authority 提到 L2（有模型推理参与）。
 * 落盘时若 id 冲突，由调用方决定保留哪一份（本函数只保证形状正确）。
 *
 * @param {object[]} proposals
 * @param {{root?:string, triaged?:object[], assignVolume?:Function, now?:Date, entryId?:Function}} [ctx]
 * @returns {object[]}
 */
export function proposalsToEntries(proposals, ctx = {}) {
  const list = Array.isArray(proposals) ? proposals : []
  const now = ctx.now instanceof Date ? ctx.now : new Date()
  const out = []

  // 会话索引：用于把 proposal 补全成完整条目（标题、项目、时间）
  const sessionIndex = new Map()
  for (const s of Array.isArray(ctx.triaged) ? ctx.triaged : []) {
    if (s && s.sid != null) sessionIndex.set(s.sid, s)
  }

  for (const p of list) {
    if (!p || typeof p !== 'object') continue
    const sid = proposalSid(p)
    const session = sid != null ? sessionIndex.get(sid) : null

    // 没有 sid 的 proposal 无法溯源，宁可不产出也不要造一个查不回来的条目
    if (sid == null) continue

    // 归属册：优先 proposal 自带，其次由调用方注入的 assignVolume 决定
    let volume = p.volume ?? null
    let assignReason = p.assignReason ?? ''
    if (!volume && typeof ctx.assignVolume === 'function' && session) {
      try {
        const assign = ctx.assignVolume(session)
        volume = assign?.volumeId ?? null
        assignReason = assign?.reason ?? ''
      } catch {
        volume = null
      }
    }
    if (!volume) volume = 'vol-05' // 兜底进收件箱，绝不瞎归册

    // 归属章：与 T0 轨同一套口径（主题词 → 项目名 → 未分类）。
    //
    // 【2026-11-08 修复】原来这里只写 `chapter: p.chapter || null`，
    // 而 LLM 从不输出 chapter —— 于是**每一条 T1 提炼出来的条目都落进
    // 「未归章」**，即使它的会话在 T0 骨架里本来有主题章。
    // 同一份内容在两条轨上归属不同，目录里就出现"同一个会话两条条目、章不一样"。
    let chapter = p.chapter || null
    let chapterTitle = p.chapterTitle || null
    if (!chapter && typeof ctx.chapterSpec === 'function' && session) {
      try {
        const spec = ctx.chapterSpec(session)
        chapter = spec?.slug ?? null
        chapterTitle = spec?.title ?? null
      } catch {
        chapter = null
      }
    }

    // id：有注入的 entryId 就用它（保证与零 LLM 版同构），否则用 sid 派生
    let id = p.id ?? null
    if (!id && typeof ctx.entryId === 'function') {
      try {
        id = ctx.entryId([sid])
      } catch {
        id = null
      }
    }
    if (!id) id = 'e-' + String(sid).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)

    const title = String(p.title || session?.title || '(无标题会话)').trim()
    const claim = String(p.claim || '').trim()
    // 提炼后仍没有结论 → 退回结构性描述，并标 needsReview 交给人工
    const finalClaim =
      claim ||
      `${session ? `${session.turnEnds} 轮 · ${session.toolCalls} 次工具调用` : '提炼未产出结论'}`

    out.push({
      id,
      volume,
      chapter,
      ...(chapterTitle ? { chapterTitle } : {}),
      title,
      sessionAt: session?.createdAt ? new Date(session.createdAt).toISOString() : now.toISOString(),
      claim: finalClaim,
      why: String(p.why || '').trim(),
      // 置信度：模型给的优先；没给就标 speculation，绝不冒充 high
      confidence: p.confidence || 'speculation',
      // authority L2 = 有 LLM 推理参与，但仍非人工确认
      authority: p.authority || 'L2',
      status: 'current',
      needsReview: p.needsReview === true || !claim,
      assignReason,
      qualityScore: Number.isFinite(p.qualityScore) ? p.qualityScore : (session?.qualityScore ?? 0),
      provenance: {
        session_id: sid,
        // 【2026-11-04】本批实际包含的会话。session_id 是"主来源"（单数，
        // 字段形状限制），session_ids 是完整批次归属 —— 溯源时两者一起看，
        // 避免把轮转猜测当成精确来源。
        session_ids: Array.isArray(p?.provenance?.session_ids)
          ? p.provenance.session_ids.filter(Boolean)
          : sid
            ? [sid]
            : [],
        /** 来源方式：batch = 已知属于哪一批；guessed = 轮转兜底（不精确） */
        source_kind:
          Array.isArray(p?.provenance?.session_ids) && p.provenance.session_ids.length > 0
            ? 'batch'
            : 'guessed',
        // 【2026-11-04】主来源的置信度与得分必须一起落盘。
        // 第一版只写了 source_kind，把这两个字段漏在重建里丢掉了 ——
        // 结果是"批次已知"但"主来源可不可信"无从判断，等于白算。
        // 只有 batch 才有置信度概念（单会话批次天然确定，不写）。
        source_confidence:
          typeof p?.provenance?.source_confidence === 'string'
            ? p.provenance.source_confidence
            : null,
        source_score: Number.isFinite(p?.provenance?.source_score)
          ? p.provenance.source_score
          : null,
        turn: p.turn ?? null,
        message_id: p.messageId ?? null,
        tool_call_id: p.toolCallId ?? null,
        timestamp: session?.createdAt ? new Date(session.createdAt).toISOString() : now.toISOString(),
      },
      tags: Array.isArray(p.tags) ? p.tags : [session?.project].filter(Boolean),
      hits: 0,
      last_hit: null,
      /** 标明这条是 LLM 提炼产出，便于后续审计与回滚 */
      distilled: true,
      distilledAt: now.toISOString(),
      /** 模型/供应商留痕：出问题时能定位是哪次调用产出的 */
      distilledBy: {
        provider: p.provider ?? null,
        model: p.model ?? null,
        runId: p.runId ?? null,
      },
    })
  }

  return out
}

/**
 * 组装 runs/distill-<runId>.json 的报告对象（**本函数不写盘**）。
 *
 * 字段对齐 library.js 的 run 报告（runId / startedAt / finishedAt / status /
 * counts / error / durationMs），额外加提炼专属字段。
 *
 * @param {object} pass runDistillPass() 的返回值
 * @param {{queue?:object[], startedAt?:string|Date, now?:Date}} [meta]
 */
export function buildRunReport(pass, meta = {}) {
  const now = meta.now instanceof Date ? meta.now : new Date()
  const startedAt = meta.startedAt
    ? meta.startedAt instanceof Date
      ? meta.startedAt.toISOString()
      : String(meta.startedAt)
    : new Date(Date.now() - (pass?.durationMs || 0)).toISOString()

  const failures = Array.isArray(pass?.failures) ? pass.failures : []
  const proposals = Array.isArray(pass?.proposals) ? pass.proposals : []

  return {
    runId: pass?.runId ?? null,
    startedAt,
    finishedAt: now.toISOString(),
    status: pass?.status || 'unknown',
    counts: {
      /** 与 library.js 对齐的两个主计数字段 */
      entries: proposals.length,
      volumes: 0,
      /** 提炼专属 */
      queued: Array.isArray(meta.queue) ? meta.queue.length : 0,
      batches: pass?.batches ?? 0,
      proposals: proposals.length,
      failedBatches: failures.length,
      failedSessions: failures.reduce((a, f) => a + (f?.sids?.length || 0), 0),
    },
    stagingDir: null,
    // error 保持"要么 null，要么能看出哪里坏了"的语义
    error:
      failures.length === 0
        ? null
        : {
            name: 'BatchFailure',
            message: `${failures.length} 个批次失败`,
            batches: failures.map((f) => ({
              batchIndex: f.batchIndex,
              sids: f.sids,
              message: f.error?.message ?? null,
            })),
          },
    durationMs: pass?.durationMs ?? 0,
    dryRun: pass?.dryRun === true,
    usage: pass?.usage ?? { calls: 0, promptChars: 0, completionChars: 0, totalChars: 0 },
  }
}
