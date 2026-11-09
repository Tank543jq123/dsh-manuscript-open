/**
 * 提案自动裁决（T1 审阅层）。
 *
 * ## 为什么需要这一层
 *
 * 最初的设想是"LLM 产出提案 → 人逐条确认 → 入册"。但实测跑一轮就产出 5 条，
 * 跑满 20 个会话会产出几十条。**人会疲劳，疲劳后会无脑点"全部通过"** ——
 * 那时的"人工确认"是假的，比不确认更危险，因为它给了虚假的安全感。
 *
 * 正确的做法是：**让 AI 先做大部分判断，人只看真正需要人看的那几条。**
 *
 * ## 三级裁决
 *
 * | 级别 | 含义 | 处置 |
 * |:---|:---|:---|
 * | `auto-accept` | 机械校验全过 + 模型自评 high + 无冲突 | 直接入册，人不用看 |
 * | `auto-reject` | 机械校验发现问题（编数字 / 名词堆 / 过短） | 直接丢弃，人不用看 |
 * | `needs-human` | 中间地带：模型自评 medium/speculation，或存在疑点 | 进人工队列 |
 *
 * **判断依据全部可机械复核**，不依赖模型自评的盲信：
 *   - 数字溯源（distill.js 已做，这里复用结论）
 *   - 标题是否陈述句
 *   - claim 长度与信息密度
 *   - 是否与已有条目重复（关键：防同一结论反复入册）
 *   - 模型自评置信度（作为加权，不作为唯一依据）
 *
 * ## 一个刻意的保守：high 也不必然 auto-accept
 *
 * 模型说 high 不等于真的 high。所以 `auto-accept` 还要求**通过独立的结构检查**。
 * 只有"模型说高 + 机器验证也没问题"才自动放行。
 */

import { looksDeclarative } from './distill.js'

/** 裁决结果。 */
export const DECISION = {
  AUTO_ACCEPT: 'auto-accept',
  AUTO_REJECT: 'auto-reject',
  NEEDS_HUMAN: 'needs-human',
}

/** 可自动接受的最低 claim 字数。太短的结论通常信息量不足。 */
export const MIN_CLAIM_CHARS = 40

/** 判定重复的相似度阈值（0-1）。超过视为同一结论。 */
export const DUP_THRESHOLD = 0.82

/**
 * 主题重合判定阈值（规则组合查重）。
 *
 * ## 为什么 bigram 指纹不够（2026-11-03 实测）
 *
 * 实测库里 9 条讲同一件事（read_image 不支持图像输入），
 * 用现行 bigram 指纹算，**两两最高只有 0.722，一条都拦不住**。
 * 原因：这 9 条措辞差异极大——
 *   「模型无法读取图片，read_image 必然失败」
 *   「模型未声明图像输入时 read_image 会直接报错，须先换模型」
 * 字面重合度低，但说的是同一件事。bigram 测的是字符重合，测不出语义。
 *
 * ## 规则组合的思路
 *
 * 不比字符，比「**有辨识度的技术标识符**」：
 *   · 带下划线/点的标识符（read_image、web_fetch、package.json）
 *   · 长英文词（grantwrite、deepseek）
 *   · 精选的中文技术名词（图像输入、原理图、寄存器…）
 *
 * 通用词（file/read/model/报错/失败）**全部排除** —— 它们在大量条目里出现，
 * 不能作为"同一主题"的证据。实测：把它们算进去会导致
 * 「edit 报 file changed」和「编辑前必须先 read」被误判成同一件事。
 *
 * ## 已知局限：会偶发误伤
 *
 * 实测 69 条真结论里，此规则能砍掉 9 条，其中 **1 条是误伤**
 * （「先查开源转换器」与「重画会重叠」共享 kicad/eprj2/原理图）。
 * 主题词相同但结论不同的情况，纯规则区分不了。
 *
 * 所以命中的不直接拒，而是**推入人工队列**（见 applyDedup 的用法），
 * 让人能看见并决定。宁可多问一句，不可静默丢弃。
 *
 * ## 阈值怎么定的（2026-11-03 用真实 69 条数据扫描）
 *
 * 实测扫描结果：
 *
 * | minShared | jaccard | read_image 命中 | web_fetch 命中 | 误伤 |
 * |:---:|:---:|:---:|:---:|:---:|
 * | 1 | 0.2 | 25/36 对 | 10/15 对 | 0 |
 * | 2 | 0.2 | 25/36 对 | 10/15 对 | 0 |
 * | 3 | 0.5 | 7/36 对 | 10/15 对 | 0 |
 *
 * 最初我拍脑袋定成 (3, 0.5)，实测下来 read_image 只能认出 7/36 —— 太严了，
 * 因为 keyTokens 本身只提取出 3-4 个 token，要求共享 3 个几乎等于要求完全一致。
 *
 * 最终取 (2, 0.2)：效果与 (1, 0.2) 相同，但多共享一个标识符更稳妥。
 * 误伤在 5 个不同主题的交叉验证里为 0。
 *
 * ⚠️ 这个阈值是**用当前 69 条样本**调的，样本变大后应重新扫描验证。
 */
