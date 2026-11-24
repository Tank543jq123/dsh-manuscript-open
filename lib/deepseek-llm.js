/**
 * DeepSeek 直连的 llm 兼容 shim（2026-11-24）
 *
 * 背景：宿主 WorkBuddy 企业订阅到期后，走宿主 `llm` 服务的提炼会返回空文本
 * （上游 429 / code 14015）。这里提供一个**最小 llm 兼容对象**，只实现
 * `stream()`，把 DeepSeek 的 SSE delta 映射成 collectTextStream 认识的
 * `{type:'text-delta', text}` chunk。
 *
 * 契约（与 lib/distill.js 的用法对齐）：
 *   llm.stream({ provider, model, system, messages, maxTokens, temperature })
 *     -> AsyncIterable<{type:'text-delta', text}>
 *
 * fail-closed：拿不到 key 时 `stream()` 直接抛错（附可操作提示），
 * 绝不静默回落到宿主——那会再次变成"看起来提炼了、其实一个字都没有"。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_BASE = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'

/** 从环境变量或 ~/.dsh/.credentials.yaml 的 refs 段取 key；取不到返回 null。 */
export function resolveDeepSeekKey(env = process.env, { allowFile = true } = {}) {
  const direct = env.DEEPSEEK_API_KEY || ''
  if (direct.trim()) return direct.trim()
  if (!allowFile) return null
  try {
    const file = join(env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
    const text = readFileSync(file, 'utf8')
    // 只做最小解析：形如 `  DEEPSEEK_API_KEY: sk-xxx` 或 `refs:\n  DEEPSEEK_API_KEY: ...`
    const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s#]+)["']?\s*$/m)
    if (m && m[1] && !m[1].startsWith('ref')) return m[1]
  } catch {
    /* 没有凭据文件就是没有 key，由调用方报错 */
  }
  return null
}


/**
 * 最小 HTTPS-over-CONNECT 客户端（2026-11-24）
 * 本机访问境外 API 必须经 xray 代理，但仓库没有 undici 依赖、Node 22 的
 * 全局 fetch 又不认 HTTPS_PROXY。这里用 net+tls 手写 CONNECT + chunked 解析，
 * 只支持流式 POST（够用且无第三方依赖）。
 */
async function* postViaProxy({ url, headers, body, proxy, signal }) {
  const { URL } = await import('node:url')
  const net = await import('node:net')
  const tls = await import('node:tls')
  const u = new URL(url)
  const proxyUrl = new URL(proxy)
  const host = u.hostname
  const port = u.port || 443
  const socket = net.connect(Number(proxyUrl.port || 8080), proxyUrl.hostname)
  const cleanup = () => { try { socket.destroy() } catch { /* ignore */ } }
  signal?.addEventListener?.('abort', cleanup, { once: true })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
    setTimeout(() => reject(new Error('proxy connect timeout')), 15000).unref?.()
  })
  socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
  let head = Buffer.alloc(0)
  while (!head.includes('\r\n\r\n')) {
    const chunk = await new Promise((res, rej) => { socket.once('data', res); socket.once('error', rej) })
    head = Buffer.concat([head, chunk])
  }
  const statusLine = head.toString('latin1').split('\r\n')[0]
  if (!/200/.test(statusLine)) throw new Error(`proxy CONNECT failed: ${statusLine}`)
  const tlsSocket = tls.connect({ socket, servername: host })
  await new Promise((resolve, reject) => { tlsSocket.once('secureConnect', resolve); tlsSocket.once('error', reject) })
  const bodyBuf = Buffer.from(body, 'utf8')
  const headerLines = Object.entries({ ...headers, host, 'content-length': String(bodyBuf.length) })
    .map(([k, v]) => `${k}: ${v}`).join('\r\n')
  tlsSocket.write(`POST ${u.pathname}${u.search} HTTP/1.1\r\n${headerLines}\r\n\r\n`)
  tlsSocket.write(bodyBuf)

  let buf = Buffer.alloc(0)
  let headersDone = false
  let status = 0
  const queue = []
  let ended = false
  tlsSocket.on('data', (chunk) => { queue.push(chunk) })
  tlsSocket.on('end', () => { ended = true })
  tlsSocket.on('error', () => { ended = true })
  for (;;) {
    if (queue.length === 0) {
      if (ended) break
      await new Promise((r) => setTimeout(r, 10))
      continue
    }
    buf = Buffer.concat([buf, queue.shift()])
    if (!headersDone) {
      const idx = buf.indexOf('\r\n\r\n')
      if (idx < 0) continue
      const headerText = buf.subarray(0, idx).toString('latin1')
      status = Number(headerText.split(' ')[1])
      buf = buf.subarray(idx + 4)
      headersDone = true
      if (status !== 200) {
        const tail = buf.toString('utf8').slice(0, 200)
        tlsSocket.destroy()
        throw new Error(`DeepSeek HTTP ${status}: ${tail}`)
      }
    }
    if (buf.length === 0) continue
    // chunked: 逐段解出数据段（简化：遇到 CRLF 长度行就跳）
    const text = buf.toString('utf8')
    buf = Buffer.alloc(0)
    const cleaned = text.replace(/^[0-9a-fA-F]+\r?\n/, '')
    if (cleaned) yield cleaned
  }
}

