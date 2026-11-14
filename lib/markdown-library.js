/**
 * 书阁 · Markdown 真相层。
 *
 * ## 第一性判断
 *
 * 从 2026-11-12 起，书库的**真相**是「一条目一个 `.md`」：
 *
 *   <root>/<vol-XX>/<chapter>/<entry-id>.md
 *
 * `library.json` 只是**派生索引** —— 删掉它可以由扫描重建，不会丢一条知识。
 * 这与旧 JSON 库的关系是单向迁移：旧 `entries/*.json` 迁移后被移到 `legacy-json/`，
 * 之后不再参与读写。
 *
 * ## 为什么不用 YAML 库
 *
 * front-matter 只承载「本项目自己写出的」JSON 标量 / 对象：
 *
 *   title: "…"                ← JSON 字符串，也是合法 YAML 标量
 *   provenance: {"session_id":"…"}   ← JSON flow mapping，也是合法 YAML
 *
 * 这样零依赖、可逐行解析、也能被普通 YAML 解析器读。手写的多行 YAML / 锚点不支持，
 * 解析失败会显式报错（见 `markdownHealth`），不静默吞。
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  lstatSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, basename, relative } from 'node:path'
import { writeFileAtomic } from './atomic.js'
import { VOLUME_DEFS } from './library.js'

/** front-matter 里的一等字段（其余统一进 meta）。 */
export const CORE_FIELDS = Object.freeze([
  'id',
  'title',
  'volume',
  'chapter',
  'confidence',
  'authority',
  'claim',
  'why',
  'provenance',
])

/** 不参与条目扫描的 Markdown 文件名（人读的册导览）。 */
const NON_ENTRY_MD = new Set(['MANUAL.md', 'TOC.md', 'README.md', 'INDEX.md'])

const VALID_VOLUMES = new Set(VOLUME_DEFS.map((d) => d.id))

/** 默认收件箱。与 library.js / commit.js / pipeline.js 同一口径。 */
const INBOX_VOLUME = 'vol-05'

/** 单个路径段的安全化：不制造目录穿越、不撞 Windows 保留字符。 */
export function safeSegment(raw, fallback = 'unknown') {
  let s = String(raw ?? '')
    .normalize('NFC')
    // 控制字符 + Windows 非法字符 + 路径分隔符
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
  if (!s) s = fallback
  return s
}

/** 条目 id 是否可安全当文件名。与 commit.js 的 SAFE_ID 同一口径。 */
export function isSafeEntryId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) && !id.includes('..')
}

/** 目录里的一册：`vol-01` 这类。 */
function isVolumeDirName(name) {
  return /^vol-\d{2}$/.test(name)
}

/** 取条目的相对路径（不含根）。 */
export function entryRelativePath(entry) {
  if (!entry || !isSafeEntryId(entry.id)) {
    throw new Error(`条目 id 不能作为文件名：${entry?.id ?? '(空)'}`)
  }
  const volume = VALID_VOLUMES.has(String(entry.volume || '').trim())
    ? String(entry.volume).trim()
    : INBOX_VOLUME
  const chapter = safeSegment(entry.chapter || 'ch-inbox', 'ch-inbox')
  return join(volume, chapter, entry.id + '.md')
}

// ── front-matter 读写 ──────────────────────────────────────────────────────

function jsonString(v) {
  return JSON.stringify(v == null ? '' : String(v))
}

function parseValue(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  // 我们只写 JSON 形状。先试 JSON；失败再退化为裸字符串（兼容手写简单值）。
  try {
    return JSON.parse(text)
  } catch {
    return text.replace(/^"(.*)"$/, '$1')
  }
}

/**
 * 解析 `---` front-matter。只支持「一行一个 key: value」。
 * @param {string} text
 * @returns {{fields:object, body:string}}
 */
