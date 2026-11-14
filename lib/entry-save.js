/**
 * 书阁 · 条目写入（保存 / 编辑）与时间线（2026-11-12 体验改造 P1）。
 *
 * ## 为什么单独成模块
 *
 * 写入逻辑同时被两条路径调用：
 *   ① HTTP `POST /dsh-manuscript/api/entry-save` —— 面板里手写/改一条
 *   ② Agent 工具 `library_save` —— 对话里把「用户明确要存的结论」落库
 * 两条入口必须**同一套校验、同一把锁、同一份返回形状**。写两遍就会漂移：
 * 面板能存空的 claim、工具不能，或者反过来 —— 这类不一致最后都表现为
 * 「用户看到保存成功，但库里是坏的」。
 *
 * ## 边界（不做的事）
 *
 *   · 不自动删除任何条目；编辑只覆盖同 id 那一个文件
 *   · 不改变已有条目的 volume / chapter（除非本来是空的）—— 归册是另一套判断
 *   · 不在本模块里重建内存快照。调用方写完后再刷新，避免模块依赖 ctx.state
 *   · 索引重建失败不否定「条目已写盘」这个事实：返回里如实分开两件事
 */

import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { VOLUME_DEFS } from './library.js'
import { withBuildLock } from './lock.js'
import {
  isMarkdownLibrary,
  readAllLibraryEntries,
  rebuildMarkdownIndex,
  writeMarkdownEntry,
  writeMarkdownEntryFile,
  findMarkdownEntryFile,
  isSafeEntryId,
} from './markdown-library.js'

/** 收件箱。与 library.js / commit.js / markdown-library.js 同一口径。 */
export const INBOX_VOLUME = 'vol-05'

/**
 * 收件箱的默认章。
 *
 * 用 `ch-未分类` 而不是 `ch-inbox`：目录里已有的收件箱条目（由 chapterSpec
 * 归章）就在这一章下。新条目若用 `ch-inbox`，扫描后会多出一个标题为
 * 「inbox」的章 —— 同是收件箱内容却分两处，人找不到。
 */
export const INBOX_CHAPTER = 'ch-未分类'
const INBOX_CHAPTER_TITLE = '未分类'

/** 字段长度上限：与 HTTP body 2MB 上限配合，挡住误贴整段会话。 */
export const SAVE_LIMITS = Object.freeze({ title: 300, claim: 2000, why: 20000 })

