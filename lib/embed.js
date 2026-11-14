/**
 * 本地 embedding 通道发现与调用（2026-11-12）。
 *
 * ## 为什么要这一层
 *
 * `lib/index.js` 的关键词路（bigram）与词频语义路（字符 2-gram TF-IDF）
 * 都建立在**字面重合**上：用户把「插件装完要重启吗」换成「插件热加载怎么弄」
 * 还能命中，但换成「装了扩展之后还要重开服务吗」就只剩低频 bigram，
 * 而 TF-IDF 路还要求 ≥2 个 bigram 重合 —— 两路一起归零。
 * 向量召回是唯一能把「字面不重合、意思相近」接上的路。
 *
 * ## 本机能力探测结论（2026-11-12，实测命令见交付报告）
 *
 *   · `127.0.0.1:8101` 的 llama-server 是 27B **对话**模型，没开 `--embeddings`，
 *     `/v1/embeddings` 返回 501；8100/8102 未监听。
 *   · 没有 ollama，没有 @xenova/transformers，没有 sentence-transformers / torch；
 *     `~/.cache/huggingface` 只有 3 个对话模型，无 embedding 权重。
 *   · llama.cpp **已编译**（`~/ai/llama.cpp/build-hip|build-vk/bin/llama-embedding`），
 *     缺的只是权重。
 *   · DeepSeek 官方 API 不提供 embeddings 端点（只有 chat/completions），
 *     且它是外网依赖 —— 不符合「优先零外网依赖」。
 *
 * 因此本模块的第一优先级是 **llama.cpp + 本地 GGUF 权重**：推理全程在本机，
 * 运行期零外网。权重缺失时返回 null，检索自动退回关键词/词频两路（见
 * `vectorStore.searchSync` 的 catch），`manual_recall` 不会因此报错。
 *
 * 备选通道：任意 OpenAI 兼容的 `/v1/embeddings`（`DSH_MANUSCRIPT_EMBED_URL`）。
 * **默认只允许回环地址** —— 否则「本地向量」会悄悄变成每轮把手册内容发外网。
 *
 * ## 不做什么
 *
 *   · 不自动下载权重（安装包里没有 26MB 二进制；下载会破坏离线承诺）
 *   · 不在插件启动时拉起常驻服务（进程按需 spawn，用完即退）
 *   · 不把 embedding 失败升级成异常（调用方只看到空数组）
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, cpus } from 'node:os'
import { join } from 'node:path'

/** 一次 CLI 调用最多塞多少条文本（命令行长度与显存/内存都要留余量）。 */
const MAX_BATCH_TEXTS = 128
/** 单次 CLI 调用最多多少字符（Linux ARG_MAX 约 2MB，这里远低于它）。 */
const MAX_BATCH_CHARS = 48000
/** 异步调用的默认超时（毫秒）。321 条实测 ~1.3s；超时说明机器异常，降级即可。 */
export const EMBED_ASYNC_TIMEOUT_MS = 60_000
/** 同步调用的默认超时（毫秒）。只用于查询侧单条文本。 */
export const EMBED_SYNC_TIMEOUT_MS = 20_000

/** llama-embedding 的多条分隔符。用不常见串，避免和正文撞车。 */
const SEP = '<#dsh-manuscript-sep#>'

/** 探测时优先认的权重文件名（其余 .gguf 仍可用，只是排在后面）。 */
const MODEL_NAME_HINT = /(embed|bge|gte|e5|jina|snow|nomic|m3)/i

const DEFAULT_MIN_COS_BY_MODEL = [
  [/bge-small-zh/i, 0.62],
  [/bge-base-zh/i, 0.72],
  [/bge-m3/i, 0.55],
  [/bge-small-en/i, 0.62],
]
const DEFAULT_MIN_COS = 0.65

function cleanText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function sha16(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

function l2normalize(vec) {
  let n = 0
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i]
  n = Math.sqrt(n)
  if (!Number.isFinite(n) || n === 0) return null
  const out = new Float32Array(vec.length)
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n
  return out
}