export const TOPIC_MIN_SHARED = 2
export const TOPIC_MIN_JACCARD = 0.2

/**
 * 标题级判重阈值（2026-11-04 新增，用于弥补 jaccard 被长 claim 稀释的缺陷）。
 *
 * 只用标题比，不吃 claim 长度的影响。判据是**共同前缀占较短标题的比例**。
 *
 * 为什么不用「标题 bigram 相似度」：实测区分力不足。
 *   · 图像输入那对（真重复）：jaccard 0.500 / overlap 0.722
 *   · edit 那对（不同成因）：  jaccard 0.520 / overlap 0.722
 *   两对几乎同分，任何阈值都会同时拦下或同时放过。
 *   根因是 fingerprint 只留汉字与英文词，丢掉了标点与语序信息，
 *   「编辑文件前必须先 read」与「edit 工具修改文件前必须先 read」
 *   在汉字层面本来就高度重合。
 *
 * 为什么共同前缀能分开：同一件事的两条，标题前缀常常逐字相同；
 * 不同成因的两条，开头就分叉。实测：
 *   · 图像输入：共同前缀 22 字符 / 较短标题 28 字 = 0.79
 *   · edit：    共同前缀  0 字符 / 较短标题 40 字 = 0.00
 *
 * ⚠️ 与 jaccard 阈值一样，这是在小样本上定的，样本变大后应重新扫描。
 */
export const TOPIC_TITLE_PREFIX_RATIO = 0.6
export const TOPIC_TITLE_MIN_SHARED = 1

/** 去掉空白后求两个字符串的共同前缀长度占较短者的比例。 */
function commonPrefixRatio(a, b) {
  const x = String(a || '').replace(/\s+/g, '')
  const y = String(b || '').replace(/\s+/g, '')
  const short = Math.min(x.length, y.length)
  if (short === 0) return 0
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i += 1
  return i / short
}

/**
 * 通用词黑名单：出现在大量条目里，不能证明"同一主题"。
 *
 * 【2026-11-04 全量矩阵实测后扩充】第一版只有 40 个词，跑全量 2346 对后
 * 发现 53 对判重里有 17 对是误判（精确率仅 67.9%）。误判来源集中在两类：
 *
 *   ① **文件路径片段**：`C:\Users\<user>\...` 里的 users 与用户名。
 *      最荒诞的一例 —— 「BOM 导致启动失败」和「技能包按需挂载」，
 *      仅仅因为 claim 里都出现 `C:\Users\<user>\` 就被判成同一件事。
 *   ② **领域泛词**：github、仓库、原理图、网表。
 *      同领域但在讲不同结论，不能算证据。
 */