export function parseFrontMatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  // 2026-11-12：图书馆面向人 —— 允许直接扔进来的普通 Markdown（没有 front-matter），
  // 这时整篇当正文，id/title/claim 由文件名与正文推导（见 markdownToEntry）。
  if (!m) return { fields: {}, body: src }
  const fields = {}
  for (const [i, line] of m[1].split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) throw new Error(`front-matter 第 ${i + 1} 行无法解析（缺 key:）`)
    const key = line.slice(0, idx).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      throw new Error(`front-matter 第 ${i + 1} 行 key 非法：${key}`)
    }
    fields[key] = parseValue(line.slice(idx + 1))
  }
  return { fields, body: src.slice(m[0].length) }
}

/**
 * 条目对象 → Markdown 文本（front-matter 为准，正文只是人读副本）。
 * @param {object} entry
 * @returns {string}
 */
export function entryToMarkdown(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('entry 不是对象')
  if (!isSafeEntryId(entry.id)) throw new Error(`条目 id 非法：${entry?.id ?? '(空)'}`)
  const meta = {}
  for (const [k, v] of Object.entries(entry)) {
    if (CORE_FIELDS.includes(k)) continue
    if (v === undefined) continue
    meta[k] = v
  }
  const lines = [
    '---',
    `id: ${jsonString(entry.id)}`,
    `title: ${jsonString(entry.title || '')}`,
    `volume: ${jsonString(entry.volume || INBOX_VOLUME)}`,
    `chapter: ${jsonString(entry.chapter || 'ch-inbox')}`,
    `confidence: ${jsonString(entry.confidence || 'medium')}`,
    `authority: ${jsonString(entry.authority || 'L2')}`,
    `claim: ${jsonString(entry.claim || '')}`,
    `why: ${jsonString(entry.why || '')}`,
    `provenance: ${JSON.stringify(entry.provenance && typeof entry.provenance === 'object' ? entry.provenance : {})}`,
    `meta: ${JSON.stringify(meta)}`,
    '---',
    '',
    `# ${entry.title || '(无标题)'}`,
    '',
    String(entry.claim || '').trim(),
    '',
  ]
  const why = String(entry.why || '').trim()
  if (why) {
    lines.push('> Why: ' + why.split(/\r?\n/).join('\n> '), '')
  }
  return lines.join('\n')
}

/**
 * Markdown 文本 → 条目对象。
 * @param {string} text
 * @param {string} [file] 用于错误信息
 * @returns {object}
 */
