/**
 * 向量索引：增量构建、持久化、余弦检索、RRF 融合（2026-11-12）。
 *
 * ## 设计约束（都来自真实事故，不是风格偏好）
 *
 * 1. **可降级**：向量不可用 / 索引没建好 / provider 报错时，检索必须继续
 *    返回关键词+词频路的结果，**绝不能抛错**。`manual_recall` 抛一次，
 *    整轮对话就断了 —— 这与插件里 `agent/pre-step` 必须容错是同一条纪律。
 * 2. **增量**：条目文本没变就复用旧向量（hash 相同），只嵌新增/改动的条目。
 *    全量重嵌 321 条约 1.3s，看似不贵；但它发生在**每次扫描之后**，
 *    而扫描是定时触发的 —— 不增量就是周期性白烧 CPU。
 * 3. **按条目校验**：检索时逐条比对「当前条目 hash == 索引里的 hash」，
 *    不匹配就跳过这一条。索引陈旧时最坏是少召回几条，绝不会拿旧向量
 *    去代表新文本（那会让相似度看起来正常、实际指向另一段内容）。
 * 4. **持久化到库根** `vectors.json`：与 entries/ 同生命周期，删库即删索引；
 *    换机器时索引随库一起拷走，换模型时靠 fingerprint 自动失效重建。
 *
 * ## 为什么是 RRF 而不是「余弦定阈值 + 直接按余弦排」
 *
 * 关键词分（整数、无上界）与余弦（0–1）量纲不同，直接相加是伪科学。
 * RRF 只用**排名**，天然可比。权重上限保证关键词永远在纯语义项之前
 * （见 `fuseRanked` 的注释），这是既有产品承诺：改个说法不该把精确命中挤下去。
 *
 * 单独的绝对阈值（`minCos`）仍然保留 —— RRF 只解决排序，解决不了
 * 「这条到底相不相关」；负控必须靠阈值挡在门外（实测见 embed.js 注释）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeFileAtomic } from './atomic.js'
import { discoverEmbeddingProvider } from './embed.js'

/** 索引文件名（库根下）。 */
export const VECTOR_INDEX_FILE = 'vectors.json'
/** 索引格式版本：结构变了就 +1，旧索引会被忽略并重建。 */
export const VECTOR_INDEX_VERSION = 1

/** RRF 的平滑常数（业界常用 60）。 */
export const RRF_K = 60

/** 各类来源的权重。关键词必须显著高于语义，见 fuseRanked 注释。 */
export const RRF_WEIGHTS = Object.freeze({ keyword: 1, vector: 0.5, tfidf: 0.45 })

/** provider 缺失时重新探测的间隔（用户可能中途往 models/ 里放权重）。 */
const REDISCOVER_MS = 10 * 60 * 1000

/** 查询向量缓存大小（同一轮里 repeat 查询很常见）。 */
const QUERY_CACHE_MAX = 64

export function vectorEntryText(e) {
  return `${String(e?.title || '')}\n${String(e?.claim || '')}`.trim()
}

export function vectorEntryHash(e) {
  return createHash('sha256').update(vectorEntryText(e)).digest('hex').slice(0, 16)
}

function encodeVector(f32) {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64')
}

function decodeVector(b64) {
  const buf = Buffer.from(b64, 'base64')
  const copy = new Uint8Array(buf.length)
  copy.set(buf)
  return new Float32Array(copy.buffer, 0, copy.length / 4)
}

/**
 * 读 `vectors.json`。不存在/损坏/版本不符 → null（调用方据此重建）。
 * **不抛错**：索引是加速器，不是正确性依赖。
 */
