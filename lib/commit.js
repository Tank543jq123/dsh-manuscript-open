/**
 * 把已裁决的条目真正写进书库（T1 链路的最后一环）。
 *
 * ## 为什么不复用 buildLibrary
 *
 * `buildLibrary` 的职责是"扫会话 → 派生条目 → 全量重建"。它的输入是会话，
 * 输出是整套书库。而这里要做的是**增量追加**：已经有 209 条了，现在把
 * 裁决通过的 3 条加进去，不能动其余 206 条。
 *
 * 用 buildLibrary 会很危险：它会重新扫描、重新派生、重新分配 ID，
 * 已有人工修正过的条目可能被覆盖。
 *
 * ## 安全性设计
 *
 * 1. **只追加，不删除**。任何情况下都不移除已有条目。
 * 2. **同一条内容只入册一次**：按内容指纹判重（见 `contentHash`）。
 *    真正的 ID 冲突（同 id、内容不同）才加后缀避让，不覆盖已有条目。
 * 3. **原子写**：复用 `atomic.js` 的 `writeFileAtomic`，写一半崩了不会留半文件。
 * 4. **写完立刻更新 library.json**，保证 declared 与 actual 一致
 *    （这是 `health.js` 的核心判据）。
 * 5. **同一时刻只允许一个写入**（复用建库锁）。
 */

import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { writeFileAtomic } from './atomic.js'
import { withBuildLock } from './lock.js'
import { defaultLibraryRoot } from './library.js'
import { deviceId } from './identity.js'
import {
  isMarkdownLibrary,
  readAllMarkdownEntries,
  writeMarkdownEntry,
  rebuildMarkdownIndex,
} from './markdown-library.js'

/**
 * 条目必须有归属册 —— 没有册的条目会变成"孤儿"：
 * 文件写在盘上、计入 counts.entries，但不在任何册的 chapterList 里，
 * 于是目录翻不到、manual_recall 查不到，而 health 只比计数也发现不了。
 *
 * 【2026-11-02 实测事故】就是这么产生了 7 条孤儿，且重建也救不回来
 * （重建走"幂等保留"分支，孤儿既不被删也不被归册，差额永远是 7）。
 *
 * 所以这里兜底：没给 volume 就进收件箱，宁可放错册，不可制造看不见的条目。
 * 与 pipeline.js 的 `if (!volume) volume = 'vol-05'` 保持同一口径。
 */
const INBOX_VOLUME = 'vol-05'

/** 给条目补上归属册（缺省进收件箱）。不修改入参，返回新对象。 */
function ensureVolume(entry) {
  const v = entry?.volume
  if (v != null && String(v).trim() !== '') return entry
  return { ...entry, volume: INBOX_VOLUME, needsReview: true }
}

/**
 * 读取当前书库的总账。损坏时返回 null（调用方决定怎么办）。
 * @param {string} root
 */