function asString(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/** `vol-03` → `VOL.03 册名`；未知 id 原样返回，不编一个假册名。 */
export function volumeDisplayName(id) {
  const def = VOLUME_DEFS.find((v) => v.id === String(id || ''))
  return def ? `${def.no} ${def.name}` : String(id || '')
}

/**
 * 条目的章标题（人读）。
 *
 * 口径与 markdown-library.catalogFromEntries 的 chapterTitleOf 一致：
 * 条目自带的 meta.chapterTitle 最可信（迁移时就记下了），其次收件箱固定文案，
 * 最后才从 slug 推导。不能只写 slug —— UI 会把 `ch-未分类` 原样显示出来。
 */
export function chapterDisplayTitle(entry) {
  const themed = asString(entry?.chapterTitle)
  if (themed) return themed
  const slug = String(entry?.chapter || '')
  if (slug === INBOX_CHAPTER) return INBOX_CHAPTER_TITLE
  return slug.replace(/^ch-/, '') || INBOX_CHAPTER_TITLE
}

/**
 * 校验并规范化保存请求。
 *
 * 有 id 时仍要求 title/claim —— 这是「编辑一条」，不是 PATCH 局部合并；
 * 未传的 why 则保留旧值（见 saveLibraryEntry 的 merge）。
 *
 * @param {object} input
 * @returns {{ok:true, fields:object} | {ok:false, error:string}}
 */
export function normalizeSaveInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'body 必须是 JSON 对象' }
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k)
  const fields = {}

  if (has('id') && input.id !== undefined && input.id !== null) {
    const id = asString(input.id)
    if (!isSafeEntryId(id)) {
      return {
        ok: false,
        error: 'id 含非法字符（只允许字母/数字/._-，最长 64；不能包含 ..，也不能以 . 开头）',
      }
    }
    fields.id = id
  }

  if (!has('title') || typeof input.title !== 'string' || !input.title.trim()) {
    return { ok: false, error: 'title 必须是非空字符串' }
  }
  const title = input.title.trim()
  if (title.length > SAVE_LIMITS.title) {
    return { ok: false, error: `title 过长（上限 ${SAVE_LIMITS.title} 字，收到 ${title.length} 字）` }
  }
  fields.title = title

  if (!has('claim') || typeof input.claim !== 'string' || !input.claim.trim()) {
    return { ok: false, error: 'claim 必须是非空字符串' }
  }
  const claim = input.claim.trim()
  if (claim.length > SAVE_LIMITS.claim) {
    return { ok: false, error: `claim 过长（上限 ${SAVE_LIMITS.claim} 字，收到 ${claim.length} 字）` }
  }
  fields.claim = claim

  // why 可选：不传 = 编辑时保留旧正文；传空串 = 显式清空正文。
  if (has('why') && input.why !== undefined && input.why !== null) {
    if (typeof input.why !== 'string') return { ok: false, error: 'why 必须是字符串' }
    const why = input.why.trim()
    if (why.length > SAVE_LIMITS.why) {
      return { ok: false, error: `why 过长（上限 ${SAVE_LIMITS.why} 字，收到 ${why.length} 字）` }
    }
    fields.why = why
  }

  // tags 可选（HTTP 契约里没有，但 library_save 工具会传）。接受数组或逗号分隔字符串。
  if (has('tags') && input.tags !== undefined && input.tags !== null) {
    const list = Array.isArray(input.tags)
      ? input.tags
      : String(input.tags).split(/[,，、]/)
    const tags = []
    for (const raw of list) {
      if (typeof raw !== 'string') continue
      const tag = raw.trim()
      if (!tag) continue
      if (tag.length > 40) return { ok: false, error: `单个 tag 过长（上限 40 字）：${tag.slice(0, 20)}…` }
      if (!tags.includes(tag)) tags.push(tag)
      if (tags.length > 20) return { ok: false, error: 'tags 过多（上限 20 个）' }
    }
    fields.tags = tags
  }

  return { ok: true, fields }
}

/**
 * 从正文里取一句话摘要（library_save 的 content → claim）。
 *
 * 跳过 Markdown 标题、列表符号与 front-matter 分隔线；第一段正文就是摘要。
 * 超过 120 字截断并加省略号 —— 摘要的用途是「在目录里一眼认出这条」，
 * 不是正文副本。
 */
export function claimFromContent(content) {
  const text = String(content || '')
  const first = text.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l !== '---')
    .map((l) => l.replace(/^[-*+>\s]+/, '').trim())
    .filter(Boolean)[0] || ''
  if (!first) return ''
  return first.length > 120 ? first.slice(0, 118) + '…' : first
}

/**
 * 新条目的 id：`md-` + 标题与内容哈希。
 *
 * 用 sha1 截 12 位而不是随机 id：同一条结论重复保存会落到同一个候选 id，
 * 调用方能看到「它已经存在」而不是悄悄产生两条一模一样的记录。
 * 只有候选 id 已被别的条目占用时才加序号（见 saveLibraryEntry）。
 *
 * @param {{title:string, claim:string, why?:string}} fields
 */
export function computeEntryId(fields) {
  const material = [fields.title, fields.claim, fields.why || ''].join('\n')
  return 'md-' + createHash('sha1').update(material, 'utf8').digest('hex').slice(0, 12)
}

