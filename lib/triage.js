/**
 * 分诊（triage）：把会话分成 empty / smoke / real 三类。
 *
 * 为什么必须分诊（本机实测证据）：
 *   216 个会话里有 24 个空壳 + 14 个冒烟测试 = 17.1% 是纯噪声。
 *   若不分层，它们全部落进"短会话"桶，会系统性地把「短」等同于「坏」。
 *   ── 而真实情况是：48 个短会话里，10 个真实短任务是 100% 正常完成的。
 *
 * 三个分类的判据：
 *   empty  —— 零人类输入 且 零工具调用（打开即弃，或只剩 header）
 *   smoke  —— 零工具调用 + 标题命中连通性测试特征（模型冒烟测试，不是干活）
 *   real   —— 其余
 *
 * 另外打一个正交的形态标签 shape（这决定走哪条提炼路径）：
 *   one-shot   —— turns <= 1 且首条指令很长（贴模板让它自己跑，是"配方"）
 *   multi-turn —— turns > 1（来回讨论，是"经验"）
 *
 * 本模块零依赖、纯函数（除了读事件流那一步），可单独测试。
 */

/** 冒烟测试的标题特征。全部来自本机真实标题样本。 */
const SMOKE_TITLE_PATTERNS = [
  /reply\s+with\s+exactly/i,
  /LOCAL-LLM-OK/i,
  /^\s*111\s*$/,
  /通讯测试/,
  /模型通讯/,
  /^测试$/,
  /模型测试/,
  /^test$/i,
]

/** 长指令的阈值（字符）。中位 1642 vs 40，这里取 500 作为明确分界。 */
export const ONE_SHOT_PROMPT_MIN_CHARS = 500

/**
 * 判定 smoke：标题命中测试特征**且没有任何交付物**，或标题极短且像测试。
 *
 * 【2026-11-07 修正】旧判据是 `toolCalls > 0 → 直接返回 false`，
 * 于是"模型测试"这类会话只要点过几次工具就被算成 real：
 * 实测本机 4 条「测试」+ 4 条「模型测试」+ 2 条「测试会话」全部以
 * `real / 0 个交付物` 的身份进了手册，目录里出现 4 条同名条目。
 *
 * 现在的判据是"**交付物**"而不是"动没动工具"：
 *   · 有交付物 → 一定不是 smoke（交付物是"这次真干活了"的硬证据）
 *   · 标题命中测试特征、且零交付物 → smoke，不看工具调用数
 * 这条判据的依据来自本项目自己的实测结论：完成 ≠ 有产出
 * （<10 次工具调用的 25 个 real 会话 100% 正常完成，但一个交付物都没有）。
 *
 * @param {{toolCalls:number, title:string, humanMessages:number, deliverables?:number}} s
 */
export function isSmokeTest(s) {
  const title = (s.title || '').trim()
  const deliverables = Number(s.deliverables || 0)
  // 有交付物就不是测试：哪怕标题写着"测试"
  if (deliverables > 0) return false
  if (SMOKE_TITLE_PATTERNS.some((re) => re.test(title))) return true
  // 无标题 + 只有一句话 + 零工具：大概率是连通性验证
  if (s.toolCalls === 0 && title.length === 0 && s.humanMessages > 0 && s.humanMessages <= 1) return true
  return false
}

/** 判定 empty：零人类输入 且 零工具调用。 */
export function isEmptySession(s) {
  return s.toolCalls === 0 && s.humanMessages === 0
}

/**
 * 给一个会话打分类。顺序要紧：先判 empty，再判 smoke，剩余才是 real。
 * @param {object} s scan.js 产出的会话记录（可附加 firstPromptChars）
 * @returns {'empty'|'smoke'|'real'}
 */
export function categorize(s) {
  if (isEmptySession(s)) return 'empty'
  if (isSmokeTest(s)) return 'smoke'
  return 'real'
}

/**
 * 形态标签：决定这是"经验"还是"配方"。
 * 这一刀是产品级要求 —— 两类混在一起提炼会互相污染。
 *   · 把 one-shot 的模板拆成"经验" → 一堆没有上下文的碎片
 *   · 把 multi-turn 当"又一个模板" → 丢掉最值钱的推理过程
 * @param {object} s
 * @returns {'one-shot'|'multi-turn'|'unknown'}
 */
export function shapeOf(s) {
  if (categorize(s) !== 'real') return 'unknown'
  const turns = s.turnEnds ?? s.turns ?? 0
  if (turns > 1) return 'multi-turn'
  const firstPromptChars = s.firstPromptChars ?? 0
  if (turns <= 1 && firstPromptChars >= ONE_SHOT_PROMPT_MIN_CHARS) return 'one-shot'
  // 单轮 + 短指令：可能是被打断，也可能是极简任务；不硬塞进任何一类
  return 'unknown'
}

