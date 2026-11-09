/**
 * 提炼状态的**负面事实**持久化：哪些会话失败过、哪些会话空产出过。
 *
 * ## 为什么需要这个文件（2026-11-07 实测事故）
 *
 * `state.failedSids` 原本是纯内存 `Map`，全代码库**没有任何落盘路径**
 * （grep `failedSids` 17 处命中，含 writeFile/JSON.stringify 的 0 处）。
 *
 * 后果链条：
 *   ① 某会话提炼失败 → failedSids +1
 *   ② 进程重启 → Map 清空
 *   ③ 「连续失败 3 次就跳过」这条退避规则**永远达不到 3**
 *   ④ 它会一轮又一轮地被选中、又一轮又一轮地失败
 *
 * 实测证据：`97e79a95` / `c9cf952a` / `0ca91d35` 三个会话在
 * 2026-11-06 05:07 与 05:33 连续两次整批失败，**16 小时后仍站在队列
 * 第 8、9、10 名**。退避机制形同虚设。
 *
 * ## 为什么不落盘"已提炼"
 *
 * 「已提炼过」这个正面事实**本来就在磁盘上** —— 每条提炼产出的条目都带
 * `provenance.session_id` 与 `distilled: true`，`restoreDistilledSids()`
 * 就是这么反推的。再存一份 positive 状态 = 制造两个真相源，迟早不一致。
 *
 * 所以本模块**只存负面事实**（失败计数 + 空产出），它们无法从条目反推：
 *   · 失败的会话没有条目，反推不出
 *   · 空产出的会话也没条目，反推不出
 * 两者都是「无从证明为真」的事件，只能显式记录。
 *
 * ## 为什么叫「负面」而不是「状态」
 *
 * 命名即约束。任何人想往这里塞 `distilled: true` 时应该先问：
 * 这个事实能不能从 entries/ 反推？能，就不该写在这里。
 *
 * ## 存放位置
 *
 * `<root>/distill-state.json` —— 与 library.json 同级。
 * 不用 runs/ ：runs 是**不可变凭证目录**（历史文件不迁移不删除），
 * 而本文件是**可变的当前状态**，混在一起会让"凭证"的语义变模糊。
 *
 * 零依赖，只用 node:fs / node:path。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic.js'
import { MAX_CONSECUTIVE_FAILURES, MAX_EMPTY_YIELDS } from './limits.js'

// 阈值只有一个真相源（limits.js）；这里转发是为了让状态模块能自洽地解释自己的数据。
export { MAX_CONSECUTIVE_FAILURES, MAX_EMPTY_YIELDS } from './limits.js'

/** 状态文件名。改这个名字等于迁移，需同步 health 的检查项。 */
export const STATE_FILENAME = 'distill-state.json'

/** 状态文件 schema 版本。读到更高版本时拒绝解释（宁可不用，不要误用）。 */
export const STATE_VERSION = 1

/**
 * 空产出连续多少次后跳过。
 *
 * **为什么要跳过空产出**（这是 2026-11-07 新加的，此前完全没有这个概念）：
 *
 * 实测 29 轮有 `marked` 字段的 distill 报告：queue 580 / marked 182，
 * 68.6% 的会话跑了却没被标记。其中 **15 轮 failures=0 却仍有 184 个会话
 * 未标记** —— 这些不是"失败了"，是"模型看完觉得没啥可提炼，返回了空数组"。
 *
 * 旧逻辑（index.js ④）：
 *   `if (!b.proposals) continue`  → 不标记 → 下轮重新选中 → 再空一次
 * 于是这些会话在队首反复空转，把它们挤掉的名额正是本可以提炼的新会话。
 *
 * 阈值取 2 而不是 1：模型偶尔（一次）觉得某会话没料是正常的，
 * 两次都这么认为就足够可信了 —— 比"一次就判死刑"稳，比"无限重试"省。
 */