/**
 * 保存 / 编辑一条。整个过程在 `.build.lock` 内完成，写入后重建派生索引。
 *
 * ## 返回形状
 *
 * ```
 * { ok:true, created:boolean, entry:{id,title,claim,why,volume,volumeName,chapter,chapterSlug},
 *   path, relativePath, index:{ok,error} }
 * ```
 * `index.ok === false` 表示条目文件**已经写成功**、但 library.json 因库里有坏条目
 * 而拒绝覆盖（fail-closed）。这是两件事，不能合并成一个 ok:false ——
 * 否则用户会重复保存，把同一条写两遍。
 *
 * @param {string} root 书库根
 * @param {object} input `{id?, title, claim, why?}`
 * @param {{now?:Date}} [opts]
 */
export function saveLibraryEntry(root, input, opts = {}) {
  if (!root) return { ok: false, code: 'no-root', error: '未配置书库根路径' }
  if (!isMarkdownLibrary(root)) {
    return {
      ok: false,
      code: 'not-markdown',
      error: '当前库不是 Markdown 库（storage 不是 markdown），在线保存仅在 Markdown 库可用',
    }
  }
  const norm = normalizeSaveInput(input)
  if (!norm.ok) return { ok: false, code: 'invalid', error: norm.error }
  const fields = norm.fields
  const now = opts.now instanceof Date ? opts.now : new Date()
  const nowIso = now.toISOString()

  const locked = withBuildLock(root, () => {
    const loaded = readAllLibraryEntries(root)
    const existing = fields.id
      ? loaded.entries.find((e) => String(e.id) === fields.id) || null
      : null
    if (fields.id && !existing) {
      return { ok: false, code: 'not-found', error: `未找到条目 ${fields.id}（有 id 即视为编辑；新建请不要传 id）` }
    }

    let entry
    let abs
    if (existing) {
      // 编辑：只覆盖调用方明确给的三个字段，其余（provenance/volume/chapter/
      // confidence/authority/tags/createdAt/status…）原样保留。
      entry = {
        ...existing,
        title: fields.title,
        claim: fields.claim,
        updatedAt: nowIso,
      }
      if (Object.prototype.hasOwnProperty.call(fields, 'why')) entry.why = fields.why
      if (Object.prototype.hasOwnProperty.call(fields, 'tags')) entry.tags = fields.tags
      abs = findMarkdownEntryFile(root, String(entry.id))
      if (!abs) {
        return {
          ok: false,
          code: 'file-missing',
          error: `条目 ${entry.id} 在磁盘上找不到对应文件，拒绝写入（避免产生同 id 的第二份文件）`,
        }
      }
      writeMarkdownEntryFile(abs, entry)
    } else {
      const base = computeEntryId(fields)
      const taken = new Set(loaded.entries.map((e) => String(e.id)))
      let id = base
      let n = 1
      while (taken.has(id)) {
        n += 1
        id = `${base}-${n}`
        if (n > 9999) break
      }
      entry = {
        id,
        title: fields.title,
        claim: fields.claim,
        why: Object.prototype.hasOwnProperty.call(fields, 'why') ? fields.why : '',
        volume: INBOX_VOLUME,
        chapter: INBOX_CHAPTER,
        chapterTitle: INBOX_CHAPTER_TITLE,
        confidence: 'medium',
        authority: 'L2',
        status: 'current',
        handwritten: true,
        tags: fields.tags || [],
        provenance: {},
        createdAt: nowIso,
        updatedAt: nowIso,
      }
      abs = writeMarkdownEntry(root, entry).path
    }

    // 索引重建在锁内：两个并发保存不会各自读到对方的半成品索引。
    // fail-closed 只影响索引文件，条目本身已经原子写成功。
    const rebuilt = rebuildMarkdownIndex(root, { now })
    return {
      ok: true,
      created: !existing,
      entry: {
        id: entry.id,
        title: entry.title,
        claim: entry.claim,
        why: entry.why || '',
        volume: entry.volume,
        volumeName: volumeDisplayName(entry.volume),
        chapter: chapterDisplayTitle(entry),
        chapterSlug: entry.chapter || '',
      },
      path: abs,
      relativePath: relative(root, abs).split(sep).join('/'),
      index: { ok: rebuilt.ok === true, error: rebuilt.ok ? null : rebuilt.error || '索引重建失败' },
    }
  })

  if (locked.skipped) {
    return { ok: false, code: 'locked', error: locked.reason || '另一个写入正在进行，本次保存被跳过' }
  }
  return locked.value
}