/**
 * 质量四维评分（0–10）。
 *
 * 设计要点（来自实测，每一条都有反例支撑）：
 *  ① 产出：交付物密度，**按长度归一化** —— 否则奖励冗长（长度与交付物 ρ=+0.577）
 *  ② 顺利度：错误率 + 重复调用率，**反向扣分** —— 长度与重复率 ρ=+0.486，长会话在挣扎
 *  ③ 完成态：末轮 completed / aborted
 *  ④ **不使用**「纠正密度 = userMsgs/turns」—— 实测 94.3% 恒等于 1.00，
 *     它测的是 DSH 的 turn 机制，不是纠正。已废弃。
 *  ⑤ **不使用**「已归档」当质量信号 —— 实测归档组交付率反而低 23.5 个百分点
 *
 * 关于区分度：初版四维大部分会话都能拿满（实测大量 9.9x），
 * 原因是"交付物密度"用 min(4, x*2) 太早饱和。
 * 改为**对数刻度 + 交叉项**：交付物少但有规模的会话不该与"又多又顺"同分。
 *
 * @param {object} s
 * @returns {{score:number, parts:object}}
 */
export function qualityScore(s) {
  if (categorize(s) !== 'real') return { score: 0, parts: { noise: true } }

  // ① 产出（0..4）：对数刻度 —— 1 个交付物 = 2.0，2 个 ≈ 3.0，4 个 ≈ 4.0
  //    用 log2 而不是线性，避免"15 个交付物"和"8 个"都被压成满分
  const d = s.deliverables
  const pDeliver = d <= 0 ? 0 : Math.min(4, 2 * Math.log2(d + 1))

  // ② 规模/密度（0..2）：每 100 次工具调用 1 个交付物为基准。
  //    这是"干了很多活且确实交了东西"的代理，同时惩罚"跑很久但没产出"
  const per100 = s.toolCalls > 0 ? (s.deliverables / s.toolCalls) * 100 : 0
  const pDensity = Math.min(2, per100 * 0.5)

  // ③ 顺利度（0..2）：错误率与重复率各扣，反向
  const errPenalty = Math.min(1.2, s.errorRate * 24) // 5% 错误率扣 1.2
  const dupPenalty = Math.min(0.8, s.dupRate * 4)
  const pSmooth = Math.max(0, 2 - errPenalty - dupPenalty)

  // ④ 完成态（0..2）
  let pEnd
  if (s.lastEndReason === 'completed') pEnd = 2
  else if (s.lastEndReason === 'interrupted') pEnd = 1
  else if (s.lastEndReason === 'aborted' || s.lastEndReason === 'error') pEnd = 0
  else pEnd = 1 // 未知/无末轮：中性

  // 无交付物时，"顺利 + 完成"不应该拿到 4 分 —— 那是空转得很干净
  const raw = pDeliver + pDensity + pSmooth + pEnd
  const score = s.deliverables > 0 ? raw : Math.min(raw, 4)

  return {
    score: Math.round(score * 100) / 100,
    parts: { pDeliver, pDensity, pSmooth, pEnd, per100 },
  }
}

/** 准入分级：noise / weak / strong。与"是否归档"无关。 */
export function admissionOf(s) {
  const cat = categorize(s)
  if (cat !== 'real') return 'noise'
  const q = qualityScore(s).score
  // strong：有交付物 且 完成态好
  if (s.deliverables > 0 && q >= 4) return 'strong'
  // weak：能提炼，但产出弱
  return 'weak'
}

/**
 * 对整个语料库做分诊 + 评分，返回聚合结果。
 * @param {object[]} sessions
 */
export function triageAll(sessions) {
  const counts = { empty: 0, smoke: 0, real: 0 }
  const shapes = { 'one-shot': 0, 'multi-turn': 0, unknown: 0 }
  const admission = { noise: 0, weak: 0, strong: 0 }
  const enriched = []

  for (const s of sessions) {
    const category = categorize(s)
    counts[category] += 1
    const shape = shapeOf(s)
    const { score, parts } = qualityScore(s)
    const admit = admissionOf(s)
    admission[admit] += 1
    if (category === 'real') shapes[shape] += 1
    enriched.push({ ...s, category, shape, qualityScore: score, qualityParts: parts, admission: admit })
  }

  return { enriched, counts, shapes, admission, total: sessions.length }
}