/** 按条数/字符数切批，避免一条超长 claim 把命令行顶爆。 */
function chunkTexts(texts) {
  const batches = []
  let cur = []
  let chars = 0
  for (const t of texts) {
    const len = t.length
    if (cur.length > 0 && (cur.length >= MAX_BATCH_TEXTS || chars + len > MAX_BATCH_CHARS)) {
      batches.push(cur)
      cur = []
      chars = 0
    }
    cur.push(t)
    chars += len
  }
  if (cur.length > 0) batches.push(cur)
  return batches
}

function isExecutableFile(p) {
  try {
    const st = statSync(p)
    if (!st.isFile()) return false
    // Windows 上 X_OK 不适用；这里只在 POSIX 判权限位
    return process.platform === 'win32' ? true : (st.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** 从 PATH 里找可执行文件（不引第三方 which 依赖）。 */
function findOnPath(binName, env) {
  const path = String(env.PATH || '')
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of path.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir, binName + ext)
      if (isExecutableFile(p)) return p
    }
  }
  return null
}

/** 常见 llama.cpp 构建目录。只是候选，不存在就跳过。 */
function llamaBuildCandidates(env) {
  const home = env.HOME || env.USERPROFILE || homedir()
  const out = [join(home, 'ai', 'llama.cpp'), join(home, 'llama.cpp'), join(home, 'src', 'llama.cpp')]
  const found = []
  for (const base of out) {
    if (!existsSync(base)) continue
    const builds = [base, ...readdirSyncSafe(base).filter((d) => /^build/i.test(d)).map((d) => join(base, d))]
    for (const b of builds) {
      for (const sub of ['bin', join('Release'), '']) {
        const p = join(b, sub, process.platform === 'win32' ? 'llama-embedding.exe' : 'llama-embedding')
        if (isExecutableFile(p)) found.push(p)
      }
    }
  }
  return found
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 找本地 GGUF 权重：显式 env > `<root>/models/` 下名字更像 embedding 的 > 体积最小的。
 *
 * 为什么优先「名字像 embedding 的」而不是最大/最新：models/ 目录是用户自己放权重的地方，
 * 里面可能同时有对话模型。挑错权重不会报错，只会让相似度变成噪声 —— 这是静默失败，
 * 必须在选权重这一步就尽量避开。选不出来时返回 null（宁可不启用）。
 */
export function discoverEmbedModel(root, env = process.env) {
  const explicit = env.DSH_MANUSCRIPT_EMBED_MODEL
  if (explicit) {
    return existsSync(explicit) ? explicit : null
  }
  const dir = join(root, 'models')
  const files = readdirSyncSafe(dir)
    .filter((f) => f.toLowerCase().endsWith('.gguf'))
    .map((f) => {
      const p = join(dir, f)
      let size = Number.MAX_SAFE_INTEGER
      try {
        size = statSync(p).size
      } catch {
        return null
      }
      return { path: p, name: f, size }
    })
    .filter(Boolean)
  if (files.length === 0) return null
  const hinted = files.filter((f) => MODEL_NAME_HINT.test(f.name)).sort((a, b) => a.size - b.size)
  if (hinted.length > 0) return hinted[0].path
  // 没有任何名字线索：只在**只有一个** gguf 时才敢用；多个时无法判断，宁可不启用。
  return files.length === 1 ? files[0].path : null
}

/**
 * llama.cpp CLI provider。
 *
 * 为什么用 CLI 而不是常驻 llama-server：
 *   · 插件不允许在用户机器上偷偷起后台服务/占端口（本机 8100-8102 已被
 *     用户的 llama.cpp 操作台占用，撞端口会把别人的实例搞坏）
 *   · 一次进程 ~0.25–1.5s 的启动成本，对本项目「一问一查」的量级可以接受
 *   · 进程退出即释放内存，不需要守护与清理
 */
function createLlamaProvider({ bin, model, env, logger }) {
  const threads = Math.max(1, Math.min(8, (cpus()?.length || 4) - 1))
  const baseName = model.split(/[\\/]/).pop()
  let dim = 0
  let fingerprint = ''

  try {
    const st = statSync(model)
    fingerprint = sha16(`${baseName}|${st.size}|${Math.round(st.mtimeMs)}|llama-cpp`)
  } catch {
    fingerprint = sha16(`${baseName}|llama-cpp`)
  }

  function argsFor(texts) {
    const joined = texts.map(cleanText).join(SEP)
    return [
      '-m', model,
      '-ngl', '0',
      '--threads', String(threads),
      '--pooling', 'cls',
      '--embd-normalize', '2',
      '--embd-output-format', 'json',
      '--embd-separator', SEP,
      '-p', joined,
    ]
  }

  function parse(stdout, expected) {
    const j = JSON.parse(stdout)
    const data = Array.isArray(j?.data) ? j.data : null
    if (!data || data.length !== expected) {
      throw new Error(`embedding 返回条数不符（期望 ${expected}，实际 ${data ? data.length : '无'}）`)
    }
    const vectors = []
    for (const d of data) {
      const vec = Array.isArray(d?.embedding) ? d.embedding : null
      if (!vec || vec.length === 0) throw new Error('embedding 返回空向量')
      const norm = l2normalize(vec)
      if (!norm) throw new Error('embedding 向量范数为 0')
      if (!dim) dim = norm.length
      if (norm.length !== dim) throw new Error(`embedding 维度不一致（${norm.length} != ${dim}）`)
      vectors.push(norm)
    }
    return vectors
  }

  const provider = {
    id: 'llama-cpp',
    kind: 'llama',
    bin,
    model: baseName,
    get dim() {
      return dim
    },
    get fingerprint() {
      return fingerprint
    },
    get minCos() {
      for (const [re, cos] of DEFAULT_MIN_COS_BY_MODEL) if (re.test(baseName)) return cos
      return Number(env.DSH_MANUSCRIPT_EMBED_MIN_COS) || DEFAULT_MIN_COS
    },
    maxBatch: MAX_BATCH_TEXTS,

    /** 异步批量嵌入。任何失败都抛，由上层决定降级。 */
    async embed(texts) {
      const list = (texts || []).map(cleanText)
      if (list.length === 0) return []
      const out = []
      for (const batch of chunkTexts(list)) {
        const stdout = await new Promise((resolve, reject) => {
          const child = spawn(bin, argsFor(batch), { stdio: ['ignore', 'pipe', 'pipe'] })
          let out = ''
          let err = ''
          let settled = false
          const timer = setTimeout(() => {
            if (settled) return
            settled = true
            try { child.kill('SIGKILL') } catch { /* 已退出 */ }
            reject(new Error(`embedding 超时（${EMBED_ASYNC_TIMEOUT_MS}ms）`))
          }, EMBED_ASYNC_TIMEOUT_MS)
          child.stdout.on('data', (d) => { out += d })
          child.stderr.on('data', (d) => { err += d })
          child.on('error', (e) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(new Error(`无法启动 ${bin}：${e.message}`))
          })
          child.on('close', (code) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (code !== 0) return reject(new Error(`llama-embedding 退出码 ${code}：${err.slice(-300)}`))
            resolve(out)
          })
        })
        out.push(...parse(stdout, batch.length))
      }
      logger?.debug?.('[dsh-manuscript] embedding %d 条（%s）', list.length, baseName)
      return out
    },

    /**
     * 同步版：只给首轮预取用（`buildPrefetchDecision` 是同步纯函数，不能改签名）。
     * 单条查询 ~0.3s，阻塞的是事件循环 —— 所以**只允许单条**，且超时更短。
     */
    embedSync(texts) {
      const list = (texts || []).map(cleanText)
      if (list.length === 0) return []
      const out = []
      for (const batch of chunkTexts(list)) {
        if (batch.length > 1) throw new Error('embedSync 只允许单条文本')
        const r = spawnSync(bin, argsFor(batch), {
          encoding: 'utf8',
          timeout: EMBED_SYNC_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
        })
        if (r.error) throw r.error
        if (r.status !== 0) throw new Error(`llama-embedding 退出码 ${r.status}：${String(r.stderr || '').slice(-300)}`)
        out.push(...parse(r.stdout, batch.length))
      }
      return out
    },
  }
  return provider
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost')
}