/** 时间戳容错：ISO 字符串 / 数字 / Date 都能读，读不出返回 0（= 丢弃）。 */
function timestampOf(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return 0
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : 0
}

function localDateKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 最近 N 天的时间线：按 `updatedAt` 倒序分组到「本地日历日」。
 *
 * ## 为什么用本地日期而不是 UTC
 *
 * 用户看的是「今天/昨天更新了什么」。条目里存的是 UTC ISO 串，直接切前 10 位
 * 会把东八区凌晨 00:00–08:00 的更新记到前一天 —— 那正是夜里干的活最容易
 * 被记错日期的时段。所以按进程本地时区归日。
 *
 * ## 没有 updatedAt 的条目
 *
 * 用文件 mtime 兜底（历史上迁移来的条目、或人手写进来的 Markdown）。
 * 两者都没有就跳过 —— 不拿当前时间假装它「刚刚更新过」。
 *
 * @param {string} root
 * @param {number} days 1–365（调用方已校验/夹取，这里再防一次）
 * @param {Date} [now]
 */
export function buildTimeline(root, days, now = new Date()) {
  if (!root) return { ok: false, error: '未配置书库根路径' }
  const wanted = Number.isFinite(days) ? Math.floor(days) : 30
  if (wanted < 1) return { ok: false, error: 'days 必须是不小于 1 的整数' }
  const windowDays = Math.min(365, wanted)
  const clamped = windowDays !== wanted

  let loaded
  try {
    loaded = readAllLibraryEntries(root)
  } catch (e) {
    return { ok: false, error: `读取书库失败：${e?.message || String(e)}` }
  }

  // 没有 updatedAt 的条目回退文件 mtime。**不能按 `<id>.md` 猜路径**：
  // 手写 Markdown 的 id 由内容派生，文件名和 id 不同（见 findMarkdownEntryFile）。
  const markdown = isMarkdownLibrary(root)

  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (windowDays - 1))
  const cutoff = start.getTime()

  const rows = []
  for (const e of loaded.entries) {
    let t = timestampOf(e.updatedAt)
    if (!t) {
      if (markdown) {
        try {
          const file = findMarkdownEntryFile(root, String(e.id))
          if (file) t = statSync(file).mtimeMs
        } catch {
          t = 0 // 文件不可读/刚被删除：这条没有可信时间，跳过
        }
      } else {
        try {
          t = statSync(join(root, 'entries', String(e.id) + '.json')).mtimeMs
        } catch {
          t = 0
        }
      }
    }
    if (!t || t < cutoff) continue
    rows.push({ t, entry: e })
  }
  rows.sort((a, b) => b.t - a.t)

  const grouped = new Map()
  for (const { t, entry } of rows) {
    const date = localDateKey(new Date(t))
    if (!grouped.has(date)) grouped.set(date, [])
    grouped.get(date).push({
      id: entry.id,
      title: entry.title || '',
      claim: entry.claim || '',
      volumeName: volumeDisplayName(entry.volume),
      chapter: chapterDisplayTitle(entry),
    })
  }

  const list = [...grouped.entries()]
    .map(([date, entries]) => ({ date, entries }))
    .sort((a, b) => b.date.localeCompare(a.date))

  return {
    ok: true,
    days: list,
    entryCount: rows.length,
    windowDays,
    clamped,
    generatedAt: now.toISOString(),
  }
}

/** 供测试/诊断：某条目的实际文件是否存在（不导出也行，保留最小接口）。 */
export function entryFileExists(root, id) {
  return existsSync(findMarkdownEntryFile(root, id) || '')
}