export function markdownToEntry(text, file = '') {
  const { fields, body } = parseFrontMatter(text)
  const meta = fields.meta && typeof fields.meta === 'object' && !Array.isArray(fields.meta)
    ? fields.meta
    : {}
  const entry = { ...meta }
  for (const k of CORE_FIELDS) {
    if (fields[k] !== undefined) entry[k] = fields[k]
  }
  // 手写 Markdown：front-matter 可选。缺 id/title 时从文件名与首个标题推导，
  // 正文首段当 claim；并在条目上持久化 `handwritten: true`。这样索引、UI 与
  // manual_trace 能区分「人手写的」与「LLM 提炼的」——两者可信度口径不同。
  const handMade = !entry.id || typeof entry.title !== 'string' || !entry.title.trim()
  if (handMade) {
    const rel = String(file || '').trim()
    const base = rel.split(/[\\/]/).pop() || 'untitled.md'
    const stem = base.replace(/\.md$/i, '').trim() || 'untitled'
    const heading = (body.match(/^\s*#\s+(.+?)\s*$/m) || [])[1]
    if (!entry.title || !String(entry.title).trim()) {
      entry.title = (heading && heading.trim()) || stem
    }
    if (!entry.id) {
      entry.id = 'md-' + createHash('sha1').update(rel || stem).digest('hex').slice(0, 12)
    }
    // 空文件 / 只有空白：不是「一条手写经验」，是坏文件。跳过并计数，不猜内容。
    if (!body.trim() && !String(entry.claim || '').trim()) {
      throw new Error('空 Markdown 文件（没有正文，也没有 front-matter 内容）')
    }
    if (!entry.claim || !String(entry.claim).trim()) {
      const paragraphs = body.split(/\r?\n/).map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.replace(/^[-*>+\s]+/, '').trim())
        .filter(Boolean)
      const first = paragraphs[0] || stem
      entry.claim = first.length > 120 ? first.slice(0, 118) + '…' : first
      if (!entry.why || !String(entry.why).trim()) {
        entry.why = paragraphs.slice(1).join('\n').trim() || body.trim()
      }
    }
    entry.handwritten = true
  }
  delete entry.__mdHandWritten
  if (!isSafeEntryId(entry.id)) throw new Error(`front-matter id 非法：${entry.id}`)
  if (!entry.volume || !VALID_VOLUMES.has(String(entry.volume).trim())) {
    // 不拒绝旧条目：归到收件箱，并留下可核对的事实，而不是静默改字段。
    entry.volume = INBOX_VOLUME
    entry.__mdVolumeFallback = true
  }
  if (!entry.chapter) {
    entry.chapter = 'ch-inbox'
    entry.__mdChapterFallback = true
  }
  if (!entry.provenance || typeof entry.provenance !== 'object' || Array.isArray(entry.provenance)) {
    entry.provenance = {}
  }
  if (entry.confidence == null) entry.confidence = 'medium'
  if (entry.authority == null) entry.authority = 'L2'
  if (entry.claim == null) entry.claim = ''
  if (entry.why == null) entry.why = ''
  return entry
}

/** 原子写一条 MD。**调用方负责加锁**（批量入册 / 迁移）。 */
export function writeMarkdownEntry(root, entry) {
  const rel = entryRelativePath(entry)
  const abs = join(root, rel)
  writeFileAtomic(abs, entryToMarkdown(entry))
  return { path: abs, relativePath: rel }
}

/**
 * 按条目 id 找到它**实际所在的** Markdown 文件。
 *
 * 【为什么不能只按 `<id>.md` 猜路径】手写进库的普通 Markdown（没有 front-matter）
 * 的 id 是从**文件名**派生的（见 markdownToEntry），但文件名与派生 id 并不同名 ——
 * 例如 `笔记/双排针.md` 的 id 是 `md-<hash>`。编辑这类条目时若按 id 拼路径，
 * 会写到另一个新文件里，旧文件仍在，扫描时立刻变成 `md-duplicate-id`。
 * 所以先走同名的快路径，找不到再解析候选文件比对 id。
 *
 * @param {string} root
 * @param {string} id
 * @returns {string|null} 绝对路径；找不到返回 null
 */
export function findMarkdownEntryFile(root, id) {
  if (!isSafeEntryId(id)) return null
  const files = listMarkdownFiles(root)
  const direct = files.find((f) => basename(f) === id + '.md')
  if (direct) return direct
  for (const file of files) {
    try {
      if (markdownToEntry(readFileSync(file, 'utf8'), file).id === id) return file
    } catch {
      // 坏文件跳过：它由体检报出，不该让「按 id 定位」整体失败
    }
  }
  return null
}

/**
 * 原子写一个**已定位**的 Markdown 文件（编辑既有条目用）。
 * 与 writeMarkdownEntry 的区别：路径由调用方给出，不按 volume/chapter 重新推导 ——
 * 否则编辑一条散放在库根的手写文档时，会把它复制到 vol-XX/ 下而留下旧文件
 * （同一 id 两份文件 = 扫描立刻报 md-duplicate-id）。
 *
 * @param {string} absPath
 * @param {object} entry
 */
export function writeMarkdownEntryFile(absPath, entry) {
  writeFileAtomic(absPath, entryToMarkdown(entry))
  return { path: absPath }
}

// ── 扫描 ───────────────────────────────────────────────────────────────────

function listDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 枚举库根下所有候选条目文件。
 *
 * 只下钻 `vol-XX/`（最多 3 层），跳过 `legacy-json/`、`volumes/`、`runs/`、
 * `snapshots/`、`archive/`、`models/` 与所有点目录 —— 既避免误扫，也避免
 * 把 26MB 的模型目录拖进遍历。
 *
 * @param {string} root
 * @returns {string[]} 绝对路径
 */
export function listMarkdownFiles(root) {
  const out = []
  const walk = (dir, depth) => {
    for (const ent of listDir(dir)) {
      if (ent.name.startsWith('.')) continue
      const full = join(dir, ent.name)
      let isDir = ent.isDirectory()
      let isFile = ent.isFile()
      if (ent.isSymbolicLink()) {
        // 不跟随目录符号链接（防止扫到库外）；文件符号链接按普通文件读
        try {
          const st = lstatSync(full)
          isDir = false
          isFile = st.isFile()
        } catch {
          continue
        }
      }
      if (isDir) {
        if (depth < 2) walk(full, depth + 1)
      } else if (isFile && ent.name.endsWith('.md') && !NON_ENTRY_MD.has(ent.name)) {
        out.push(full)
      }
    }
  }
  if (!root || !existsSync(root)) return []
  // 2026-11-12：图书馆面向人 —— 不再只认 vol-XX/ 这一种命名。
  // 库根下任何目录（跳过运行态目录）与库根下的 .md 都算候选，方便直接扔说明书进来。
  const SKIP_DIRS = new Set(['legacy-json', 'volumes', 'runs', 'snapshots', 'archive', 'models', '.state', 'node_modules'])
  for (const ent of listDir(root)) {
    if (ent.name.startsWith('.')) continue
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      walk(join(root, ent.name), 0)
    } else if (ent.isFile() && ent.name.endsWith('.md') && !NON_ENTRY_MD.has(ent.name)) {
      out.push(join(root, ent.name))
    }
  }
  return out.sort()
}