/** 空状态：两个表都空。 */
function emptyState() {
  return {
    version: STATE_VERSION,
    /** sid -> 连续失败次数 */
    failedSids: {},
    /** sid -> 连续空产出次数 */
    emptySids: {},
    /** sid -> 连续"产出全被单条淘汰"次数（与 empty 区分：那是模型没守格式，不是会话没料） */
    rejectedSids: {},
    /** sid -> 在多会话批里失败的累计次数（弱信号，阈值更高，见 MAX_SUSPECTED_FAILURES） */
    suspectSids: {},
    updatedAt: null,
  }
}

/**
 * 读状态文件。**任何异常都退化为空状态，绝不抛错**。
 *
 * 理由：状态文件是**优化**（省钱的退避），不是**正确性**依赖。
 * 它损坏时最坏的后果是"多提炼几轮"，而抛错会让整个提炼功能不可用。
 * 但退化要留痕 —— 返回值里带 `_degraded` 说明为什么，调用方可决定是否告警。
 *
 * @param {string} root 书库根
 * @returns {{version:number, failedSids:Record<string,number>, emptySids:Record<string,number>,
 *            updatedAt:string|null, _degraded?:string}}
 */
export function readState(root) {
  if (!root) return { ...emptyState(), _degraded: 'root 缺失' }
  const p = join(root, STATE_FILENAME)
  if (!existsSync(p)) return emptyState()

  let raw
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e) {
    return { ...emptyState(), _degraded: `读失败: ${e?.message || e}` }
  }

  let obj
  try {
    obj = JSON.parse(raw)
  } catch (e) {
    // 坏 JSON：不静默重建（那会掩盖一次写坏的事实），标 degraded 让上层知道
    return { ...emptyState(), _degraded: `JSON 损坏: ${e?.message || e}` }
  }

  if (Array.isArray(obj)) {
    // 数组能通过 `typeof === 'object'` 检查 —— 这是 JS 的经典陷阱。
    // 若不显式挡掉，下面 `obj.failedSids` 全是 undefined，会被静默当成
    // "状态是空的"，于是一次类型错误伪装成"一切正常"。
    return { ...emptyState(), _degraded: '顶层是数组而非对象' }
  }
  if (!obj || typeof obj !== 'object') {
    return { ...emptyState(), _degraded: '顶层不是对象' }
  }
  // 未来版本的 schema：拒绝解释。误读比不读更危险（字段语义可能已变）。
  if (Number.isFinite(obj.version) && obj.version > STATE_VERSION) {
    return { ...emptyState(), _degraded: `schema 版本 ${obj.version} 高于本程序支持的 ${STATE_VERSION}` }
  }

  return {
    version: STATE_VERSION,
    failedSids: sanitizeCounts(obj.failedSids),
    emptySids: sanitizeCounts(obj.emptySids),
    // 旧文件没有这个键 → 空表，等价于"没有会话被淘汰过"，向后兼容
    rejectedSids: sanitizeCounts(obj.rejectedSids),
    // 多会话批失败（弱信号）—— 旧文件没有这个键 → 空表
    suspectSids: sanitizeCounts(obj.suspectSids),
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : null,
  }
}

/**
 * 清洗计数表：只保留 `非空字符串 sid -> 正整数`。
 *
 * 为什么要清洗而不是直接信任：手改、旧版本写入、并发写坏都可能留下
 * `{"x": "3"}` / `{"x": -1}` / `{"x": null}`。这些进了 selectQueue 会让
 * `Number.isFinite` 判断出意外结果（字符串 "3" 不是 finite → 当成 0 次失败
 * → 退避永远不生效，且**静默**）。
 *
 * @param {unknown} obj
 * @returns {Record<string, number>}
 */
function sanitizeCounts(obj) {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k !== 'string' || !k) continue
    if (!Number.isFinite(v)) continue
    const n = Math.floor(v)
    if (n <= 0) continue
    out[k] = n
  }
  return out
}