/** OpenAI 兼容 /v1/embeddings（默认只允许回环地址）。 */
function createHttpProvider({ url, apiKey, model, env, logger }) {
  const endpoint = String(url).replace(/\/+$/, '') + '/v1/embeddings'
  let dim = 0
  const fingerprint = sha16(`http|${endpoint}|${model}`)
  const minCos = Number(env.DSH_MANUSCRIPT_EMBED_MIN_COS) || DEFAULT_MIN_COS

  async function call(texts) {
    const headers = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(EMBED_ASYNC_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`embedding HTTP ${res.status}`)
    const j = await res.json()
    const data = Array.isArray(j?.data) ? j.data : null
    if (!data || data.length !== texts.length) throw new Error('embedding HTTP 返回条数不符')
    return data.map((d) => {
      const norm = l2normalize(d?.embedding || [])
      if (!norm) throw new Error('embedding HTTP 返回空向量')
      if (!dim) dim = norm.length
      return norm
    })
  }

  return {
    id: 'http-openai',
    kind: 'http',
    endpoint,
    model,
    get dim() { return dim },
    fingerprint,
    minCos,
    maxBatch: 32,
    async embed(texts) {
      const list = (texts || []).map(cleanText)
      if (list.length === 0) return []
      const out = []
      for (const batch of chunkTexts(list)) out.push(...(await call(batch)))
      logger?.debug?.('[dsh-manuscript] embedding HTTP %d 条', list.length)
      return out
    },
    embedSync() {
      // fetch 没有同步版；首轮预取在 HTTP 通道下退回关键词路。
      throw new Error('HTTP embedding 通道不支持同步调用')
    },
  }
}