/**
 * 扫描全部 Markdown 条目。
 *
 * @param {string} root
 * @returns {{
 *   entries: object[], errors: {file:string, code:string, message:string}[],
 *   warnings: {file:string, code:string, message:string}[], files:string[]
 * }}
 */
export function readAllMarkdownEntries(root) {
  const files = listMarkdownFiles(root)
  const entries = []
  const errors = []
  const warnings = []
  const seen = new Map()
  for (const file of files) {
    let entry
    try {
      entry = markdownToEntry(readFileSync(file, 'utf8'), file)
    } catch (e) {
      errors.push({
        file: relative(root, file) || basename(file),
        code: 'md-unparsable',
        message: e?.message || String(e),
      })
      continue
    }
    if (seen.has(entry.id)) {
      errors.push({
        file: relative(root, file) || basename(file),
        code: 'md-duplicate-id',
        message: `id ${entry.id} 重复（另一份：${seen.get(entry.id)}）`,
      })
      continue
    }
    seen.set(entry.id, relative(root, file) || basename(file))
    if (entry.__mdVolumeFallback) {
      warnings.push({
        file: relative(root, file) || basename(file),
        code: 'md-volume-fallback',
        message: `volume 缺失或非法，按收件箱 ${INBOX_VOLUME} 处理`,
      })
      delete entry.__mdVolumeFallback
    }
    if (entry.__mdChapterFallback) {
      warnings.push({
        file: relative(root, file) || basename(file),
        code: 'md-chapter-fallback',
        message: 'chapter 缺失，按 ch-inbox 处理',
      })
      delete entry.__mdChapterFallback
    }
    entries.push(entry)
  }
  entries.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return { entries, errors, warnings, files }
}

// ── 派生索引 ───────────────────────────────────────────────────────────────

function humanizeChapter(slug) {
  return String(slug || '')
    .replace(/^ch-/, '')
    .replace(/[-_]+/g, ' ')
    .trim() || '未分类'
}

function chapterTitleOf(items, slug) {
  const prebuilt = items.find((e) => e.prebuilt && e.prebuiltChapter)
  if (prebuilt) return prebuilt.prebuiltChapter
  const themed = items.find((e) => e.chapterTitle)
  if (themed) return themed.chapterTitle
  return humanizeChapter(slug)
}

/**
 * 从条目集合重建总账（library 对象）。纯函数，不碰磁盘。
 *
 * 保留 baseLibrary 里的会话统计字段（total/real/stages 等）——
 * Markdown 只存条目，不知道「总共扫了多少会话」；这些数字迁移前记在旧索引里，
 * 不能因为换存储就编一个新值。
 *
 * @param {object[]} entries
 * @param {object|null} [baseLibrary]
 * @param {Date} [now]
 * @returns {object}
 */