/**
 * 写状态文件。原子写，失败时**抛错**（调用方决定是否吞掉）。
 *
 * 注意与 readState 的策略不同：读失败可以退化，**写失败必须让调用方知道**。
 * 静默的写失败会让「退了避」变成幻觉 —— 用户以为系统记住了，其实没有，
 * 这正是本次要修的那个 bug 的形态。
 *
 * @param {string} root
 * @param {{failedSids?:Record<string,number>|Map<string,number>,
 *          emptySids?:Record<string,number>|Map<string,number>,
 *          rejectedSids?:Record<string,number>|Map<string,number>,
 *          suspectSids?:Record<string,number>|Map<string,number>}} state
 * @param {Date} [now]
 * @returns {string} 写入的路径
 */
export function writeState(root, state, now = new Date()) {
  if (!root) throw new Error('[distill-state] writeState 需要 root')
  const payload = {
    version: STATE_VERSION,
    failedSids: toPlainCounts(state?.failedSids),
    emptySids: toPlainCounts(state?.emptySids),
    rejectedSids: toPlainCounts(state?.rejectedSids),
    suspectSids: toPlainCounts(state?.suspectSids),
    updatedAt: now.toISOString(),
  }
  const p = join(root, STATE_FILENAME)
  writeFileAtomic(p, JSON.stringify(payload, null, 2))
  return p
}

/** Map / 普通对象 → 干净的普通对象。空值被丢弃，保证文件不膨胀。 */
function toPlainCounts(v) {
  const out = {}
  if (!v) return out
  const entries = typeof v.forEach === 'function' && typeof v.get === 'function'
    ? (() => { const a = []; v.forEach((val, k) => a.push([k, val])); return a })()
    : Object.entries(v)
  for (const [k, val] of entries) {
    if (typeof k !== 'string' || !k) continue
    if (!Number.isFinite(val)) continue
    const n = Math.floor(val)
    if (n <= 0) continue
    out[k] = n
  }
  return out
}

/**
 * 把本轮的失败/空产出并进已有状态，**返回新状态对象**（不改入参）。
 *
 * 语义（每条都有实测依据）：
 *   · 失败 → 对应 sid 计数 +1
 *   · 空产出 → 对应 sid 计数 +1
 *   · **成功产出** → 两个计数都清零（它已证明能被提炼，不该再被退避）
 *
 * 最后一条是关键：没有它，一个曾经失败 2 次、第 3 次成功的会话会永远
 * 带着 2 的计数，再失败一次就被永久隔离。成功必须能洗白历史。
 *
 * @param {object} prev readState() 的返回值
 * @param {{failures?:object[], emptySids?:string[], yieldedSids?:string[]}} delta
 * @returns {{failedSids:Record<string,number>, emptySids:Record<string,number>}}
 */
export function mergeState(prev, delta = {}) {
  const failed = { ...sanitizeCounts(prev?.failedSids) }
  const empty = { ...sanitizeCounts(prev?.emptySids) }

  // ① 失败 +1
  for (const f of Array.isArray(delta.failures) ? delta.failures : []) {
    for (const sid of f?.sids || []) {
      if (!sid) continue
      failed[sid] = (failed[sid] || 0) + 1
    }
  }

  // ② 空产出 +1
  for (const sid of Array.isArray(delta.emptySids) ? delta.emptySids : []) {
    if (!sid) continue
    empty[sid] = (empty[sid] || 0) + 1
  }

  // ③ 成功产出 → 双向清零
  for (const sid of Array.isArray(delta.yieldedSids) ? delta.yieldedSids : []) {
    if (!sid) continue
    delete failed[sid]
    delete empty[sid]
  }

  return { failedSids: failed, emptySids: empty }
}