/** 把 OpenAI 兼容的 SSE 文本流解析成 text-delta 序列。 */
export async function* parseSse(lines, { signal } = {}) {
  let buffer = ''
  for await (const part of lines) {
    buffer += part
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        const m = /^data:\s*(.*)$/.exec(line.trim())
        if (!m) continue
        const payload = m[1]
        if (payload === '[DONE]') return
        let json
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        const delta = json?.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta.length > 0) {
          yield { type: 'text-delta', text: delta }
        }
      }
    }
    if (signal?.aborted) throw new Error('aborted')
  }
}

/**
 * 创建 shim。`fetchImpl` 可注入，便于单测。
 * @returns {{stream: function, listProviders: function, listModels: function}}
 */
export function createDeepSeekLLM(options = {}) {
  const env = options.env || process.env
  const base = options.baseUrl || env.DEEPSEEK_BASE_URL || DEFAULT_BASE
  const model = options.model || env.DEEPSEEK_MODEL || DEFAULT_MODEL
  const key = options.apiKey ?? resolveDeepSeekKey(env, { allowFile: options.allowFile !== false })
  const fetchImpl = options.fetchImpl || globalThis.fetch

  return {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek (direct)' }],
    listModels: () => [{ id: model, provider: 'deepseek' }],
    stream(request = {}) {
      if (!key) {
        throw new Error(
          'DeepSeek 直连需要 DEEPSEEK_API_KEY（环境变量或 ~/.dsh/.credentials.yaml），当前取不到；' +
            '不会回落到宿主模型，请配置 key 后重试',
        )
      }
      const body = {
        // 宿主传下来的 model 可能是 workbuddy 的 id；非 deepseek 前缀一律用本 shim 的默认模型。
        // 只放行官方确实支持的模型名。宿主传下来的可能是 deepseek-v4.1-flash 这类
        // 别名（实测报 "The supported API model names are deepseek-flash, deepseek-v4-pro"），
        // 盲目透传会整批失败。
        model: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat'].includes(String(request.model || ''))
          ? request.model
          : model,
        stream: Boolean(request.stream) === true,
        temperature: request.temperature ?? 0.3,
        max_tokens: request.maxTokens ?? 4000,
        messages: [
          ...(request.system ? [{ role: 'system', content: String(request.system) }] : []),
          ...(Array.isArray(request.messages) ? request.messages.map(toTextMessage) : []),
        ],
      }
      const iterator = (async function* run() {
        // 2026-11-24：Node 的 fetch 在本机 IPv6 优先解析下会 "fetch failed"（curl 正常）。
        // 没有注入 fetchImpl 时直接调 curl 拿全文，绕开 Node HTTP 栈。
        if (!options.fetchImpl) {
          const { execFile } = await import('node:child_process')
          const payload = JSON.stringify(body)
          const args = [
            '-sS', '-m', '120',
            `${base.replace(/\/$/, '')}/chat/completions`,
            '-H', `authorization: Bearer ${key}`,
            '-H', 'content-type: application/json',
            '--data-binary', payload,
          ]
          const stdout = await new Promise((resolve, reject) => {
            execFile('curl', args, { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
              if (err) return reject(new Error(`curl 调用失败：${err.message}`))
              resolve(out)
            })
          })
          let data = null
          try { data = JSON.parse(stdout) } catch { /* 下面统一报错 */ }
          const content = data?.choices?.[0]?.message?.content
          if (typeof content === 'string' && content.length > 0) {
            yield { type: 'text-delta', text: content }
            return
          }
          const reason = data?.choices?.[0]?.finish_reason || (data?.error?.message ?? 'empty')
          throw new Error(`DeepSeek 返回空内容（${reason}）`)
        }
        let doFetch = fetchImpl
        // 境外 API 必须走代理：显式 options.proxy > DEEPSEEK_PROXY > HTTPS_PROXY；
        // 都没有就直接 fetch（本地/内网部署可用）。
        const proxy = options.proxy || env.DEEPSEEK_PROXY || env.HTTPS_PROXY || ''
        if (proxy) {
          // 首选 undici ProxyAgent（成熟实现）；没装 undici 才退回内置 CONNECT。
          try {
            const { ProxyAgent } = await import('undici')
            const res = await doFetch(`${base.replace(/\/$/, '')}/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
              body: JSON.stringify(body),
              signal: request.signal,
              dispatcher: new ProxyAgent(proxy),
            })
            if (!res.ok) {
              const text = await res.text().catch(() => '')
              throw new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 200)}`)
            }
            yield* parseSse(sseLines(res.body), { signal: request.signal })
            return
          } catch (e) {
            if (/Cannot find package|ERR_MODULE_NOT_FOUND/.test(String(e?.code || e?.message || ''))) {
              // 没有 undici：走内置 CONNECT 兜底
            } else {
              throw e
            }
          }
          const stream2 = postViaProxy({
            url: `${base.replace(/\/$/, '')}/chat/completions`,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            proxy,
            signal: request.signal,
          })
          yield* parseSse(stream2, { signal: request.signal })
          return
        }
        // 2026-11-24：Node 的 fetch 在这台机器上会优先解析 AAAA，导致 "fetch failed"；
        // 用 undici Agent 固定 IPv4（curl 与 --dns-result-order=ipv4first 都正常）。
        let dispatcher = options.dispatcher
        if (!dispatcher) {
          try {
            // 必须用 undici 自带的 fetch 配 undici 的 dispatcher：
            // Node 内置 fetch 来自另一个 undici 副本，混用会直接 "fetch failed"。
            const undici = await import('undici')
            dispatcher = new undici.Agent({ connect: { family: 4 } })
            if (!options.fetchImpl) doFetch = undici.fetch
          } catch {
            dispatcher = undefined
          }
        }
        const res = await doFetch(`${base.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: request.signal,
          ...(dispatcher ? { dispatcher } : {}),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 200)}`)
        }
        if (!body.stream) {
          // 非流式：一次拿全文，按 collectTextStream 认的形态发一段
          const data = await res.json().catch(() => null)
          const content = data?.choices?.[0]?.message?.content
          if (typeof content !== 'string' || content.length === 0) {
            const reason = data?.choices?.[0]?.finish_reason || 'empty'
            throw new Error(`DeepSeek 返回空内容（finish_reason=${reason}）`)
          }
          yield { type: 'text-delta', text: content }
          return
        }
        if (!res.body) throw new Error('DeepSeek 响应没有 body（无法流式读取）')
        yield* parseSse(sseLines(res.body), { signal: request.signal })
      })()
      return iterator
    },
  }
}

function toTextMessage(msg) {
  if (typeof msg?.content === 'string') return { role: msg.role, content: msg.content }
  if (Array.isArray(msg?.content)) {
    const text = msg.content
      .map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : ''))
      .join('')
    return { role: msg.role, content: text }
  }
  return { role: msg?.role || 'user', content: '' }
}

async function* sseLines(body) {
  const decoder = new TextDecoder()
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) {
      yield typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    }
    return
  }
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      yield decoder.decode(value, { stream: true })
    }
  }
}