export function loadVectorIndex(root) {
  const p = join(root, VECTOR_INDEX_FILE)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    if (!raw || raw.version !== VECTOR_INDEX_VERSION) return null
    if (!raw.provider || !raw.entries || typeof raw.entries !== 'object') return null
    const entries = new Map()
    for (const [id, rec] of Object.entries(raw.entries)) {
      if (!rec || typeof rec.h !== 'string' || typeof rec.v !== 'string') continue
      const vec = decodeVector(rec.v)
      if (vec.length === 0) continue
      entries.set(id, { h: rec.h, v: vec })
    }
    return {
      version: raw.version,
      provider: raw.provider,
      builtAt: Number(raw.builtAt) || 0,
      entries,
      bytes: Buffer.byteLength(JSON.stringify(raw)),
    }
  } catch {
    return null
  }
}

/** 原子写索引。返回写入字节数；失败抛（由 store 决定吞不吞）。 */
export function saveVectorIndex(root, index) {
  const plain = {
    version: VECTOR_INDEX_VERSION,
    provider: index.provider,
    builtAt: index.builtAt,
    entries: {},
  }
  for (const [id, rec] of index.entries) plain.entries[id] = { h: rec.h, v: encodeVector(rec.v) }
  const text = JSON.stringify(plain)
  writeFileAtomic(join(root, VECTOR_INDEX_FILE), text)
  return Buffer.byteLength(text)
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/**
 * 从 snapshot 收集要嵌入的条目（调用方已按 `isRecallPolluted` 过滤）。
 * @returns {{id:string,text:string,hash:string,entry:object,volumeName:string,chapterTitle:string,volumeId:string,skeleton:boolean}[]}
 */
export function collectVectorDocs(snapshot, { filterEntry, isSkeleton } = {}) {
  const docs = []
  for (const v of snapshot?.summary?.volumes || []) {
    for (const c of v.chapters || []) {
      for (const e of c.entries || []) {
        if (!e?.id) continue
        if (typeof filterEntry === 'function' && filterEntry(e)) continue
        const text = vectorEntryText(e)
        if (!text) continue
        docs.push({
          id: e.id,
          text,
          hash: vectorEntryHash(e),
          entry: e,
          volumeName: v.no + ' ' + v.name,
          chapterTitle: c.title,
          volumeId: v.id,
          skeleton: typeof isSkeleton === 'function' ? !!isSkeleton(e) : false,
        })
      }
    }
  }
  return docs
}

/**
 * RRF 融合（Reciprocal Rank Fusion）。
 *
 * `lists` 里每一路是 `{name, weight, hits}`，hits 按该路自己的相关性从高到低。
 * 每个条目得分 = Σ weight / (K + rank)。按 id 去重，来源记在 `sources`。
 *
 * **为什么权重上限要在 0.5**：关键词路最差的名次（rank=topK-1）贡献
 * `1/(60+topK-1)`；语义路最好名次贡献 `w/(60+0)`。只有 `w < 60/(60+topK-1)`
 * 时才能保证「关键词命中永远排在纯语义项之前」。topK 上限 50 时该比值 0.545，
 * 所以 0.5 是安全上限 —— 改这个值等于改产品承诺，必须同步改测试。
 *
 * @param {{name:string,weight:number,hits:object[]}[]} lists
 * @param {{topK?:number}} [opts]
 */
export function fuseRanked(lists, opts = {}) {
  const topK = Number.isFinite(opts.topK) && opts.topK > 0 ? Math.floor(opts.topK) : 8
  const byId = new Map()
  for (const list of lists) {
    const weight = Number.isFinite(list?.weight) ? list.weight : 1
    const hits = Array.isArray(list?.hits) ? list.hits : []
    hits.forEach((h, rank) => {
      if (!h || !h.id) return
      const add = weight / (RRF_K + rank + 1)
      const cur = byId.get(h.id)
      if (cur) {
        cur.rrf += add
        if (!cur.sources.includes(list.name)) cur.sources.push(list.name)
        // 关键词项的分值/标签优先保留，别被语义项覆盖
        if (list.name === 'keyword') {
          cur.score = h.score
          cur.matchHits = h.matchHits
          cur.match = 'keyword'
        } else if (!cur.match) {
          cur.match = h.match || 'semantic'
        }
        if (!cur.semanticScore && h.semanticScore) cur.semanticScore = h.semanticScore
      } else {
        byId.set(h.id, {
          ...h,
          rrf: add,
          sources: [list.name],
          match: list.name === 'keyword' ? 'keyword' : h.match || 'semantic',
        })
      }
    })
  }
  const out = [...byId.values()]
  out.sort((a, b) => b.rrf - a.rrf)
  return out.slice(0, topK)
}

/**
 * 向量库。惰性发现 provider、按需建索引、查询走缓存。
 */
export function createVectorStore(opts = {}) {
  const root = opts.root
  const logger = opts.logger
  const env = opts.env || process.env
  const now = opts.now || (() => Date.now())
  /** 允许注入（测试用）：给了就不再探测真实环境。 */
  const injectedProvider = opts.provider === undefined ? undefined : opts.provider
  const filterEntry = opts.filterEntry
  const isSkeleton = opts.isSkeleton

  let provider = injectedProvider
  let providerResolved = injectedProvider !== undefined
  let lastDiscoverAt = 0
  let index = null
  let indexLoaded = false
  let building = null
  let lastError = null
  let lastBuildMs = 0
  let lastReused = 0
  const queryCache = new Map()

  function nowMs() {
    return now()
  }

  function getProvider() {
    if (providerResolved) return provider
    const ts = nowMs()
    if (ts - lastDiscoverAt < REDISCOVER_MS) return provider
    lastDiscoverAt = ts
    providerResolved = true
    try {
      provider = discoverEmbeddingProvider({ root, env, logger })
      if (provider) {
        logger?.info?.('[dsh-manuscript] 向量召回启用：%s（%s）', provider.model, provider.id)
      }
    } catch (e) {
      provider = null
      lastError = `provider 发现失败: ${e?.message || e}`
      logger?.warn?.('[dsh-manuscript] embedding provider 发现失败（降级为关键词检索）：%s', lastError)
    }
    return provider
  }

  function loadOnce() {
    if (indexLoaded) return index
    indexLoaded = true
    index = loadVectorIndex(root)
    return index
  }

  /** 当前语料与索引是否仍然对得上（provider 指纹 + 每个 id 的 hash）。 */
  function isFresh(indexObj, docs, prov) {
    if (!indexObj || !prov) return false
    if (!indexObj.provider || indexObj.provider.fingerprint !== prov.fingerprint) return false
    if (indexObj.provider.dim && prov.dim && indexObj.provider.dim !== prov.dim) return false
    if (indexObj.entries.size === 0 && docs.length > 0) return false
    for (const d of docs) {
      const rec = indexObj.entries.get(d.id)
      if (!rec || rec.h !== d.hash) return false
    }
    // 索引里多出来的条目（已删除）不算 dirty：检索时按 snapshot 查表，多出来的用不到。
    return true
  }

  async function build(snapshot) {
    const prov = getProvider()
    if (!prov) return null
    const docs = collectVectorDocs(snapshot, { filterEntry, isSkeleton })
    if (docs.length === 0) return null
    const started = nowMs()
    const existing = loadOnce()
    const sameModel = existing && existing.provider?.fingerprint === prov.fingerprint
    const nextEntries = new Map()
    const todo = []
    let reused = 0
    for (const d of docs) {
      const rec = sameModel ? existing.entries.get(d.id) : null
      if (rec && rec.h === d.hash && rec.v.length === (prov.dim || rec.v.length)) {
        nextEntries.set(d.id, rec)
        reused += 1
      } else {
        todo.push(d)
      }
    }

    if (todo.length > 0) {
      // 分批交给 provider；一个批次失败不让整份索引归零 —— 已成功的部分照常落盘。
      const vectors = []
      let failed = 0
      for (let i = 0; i < todo.length; i += prov.maxBatch || 24) {
        const batch = todo.slice(i, i + (prov.maxBatch || 24))
        try {
          const vs = await prov.embed(batch.map((d) => d.text))
          if (vs.length !== batch.length) throw new Error('返回条数不符')
          vectors.push(...vs)
          for (let j = 0; j < batch.length; j++) nextEntries.set(batch[j].id, { h: batch[j].hash, v: vs[j] })
        } catch (e) {
          failed += batch.length
          lastError = `embedding 失败: ${e?.message || e}`
          logger?.warn?.('[dsh-manuscript] embedding 失败（本批 %d 条跳过，检索继续用关键词）：%s', batch.length, lastError)
        }
      }
      if (failed === todo.length && nextEntries.size === 0) {
        // 一条都没成功：不要把空索引写进库根（否则下次还得全量重建）
        throw new Error(lastError || 'embedding 全部失败')
      }
    }

    const dim = prov.dim || (nextEntries.values().next().value?.v?.length ?? 0)
    const next = {
      version: VECTOR_INDEX_VERSION,
      provider: {
        id: prov.id,
        model: prov.model,
        dim,
        fingerprint: prov.fingerprint,
        minCos: prov.minCos,
      },
      builtAt: nowMs(),
      entries: nextEntries,
    }
    let bytes = 0
    try {
      bytes = saveVectorIndex(root, next)
    } catch (e) {
      lastError = `索引落盘失败: ${e?.message || e}`
      logger?.warn?.('[dsh-manuscript] vectors.json 落盘失败（本次索引只在内存生效）：%s', lastError)
    }
    next.bytes = bytes
    index = next
    indexLoaded = true
    lastBuildMs = nowMs() - started
    lastReused = reused
    logger?.info?.(
      '[dsh-manuscript] 向量索引就绪：%d 条（复用 %d，新嵌 %d），%d 维，%d ms，%s KB',
      next.entries.size, reused, next.entries.size - reused, dim, lastBuildMs, Math.round(bytes / 1024),
    )
    return next
  }

  const store = {
    get root() {
      return root
    },
    get provider() {
      return providerResolved ? provider : null
    },
    get ready() {
      return !!(index && index.entries.size > 0)
    },
    get lastError() {
      return lastError
    },

    /** 同步取状态（给 UI/日志/测试）。 */
    stats(snapshot) {
      const prov = providerResolved ? provider : null
      const idx = indexLoaded ? index : null
      const docs = snapshot ? collectVectorDocs(snapshot, { filterEntry, isSkeleton }) : []
      return {
        enabled: !!prov,
        provider: prov ? { id: prov.id, model: prov.model, dim: prov.dim || 0, minCos: prov.minCos } : null,
        indexed: idx ? idx.entries.size : 0,
        docs: docs.length,
        bytes: idx ? idx.bytes || 0 : 0,
        dim: idx ? idx.provider?.dim || 0 : 0,
        builtAt: idx ? idx.builtAt : 0,
        buildMs: lastBuildMs,
        reused: lastReused,
        fresh: isFresh(idx, docs, prov),
        lastError,
      }
    },

    /** 不等待：扫描完成后调用，后台把索引补齐。 */
    kick(snapshot) {
      if (!root || !snapshot) return null
      if (!getProvider()) return null
      const docs = collectVectorDocs(snapshot, { filterEntry, isSkeleton })
      if (isFresh(loadOnce(), docs, getProvider())) return null
      if (building) return building
      building = Promise.resolve()
        .then(() => build(snapshot))
        .catch((e) => {
          lastError = `索引构建失败: ${e?.message || e}`
          logger?.warn?.('[dsh-manuscript] 向量索引构建失败（检索降级为关键词）：%s', lastError)
          return null
        })
        .finally(() => {
          building = null
        })
      return building
    },

    /** 等待索引就绪（测试/诊断用；生产热路径不要 await）。 */
    async ensure(snapshot) {
      const p = store.kick(snapshot)
      if (p) await p.catch(() => {})
      return index
    },

    /**
     * 同步检索：查询向量走 provider.embedSync（仅 llama CLI 支持）。
     * **任何异常都吞掉并返回 []** —— 调用方必须能继续走关键词路。
     */
    searchSync(snapshot, query, topK = 8, opts = {}) {
      const prov = getProvider()
      if (!prov) return []
      const idx = loadOnce()
      if (!idx || idx.entries.size === 0) return []
      const q = String(query || '')
      if (!q.trim()) return []
      const minCos = Number.isFinite(opts.minCos) ? opts.minCos : Number(idx.provider?.minCos ?? prov.minCos)
      let qv = queryCache.get(q)
      if (!qv) {
        try {
          const vs = prov.embedSync([q])
          if (!vs || vs.length !== 1) throw new Error('查询向量为空')
          qv = vs[0]
          queryCache.set(q, qv)
          if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value)
        } catch (e) {
          lastError = `查询嵌入失败: ${e?.message || e}`
          logger?.debug?.('[dsh-manuscript] 查询嵌入失败（本次走关键词）：%s', lastError)
          return []
        }
      }
      return searchVectorIndex(snapshot, idx, qv, { topK, minCos, isSkeleton })
    },

    /** 异步检索（工具面用；可以不阻塞事件循环）。 */
    async search(snapshot, query, topK = 8, opts = {}) {
      const prov = getProvider()
      if (!prov) return []
      const idx = loadOnce()
      if (!idx || idx.entries.size === 0) return []
      const q = String(query || '')
      if (!q.trim()) return []
      const minCos = Number.isFinite(opts.minCos) ? opts.minCos : Number(idx.provider?.minCos ?? prov.minCos)
      let qv = queryCache.get(q)
      if (!qv) {
        try {
          const vs = await prov.embed([q])
          if (!vs || vs.length !== 1) throw new Error('查询向量为空')
          qv = vs[0]
          queryCache.set(q, qv)
          if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value)
        } catch (e) {
          lastError = `查询嵌入失败: ${e?.message || e}`
          return []
        }
      }
      return searchVectorIndex(snapshot, idx, qv, { topK, minCos, isSkeleton })
    },
  }
  return store
}