export function catalogFromEntries(entries, baseLibrary = null, now = new Date()) {
  const list = Array.isArray(entries) ? entries : []
  const visible = list.filter((e) => e && e.status !== 'expired')
  const counts = { ...(baseLibrary?.counts || {}) }
  counts.entries = list.length
  counts.retired = list.filter((e) => e?.status === 'expired').length
  // 旧索引缺这些字段时给一个可解释的兜底；不把「不知道」伪装成精确统计。
  if (!Number.isFinite(counts.total)) counts.total = list.length
  if (!Number.isFinite(counts.real)) counts.real = list.length
  if (!Number.isFinite(counts.archived)) counts.archived = list.length

  const byVolume = {}
  for (const e of list) {
    const v = String(e?.volume || INBOX_VOLUME)
    byVolume[v] = (byVolume[v] || 0) + 1
  }

  const volumes = VOLUME_DEFS.map((def) => {
    const all = list.filter((e) => String(e?.volume || '') === def.id)
    const vis = all.filter((e) => e?.status !== 'expired')
    const chapterMap = new Map()
    for (const e of vis) {
      const slug = e.chapter || 'ch-inbox'
      if (!chapterMap.has(slug)) chapterMap.set(slug, [])
      chapterMap.get(slug).push(e)
    }
    const chapters = [...chapterMap.entries()]
      .map(([slug, items]) => ({
        slug,
        title: chapterTitleOf(items, slug),
        prebuilt: items.some((e) => e.prebuilt),
        entries: items
          .slice()
          .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0))
          .map((e) => ({
            id: e.id,
            title: e.title,
            claim: e.claim,
            confidence: e.confidence,
            authority: e.authority,
            hits: e.hits || 0,
            needsReview: !!e.needsReview,
            prebuilt: !!e.prebuilt,
            sessionAt: e.sessionAt || null,
            evidence: e.evidence || null,
            provenance: e.provenance || null,
            volumeFallback: e.volumeFallback === true,
            handwritten: e.handwritten === true,
          })),
      }))
      .sort((a, b) => {
        if (a.prebuilt !== b.prebuilt) return a.prebuilt ? -1 : 1
        return b.entries.length - a.entries.length || a.slug.localeCompare(b.slug)
      })

    const recent = all.reduce((acc, e) => {
      const t = e.sessionAt || e.provenance?.timestamp
      if (!t) return acc
      return !acc || t > acc ? t : acc
    }, null)

    return {
      ...def,
      chapters: chapters.length,
      chapterList: chapters,
      entries: vis.length,
      recent: recent || null,
    }
  })

  return {
    ...(baseLibrary && typeof baseLibrary === 'object' ? baseLibrary : {}),
    version: 1,
    generatedAt: now.toISOString(),
    counts,
    byVolume,
    volumes,
  }
}