const GENERIC_TOKENS = new Set([
  // 英文虚词与高频动词
  'file', 'read', 'write', 'edit', 'changed', 'since', 'was', 'the', 'then', 'retry',
  'cannot', 'not', 'does', 'declare', 'model', 'input', 'image', 'tool', 'error',
  'fail', 'failed', 'and', 'for', 'with', 'from', 'this', 'that', 'can', 'will',
  'modify', 're-read', 'has', 'been', 'which', 'when', 'where', 'what',
  // 路径片段（实测误判元凶）。
  // 注意：这里只放**通用**的路径噪声词。某人机器上的具体用户名**不能**进这张表 ——
  // 一是那会随仓库公开泄露用户名，二是换个用户它就失效了（`<user>` 才是通配思路）。
  'users', 'temp', 'appdata', 'local', 'roaming', 'program', 'files',
  'c:', 'd:', 'e:', 'home', 'root', 'node_modules', 'package', 'json',
  // 领域泛词（同领域但不同结论）
  'github', 'git', 'gh', '仓库', '原理图', '网表', 'eda', 'kicad', 'eprj2',
  'visual', 'studio', 'code', 'vscode', 'windows', 'linux', 'macos',
  // 中文虚词与泛概念
  '会话', '模型', '工具', '图像', '报错', '失败', '接口', '协议', '配置', '启动',
  '不支持', '超时', '重试', '缓存', '并发', '文件', '路径', '目录', '系统',
  '问题', '情况', '需要', '可以', '使用', '出现', '导致', '需要', '进行',
])

/** 精选中文技术名词：够独特，出现即说明在同一领域。 */
const SPECIFIC_CJK = [
  '图像输入', '芯片', '器件', '封装', '寄存器', '中断', '状态机',
  '凭据', '乱码', '归档', '提炼', '选型', '引脚',
]

/**
 * 提取"有辨识度的技术标识符"。
 * @param {string} text
 * @returns {Set<string>}
 */