/**
 * 在已加载的索引上做余弦检索。
 *
 * 逐条校验 hash：索引与当前 snapshot 不同步时，只跳过对不上的条目 —— 不整份作废，
 * 也不拿旧向量冒充新文本。这是「降级要局部化」的具体做法。
 */
export function searchVectorIndex(snapshot, index, qvec, opts = {}) {
  const topK = Number.isFinite(opts.topK) && opts.topK > 0 ? Math.floor(opts.topK) : 8
  const minCos = Number.isFinite(opts.minCos) ? opts.minCos : 0.62
  const isSkeleton = opts.isSkeleton
  if (!index?.entries || !qvec) return []
  const scored = []
  for (const v of snapshot?.summary?.volumes || []) {
    for (const c of v.chapters || []) {
      for (const e of c.entries || []) {
        if (!e?.id) continue
        const rec = index.entries.get(e.id)
        if (!rec) continue
        if (rec.h !== vectorEntryHash(e)) continue // 文本变过：这条不参与
        const cos = cosine(qvec, rec.v)
        if (!Number.isFinite(cos) || cos < minCos) continue
        scored.push({
          ...e,
          score: Number(cos.toFixed(3)),
          semanticScore: cos,
          match: 'semantic',
          semanticKind: 'vector',
          skeleton: typeof isSkeleton === 'function' ? !!isSkeleton(e) : false,
          volumeName: v.no + ' ' + v.name,
          chapterTitle: c.title,
          volumeId: v.id,
        })
      }
    }
  }
  scored.sort(
    (a, b) => Number(!!a.skeleton) - Number(!!b.skeleton) || b.semanticScore - a.semanticScore,
  )
  return scored.slice(0, topK)
}