/** 读 library.json；不存在/损坏返回 null。 */
export function readLibraryJsonSafe(root) {
  const p = join(root, 'library.json')
  if (!existsSync(p)) return null
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'))
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/**
 * 是不是 Markdown 库？
 *
 * 判据：索引声明 `storage: "markdown"`；索引缺失/损坏时，只要存在
 * `vol-XX/**\/*.md` 也按 MD 库处理（索引可重建，不能因为缺索引就拒读）。
 * 如果索引明确是旧 JSON 结构（有 volumes/counts、无 storage），判 false。
 *
 * @param {string} root
 * @returns {boolean}
 */
export function isMarkdownLibrary(root) {
  if (!root || !existsSync(root)) return false
  const lib = readLibraryJsonSafe(root)
  if (lib) {
    if (lib.storage === 'markdown') return true
    if (Array.isArray(lib.volumes) || lib.counts) return false
  }
  return listMarkdownFiles(root).length > 0
}

/**
 * 扫描 Markdown 库并产出内存快照（不写盘）。
 *
 * @param {string} root
 * @param {{now?: Date}} [opts]
 */
export function scanMarkdownLibrary(root, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date()
  const loaded = readAllMarkdownEntries(root)
  // 迁移时需要把旧 library.json 的会话统计带进新索引；调用方通过 baseLibrary 传入。
  const base = opts.baseLibrary && typeof opts.baseLibrary === 'object'
    ? opts.baseLibrary
    : readLibraryJsonSafe(root)
  const library = catalogFromEntries(loaded.entries, base, now)
  library.storage = 'markdown'
  return {
    root,
    entries: loaded.entries,
    library,
    errors: loaded.errors,
    warnings: loaded.warnings,
    files: loaded.files,
  }
}

/**
 * 扫描并原子写回派生索引。
 *
 * fail-closed：存在无法解析/重复 id 的条目时**不覆盖** library.json ——
 * 否则一次坏写入会把「有多少条」的参照物也弄坏。
 *
 * @param {string} root
 * @param {{now?: Date}} [opts]
 */
export function rebuildMarkdownIndex(root, opts = {}) {
  const scan = scanMarkdownLibrary(root, opts)
  const hardErrors = scan.errors.filter((e) => e.code === 'md-unparsable' || e.code === 'md-duplicate-id')
  if (hardErrors.length > 0) {
    return {
      ok: false,
      error: `有 ${hardErrors.length} 个条目无法解析，拒绝覆盖索引`,
      errors: hardErrors,
      warnings: scan.warnings,
      entries: scan.entries.length,
    }
  }
  const library = {
    ...scan.library,
    storage: 'markdown',
    mdIndexedAt: new Date().toISOString(),
  }
  writeFileAtomic(join(root, 'library.json'), JSON.stringify(library, null, 2) + '\n')
  return {
    ok: true,
    library,
    entries: scan.entries.length,
    volumes: library.volumes.filter((v) => v.entries > 0).length,
    errors: scan.errors,
    warnings: scan.warnings,
  }
}

// ── 统一读写入口（MD / 旧 JSON 自动分支） ─────────────────────────────────

/**
 * 读库里的全部条目。MD 模式扫 MD；JSON 模式读 `entries/*.json`。
 *
 * @param {string} root
 * @returns {{entries:object[], errors:{file:string,code:string,message:string}[], storage:'markdown'|'json'}}
 */
export function readAllLibraryEntries(root) {
  if (isMarkdownLibrary(root)) {
    const r = readAllMarkdownEntries(root)
    return { entries: r.entries, errors: r.errors, storage: 'markdown' }
  }
  const entries = []
  const errors = []
  const dir = join(root, 'entries')
  let names = []
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  } catch {
    names = []
  }
  for (const name of names) {
    try {
      const e = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (!e || typeof e !== 'object' || !e.id) {
        errors.push({ file: name, code: 'entry-invalid', message: '缺少 id' })
        continue
      }
      entries.push(e)
    } catch (e) {
      errors.push({ file: name, code: 'entry-unparsable', message: e?.message || String(e) })
    }
  }
  return { entries, errors, storage: 'json' }
}

/**
 * 按 id 读一条条目。找不到返回 null；坏文件抛错由调用方决定怎么报。
 * @param {string} root
 * @param {string} id
 * @returns {object|null}
 */
export function getLibraryEntry(root, id) {
  if (!isSafeEntryId(id)) return null
  if (isMarkdownLibrary(root)) {
    // 用 findMarkdownEntryFile 而不是 `basename === id+'.md'`：
    // 手写文档的 id 由内容/文件名派生，文件名可能完全不等于 id。
    const hit = findMarkdownEntryFile(root, id)
    if (!hit) return null
    return markdownToEntry(readFileSync(hit, 'utf8'), hit)
  }
  const p = join(root, 'entries', id + '.json')
  if (!existsSync(p)) return null
  const e = JSON.parse(readFileSync(p, 'utf8'))
  return e && typeof e === 'object' ? e : null
}

// ── 体检 ───────────────────────────────────────────────────────────────────

function issue(code, severity, detail, fixable = false) {
  return { code, severity, detail, fixable }
}

