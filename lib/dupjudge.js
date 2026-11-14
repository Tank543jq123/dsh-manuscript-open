/**
 * LLM 语义判重（2026-11-04 新增）。
 *
 * ## 为什么必须用 LLM，而不是继续调规则阈值
 *
 * 用 10 个已人工标注的样本（5 正 / 5 负）实测了 5 种纯规则指标，
 * **没有一种能把正负样本分开**：
 *
 * | 指标 | 正均值 | 负均值 | 可分 |
 * |:---|:---:|:---:|:---:|
 * | bigram 全文 | 0.15 | 0.06 | ✗ 重叠 |
 * | bigram 标题 | 0.28 | 0.05 | ✗ 重叠 |
 * | topic jaccard | 0.22 | 0.02 | ✗ 重叠 |
 * | 标题前缀比例 | 0.03 | 0.06 | ✗ 倒挂 |
 * | 共享 token 数 | 0.80 | 0.20 | ✗ 重叠 |
 *
 * 根因：`keyTokens` 靠 claim 里的**英文标识符**提 token，中文标题几乎不贡献。
 * 实测正例「标准年份」那一对，A 只提到 `iso.org`、B 一个 token 都没有 → shared=[]。
 * 也就是说规则法对中文条目基本是瞎的：正例错、负例对，都是巧合。
 *
 * ## 设计约束
 *
 * 1. **不阻断主流程**：LLM 调用失败时返回 `null`（未知），由调用方按原规则继续。
 *    查重是增强，不该因为一次网络抖动就把整批提炼搞挂。
 * 2. **只在候选足够像时才问** —— 先用廉价的规则做粗筛（title 或 claim 有字面重合），
 *    避免每条候选都对全库几百条调 LLM。这是成本与召回的折中。
 * 3. **temperature=0** —— 判重是分类任务，不需要创造性。
 * 4. **输出只认 JSON** —— 解析失败视为未知，不当成 false（不能把"没答上来"说成"不重复"）。
 */

/** 判重系统提示词。刻意写死判据，并要求只输出一行 JSON。 */
import { collectTextStream } from './llm-stream.js'

export const JUDGE_SYSTEM = `你是「书阁」知识库的查重员。判断两条经验条目是否在讲**同一件事**。

判据：
- 同一件事 = 两条的**核心结论相同**，读者按其中一条做就能得到另一条说的效果。
- 不是同一件事 = 主题相近但**成因不同、触发条件不同、或结论相反**。
  例：「edit 报 file changed」与「编辑前必须先 read」都涉及 edit，但成因不同 → 不是同一件事。
- 只看结论是否等价，不看措辞、举例、细节多寡。
- 细节更多的那条如果是同一条结论的展开，仍算同一件事。

只输出一行 JSON，不要任何解释：
{"same": true} 或 {"same": false}`