/**
 * 从历史 runs/ 报告**反推**失败计数。
 *
 * ## 为什么需要这个（迁移用）
 *
 * 状态文件是 2026-11-07 才有的。在此之前的 61 轮 distill 已经积累了真实的
 * 失败历史，全躺在 `runs/distill-*.json` 的 `failures[].sids` 里。
 * 不迁移的话，新机制从零开始，那些"卡了 3 次"的会话还要再卡 3 次。
 *
 * ## 为什么不把它当常态数据源
 *
 * runs/ 是**不可变凭证**，只增不改，所以它比状态文件更"真"，但：
 *   · 它是流水账，随时间无限增长（本机已 365 个文件），不能每轮都全量扫
 *   · 它记的是「哪一轮失败过」，不含「成功了没有」——无法洗白
 * 所以只作为**一次性迁移**的输入，迁移完以状态文件为准。
 *
 * ## 只计最近 N 轮的失败
 *
 * 太久远的失败不该一直压着一个会话（它可能只是当时模型抽风）。
 * 但**默认值必须覆盖全部历史**（2026-11-07 实测修正）：
 *
 *   本机 61 份 distill 报告里，
 *     maxRuns=30  → 只扫到 33 个失败过的会话，达 3 次的 4 个
 *     maxRuns=100 → 扫到 70 个失败过的会话，达 3 次的 9 个
 *   差了一倍。原因很简单：报告是**交错写入**的（早期文件时间戳更早但
 *   排序靠前），「最近 30 份」并不等于「失败的最近 30 次」。
 *
 * 迁移只在首次运行发生一次，全量扫的成本可忽略（61 个文件约 100ms）。
 * 所以默认 INFINITE_RUNS_SCAN = 全部。真要限制时显式传 maxRuns。
 *
 * @param {string} root
 * @param {{maxRuns?:number}} [opts]
 * @returns {{failedSids:Record<string,number>, scanned:number, skipped:number}}
 */
export function rebuildFromRuns(root, opts = {}) {
  const maxRuns = Number.isFinite(opts.maxRuns) ? Math.max(1, Math.floor(opts.maxRuns)) : Infinity
  const out = { failedSids: {}, scanned: 0, skipped: 0 }
  if (!root) return out
  const dir = join(root, 'runs')
  if (!existsSync(dir)) return out

  let files
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return out
  }

  const reports = []
  for (const f of files) {
    let j
    try {
      j = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      out.skipped += 1
      continue
    }
    if (!j || j.kind !== 'distill') continue
    reports.push(j)
  }

  // 按开始时间升序，取最近 maxRuns 轮（默认全部）
  reports.sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')))
  const recent = Number.isFinite(maxRuns) ? reports.slice(-maxRuns) : reports

  for (const j of recent) {
    out.scanned += 1
    for (const f of Array.isArray(j.failures) ? j.failures : []) {
      for (const sid of f?.sids || []) {
        if (!sid) continue
        out.failedSids[sid] = (out.failedSids[sid] || 0) + 1
      }
    }
  }
  return out
}

/**
 * 人话解释某个 sid 为什么被退避（给 UI / 日志用）。
 * 查不到返回 null —— 「没被退避」和「不知道为什么」必须能区分。
 *
 * @param {object} state readState() 的返回值
 * @param {string} sid
 * @returns {{kind:'failed'|'empty', count:number, limit:number, text:string}|null}
 */
export function explainSkip(state, sid) {
  if (!state || !sid) return null
  const f = Number.isFinite(state.failedSids?.[sid]) ? state.failedSids[sid] : 0
  const e = Number.isFinite(state.emptySids?.[sid]) ? state.emptySids[sid] : 0
  if (f >= MAX_CONSECUTIVE_FAILURES) {
    return { kind: 'failed', count: f, limit: MAX_CONSECUTIVE_FAILURES, text: `连续失败 ${f} 次，已跳过` }
  }
  if (e >= MAX_EMPTY_YIELDS) {
    return { kind: 'empty', count: e, limit: MAX_EMPTY_YIELDS, text: `连续 ${e} 次没提炼出内容，已跳过` }
  }
  return null
}