/**
 * Markdown 库的体检。返回形状与 `health.js` 的 `checkLibraryHealth` 一致，
 * 这样调用方（插件启动、/summary、UI）不需要分支。
 *
 * @param {string} root
 */
export function markdownHealth(root) {
  const scan = scanMarkdownLibrary(root)
  const lib = readLibraryJsonSafe(root)
  const facts = {
    storage: 'markdown',
    libraryJsonExists: existsSync(join(root, 'library.json')),
    libraryJsonParsable: !!lib,
    declaredEntries: Number.isFinite(lib?.counts?.entries) ? lib.counts.entries : 0,
    actualEntryFiles: scan.entries.length,
    mdEntries: scan.entries.length,
    volumesOnDisk: 0,
    uncatalogedEntries: 0,
    damagedEntries: 0,
    retiredEntries: scan.entries.filter((e) => e.status === 'expired').length,
    parseErrors: scan.errors.length,
    warnings: scan.warnings.length,
    legacyEntriesDir: existsSync(join(root, 'entries')),
  }
  const issues = []

  if (!facts.libraryJsonExists) {
    issues.push(issue('library-index-missing', 'warn', 'library.json 不存在；索引可由扫描 Markdown 重建'))
  } else if (!facts.libraryJsonParsable) {
    issues.push(issue('library-unparsable', 'error', 'library.json 无法解析（可删除后由扫描重建）'))
  } else if (lib.storage !== 'markdown') {
    issues.push(issue('library-storage-mismatch', 'warn', `library.json 的 storage=${lib.storage ?? '(缺)'}，按 Markdown 库处理`))
  }

  if (scan.errors.length > 0) {
    const sample = scan.errors.slice(0, 10).map((e) => `${e.file}（${e.message}）`).join('；')
    issues.push(issue('md-unparsable', 'error', `${scan.errors.length} 个 Markdown 条目无法解析：${sample}`))
  }
  if (scan.warnings.length > 0) {
    const sample = scan.warnings.slice(0, 10).map((e) => `${e.file}（${e.message}）`).join('；')
    issues.push(issue('md-warning', 'warn', `${scan.warnings.length} 条条目字段降级：${sample}`))
  }
  if (facts.libraryJsonParsable && facts.declaredEntries !== facts.actualEntryFiles) {
    issues.push(issue(
      'entry-count-mismatch',
      'warn',
      `library.json 声明 ${facts.declaredEntries} 条，Markdown 实际 ${facts.actualEntryFiles} 条（索引可重建）`
    ))
  }

  // 目录可见性：chapterList 里的 id 是否覆盖所有未退役条目。
  if (facts.libraryJsonParsable) {
    const catalog = new Set()
    for (const v of Array.isArray(lib.volumes) ? lib.volumes : []) {
      for (const c of Array.isArray(v?.chapterList) ? v.chapterList : []) {
        for (const e of Array.isArray(c?.entries) ? c.entries : []) {
          if (e?.id != null) catalog.add(String(e.id))
        }
      }
    }
    let uncataloged = 0
    for (const e of scan.entries) {
      if (e.status === 'expired') continue
      if (!catalog.has(String(e.id))) uncataloged += 1
    }
    facts.uncatalogedEntries = uncataloged
    if (uncataloged > 0) {
      issues.push(issue(
        'entry-not-in-catalog',
        'warn',
        `${uncataloged} 条 Markdown 条目不在索引目录里（索引过期，可重建）`
      ))
    }
  }

  if (facts.legacyEntriesDir) {
    issues.push(issue(
      'legacy-json-present',
      'warn',
      '库根下仍有 entries/（旧 JSON 真相层）；迁移后应移入 legacy-json/，避免两个真相源'
    ))
  }

  // 册数：有内容的册目录数。空册不建目录是允许的。
  const vols = new Set(scan.entries.map((e) => String(e.volume)))
  facts.volumesOnDisk = [...vols].filter((v) => existsSync(join(root, v))).length

  let level = 'healthy'
  if (issues.some((i) => i.severity === 'error')) level = 'broken'
  else if (issues.length > 0) level = 'warn'
  return { ok: level !== 'broken', level, issues, facts }
}