/**
 * 粗筛：只有"看起来可能重复"的候选才值得花一次 LLM 调用。
 *
 * 这一层不判重，只做成本控制。宁可多问（召回优先），因为漏判的代价是
 * 库里多一条重复；误问的代价只是一次很短的 LLM 调用。
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function worthAsking(a, b) {
  const ta = String(a?.title || '')
  const tb = String(b?.title || '')
  // ① 标题有较长的公共子串 → 值得问
  if (longestCommonSubstring(ta, tb) >= 6) return true
  // ② 共享英文标识符 → 值得问
  const ka = new Set(ta.match(/[a-zA-Z][a-zA-Z0-9_.-]{2,}/g) || [])
  const kb = new Set(tb.match(/[a-zA-Z][a-zA-Z0-9_.-]{2,}/g) || [])
  for (const x of ka) if (kb.has(x)) return true

  // ③ 【2026-11-04 补】中文标题的公共 2-gram 比例。
  //
  // 为什么必须补：原判据只有①（≥6 字公共子串）和②（共享英文标识符），
  // 对中文短标题过于严格，会直接漏判。真实漏例：
  //   候选「区域采纳版编号里的年份会被误当成 ISO 标准修订版」
  //   已有「标准编号里的新年份常是区域采纳版，不代表技术修订」
  // 最长公共子串只有 4（「区域采纳」），且共享的 "ISO" 是 2 个字母
  // 够不上②的 3 字符门槛 —— 于是 worthAsking 返回 false，
  // **LLM 根本没被问到**，这条重复就进了库（库中已有 2 条同主题）。
  //
  // 改用比例：较短标题的 2-gram 有 30% 以上出现在另一条里 → 值得问。
  // 这个门槛刻意压低 —— 本函数的原则是"宁可多问"，成本只是一次
  // 很短的 LLM 调用，而漏判的代价是库里永久多一条重复。
  const ratio = bigramOverlapRatio(ta, tb)
  if (ratio >= 0.3) return true
  return false
}

/** 两个中文标题的 2-gram 重合率（分母取较短者，避免长标题稀释）。 */
function bigramOverlapRatio(a, b) {
  const A = String(a || '').replace(/\s+/g, '')
  const B = String(b || '').replace(/\s+/g, '')
  if (A.length < 2 || B.length < 2) return 0
  const grams = (s) => {
    const out = new Set()
    for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2))
    return out
  }
  const ga = grams(A)
  const gb = grams(B)
  if (ga.size === 0 || gb.size === 0) return 0
  let hit = 0
  for (const g of ga) if (gb.has(g)) hit += 1
  return hit / Math.min(ga.size, gb.size)
}

/** 最长公共子串长度（用于粗筛，O(n*m)，标题很短所以够用）。 */
function longestCommonSubstring(a, b) {
  if (!a || !b) return 0
  const A = a.replace(/\s+/g, '')
  const B = b.replace(/\s+/g, '')
  let best = 0
  let prev = new Array(B.length + 1).fill(0)
  for (let i = 1; i <= A.length; i += 1) {
    const cur = new Array(B.length + 1).fill(0)
    for (let j = 1; j <= B.length; j += 1) {
      if (A[i - 1] === B[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best) best = cur[j]
      }
    }
    prev = cur
  }
  return best
}

// 收集器统一走 lib/llm-stream.js（见那里的注释：dupjudge 原来在 text-chunks
// 流下拿不到内容 → same:null → 查重静默失效）

/**
 * 问一次 LLM：这两条是不是同一件事？
 *
 * @param {object} llm  宿主注入的 llm 服务（ctx.llm），为空则直接返回 null
 * @param {object} a
 * @param {object} b
 * @param {{provider?:string, model?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<{same: boolean|null, raw?: string, error?: string}>}
 *   `same: null` 表示"问不出结论"（无 llm / 调用失败 / 输出不可解析）。
 *   **调用方必须把 null 当作未知，而不是不重复。**
 */
export async function judgeSameTopic(llm, a, b, opts = {}) {
  if (!llm || typeof llm.stream !== 'function') return { same: null, error: 'no-llm' }

  const body = `条目 A
标题：${a?.title || ''}
结论：${a?.claim || ''}

条目 B
标题：${b?.title || ''}
结论：${b?.claim || ''}`

  const timeoutMs = opts.timeoutMs ?? 30000
  let signal
  try {
    signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(timeoutMs)
      : undefined
  } catch {
    signal = undefined
  }

  let raw
  try {
    const chunks = llm.stream({
      provider: opts.provider ?? 'workbuddy',
      model: opts.model ?? 'deepseek-v4.1-flash',
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: body }] }],
      maxTokens: 64,
      temperature: 0,
      ...(signal ? { signal } : {}),
    })
    raw = await collectTextStream(chunks)
  } catch (e) {
    return { same: null, error: `调用失败：${e?.message || String(e)}` }
  }

  const m = String(raw || '').match(/\{[\s\S]*?\}/)
  if (!m) return { same: null, raw, error: '输出不含 JSON' }
  try {
    const parsed = JSON.parse(m[0])
    if (typeof parsed?.same !== 'boolean') return { same: null, raw, error: 'JSON 缺 same 布尔字段' }
    return { same: parsed.same, raw }
  } catch (e) {
    return { same: null, raw, error: `JSON 解析失败：${e?.message || String(e)}` }
  }
}