/**
 * 发现可用 provider。找不到返回 null（这是**正常状态**，不是错误）。
 *
 * @param {{root?:string, env?:NodeJS.ProcessEnv, logger?:object}} [opts]
 * @returns {object|null}
 */
export function discoverEmbeddingProvider(opts = {}) {
  const env = opts.env || process.env
  const logger = opts.logger
  if (String(env.DSH_MANUSCRIPT_EMBED || '').toLowerCase() === 'off') {
    logger?.info?.('[dsh-manuscript] 向量召回已关闭（DSH_MANUSCRIPT_EMBED=off）')
    return null
  }

  // ① 显式 HTTP 通道
  const url = env.DSH_MANUSCRIPT_EMBED_URL
  if (url) {
    let u = null
    try {
      u = new URL(url)
    } catch {
      logger?.warn?.('[dsh-manuscript] DSH_MANUSCRIPT_EMBED_URL 不是合法 URL，忽略')
    }
    if (u) {
      const allowRemote = String(env.DSH_MANUSCRIPT_EMBED_ALLOW_REMOTE || '') === '1'
      if (!allowRemote && !isLoopbackHost(u.hostname)) {
        logger?.warn?.(
          '[dsh-manuscript] 拒绝非回环 embedding 地址 %s（会把手册内容发出本机）；确需如此请设 DSH_MANUSCRIPT_EMBED_ALLOW_REMOTE=1',
          u.host,
        )
      } else {
        return createHttpProvider({
          url,
          apiKey: env.DSH_MANUSCRIPT_EMBED_KEY,
          model: env.DSH_MANUSCRIPT_EMBED_MODEL_NAME || 'default',
          env,
          logger,
        })
      }
    }
  }

  // ② 本地 llama.cpp + GGUF
  const model = discoverEmbedModel(opts.root || join(homedir(), '.dsh', 'dsh-manuscript'), env)
  if (!model) return null
  const bin =
    (env.DSH_MANUSCRIPT_EMBED_BIN && isExecutableFile(env.DSH_MANUSCRIPT_EMBED_BIN)
      ? env.DSH_MANUSCRIPT_EMBED_BIN
      : null) ||
    findOnPath('llama-embedding', env) ||
    llamaBuildCandidates(env)[0] ||
    null
  if (!bin) {
    logger?.info?.('[dsh-manuscript] 找到 embedding 权重但没找到 llama-embedding 可执行文件，向量召回不启用')
    return null
  }
  return createLlamaProvider({ bin, model, env, logger })
}
