/**
 * 「T0 统计骨架」判据 —— 只有一个可核验的定义，供三处共用：
 *   ① lib/index.js 的检索降权 / 标注（2026-11-12 验收）
 *   ② lib/library.js 的骨架自动退役（同会话已有真结论时）
 *   ③ scripts/redistill-skeletons.mjs 的批量重提炼与占比统计
 *
 * 为什么单独立成模块：判据一旦出现两份，改一处忘另一处就会静默漂移 ——
 * 脚本按 A 口径挑会话、建库按 B 口径退役，两边的数字永远对不上。
 * 这个文件不 import 任何东西，避免把 index.js 的宿主依赖带进 CLI 脚本。
 */

/**
 * 该 claim 是不是「T0 统计骨架」——只有轮次/调用数，没有结论。
 *
 * 线上事故（2026-11-12）：320 条里 155 条（48.4%）claim 就是
 * `7 轮 · 3 次工具调用 · 0 个交付物 · （多轮讨论）` 这种结构描述。
 * 它靠标题里的词命中，却把「会话有多长」混进「会话教会了什么」。
 *
 * 判据刻意写得窄：必须**以轮次开头且紧跟「次工具调用」**，长度 <120。
 * 真实结论几乎不会长成这个样子；写成"含「轮」就排除"会误杀讲轮次的条目
 * （test-recall-skeleton 锁的就是这条）。
 *
 * @param {unknown} claim
 * @returns {boolean}
 */
export function isSkeletonClaim(claim) {
  const text = String(claim ?? '').trim()
  if (!text || text.length > 120) return false
  return /^\d+\s*轮\s*·\s*\d+\s*次工具调用/.test(text)
}

/**
 * 目录投影 / 磁盘条目都适用：只看 claim。
 * @param {object} entry
 * @returns {boolean}
 */
export function isSkeletonEntry(entry) {
  return isSkeletonClaim(entry?.claim)
}
