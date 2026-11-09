/**
 * 多设备书库合并 —— 纯逻辑部分（不碰磁盘）。
 *
 * ## 为什么单独抽出来
 *
 * 用户要做一个"图书馆"来管理不同设备上的书阁数据。同步的真正难点不是传文件，
 * 而是**同一条条目在两台设备上被改成了不同样子**时怎么办。
 *
 * 这里给一套**保守、可解释、不删数据**的规则：
 *
 *   1. 只在一边存在        → `add`（并进目标）
 *   2. 两边内容完全一致    → `same`（什么都不做）
 *   3. 两边内容不同，但 `updatedAt` 可比较 → 新的赢：`update`（旧的那份**另存为冲突副本**）
 *   4. `updatedAt` 相同或缺失，内容却不同 → `conflict`（**不猜**，保留目标侧原件，
 *      把对方那份写进 conflicts/ 让人看）
 *
 * 为什么规则 3 也要留副本：`updatedAt` 只是"最后一次写入时间"，它证明不了
 * "这次写入是有意的改正"。留一份副本的成本是几 KB，丢一条经验的成本是不可逆的。
 *
 * 为什么规则 4 不按文件名/设备名排序硬选一个：那是**编造顺序**。
 * 两条都留着、等人看，比一个看起来确定的错误答案好。
 *
 * 本模块只做数据整形，不做 IO —— IO 在 scripts/merge-libraries.mjs。
 */

/**
 * 参与"内容是否相同"比较的字段。
 *
 * 刻意**不含** `updatedAt` / `createdAt` / `committedAt` / `origin`：
 * 两台设备各自写入时这些一定会不同，把它们算进内容比较会让"内容相同"永远不成立。
 * 也**不含** `hits` / `last_hit` / `slot` —— 那是本机的使用统计，不是条目内容。
 */
export const CONTENT_FIELDS = [
  'volume',
  'chapter',
  'chapterTitle',
  'title',
  'claim',
  'why',
  'confidence',
  'authority',
  'status',
  'needsReview',
  'tags',
  'evidence',
  'provenance',
]

/** 取条目内容的规范化 JSON（用于判等）。 */
export function contentOf(entry) {
  const out = {}
  for (const k of CONTENT_FIELDS) {
    const v = entry?.[k]
    if (v === undefined) continue
    out[k] = v
  }
  // 键顺序固定，保证两台设备算出的字符串一致
  return JSON.stringify(out, CONTENT_FIELDS.filter((k) => k in out))
}

/** 解析 updatedAt；无效或缺失返回 null。 */
function updatedAtOf(entry) {
  const t = Date.parse(String(entry?.updatedAt || ''))
  return Number.isFinite(t) ? t : null
}

/**
 * 算出合并计划（纯函数，不写盘）。
 *
 * @param {object[]} base 目标侧现有条目
 * @param {object[]} incoming 另一侧待并入的条目
 * @returns {{
 *   operations: Array<{id:string, action:'add'|'update'|'same'|'conflict',
 *                      winner?:object, loser?:object, reason?:string}>,
 *   stats: {added:number, updated:number, same:number, conflicts:number, skipped:number},
 *   conflicts: Array<{id:string, base:object, incoming:object, reason:string}>,
 * }}
 */
export function planMerge(base, incoming) {
  const baseById = new Map()
  for (const e of Array.isArray(base) ? base : []) {
    if (e && typeof e.id === 'string' && e.id) baseById.set(e.id, e)
  }
  const operations = []
  const conflicts = []
  const stats = { added: 0, updated: 0, same: 0, conflicts: 0, skipped: 0 }

  const seen = new Set()
  for (const inc of Array.isArray(incoming) ? incoming : []) {
    if (!inc || typeof inc.id !== 'string' || !inc.id) {
      stats.skipped += 1
      continue
    }
    if (seen.has(inc.id)) {
      // 同一批里出现重复 id：只处理第一条，其余记 skipped（不静默合并）
      stats.skipped += 1
      continue
    }
    seen.add(inc.id)

    const cur = baseById.get(inc.id)
    if (!cur) {
      stats.added += 1
      operations.push({ id: inc.id, action: 'add', winner: inc })
      continue
    }
    if (contentOf(cur) === contentOf(inc)) {
      stats.same += 1
      operations.push({ id: inc.id, action: 'same' })
      continue
    }

    const tBase = updatedAtOf(cur)
    const tInc = updatedAtOf(inc)
    if (tBase !== null && tInc !== null && tBase !== tInc) {
      const winner = tInc > tBase ? inc : cur
      const loser = tInc > tBase ? cur : inc
      stats.updated += 1
      operations.push({
        id: inc.id,
        action: 'update',
        winner,
        loser,
        reason: tInc > tBase ? 'incoming 更新' : 'base 更新',
      })
      continue
    }

    // 时间不可比（缺失或相同）却内容不同 —— 不猜，冲突留档
    stats.conflicts += 1
    operations.push({ id: inc.id, action: 'conflict', winner: cur, loser: inc, reason: '时间不可比' })
    conflicts.push({
      id: inc.id,
      base: cur,
      incoming: inc,
      reason: tBase === null || tInc === null ? 'updatedAt 缺失' : 'updatedAt 相同',
    })
  }

  return { operations, stats, conflicts }
}