export function readLibraryJson(root) {
  const p = join(root, 'library.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 让 ID 在目录里唯一。冲突就加 `-2`、`-3`…
 * @param {string} root
 * @param {string} id
 */
function sanitizeId(raw) {
  // `\w` 只认 ASCII。纯中文的 id（或标题）会被清洗成空串，
  // 而空串拼出来的文件名就是 `.json` —— 一个隐藏文件：写进库、计入 counts，
  // 但 `ls` 看不见、人工清理时也不会注意到。所以这里**允许**返回空串，
  // 由调用方改用内容派生 id，绝不把空串交给文件名。
  return String(raw ?? '').replace(/[^\w.-]/g, '')
}

/**
 * 从条目内容派生一个确定性 id。
 *
 * 为什么不是 `e-unknown`：那样所有中文条目标题都会撞到同一个 id，
 * 只能靠 `-2`/`-3` 后缀区分，重跑一次就换一批 id —— 幂等性直接没了。
 * 用内容哈希则同一条内容永远得到同一个 id。
 *
 * @param {object} entry
 * @returns {string} 形如 `e-1a2b3c4d5e6f`
 */
function contentHash(entry) {
  return createHash('sha256')
    .update(['volume', 'chapter', 'title', 'claim'].map((k) => String(entry?.[k] ?? '').trim()).join('\u0000'))
    .digest('hex')
}

function deriveId(entry) {
  return 'e-' + contentHash(entry).slice(0, 12)
}

/** 一个"能直接用"的显式 id 的形状：ASCII、字母数字开头、≤64 字符。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/**
 * Windows 保留设备名。
 *
 * 【为什么在 Linux 上也要管】`CON.json` 在 Windows 上仍然是设备名 ——
 * 带扩展名也不行，写入会直接失败（EPERM/不存在的设备）。这个项目的主要
 * 使用场景就是 Windows，而 id 来自 LLM 提案，什么都可能出现。
 */
const RESERVED_ID = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 判断调用方给的 id 能不能直接当文件名用。
 *
 * 【2026-11-08】此前只处理了"清洗后为空"这一种情况，实测仍有三种能写出坏文件：
 *   · `.hidden`   → 生成 `entries/.hidden.json`（隐藏文件：ls 看不见、人工清理也漏）
 *   · `..`        → 生成 `entries/...json`
 *   · 200 个字符  → 文件名超过 NAME_MAX，在部分文件系统上直接失败
 *   · `CON`       → Windows 保留设备名，写不进去
 * 这几种一律**改用内容派生 id**，而不是拒绝入册：内容本身是合法的，
 * 坏的是调用方随手给的名字。
 *
 * @param {unknown} raw
 * @returns {string} 可安全使用的 id，或 ''（表示"另想办法"）
 */
function safeExplicitId(raw) {
  const s = sanitizeId(raw)
  if (!s) return ''
  if (!SAFE_ID.test(s)) return ''
  if (RESERVED_ID.test(s)) return ''
  return s
}

/**
 * 入册前的最小校验。
 *
 * 为什么必须校验：这是**唯一**写盘口，进来什么就写什么。
 * 实测喂一条 `{ title: '缺字段' }` 曾写出 `entries/.json` —— 空 id 条目进了库，
 * counts 也对得上，从外面完全看不出异常。
 *
 * 只校验"没有它就构不成一条经验"的字段：标题（能不能被翻到）与 claim（说了什么）。
 * `volume` 不在此列 —— 缺失由 `ensureVolume()` 归进收件箱，这是既有语义。
 *
 * @param {object} entry
 * @returns {string|null} null = 合法；字符串 = 拒绝原因
 */
function validateEntry(entry) {
  const title = typeof entry.title === 'string' ? entry.title.trim() : ''
  if (!title) return '缺 title'
  const claim = typeof entry.claim === 'string' ? entry.claim.trim() : ''
  if (!claim) return '缺 claim'
  return null
}

function uniqueId(root, id) {
  const dir = join(root, 'entries')
  const base = sanitizeId(id) || 'e-unknown'
  let candidate = base
  let n = 1
  while (existsSync(join(dir, candidate + '.json'))) {
    n += 1
    candidate = `${base}-${n}`
    if (n > 9999) break
  }
  return candidate
}

/**
 * Markdown 库的入册：写 `.md` 条目 → 重建派生索引。
 *
 * 与 JSON 分支共享同一套语义：只追加、内容指纹判重、同 id 不同内容加后缀、
 * 缺 volume 进收件箱、写盘前后都受 `.build.lock` 保护。区别只在存储介质。
 *
 * @param {object[]} list
 * @param {{root:string}} opts
 */
function commitEntriesMarkdown(list, opts) {
  const root = opts.root
  const locked = withBuildLock(root, () => {
    const loaded = readAllMarkdownEntries(root)
    const existing = loaded.entries
    const byId = new Map(existing.map((e) => [String(e.id), e]))
    const byFingerprint = new Map()
    for (const e of existing) {
      if (typeof e.title !== 'string' || typeof e.claim !== 'string') continue
      byFingerprint.set(contentHash(e), String(e.id))
    }

    const ids = []
    const duplicates = []
    const rejected = []
    let written = 0
    let skipped = 0

    for (const raw of list) {
      const e = ensureVolume(raw)
      const invalid = validateEntry(e)
      if (invalid) {
        skipped += 1
        rejected.push({ title: typeof e.title === 'string' ? e.title.slice(0, 60) : '', reason: invalid })
        continue
      }
      const fp = contentHash(e)
      const sameContentId = byFingerprint.get(fp)
      if (sameContentId) {
        skipped += 1
        duplicates.push({ title: String(e.title).slice(0, 60), existingId: sameContentId })
        continue
      }
      const explicitId = safeExplicitId(e.id)
      let id = explicitId || deriveId(e)
      let n = 1
      while (byId.has(id)) {
        n += 1
        id = `${explicitId || deriveId(e)}-${n}`
        if (n > 9999) break
      }

      const nowIso = new Date().toISOString()
      const record = {
        ...e,
        id,
        status: e.status || 'current',
        provenance: e.provenance || {},
        committedAt: nowIso,
        updatedAt: nowIso,
        createdAt: e.createdAt || nowIso,
        origin: e.origin && typeof e.origin === 'object' ? e.origin : { device: deviceId() },
      }
      try {
        writeMarkdownEntry(root, record)
      } catch (err) {
        skipped += 1
        rejected.push({
          title: typeof e.title === 'string' ? e.title.slice(0, 60) : '',
          reason: `写 Markdown 失败：${err?.message || String(err)}`,
        })
        continue
      }
      byFingerprint.set(fp, id)
      byId.set(id, record)
      ids.push(id)
      written += 1
    }

    const rebuilt = rebuildMarkdownIndex(root)
    if (!rebuilt.ok) {
      return {
        ok: false,
        written,
        skipped,
        ids,
        rejected,
        duplicates,
        reason: rebuilt.error || '索引重建失败',
      }
    }
    return {
      ok: true,
      written,
      skipped,
      ids,
      rejected,
      duplicates,
      library: rebuilt.library,
    }
  })

  if (locked.skipped) {
    return {
      ok: false,
      written: 0,
      skipped: list.length,
      ids: [],
      reason: locked.reason || '另一个写入正在进行',
    }
  }
  return locked.value
}

/**
 * 把一批已裁决的条目写入书库。
 *
 * @param {object[]} entries 已经过 adjudicate 且通过人工确认的条目
 * @param {object} [opts]
 * @param {string} [opts.root] 书库根
 * @param {object} [opts.library] 预先读好的 library.json（省一次 IO）
 * @returns {{
 *   ok: boolean,
 *   written: number,
 *   skipped: number,
 *   ids: string[],
 *   reason?: string,
 *   library?: object,
 * }}
 */
export function commitEntries(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : []
  if (list.length === 0) {
    return { ok: true, written: 0, skipped: 0, ids: [], reason: '没有要写入的条目' }
  }

  const root = opts.root || defaultLibraryRoot()

  // 【2026-11-12】Markdown 真相层：写 .md + 重建派生索引，走独立分支。
  // 不能落进下面的 JSON 逻辑 —— 那会在共享根里重新造出 entries/，形成两个真相源。
  if (isMarkdownLibrary(root)) return commitEntriesMarkdown(list, { root })

  mkdirSync(join(root, 'entries'), { recursive: true })

  const locked = withBuildLock(root, () => {
    const lib = opts.library || readLibraryJson(root)
    if (!lib) {
      // 总账不存在或损坏 —— **不猜**，明确拒绝。
      // 这种情况下写条目会让"declared vs actual"永远对不上，
      // 而 health.js 会报 broken。正确做法是先让它 rebuild。
      return {
        ok: false,
        written: 0,
        skipped: list.length,
        ids: [],
        reason: 'library.json 缺失或损坏，请先重建书库再入册（避免污染一致性）',
      }
    }

    // 【重要修复 2026-11-02】
    // 不能信任 lib.entries —— 它可能因为历史事故被清空过（实际发生过：
    // 一次清理脚本把 entries 数组写成空数组，而 counts 和磁盘都是对的）。
    // 那样再从这里追加，会得到一个只有几条的数组，覆写回去就把明细弄丢了。
    //
    // 正确做法：**以磁盘为准重建**。磁盘上的 .json 文件是唯一真相，
    // library.json 里的数组只是它的投影。
    const diskIds = []
    try {
      for (const f of readdirSync(join(root, 'entries'))) {
        if (f.endsWith('.json')) diskIds.push(f.slice(0, -5))
      }
    } catch {
      /* 目录不存在时留空 */
    }
    // 【结构真相 2026-11-02】
    // library.json **本来就没有顶层 entries 数组** —— 它的结构是
    //   { version, generatedAt, counts, stages, byVolume, volumes }
    // 条目明细的真相在 entries/ 目录里，总账只存 counts 和 volumes。
    //
    // 我一度以为"entries 数组被清空"是数据损坏，于是"修复"成从磁盘重建数组 ——
    // 那其实是在往文件里塞一个不属于它的字段，而 buildLibrary 每次重建都会
    // 正确地把它移除。真正该改的是这里的依赖方向：**只信磁盘**。
    //
    // 所以下面完全不用 lib.entries，逐文件读。
    const existing = diskIds.map((id) => {
      try {
        return JSON.parse(readFileSync(join(root, 'entries', id + '.json'), 'utf8'))
      } catch {
        return { id }
      }
    })
    const byId = new Map(existing.map((e, i) => [e.id, i]))
    // 内容指纹 → 已有条目 id。用于幂等：同一条内容重复提交不该产生第二条。
    // 只对解析成功的条目建表（解析失败时 we only 有 id，看不出内容）。
    const byFingerprint = new Map()
    for (const e of existing) {
      if (!e || typeof e !== 'object') continue
      if (typeof e.title !== 'string' || typeof e.claim !== 'string') continue
      byFingerprint.set(contentHash(e), e.id)
    }
    const ids = []
    const duplicates = []
    const rejected = []
    let written = 0
    let skipped = 0

    for (const raw of list) {
      // 兜底归属册：没有 volume 的条目一律进收件箱，绝不写入"无册条目"。
      // 这是孤儿问题的源头，必须挡在写入之前。
      const e = ensureVolume(raw)

      // 校验在**写入之前**：非法条目既不写盘、也不占 id。
      const invalid = validateEntry(e)
      if (invalid) {
        skipped += 1
        rejected.push({ title: typeof e.title === 'string' ? e.title.slice(0, 60) : '', reason: invalid })
        continue
      }

      // 幂等：内容完全相同 → 跳过，不制造第二条。
      // 这不是"尽力去重"，而是入册口的承诺：双击、重试、重复投递都只得到一条。
      const fp = contentHash(e)
      const sameContentId = byFingerprint.get(fp)
      if (sameContentId) {
        skipped += 1
        duplicates.push({ title: String(e.title).slice(0, 60), existingId: sameContentId })
        continue
      }

      // id 的三种来源：显式 id > 内容派生 id。
      // 显式 id 全被非 ASCII 吃掉时（纯中文 id）退回内容派生，
      // 否则清洗结果为空会让文件名退化成 `.json`。
      const explicitId = safeExplicitId(e.id)
      const id = uniqueId(root, explicitId || deriveId(e))
      // 再查一次内存里的 id（uniqueId 只查了磁盘）
      if (byId.has(id)) {
        skipped += 1
        continue
      }

      const nowIso = new Date().toISOString()
      const record = {
        ...e,
        id,
        // 入册标记：和"提议"区分开
        status: e.status || 'current',
        // 溯源必须保留，否则以后查不回来
        provenance: e.provenance || {},
        // 入册时间
        committedAt: nowIso,
        // 最后修改时间：多设备同步时判断"谁更新"的唯一依据。
        // （没有它的话，人工改写与另一台设备的旧副本无法区分先后）
        updatedAt: nowIso,
        createdAt: e.createdAt || nowIso,
        // 来源设备：调用方没给就记本机
        origin: e.origin && typeof e.origin === 'object' ? e.origin : { device: deviceId() },
      }

      writeFileAtomic(join(root, 'entries', id + '.json'), JSON.stringify(record, null, 2))
      byFingerprint.set(fp, id)
      byId.set(id, existing.length)
      existing.push(record)
      ids.push(id)
      written += 1
    }

    // 更新总账：entries 数组 + 计数
    // 注意 counts.entries 必须等于磁盘实际文件数，否则 health 报错
    const actualCount = readdirSync(join(root, 'entries')).filter((f) => f.endsWith('.json')).length
    // 只更新 counts.entries —— 不写顶层 entries 数组（那不属于这个文件的结构）
    const newLib = {
      ...lib,
      counts: { ...(lib.counts || {}), entries: actualCount },
      updatedAt: new Date().toISOString(),
    }
    // 总账最后写 —— 它是提交标记
    writeFileAtomic(join(root, 'library.json'), JSON.stringify(newLib, null, 2))

    return { ok: true, written, skipped, ids, rejected, duplicates, library: newLib }
  })

  if (locked.skipped) {
    return {
      ok: false,
      written: 0,
      skipped: list.length,
      ids: [],
      reason: locked.reason || '另一个写入正在进行',
    }
  }
  return locked.value
}