export function keyTokens(text) {
  // 【必须先剥掉路径】实测误判元凶：`C:\Users\<user>\...` 这类路径里的
  // users/<user>/temp/appdata 会被当成技术标识符，导致两条毫不相干的条目
  // （「BOM 导致启动失败」与「技能包按需挂载」）被判成同一件事。
  // 路径对"讲的是什么事"没有区分力 —— 同一台机器上所有条目都共享它。
  const stripped = String(text || '')
    .replace(/[a-z]:\\[^\s，。；]*/gi, ' ')   // Windows 绝对路径
    .replace(/\/[\w.-]+(?:\/[\w.-]+)+/g, ' ') // Unix 风格路径
    .replace(/~\/[\w./-]*/g, ' ')             // 家目录路径

  const s = stripped.toLowerCase()
  const out = new Set()
  // 带下划线 / 点 / 井号的标识符最有辨识度（read_image、package.json）
  for (const w of s.match(/[a-z][a-z0-9_+#.\-]*[_#.][a-z0-9_+#.\-]+/g) || []) {
    if (!GENERIC_TOKENS.has(w)) out.add(w)
  }
  // 较长的英文词（>=5 字符），排除纯通用词
  for (const w of s.match(/\b[a-z][a-z0-9\-]{4,}\b/g) || []) {
    if (!GENERIC_TOKENS.has(w) && !/^\d/.test(w)) out.add(w)
  }
  for (const w of SPECIFIC_CJK) if (s.includes(w)) out.add(w)
  return out
}

/**
 * 判断两条是否"在讲同一件事"（主题重合，不是字面重合）。
 *
 * @param {{title?:string, claim?:string}} a
 * @param {{title?:string, claim?:string}} b
 * @returns {{dup:boolean, shared:string[], jaccard:number}}
 */
export function looksSameTopic(a, b) {
  const ta = keyTokens(`${a?.title || ''} ${a?.claim || ''}`)
  const tb = keyTokens(`${b?.title || ''} ${b?.claim || ''}`)
  const shared = [...ta].filter((x) => tb.has(x))
  const union = ta.size + tb.size - shared.length
  const j = union > 0 ? shared.length / union : 0

  // 【2026-11-04 修复缺陷 2】标题级判据，防止 jaccard 被「长 claim」稀释。
  //
  // 事故现场（真实数据）：
  //   库里   「当前模型不支持图像输入，read_image 工具必然失败」
  //          claim 里写了 svgcheck.png / n3_report.png / deepseek-v4.1-flash → 11 个 token
  //   新候选 「当前模型不支持图像输入，read_image 读物料图片直接失败」
  //          只有 4 个 token
  //   共享 read_image + 图像输入 = 2 个，但 jaccard = 2/13 = 0.154 < 0.20 → **放行**
  //
  // 这不是边缘情况：两条明明在讲同一件事，标题几乎逐字相同，却因为
  // 一条 claim 写得更具体（而这恰恰是我们想要的）而被判成"不重复"。
  // 也就是说 —— **claim 越详细，越容易漏判**，方向和提炼质量相反。
  //
  // 修法：单独看标题的共同前缀（为什么不用字面相似度，见常量处说明），
  // 再要求至少共享 1 个 keyToken，避免共享词为空的条目被误伤。
  const prefixRatio = commonPrefixRatio(a?.title, b?.title)
  const titleDup =
    prefixRatio >= TOPIC_TITLE_PREFIX_RATIO && shared.length >= TOPIC_TITLE_MIN_SHARED

  const byJaccard = shared.length >= TOPIC_MIN_SHARED && j >= TOPIC_MIN_JACCARD
  return {
    dup: byJaccard || titleDup,
    shared,
    jaccard: j,
    prefixRatio,
    byTitle: titleDup && !byJaccard,
  }
}

/**
 * 文本指纹：用于粗粒度去重。
 *
 * 做法：去掉标点与空白，取中文 bigram + 英文词，生成集合。
 * 不用编辑距离——O(n²) 在几十条上没问题，但 bigram 集合的 Jaccard
 * 更快且对语序不敏感，适合"同一结论换了个说法"。
 *
 * @param {string} s
 * @returns {Set<string>}
 */
export function fingerprint(s) {
  const text = String(s || '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ')
  const grams = new Set()
  // 中文 bigram
  const han = text.replace(/[^\p{Script=Han}]/gu, '')
  for (let i = 0; i + 1 < han.length; i += 1) grams.add(han.slice(i, i + 2))
  // 英文词
  for (const w of text.match(/[a-z][a-z0-9_+#.-]{1,}/g) || []) {
    if (w.length >= 3) grams.add(w)
  }
  return grams
}

/** Jaccard 相似度。 */
export function similarity(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

/**
 * 单条提案的机械检查。任何一项不过都可能降级到 reject 或 human。
 *
 * @param {object} proposal
 * @param {object} [opts]
 * @returns {{ok:boolean, reasons:string[], warnings:string[]}}
 */
export function inspectProposal(proposal, opts = {}) {
  const reasons = []
  const warnings = []
  const p = proposal || {}

  const title = String(p.title || '').trim()
  const claim = String(p.claim || '').trim()

  // 硬性：标题必须是陈述句
  let decl
  try {
    decl = looksDeclarative(title)
  } catch {
    decl = { ok: true }
  }
  if (!decl || decl.ok !== true) {
    reasons.push(`标题不是陈述句${decl?.reason ? '：' + decl.reason : ''}`)
  }

  // 硬性：claim 太短通常是废话
  if (claim.length < MIN_CLAIM_CHARS) {
    reasons.push(`结论过短（${claim.length} 字，少于 ${MIN_CLAIM_CHARS}）`)
  }

  // 硬性：标题与 claim 不能几乎一样（说明模型在重复自己）
  const tf = fingerprint(title)
  const cf = fingerprint(claim)
  if (similarity(tf, cf) > 0.9) {
    reasons.push('标题与结论内容几乎相同，说明没有提炼')
  }

  // 软性：claim 里没有具体锚点（数字/路径/专名/命令）→ 可能是"正确的废话"
  const hasAnchor =
    /\d/.test(claim) ||
    /[A-Za-z][A-Za-z0-9_.-]{2,}/.test(claim) ||
    /[/\\][\w.-]+[/\\]/.test(claim) ||
    /`[^`]+`/.test(claim)
  if (!hasAnchor) {
    warnings.push('结论里没有数字、路径、专名或命令，可能是泛泛而谈')
  }

  // 软性：模型自评
  const conf = String(p.confidence || '').toLowerCase()
  if (conf === 'speculation') warnings.push('模型自评为推测')
  if (!conf) warnings.push('模型未给置信度')

  return { ok: reasons.length === 0, reasons, warnings }
}

/**
 * 对一批提案做自动裁决。
 *
 * @param {object[]} proposals
 * @param {object} [opts]
 * @param {object[]} [opts.existing] 已在库里的条目（用于去重）
 * @param {number}   [opts.maxHuman] 最多让人看几条（默认 8）。超出的降级为延后
 * @returns {{
 *   accept: object[],
 *   reject: object[],
 *   human: object[],
 *   deferred: object[],
 *   stats: object
 * }}
 */
export function adjudicate(proposals, opts = {}) {
  const list = Array.isArray(proposals) ? proposals.filter((p) => p && typeof p === 'object') : []
  const existing = Array.isArray(opts.existing) ? opts.existing : []
  const maxHuman = Number.isFinite(opts.maxHuman) ? opts.maxHuman : 8

  // 已有条目的指纹索引，用于查重
  const existingPrints = existing.map((e) => ({
    id: e.id || null,
    title: e.title || '',
    // claim 也要留：主题级查重（looksSameTopic）需要完整正文，
    // 只给 title 会漏掉大量标识符，判重准确率明显下降。
    claim: e.claim || '',
    fp: fingerprint(`${e.title || ''} ${e.claim || ''}`),
  }))

  const accept = []
  const reject = []
  const human = []
  const deferred = []

  // 本轮已接受的候选，防止同一批里自身重复。
  //
  // 【2026-11-04 修复】原来这里只存 bigram 指纹，而主题级查重（②-b）只遍历
  // `existingPrints`（历史库），**从不与本批已接受的候选比对**。
  // 后果实测（真实数据，20 会话那批）：
  //   · 两条提案都讲「read_image 因模型不支持图像输入而失败」
  //   · bigram 相似度仅 0.261（阈值 0.82，第一层拦不住）
  //   · 主题层共享 read_image / 图像输入（jaccard = 1.0，完全同主题）
  //   · 但 existing 里没有同主题条目时，两条**一起进了 accept**
  // 也就是说：批内同主题重复只在「恰好历史库里也有一条」时才被顺带拦住，
  // 属于偶然而非设计。批越大（每批 3 会话）漏得越多。
  //
  // 现在同时保留 claim 与主题判定所需的原文，两层都对比本批候选。
  const acceptedPrints = []

  for (const p of list) {
    const insp = inspectProposal(p)

    // ① 机械检查不过 → 直接拒（人不用看）
    if (!insp.ok) {
      reject.push({ ...p, _decision: DECISION.AUTO_REJECT, _reasons: insp.reasons, _warnings: insp.warnings })
      continue
    }

    // ② 查重：与库里已有条目太像 → 拒
    const fp = fingerprint(`${p.title || ''} ${p.claim || ''}`)
    let dupOf = null
    for (const e of existingPrints) {
      if (similarity(fp, e.fp) >= DUP_THRESHOLD) {
        dupOf = e
        break
      }
    }
    if (!dupOf) {
      for (const a of acceptedPrints) {
        if (similarity(fp, a.fp) >= DUP_THRESHOLD) {
          dupOf = a
          break
        }
      }
    }
    if (dupOf) {
      reject.push({
        ...p,
        _decision: DECISION.AUTO_REJECT,
        _reasons: [`与已有条目的内容重复：${dupOf.title || dupOf.id || '(本条批内重复)'}`],
        _warnings: insp.warnings,
      })
      continue
    }

    // ②-b 主题级查重（2026-11-03 新增）
    //
    // 【为什么单独一层】上面的 bigram 指纹测的是**字面重合**，阈值 0.82 很严。
    // 实测 9 条讲 read_image 的条目，两两最高只有 0.722，一条都拦不住。
    //
    // 这一层测的是**主题重合**（共享技术标识符），能抓住"换了说法但说的是同一件事"。
    //
    // 【为什么推入 human 而不是 reject】规则法会偶发误伤 —— 实测 69 条里
    // 砍掉的 9 条中有 1 条其实是不同结论（「先查开源转换器」vs「重画会重叠」
    // 共享 kicad/eprj2/原理图）。静默丢弃等于替用户做判断，
    // 所以只"提醒"，把决定权交回去。
    let topicDup = null
    for (const e of existingPrints) {
      const r = looksSameTopic(p, e)
      if (r.dup) {
        topicDup = { of: e, shared: r.shared }
        break
      }
    }
    // 【2026-11-04 修复】本批已接受的候选也要纳入主题查重。
    // 详见 acceptedPrints 声明处的说明：漏掉这一圈会让同一批里的
    // 同主题提案双双入册，而 bigram 层因字面差异大完全拦不住。
    if (!topicDup) {
      for (const a of acceptedPrints) {
        if (!a.title && !a.claim) continue
        const r = looksSameTopic(p, a)
        if (r.dup) {
          topicDup = { of: a, shared: r.shared, inBatch: true }
          break
        }
      }
    }
    if (topicDup) {
      human.push({
        ...p,
        _decision: DECISION.NEEDS_HUMAN,
        _reasons: [],
        _warnings: [
          ...insp.warnings,
          `疑似与${topicDup.inBatch ? '本批已接受的候选' : '已有条目'}讲同一件事（共享 ${topicDup.shared.slice(0, 3).join('/')}）：${topicDup.of.title || topicDup.of.id}`,
        ],
      })
      continue
    }

    // ③ 判定是否够格自动接受
    //
    //    【关键设计 2026-11-02 调整】
    //    第一版要求「模型自评 high + 无警告」，实测自动处理率只有 60% ——
    //    两条内容完全合格的真实条目（机械检查全过、无任何警告）因为模型
    //    自评是 medium 就被推进人工队列。这不对：**模型给 medium 是常态**
    //    （它倾向于保守），拿它当硬门槛会把人工队列撑爆，而人工队列一长，
    //    人就会无脑点"全过" —— 那时"人工确认"是假的。
    //
    //    改成：**机械检查说了算，模型自评只是加分项。**
    //      · 无警告 + 自评 high        → 直接入册（最可信）
    //      · 无警告 + 自评 medium      → 直接入册，但打标记「建议抽查」
    //      · 有警告                    → 进人工队列（这才真的需要人判断）
    //      · 自评 speculation          → 进人工队列（模型自己都没把握）
    const conf = String(p.confidence || '').toLowerCase()
    const cleanEnough = insp.warnings.length === 0
    const confidentEnough = conf === 'high' || conf === 'medium'

    if (cleanEnough && confidentEnough) {
      accept.push({
        ...p,
        _decision: DECISION.AUTO_ACCEPT,
        _reasons: [],
        _warnings: [],
        // medium 入册的条目要能被抽查到，所以留一个标记
        _spotCheck: conf === 'medium',
      })
      acceptedPrints.push({ fp, title: p.title, claim: p.claim || '' })
      continue
    }

    // ④ 其余进人工队列
    human.push({ ...p, _decision: DECISION.NEEDS_HUMAN, _reasons: [], _warnings: insp.warnings })
  }

  // ⑤ 人工队列按"最值得看"排序：有警告的、medium 的在前
  human.sort((a, b) => {
    const score = (x) => (x._warnings?.length || 0) * 10 + (x.confidence === 'medium' ? 5 : 1)
    return score(b) - score(a)
  })

  // ⑥ 超过上限的延后（不是拒绝，下轮还会出现）
  let humanOut = human
  if (human.length > maxHuman) {
    humanOut = human.slice(0, maxHuman)
    for (const p of human.slice(maxHuman)) {
      deferred.push({ ...p, _decision: 'deferred', _reason: '超出本轮人工复核上限，留待下轮' })
    }
  }

  return {
    accept,
    reject,
    human: humanOut,
    deferred,
    stats: {
      total: list.length,
      accepted: accept.length,
      rejected: reject.length,
      needsHuman: humanOut.length,
      deferred: deferred.length,
      /** 自动处理占比 —— 这是这个模块存在的核心指标 */
      autoHandledRate: list.length ? (accept.length + reject.length) / list.length : 0,
    },
  }
}

/**
 * 把裁决结果压成一句人话摘要（给 UI 顶部用，不列明细）。
 */
export function summarizeAdjudication(adj) {
  const s = adj.stats
  if (!s.total) return '本轮没有产出候选条目。'
  const pct = Math.round(s.autoHandledRate * 100)
  const parts = [`产出 ${s.total} 条`, `AI 自动处理 ${s.accepted + s.rejected} 条（${pct}%）`]
  if (s.needsHuman) parts.push(`需你确认 ${s.needsHuman} 条`)
  if (s.deferred) parts.push(`延后 ${s.deferred} 条`)
  return parts.join(' · ')
}
