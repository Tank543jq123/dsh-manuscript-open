#!/usr/bin/env node
/**
 * 批量重提炼「T0 统计骨架」会话 —— 把只有「N 轮 · M 次工具调用」的条目换成真结论。
 *
 * ## 事故背景（2026-11-12）
 *
 * 线上库 321 条里 156 条（48.6%）的 claim 是
 * `7 轮 · 3 次工具调用 · 0 个交付物 · （多轮讨论）`。其中 110 个会话**早就有**
 * LLM 提炼出的真结论，只是骨架从没退役；剩下 46 个会话只有骨架，才是真正
 * 需要重提炼的对象。目标：目录里骨架占比 < 20%。
 *
 * ## 这个脚本做三件事（顺序固定）
 *
 *   ① **建库重扫**：调用 lib/library.js 的 buildLibrary。建库里有一条派生规则
 *      「同会话已有真结论 → 骨架自动退役」，所以这一步会先把 110 条历史骨架
 *      从目录里清掉（文件保留，只改 status）。**脚本本身不写 entries 文件。**
 *   ② **真提炼**：默认走线上 DSH 的 `/api/distill/run`（宿主 ctx.llm，模型跟随
 *      宿主配置，按次计费）。端点只能按优先级取前 N 个、不能指定 sid，所以每轮
 *      跑之前都用 `/api/distill/plan` 核对：队列里的会话必须全部是骨架会话，
 *      否则拒绝花钱（防止把非骨架会话顺带重提）。
 *
 *      **备选引擎 `--engine deepseek`**：直连官方 DeepSeek API
 *      （宿主 credentials 里的 DEEPSEEK_API_KEY，模型 deepseek-flash）。
 *      它是为 2026-11-12 实测到的宿主 WorkBuddy 路由故障准备的 ——
 *      该路由当时对所有模型返回 HTTP 429 / code 14015「企业订阅已到期」，
 *      经 /api/distill/run 表现为 `LLM 返回空文本`。本地引擎同时解决了
 *      "端点不能按 sid 选择"的问题：一个会话一次调用，可精确排除并发中的
 *      会话（--exclude-recent-minutes）。日志与报告都会写明 engine，不冒充宿主路由。
 *   ③ **入册 + 再重扫**：`/api/distill/commit` 把本轮 proposal 写进书库；
 *      随后本地再跑一次 buildLibrary，让新入册的真结论把骨架退役。最后从
 *      library.json 现算骨架占比。
 *
 * ## 幂等
 *
 *   · 入册口按内容指纹去重（commit.js），重复提交不会产生第二条；
 *   · 骨架退役是建库派生规则，第二次重扫 `skeletonRetired = 0`；
 *   · 已提炼过的会话不在队列里；已尝试过且没产出的会话默认跳过
 *     （读 distill-state.json 的 emptySids/failedSids…，见 --retry-attempted）。
 *   因此第二次执行 `--run` 应当是零 LLM 调用、占比不变。
 *
 * ## 失败处理
 *
 *   提炼失败的会话**保留骨架不动**，并按失败原因记账；不伪造结论、不删条目。
 *
 * 用法：
 *   node scripts/redistill-skeletons.mjs                 # 默认 dry-run：只估算
 *   node scripts/redistill-skeletons.mjs --run           # 真跑（会调 LLM、花钱）
 *   node scripts/redistill-skeletons.mjs --stats-only    # 只看当前占比
 *   node scripts/redistill-skeletons.mjs --run --batch-size 20 --max-batches 5
 *
 * 选项：
 *   --root <path>        书库根（默认 $DSH_MANUSCRIPT_ROOT 或 ~/.dsh/dsh-manuscript）
 *   --host <url>         线上 DSH Web（默认 $DSH_WEB_URL 或 http://127.0.0.1:3082）
 *   --batch-size <n>     每轮最多跑几个会话（默认 20；见下方 "一批的边界"）
 *   --max-batches <n>    最多几轮（默认 20）
 *   --timeout-ms <n>     单次 HTTP 超时（默认 1200000 = 20 分钟）
 *   --log-dir <path>     日志目录（默认 <repo>/.artifacts/redistill-skeletons）
 *   --threshold <0..1>   目标骨架占比（默认 0.2，仅用于报告"达标/未达标"）
 *   --no-commit          只提炼不入册（调试用；条目会写入日志，不会丢）
 *   --retry-attempted    允许重试 distill-state 里已记过失败/空产出的会话
 *   --allow-non-skeleton 允许队列里混入非骨架会话（默认拒绝，防止顺带烧钱）
 *   --engine <host|deepseek>  提炼引擎（默认 host；deepseek 直连官方 API）
 *   --api-base <url>      deepseek 引擎端点（默认 https://api.deepseek.com）
 *   --api-key-env <name>  key 的环境变量名（默认 DEEPSEEK_API_KEY）
 *   --api-model <id>      deepseek 引擎模型（默认 deepseek-flash）
 *   --api-max-tokens <n>  单次输出上限（默认 8000）
 *   --max-calls <n>       deepseek 引擎最多调用几次（默认 60，硬性成本闸门）
 *   --exclude-recent-minutes <n>  deepseek 引擎跳过 N 分钟内创建的会话（默认 10）
 *   --price-in-per-m <n>  可选：输入单价（元/百万 token），不传则不编造金额
 *   --price-out-per-m <n> 可选：输出单价（元/百万 token）
 *
 * ## 一批的边界（为什么不总是 10–20）
 *
 * 服务端的 run 端点是"按优先级取前 N 个"，不是"按我给的 sid 列表跑"。如果
 * 只跑一部分，没跑到的低优先级会话会被本轮空产出会话挤到下一轮后面 ——
 * 重试它们纯属白花钱。所以：eligible ≤ 25 时**一轮跑完**；更大的队列才按
 * --batch-size 切，并且每轮核对"队首是否全是我还没试过的骨架会话"，
 * 一旦发现会被重试挤占就停下并说明，不烧钱。
 */

import { parseArgs } from 'node:util'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildLibrary, BuildLockedError, defaultLibraryRoot, assignVolume, chapterSpec } from '../lib/library.js'
import { scanSessions } from '../lib/scan.js'
import { triageAll } from '../lib/triage.js'
import { selectQueue, proposalsToEntries, priorityOf } from '../lib/pipeline.js'
import { distillBatch, renderSessionDigest } from '../lib/distill.js'
import { adjudicate } from '../lib/adjudicate.js'
import { commitEntries } from '../lib/commit.js'
import { readState as readDistillStateFile, writeState as writeDistillStateFile } from '../lib/distill-state.js'
import { isSkeletonClaim } from '../lib/skeleton.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

const { values: argv } = parseArgs({
  options: {
    root: { type: 'string' },
    host: { type: 'string' },
    'batch-size': { type: 'string', default: '20' },
    'max-batches': { type: 'string', default: '20' },
    'timeout-ms': { type: 'string', default: '1200000' },
    'log-dir': { type: 'string' },
    threshold: { type: 'string', default: '0.2' },
    run: { type: 'boolean', default: false },
    'stats-only': { type: 'boolean', default: false },
    'no-commit': { type: 'boolean', default: false },
    'retry-attempted': { type: 'boolean', default: false },
    'allow-non-skeleton': { type: 'boolean', default: false },
    'price-in-per-m': { type: 'string' },
    'price-out-per-m': { type: 'string' },
    engine: { type: 'string', default: 'host' },
    'api-base': { type: 'string' },
    'api-key-env': { type: 'string', default: 'DEEPSEEK_API_KEY' },
    'api-model': { type: 'string', default: 'deepseek-flash' },
    'api-max-tokens': { type: 'string', default: '8000' },
    'api-timeout-ms': { type: 'string', default: '180000' },
    'max-calls': { type: 'string', default: '60' },
    'exclude-recent-minutes': { type: 'string', default: '10' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (argv.help) {
  console.log(`
书阁 · 批量重提炼统计骨架

  node scripts/redistill-skeletons.mjs                 只预演（dry-run，不调 LLM）
  node scripts/redistill-skeletons.mjs --run           真跑：重扫 → 提炼 → 入册 → 重扫
  node scripts/redistill-skeletons.mjs --stats-only    只统计当前骨架占比

选项见文件头注释。日志与每轮原始响应都写到 .artifacts/redistill-skeletons/。
`)
  process.exit(0)
}

const root = resolve(argv.root || process.env.DSH_MANUSCRIPT_ROOT || defaultLibraryRoot())
const host = String(argv.host || process.env.DSH_WEB_URL || 'http://127.0.0.1:3082').replace(/\/+$/, '')
const batchSize = clampInt(argv['batch-size'], 1, 50, 20)
const maxBatches = clampInt(argv['max-batches'], 1, 100, 20)
const timeoutMs = clampInt(argv['timeout-ms'], 1000, 3_600_000, 1_200_000)
const threshold = clampRatio(argv.threshold, 0.2)
const logDir = resolve(argv['log-dir'] || join(REPO, '.artifacts', 'redistill-skeletons'))
const doRun = argv.run === true
const statsOnly = argv['stats-only'] === true
const doCommit = argv['no-commit'] !== true
const retryAttempted = argv['retry-attempted'] === true
const allowNonSkeleton = argv['allow-non-skeleton'] === true
const priceIn = numberOrNull(argv['price-in-per-m'])
const priceOut = numberOrNull(argv['price-out-per-m'])
const engine = String(argv.engine || 'host')
if (!['host', 'deepseek'].includes(engine)) {
  console.error(`✗ --engine 只支持 host | deepseek，收到 ${JSON.stringify(engine)}`)
  process.exit(2)
}
const apiBase = String(argv['api-base'] || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const apiKeyEnv = String(argv['api-key-env'] || 'DEEPSEEK_API_KEY')
const apiModel = String(argv['api-model'] || 'deepseek-flash')
const apiMaxTokens = clampInt(argv['api-max-tokens'], 256, 128000, 8000)
const apiTimeoutMs = clampInt(argv['api-timeout-ms'], 5000, 1_800_000, 180_000)
const maxCalls = clampInt(argv['max-calls'], 1, 500, 60)
const excludeRecentMinutes = clampInt(argv['exclude-recent-minutes'], 0, 1440, 10)

function clampInt(raw, min, max, def) {
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return def
  return Math.min(max, Math.max(min, n))
}
function clampRatio(raw, def) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) return def
  return n
}
function numberOrNull(raw) {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// ─────────────────────────────────────────────────────────────
// 日志 / 落盘
// ─────────────────────────────────────────────────────────────

mkdirSync(logDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const logLines = []
const logFile = join(logDir, `log-${stamp}.log`)

function log(msg = '') {
  const line = String(msg)
  console.log(line)
  logLines.push(`[${new Date().toISOString()}] ${line}`)
}
function flushLog() {
  try {
    writeFileSync(logFile, logLines.join('\n') + '\n', 'utf8')
  } catch (e) {
    console.error(`写日志失败（不影响主流程）：${e?.message || e}`)
  }
}
function saveJson(name, data) {
  const p = join(logDir, name)
  try {
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
    return p
  } catch (e) {
    log(`  ⚠ 写 ${name} 失败：${e?.message || e}`)
    return null
  }
}
function pct(x) {
  return Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '?'
}

// ─────────────────────────────────────────────────────────────
// 统计：一律从磁盘现读，不信内存
// ─────────────────────────────────────────────────────────────

/** 从 library.json 的目录投影（chapterList）算可见条目与骨架占比。 */
function catalogStats(library) {
  const entries = []
  for (const v of library?.volumes || []) {
    for (const ch of v.chapterList || []) {
      for (const e of ch.entries || []) entries.push(e)
    }
  }
  const skeletons = entries.filter((e) => isSkeletonClaim(e.claim))
  return {
    total: entries.length,
    skeletons: skeletons.length,
    ratio: entries.length ? skeletons.length / entries.length : null,
    skeletonIds: skeletons.map((e) => e.id),
  }
}

/** 磁盘全量交叉校验：current / expired 各多少，其中骨架多少。 */
function diskStats(rootPath) {
  const dir = join(rootPath, 'entries')
  const all = []
  const bad = []
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const e = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        if (e && e.id) all.push(e)
        else bad.push(f)
      } catch {
        bad.push(f)
      }
    }
  }
  const current = all.filter((e) => e.status !== 'expired')
  const expired = all.filter((e) => e.status === 'expired')
  const currentSkeletons = current.filter((e) => isSkeletonClaim(e.claim))
  return {
    total: all.length,
    current: current.length,
    expired: expired.length,
    currentSkeletons: currentSkeletons.length,
    expiredSkeletons: expired.filter((e) => isSkeletonClaim(e.claim)).length,
    ratioCurrent: current.length ? currentSkeletons.length / current.length : null,
    badFiles: bad,
  }
}

function readLibrary() {
  const p = join(root, 'library.json')
  if (!existsSync(p)) throw new Error(`library.json 不存在：${p}`)
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    throw new Error(`library.json 解析失败：${e?.message || e}`)
  }
}

function readDistillState() {
  const p = join(root, 'distill-state.json')
  if (!existsSync(p)) return { failedSids: {}, emptySids: {}, rejectedSids: {}, suspectSids: {} }
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return { failedSids: {}, emptySids: {}, rejectedSids: {}, suspectSids: {} }
  }
}

/**
 * 当前「只有骨架、没有真结论」的会话。
 * 只读 entries/*.json，返回 Map<sid, { skeletonIds, distilledIds }>。
 */
function skeletonSessions(rootPath) {
  const dir = join(rootPath, 'entries')
  const bySid = new Map()
  if (!existsSync(dir)) return bySid
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    let e
    try {
      e = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      continue
    }
    const sid = e?.provenance?.session_id
    if (!sid) continue
    const bucket = bySid.get(sid) || { skeletonIds: [], distilledIds: [] }
    if (e.status !== 'expired' && isSkeletonClaim(e.claim)) bucket.skeletonIds.push(e.id)
    // "真结论"的口径必须与 library.js 的自动退役一致：
    // distilled === true、非骨架 claim、未退役。
    if (e.distilled === true && e.status !== 'expired' && !isSkeletonClaim(e.claim)) {
      bucket.distilledIds.push(e.id)
    }
    bySid.set(sid, bucket)
  }
  return bySid
}

/** 已经被尝试过（失败/空产出/被淘汰）的会话 sid 集合，用于保证脚本幂等。 */
function attemptedSids(state) {
  const out = new Set()
  for (const key of ['failedSids', 'emptySids', 'rejectedSids', 'suspectSids']) {
    for (const [sid, n] of Object.entries(state?.[key] || {})) {
      if (Number.isFinite(n) && n > 0) out.add(sid)
    }
  }
  return out
}

/**
 * 磁盘上「已提炼」的会话集合 —— 判据与 index.js 的 restoreDistilledSids 一致：
 * distilled === true、非 prebuilt、有 provenance.session_id。
 * （不看 claim / status：宿主恢复内存状态时也不看，两边必须同口径。）
 */
function distilledSessionsOnDisk(rootPath) {
  const set = new Set()
  const dir = join(rootPath, 'entries')
  if (!existsSync(dir)) return set
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (e?.distilled === true && e?.prebuilt !== true && e?.provenance?.session_id) {
        set.add(e.provenance.session_id)
      }
    } catch {
      /* 坏文件由 health 报，本脚本不处理 */
    }
  }
  return set
}

// ─────────────────────────────────────────────────────────────
// HTTP（线上 DSH 插件端点）
// ─────────────────────────────────────────────────────────────

const GUARD_HEADER = { 'x-dsh-manuscript': '1' }

async function api(path, { method = 'GET', body, timeout = timeoutMs } = {}) {
  const url = host + path
  let res
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...GUARD_HEADER,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    })
  } catch (e) {
    // 不把网络错误伪装成"空队列"：这是脚本最危险的失败形态
    throw new Error(`请求 ${method} ${path} 失败（${url}）：${e?.name === 'TimeoutError' ? `超时 >${timeout}ms` : e?.message || e}`)
  }
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${method} ${path} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`)
  }
  return { status: res.status, json }
}

async function fetchPlan() {
  const { status, json } = await api('/dsh-manuscript/api/distill/plan')
  if (!json?.ok) throw new Error(`/distill/plan 失败（HTTP ${status}）：${json?.error || '未知错误'}`)
  return json
}

// ─────────────────────────────────────────────────────────────
// 本地重扫（走 buildLibrary，含骨架自动退役）
// ─────────────────────────────────────────────────────────────

/** 扫描 + 分诊只做一次：一次脚本执行期间会话不会变（新会话与本次无关）。 */
let triagedCache = null
function getTriaged() {
  if (!triagedCache) {
    const { sessions } = scanSessions()
    triagedCache = triageAll(sessions).enriched
  }
  return triagedCache
}

async function localRebuild() {
  const maxTries = 12
  let lastErr = null
  for (let i = 0; i < maxTries; i++) {
    try {
      // dataDir 必须与宿主一致（lib/index.js 的 DATA_DIR）——否则预加工册
      // VOL.06 会因为找不到 data/vol-06-ai-collab.json 而从目录里消失。
      return buildLibrary(getTriaged(), { root, dataDir: join(REPO, 'data') })
    } catch (e) {
      lastErr = e
      // 建库锁被宿主周期性扫描占用时，等一会儿重试；这不是失败
      if (e instanceof BuildLockedError || /建库锁|正在运行|BuildLocked/i.test(String(e?.message || e))) {
        log(`  建库锁被占用，5s 后重试（${i + 1}/${maxTries}）…`)
        await new Promise((r) => setTimeout(r, 5000))
        continue
      }
      throw e
    }
  }
  throw new Error(`本地重扫连续 ${maxTries} 次被锁占用：${lastErr?.message || lastErr}`)
}

/**
 * 本地重算「合格待提炼队列」——和宿主 selectQueue 用同一套规则，但不依赖
 * `/distill/plan`（那个端点最多只返回 20 个 willDistill，无法覆盖 20+ 的整批）。
 *
 * 判据口径与宿主一致：
 *   · 已提炼 = 磁盘上有 distilled===true 且非骨架、未退役的条目
 *   · 失败/空产出/被淘汰/疑似失败计数从 distill-state.json 读
 * 这样脚本能拿到**完整**的会话名单，用于逐会话归因与幂等判断。
 */
function localEligibleQueue() {
  const state = readDistillState()
  const distilledSids = distilledSessionsOnDisk(root)
  const sel = selectQueue(
    getTriaged(),
    {
      distilledSids,
      failedSids: state.failedSids || {},
      emptySids: state.emptySids || {},
      rejectedSids: state.rejectedSids || {},
      suspectSids: state.suspectSids || {},
    },
    { maxSessions: 50 }
  )
  return { queue: sel.queue, skipped: sel.skipped, stats: sel.stats }
}

// ─────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────

function estimateText(plan) {
  const p = plan?.plan || {}
  const calls = Number.isFinite(p.calls) ? p.calls : null
  const chars = Number.isFinite(p.totalChars) ? p.totalChars : null
  // 只做量级估算：中文 1 字≈1 token 偏保守，这里按 1.6 字符/token 给区间
  const tokensLow = chars == null ? null : Math.round(chars / 1.6)
  const tokensHigh = chars == null ? null : Math.round(chars / 1.0)
  return {
    calls,
    inputChars: chars,
    batches: Array.isArray(p.batches) ? p.batches.length : null,
    tokensLow,
    tokensHigh,
  }
}

function formatCost(usage, estimate) {
  const lines = []
  const calls = usage?.calls
  const inChars = usage?.promptChars
  const outChars = usage?.completionChars
  if (Number.isFinite(calls) || Number.isFinite(inChars)) {
    lines.push(
      `实际用量：提炼调用 ${Number.isFinite(calls) ? calls : '?'} 次 · ` +
        `判重调用 ${usage?.judgeCalls ?? '?'} 次 · ` +
        `输入 ${Number.isFinite(inChars) ? inChars : '?'} 字符 · ` +
        `输出 ${Number.isFinite(outChars) ? outChars : '?'} 字符`
    )
    lines.push('  （usage 只统计提炼调用；判重调用按 adjudication.stats.llmJudged.asked 另计，同样计费。）')
  }
  if (estimate) {
    lines.push(
      `预估（dry-run）：${estimate.calls ?? '?'} 次调用 · ` +
        `输入约 ${estimate.inputChars ?? '?'} 字符（≈${estimate.tokensLow ?? '?'}–${estimate.tokensHigh ?? '?'} token）`
    )
  }
  if (priceIn != null && priceOut != null) {
    const inTokens = Number.isFinite(inChars) ? inChars / 1.6 : null
    const outTokens = Number.isFinite(outChars) ? outChars / 1.6 : null
    if (inTokens != null && outTokens != null) {
      const cny = (inTokens / 1e6) * priceIn + (outTokens / 1e6) * priceOut
      lines.push(`估算金额：≈ ¥${cny.toFixed(4)}（按 ¥${priceIn}/M 输入 · ¥${priceOut}/M 输出，token 按 1.6 字符≈1 token）`)
    }
  } else {
    lines.push('金额：未提供 --price-in-per-m / --price-out-per-m；仓库与宿主配置里没有单价，故不编造，只报调用次数与字符量。')
  }
  return lines
}

// ─────────────────────────────────────────────────────────────
// 本地引擎：官方 DeepSeek API（绕过宿主 WorkBuddy 代理）
// ─────────────────────────────────────────────────────────────
//
// 【为什么需要这个引擎（2026-11-12 实测）】
//   宿主配置的 WorkBuddy/DeepSeek 路由当前返回 HTTP 429 / code 14015
//   「企业订阅已到期」。通过 /api/distill/run 的每次调用都得到
//   `LLM 返回空文本`（10 批全失败、completionChars=0）。这不是模型或
//   prompt 的问题 —— 同一账号的官方 DeepSeek key 可以正常流式返回。
//
//   本引擎用**宿主 credentials 里的 DEEPSEEK_API_KEY** 直连官方
//   OpenAI 兼容接口，模型仍是 DeepSeek-V4.1-Flash（官方 id: deepseek-flash），
//   按次计费、不需要重启 DSH；同时能精确只跑指定 sid，不会把并发中的
//   会话顺带提炼。日志会明确标注 engine=deepseek，不冒充宿主路由。


/** 从环境变量或 ~/.dsh/.credentials.yaml 的 refs 段取 key；绝不打印 key 本身。 */
function resolveApiKey() {
  if (process.env[apiKeyEnv]) return process.env[apiKeyEnv]
  const file = process.env.DSH_CREDENTIALS_FILE || join(process.env.DSH_HOME || join(process.env.HOME || '', '.dsh'), '.credentials.yaml')
  try {
    const text = readFileSync(file, 'utf8')
    const m = new RegExp(`^\\s*${apiKeyEnv}:\\s*(\\S+)\\s*$`, 'm').exec(text)
    if (m) return m[1]
  } catch {
    /* 文件不存在/不可读：下面统一报错 */
  }
  return null
}

/** distillBatch 的 messages 是 [{role, content:[{type:'text',text}]}]，OpenAI 要字符串。 */
function flattenMessages(messages) {
  const out = []
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue
    let text = ''
    if (typeof m.content === 'string') text = m.content
    else if (Array.isArray(m.content)) {
      text = m.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('')
    }
    if (text) out.push({ role: m.role || 'user', content: text })
  }
  return out
}

/**
 * OpenAI 兼容的流式适配器。只认 `delta.content`；reasoning_content 不计入
 * 正文（与 lib/llm-stream.js 的口径一致：推理过程不是提炼结果）。
 */
function makeDeepSeekLLM(apiKey) {
  return {
    stream(options) {
      return (async function* () {
        const body = {
          model: options.model || apiModel,
          messages: [
            ...(options.system ? [{ role: 'system', content: String(options.system) }] : []),
            ...flattenMessages(options.messages),
          ],
          stream: true,
          max_tokens: options.maxTokens ?? apiMaxTokens,
          temperature: options.temperature ?? 0.2,
        }
        if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort
        let res
        try {
          res = await fetch(`${apiBase}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal: options.signal,
          })
        } catch (e) {
          yield { type: 'error', error: { message: `DeepSeek 请求失败：${e?.message || e}` } }
          return
        }
        if (!res.ok) {
          const text = (await res.text().catch(() => '')).slice(0, 400)
          yield { type: 'error', error: { message: `DeepSeek HTTP ${res.status}：${text}` } }
          return
        }
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let idx
            while ((idx = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, idx).trim()
              buf = buf.slice(idx + 1)
              if (!line.startsWith('data:')) continue
              const data = line.slice(5).trim()
              if (!data || data === '[DONE]') continue
              let json
              try {
                json = JSON.parse(data)
              } catch {
                continue
              }
              const delta = json?.choices?.[0]?.delta
              if (delta && typeof delta.content === 'string' && delta.content) {
                yield { type: 'text-delta', text: delta.content }
              }
            }
          }
        } catch (e) {
          yield { type: 'error', error: { message: `DeepSeek 流读取失败：${e?.message || e}` } }
        }
      })()
    },
  }
}

/** 与 lib/index.js 的 readEntriesForDedup 同口径：排除退役/预加工/骨架/损坏。 */
function readEntriesForDedupLocal() {
  const dir = join(root, 'entries')
  const out = []
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    let e
    try {
      e = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      continue
    }
    if (!e || e.status === 'expired' || e.prebuilt === true) continue
    if (isSkeletonClaim(e.claim)) continue
    if (/\?{3,}/.test(`${e.title || ''} ${e.claim || ''}`)) continue
    out.push(e)
  }
  return out
}

function stateCount(state, key, sid) {
  const v = state?.[key]?.[sid]
  return Number.isFinite(v) ? v : 0
}

/**
 * 本地引擎主流程。返回给 main 的报告片段。
 *
 * 顺序：选目标（当前只有骨架、非并发新会话、未达退避阈值）
 *      → 逐个会话 distillBatch（1 会话/次，sid 精确）
 *      → 规则裁决 → commitEntries
 *      → 建库重扫（骨架自动退役）→ 统计。
 */
async function runDeepSeekEngine(report, estimate) {
  const apiKey = resolveApiKey()
  if (!apiKey) throw new Error(`本地引擎需要 ${apiKeyEnv}（环境变量或 ~/.dsh/.credentials.yaml 的 refs 段），当前取不到`)
  const llm = makeDeepSeekLLM(apiKey)
  const triaged = getTriaged()
  const sessionIndex = new Map(triaged.map((s) => [s.sid, s]))
  const skelMap = skeletonSessions(root)
  const state = readDistillStateFile(root) || {}
  const cutoff = Date.now() - excludeRecentMinutes * 60_000

  const skippedRecent = []
  const skippedBackoff = []
  const skippedNotReal = []
  const targets = []
  for (const [sid, bucket] of skelMap) {
    if (!bucket.skeletonIds.length || bucket.distilledIds.length) continue
    const s = sessionIndex.get(sid)
    if (!s) {
      skippedNotReal.push(sid)
      continue
    }
    if (s.category !== 'real') {
      skippedNotReal.push(sid)
      continue
    }
    if (Number.isFinite(s.createdAt) && s.createdAt > cutoff) {
      skippedRecent.push({ sid, title: s.title, createdAt: s.createdAt })
      continue
    }
    // 幂等：默认跳过任何"已经被尝试过"的会话（失败/空产出/被淘汰/疑似失败，
    // 计数 > 0 即算）。这样第二次执行不会为了模型的一次空判断再烧一遍钱；
    // 想按宿主的 2/3 次退避口径重试，显式加 --retry-attempted。
    const everTried = retryAttempted
      ? false
      : ['failedSids', 'emptySids', 'rejectedSids', 'suspectSids'].some((k) => stateCount(state, k, sid) > 0)
    if (everTried) {
      skippedBackoff.push(sid)
      continue
    }
    targets.push(s)
  }
  targets.sort((a, b) => priorityOf(b) - priorityOf(a))

  report.local = {
    engine: 'deepseek',
    apiBase,
    apiModel,
    targets: targets.length,
    skippedRecent: skippedRecent.length,
    skippedBackoff: skippedBackoff.length,
    skippedNotReal: skippedNotReal.length,
    results: [],
  }
  log('')
  log('【本地引擎】官方 DeepSeek API（engine=deepseek）')
  log(`  端点 ${apiBase} · 模型 ${apiModel} · 单次 max_tokens=${apiMaxTokens} · 会话/次=1`)
  log(`  目标 ${targets.length} 个骨架会话 · 跳过近期会话 ${skippedRecent.length} · 退避 ${skippedBackoff.length}`)
  if (skippedRecent.length) {
    log(`  近期会话（--exclude-recent-minutes=${excludeRecentMinutes}，可能仍在进行，留待完成后再提炼）：`)
    for (const x of skippedRecent.slice(0, 10)) log(`    - ${x.sid}  ${(x.title || '').slice(0, 40)}`)
  }

  // dry-run：只渲染 digest 估字符，不调用 API
  if (!doRun) {
    let chars = 0
    for (const s of targets) {
      try {
        chars += Buffer.byteLength(renderSessionDigest(s, {}), 'utf8')
      } catch {
        /* 压缩失败不影响估算 */
      }
    }
    log(
      `  预估：${targets.length} 次调用 · digest 合计约 ${chars} 字符（另加 system prompt ~1.3KB/次）`
    )
    report.estimate = { ...(estimate || {}), calls: targets.length, inputChars: chars }
    return
  }

  const runId = `redistill-deepseek-${stamp}`
  const existing = readEntriesForDedupLocal()
  const pendingState = {
    failedSids: { ...(state.failedSids || {}) },
    emptySids: { ...(state.emptySids || {}) },
    rejectedSids: { ...(state.rejectedSids || {}) },
    suspectSids: { ...(state.suspectSids || {}) },
  }
  let calls = 0
  let success = 0
  let empty = 0
  let failed = 0
  let rejected = 0
  let written = 0
  let stopReason = null

  for (const s of targets) {
    if (calls >= maxCalls) {
      stopReason = `达到 --max-calls=${maxCalls} 上限`
      break
    }
    calls += 1
    const label = `${s.sid.slice(0, 24)} ${(s.title || '').slice(0, 34)}`
    const t0 = Date.now()
    let r
    try {
      r = await distillBatch([s], {
        llm,
        provider: 'deepseek',
        model: apiModel,
        maxSessionsPerCall: 1,
        maxTokens: apiMaxTokens,
        timeoutMs: apiTimeoutMs,
        reasoningEffort: 'high',
      })
    } catch (e) {
      r = { proposals: [], usage: { calls: 1, inputChars: 0, outputChars: 0 }, error: e?.message || String(e) }
    }
    const ms = Date.now() - t0
    report.usage.calls += Number(r?.usage?.calls) || 1
    report.usage.promptChars += Number(r?.usage?.inputChars) || 0
    report.usage.completionChars += Number(r?.usage?.outputChars) || 0

    if (r?.error) {
      failed += 1
      pendingState.failedSids[s.sid] = (pendingState.failedSids[s.sid] || 0) + 1
      log(`  ✗ ${label} · ${ms}ms · ${r.error}`)
      report.local.results.push({ sid: s.sid, title: s.title, outcome: 'failed', ms, error: r.error })
      continue
    }
    if (!Array.isArray(r?.proposals) || r.proposals.length === 0) {
      empty += 1
      pendingState.emptySids[s.sid] = (pendingState.emptySids[s.sid] || 0) + 1
      log(`  ○ ${label} · ${ms}ms · 模型认为无可提炼（骨架保留）`)
      report.local.results.push({ sid: s.sid, title: s.title, outcome: 'empty', ms })
      continue
    }

    // 单个会话的提案都归到该 sid —— 没有批内指派问题
    const proposals = r.proposals.map((p) => ({
      ...p,
      sid: s.sid,
      provenance: { ...(p.provenance || {}), session_ids: [s.sid], source_kind: 'single-session' },
    }))
    const candidates = proposalsToEntries(proposals, {
      runId,
      triaged: [s],
      assignVolume,
      chapterSpec,
      now: new Date(),
    })
    const adj = adjudicate(candidates, { existing, maxHuman: 8 })
    if (adj.accept.length === 0) {
      rejected += 1
      pendingState.rejectedSids[s.sid] = (pendingState.rejectedSids[s.sid] || 0) + 1
      log(
        `  ▷ ${label} · ${ms}ms · 提案 ${r.proposals.length} 条，全部未通过裁决` +
          `（reject ${adj.reject.length} / human ${adj.human.length} / deferred ${adj.deferred.length}）`
      )
      report.local.results.push({
        sid: s.sid,
        title: s.title,
        outcome: 'rejected',
        ms,
        proposals: r.proposals.length,
        rejected: adj.reject.length,
        human: adj.human.length,
      })
      continue
    }

    let cr = commitEntries(adj.accept, { root })
    // 建库锁偶发冲突：等一下重试一次，仍失败就保留骨架
    if (!cr.ok) {
      await new Promise((res) => setTimeout(res, 5000))
      cr = commitEntries(adj.accept, { root })
    }
    if (!cr.ok) {
      failed += 1
      pendingState.failedSids[s.sid] = (pendingState.failedSids[s.sid] || 0) + 1
      log(`  ✗ ${label} · 入册失败：${cr.reason || '未知'}`)
      report.local.results.push({ sid: s.sid, title: s.title, outcome: 'commit-failed', ms, error: cr.reason || null })
      continue
    }
    success += 1
    written += cr.written
    existing.push(...adj.accept)
    delete pendingState.failedSids[s.sid]
    delete pendingState.emptySids[s.sid]
    delete pendingState.rejectedSids[s.sid]
    log(
      `  ✓ ${label} · ${ms}ms · 提案 ${r.proposals.length} → 入册 ${cr.written} 条` +
        (cr.skipped ? `（跳过 ${cr.skipped}）` : '') +
        ` · 裁决 reject ${adj.reject.length}/human ${adj.human.length}`
    )
    report.local.results.push({
      sid: s.sid,
      title: s.title,
      outcome: 'distilled',
      ms,
      proposals: r.proposals.length,
      written: cr.written,
      skipped: cr.skipped,
      reject: adj.reject.length,
      human: adj.human.length,
    })
  }

  // 落负面状态：与宿主的退避口径一致（失败的 +1、空产出的 +1、成功清零）
  try {
    writeDistillStateFile(root, pendingState)
  } catch (e) {
    log(`  ⚠ 写 distill-state 失败（退避只在本次生效）：${e?.message || e}`)
  }

  report.local.summary = { calls, success, empty, failed, rejected, written, stopReason }
  log('')
  log('【本地引擎】提炼结束，建库重扫（应用骨架退役）…')
  const rb = await localRebuild()
  report.afterRebuild = {
    skeletonRetired: rb.skeletonRetired ?? 0,
    retired: rb.library?.counts?.retired ?? null,
    catalog: catalogStats(rb.library),
  }
  log(
    `  新退役骨架 ${rb.skeletonRetired ?? 0} 条 · 目录 ${report.afterRebuild.catalog.total} 条 / ` +
      `骨架 ${report.afterRebuild.catalog.skeletons}（${pct(report.afterRebuild.catalog.ratio)}）`
  )
  report.notes.push(stopReason || `本地引擎跑完 ${calls} 个会话`)
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(join(root, 'library.json'))) throw new Error(`书库根不对：${root} 下没有 library.json`)

  const report = {
    at: new Date().toISOString(),
    mode: statsOnly ? 'stats-only' : doRun ? 'run' : 'dry-run',
    root,
    host,
    batchSize,
    threshold,
    before: null,
    afterRebuild: null,
    after: null,
    plan: null,
    estimate: null,
    batches: [],
    usage: { calls: 0, judgeCalls: 0, promptChars: 0, completionChars: 0 },
    attempted: {},
    failures: [],
    notes: [],
  }

  const beforeLib = readLibrary()
  report.before = { catalog: catalogStats(beforeLib), disk: diskStats(root) }

  log('═'.repeat(68))
  log(`书阁 · 批量重提炼统计骨架（${report.mode}）`)
  log(`库根：${root}`)
  log(`宿主：${host}`)
  log('─'.repeat(68))
  log('【前】目录可见条目 / 骨架：')
  log(
    `  ${report.before.catalog.total} 条 · 骨架 ${report.before.catalog.skeletons} 条 · ` +
      `占比 ${pct(report.before.catalog.ratio)}`
  )
  log(
    `  磁盘：${report.before.disk.total} 文件 / current ${report.before.disk.current} / ` +
      `expired ${report.before.disk.expired} · current 骨架 ${report.before.disk.currentSkeletons}`
  )
  if (report.before.disk.badFiles.length) {
    log(`  ⚠ 读不出的条目文件 ${report.before.disk.badFiles.length} 个（health 会报，本脚本不处理）`)
  }

  if (statsOnly) {
    saveJson(`stats-${stamp}.json`, report)
    flushLog()
    log('\n（--stats-only，结束）')
    return report
  }

  // ── 本地引擎：官方 DeepSeek API ────────────────────────────
  if (engine === 'deepseek') {
    report.mode = doRun ? 'run+deepseek' : 'dry-run+deepseek'
    await runDeepSeekEngine(report, null)
    finalizeReport(report, { estimate: report.estimate, stoppedReason: report.notes[report.notes.length - 1] || '' })
    return report
  }

  // ── 预检 ────────────────────────────────────────────────────
  let plan = await fetchPlan()
  report.plan = summarizePlan(plan)
  const estimate = estimateText(plan)
  report.estimate = estimate
  const state = readDistillState()
  const alreadyTried = retryAttempted ? new Set() : attemptedSids(state)

  if (!doRun) {
    // dry-run 不写盘，所以「并发产生的新会话」此刻还没拿到 T0 骨架。
    // 只提示，不拦截 —— 真跑会先重扫，它们会先变成骨架会话再加入队列。
    const local = localEligibleQueue()
    const skelMap = skeletonSessions(root)
    const nonSkeleton = local.queue.filter((s) => !skelMap.get(s.sid)?.skeletonIds?.length)
    log('')
    log('【预检】/api/distill/plan + 本地 selectQueue')
    log(
      `  宿主队列 ${plan.queue ?? '?'} / 宿主合格 ${plan.stats?.eligible ?? '?'} · ` +
        `本地合格 ${local.queue.length}（其中 ${nonSkeleton.length} 个是本次重扫前还没有骨架的新会话）· ` +
        `已提炼跳过 ${plan.stats?.skippedByReason?.['already-distilled'] ?? '?'} · ` +
        `空产出退避 ${plan.stats?.skippedByReason?.['too-many-empty'] ?? '?'}`
    )
    log(
      `  预估：${estimate.calls ?? '?'} 次 LLM 调用（按宿主当次队列）· 输入约 ${estimate.inputChars ?? '?'} 字符 ` +
        `（≈${estimate.tokensLow ?? '?'}–${estimate.tokensHigh ?? '?'} token）`
    )
    if (nonSkeleton.length > 0) {
      log(
        `  提示：真跑会先重扫，这 ${nonSkeleton.length} 个新会话会获得 T0 骨架并被一并列入队列 —— ` +
          '它们不是"伪造"的骨架，而是并发会话的占位条目；日志会逐个标出。'
      )
    }
    saveJson(`dry-run-${stamp}.json`, report)
    flushLog()
    log('')
    log('（dry-run：未调用 LLM、未写书库。确认后加 --run 真跑）')
    return report
  }

  // ── 真跑：先重扫（退役历史骨架 + 给新会话补 T0 骨架），再逐轮提炼 ──
  log('')
  log('【步骤 1/3】建库重扫（同会话已有真结论的骨架会被自动退役）')
  const rebuild0 = await localRebuild()
  report.afterRebuild = {
    skeletonRetired: rebuild0.skeletonRetired ?? 0,
    retired: rebuild0.library?.counts?.retired ?? null,
    catalog: catalogStats(rebuild0.library),
  }
  log(
    `  本轮新退役骨架 ${report.afterRebuild.skeletonRetired} 条 · 现存 retired ${report.afterRebuild.retired} · ` +
      `目录 ${report.afterRebuild.catalog.total} 条 / 骨架 ${report.afterRebuild.catalog.skeletons}（${pct(
        report.afterRebuild.catalog.ratio
      )}）`
  )

  // 重扫后再核对一次：此刻队列里的每个会话都应已有骨架（T0 轨给每个 real 会话建骨架）
  const localInitial = localEligibleQueue()
  const localInitialSids = new Set(localInitial.queue.map((s) => s.sid))
  const skelMap0 = skeletonSessions(root)
  const nonSkeleton = localInitial.queue.filter((s) => !skelMap0.get(s.sid)?.skeletonIds?.length)
  const hostWill = Array.isArray(plan.willDistill) ? plan.willDistill : []
  const hostMismatch = hostWill.filter((s) => !localInitialSids.has(s.sid))

  log('')
  log('【预检】重扫后的本地 selectQueue')
  log(
    `  本地合格 ${localInitial.queue.length} · 其中骨架会话 ${localInitial.queue.length - nonSkeleton.length} · ` +
      `已提炼跳过 ${plan.stats?.skippedByReason?.['already-distilled'] ?? '?'} · ` +
      `空产出退避 ${plan.stats?.skippedByReason?.['too-many-empty'] ?? '?'}`
  )
  if (hostMismatch.length > 0) {
    const msg =
      `宿主 willDistill 里有 ${hostMismatch.length} 个会话不在本地合格队列中（例：${hostMismatch
        .slice(0, 3)
        .map((s) => s.sid)
        .join(', ')}）—— 宿主状态与磁盘不一致，拒绝继续（避免跑错会话）。`
    log(`  ✗ ${msg}`)
    throw new Error(msg)
  }
  if (nonSkeleton.length > 0) {
    const msg =
      `重扫后仍有 ${nonSkeleton.length} 个合格会话没有骨架条目（例：${nonSkeleton
        .slice(0, 3)
        .map((s) => s.sid)
        .join(', ')}）。run 端点不能按 sid 选择，继续会提炼它们 —— 默认拒绝花钱。`
    log(`  ✗ ${msg}`)
    if (!allowNonSkeleton) throw new Error(msg)
    log('  （已显式 --allow-non-skeleton，继续）')
  }

  const attempted = new Map() // sid -> { runs:[i], batchFailed:boolean }
  const attemptedSidsSet = new Set()
  const usedRuns = []
  let stoppedReason = null

  for (let round = 0; round < maxBatches; round++) {
    plan = await fetchPlan()
    if (plan.busy) {
      log('  宿主正有一轮提炼在跑，等待 10s…')
      await new Promise((r) => setTimeout(r, 10_000))
      continue
    }
    const skelMap = skeletonSessions(root)
    const local = localEligibleQueue()
    if (local.queue.length === 0) {
      stoppedReason = '本地合格队列为空：没有可提炼的会话了'
      break
    }

    // 还没试过、且确实只有骨架的会话
    const targets = local.queue.filter(
      (s) => skelMap.get(s.sid)?.skeletonIds?.length && !attemptedSidsSet.has(s.sid) && !alreadyTried.has(s.sid)
    )
    if (targets.length === 0) {
      stoppedReason = '没有「只有骨架且未尝试」的合格会话了'
      break
    }

    // run 端点按优先级取前 N 个，不能指定 sid。若只跑一部分，本轮空产出的会话
    // 会排到未跑会话前面导致重试白花钱 —— 所以小队列一次跑完。
    const eligible = local.queue.length
    const coalesced = eligible <= 25
    const limit = coalesced ? Math.min(eligible, 50) : Math.min(batchSize, eligible, 50)
    if (coalesced && limit > batchSize) {
      log(`  ⚠ eligible=${eligible} ≤ 25：一次跑完（limit=${limit}），避免空产出会话把未跑会话挤出队首`)
    }

    // 本轮队首（宿主会按同一优先级取前 limit 个）里不能混入"已经试过"的会话，
    // 否则就是在重复烧钱。发现即停，保留骨架，等下一次显式 --retry-attempted。
    const batch = local.queue.slice(0, limit)
    const retryInBatch = batch.filter((s) => attemptedSidsSet.has(s.sid) || alreadyTried.has(s.sid))
    if (retryInBatch.length > 0) {
      stoppedReason =
        `下一轮队首会重试 ${retryInBatch.length} 个已尝试过的会话（端点无法只跑未试过的），` +
        '为避免重复计费已停止；剩余骨架保留'
      log(`  ✗ ${stoppedReason}`)
      break
    }
    const nonSkelInBatch = batch.filter((s) => !skelMap.get(s.sid)?.skeletonIds?.length)
    if (nonSkelInBatch.length > 0 && !allowNonSkeleton) {
      stoppedReason = `本轮队首混入 ${nonSkelInBatch.length} 个非骨架会话，已停止（防止顺带重提）`
      log(`  ✗ ${stoppedReason}`)
      break
    }

    log('')
    log(`【步骤 2/3】第 ${round + 1} 轮提炼 · limit=${limit} · 目标骨架会话 ${targets.length} 个`)
    const t0 = Date.now()
    const { status, json: runJson } = await api(`/dsh-manuscript/api/distill/run?limit=${limit}`, {
      method: 'POST',
      timeout: timeoutMs,
    })
    const ms = Date.now() - t0
    const runRecord = {
      round: round + 1,
      request: { limit },
      httpStatus: status,
      ms,
      ok: runJson?.ok === true,
      status: runJson?.status ?? null,
      busy: runJson?.busy === true,
      runId: runJson?.runId ?? null,
      queue: runJson?.queue ?? null,
      proposals: runJson?.proposals ?? null,
      entries: Array.isArray(runJson?.entries) ? runJson.entries.length : 0,
      entriesRejected: runJson?.entriesRejected ?? null,
      droppedProposals: runJson?.droppedProposals ?? null,
      failures: runJson?.failures ?? null,
      accounting: runJson?.accounting ?? null,
      usage: runJson?.usage ?? null,
      // 语义判重的额外 LLM 调用（不在 usage.calls 里，但同样计费）
      llmJudged: runJson?.adjudication?.stats?.llmJudged ?? null,
      error: runJson?.error ?? null,
    }
    report.batches.push(runRecord)
    saveJson(`run-${String(round + 1).padStart(2, '0')}-${runJson?.runId || stamp}.json`, {
      at: new Date().toISOString(),
      request: { limit },
      response: runJson,
    })
    log(
      `  HTTP ${status} · ${ms}ms · status=${runJson?.status || '?'} · runId=${runJson?.runId || '?'} · ` +
        `proposals ${runJson?.proposals ?? '?'} · 可入册 ${runRecord.entries}`
    )
    if (runJson?.usage) {
      report.usage.calls += Number(runJson.usage.calls) || 0
      report.usage.promptChars += Number(runJson.usage.promptChars) || 0
      report.usage.completionChars += Number(runJson.usage.completionChars) || 0
    }
    const judgedAsked = Number(runJson?.adjudication?.stats?.llmJudged?.asked)
    if (Number.isFinite(judgedAsked)) report.usage.judgeCalls += judgedAsked
    if (runJson?.error) log(`  ✗ error：${runJson.error}`)

    // 记录本轮尝试过的会话（用于幂等与失败归因）
    for (const s of batch) {
      attemptedSidsSet.add(s.sid)
      const rec = attempted.get(s.sid) || { runs: [], batchFailed: false }
      rec.runs.push(round + 1)
      attempted.set(s.sid, rec)
    }
    const batchFailedSids = new Set(
      (Array.isArray(runJson?.failures) ? runJson.failures : []).flatMap((f) => f?.sids || []).filter(Boolean)
    )
    for (const sid of batchFailedSids) {
      const rec = attempted.get(sid) || { runs: [round + 1], batchFailed: false }
      rec.batchFailed = true
      attempted.set(sid, rec)
    }
    if (runJson?.busy) {
      stoppedReason = '宿主报告正在提炼（busy），已停止'
      break
    }

    // ── 入册 ──
    let commitOk = false
    if (Array.isArray(runJson?.entries) && runJson.entries.length > 0 && doCommit) {
      log(`  【步骤 3/3】入册 ${runJson.entries.length} 条…`)
      const { status: cs, json: cj } = await api('/dsh-manuscript/api/distill/commit', {
        method: 'POST',
        body: { entries: runJson.entries },
        timeout: timeoutMs,
      })
      commitOk = cj?.ok === true
      saveJson(`commit-${String(round + 1).padStart(2, '0')}-${stamp}.json`, {
        at: new Date().toISOString(),
        httpStatus: cs,
        response: cj,
      })
      log(
        `  HTTP ${cs} · 写入 ${cj?.written ?? '?'} · 跳过 ${cj?.skipped ?? '?'}` +
          (cj?.reason ? ` · ${cj.reason}` : '')
      )
      if (!commitOk) {
        // 绝不能丢：proposal 已在 run-*.json 里留了原文，这里再单独存一份可入册数组
        saveJson(`uncommitted-${String(round + 1).padStart(2, '0')}-${stamp}.json`, {
          at: new Date().toISOString(),
          entries: runJson.entries,
        })
        stoppedReason = `入册失败（HTTP ${cs}：${cj?.error || cj?.reason || '未知'}），proposal 已存档，停止以免丢失`
        log(`  ✗ ${stoppedReason}`)
        break
      }
    } else if (Array.isArray(runJson?.entries) && runJson.entries.length > 0 && !doCommit) {
      saveJson(`uncommitted-${String(round + 1).padStart(2, '0')}-${stamp}.json`, {
        at: new Date().toISOString(),
        entries: runJson.entries,
      })
      log('  （--no-commit：条目已存档，未入册）')
    } else {
      log('  （本轮无新条目可入册）')
    }

    // ── 重扫：让新入册的真结论把骨架退役 ──
    log('  重扫建库（应用骨架退役）…')
    const rb = await localRebuild()
    const cat = catalogStats(rb.library)
    log(
      `  新退役骨架 ${rb.skeletonRetired ?? 0} 条 · 目录 ${cat.total} 条 / 骨架 ${cat.skeletons}（${pct(cat.ratio)}）`
    )

    usedRuns.push({ round: round + 1, runId: runJson?.runId, entries: runRecord.entries, skeletonRetired: rb.skeletonRetired ?? 0 })

    // 失败批若整轮 0 产出，继续跑大概率还是同一个错误 —— 停下，骨架保留
    if (Array.isArray(runJson?.failures) && runJson.failures.length > 0 && (runJson?.proposals || 0) === 0) {
      stoppedReason = `本轮 ${runJson.failures.length} 个批次失败、0 产出，停止（失败会话保留骨架）`
      log(`  ✗ ${stoppedReason}`)
      break
    }
  }

  if (!stoppedReason) stoppedReason = `达到 --max-batches=${maxBatches} 上限`
  report.notes.push(stoppedReason)

  // 用最近一次 build 的库做最终统计（循环里已重扫；这里再读磁盘保证是真相）
  finalizeReport(report, {
    estimate,
    attempted,
    usedRuns,
    stoppedReason,
  })
  return report
}

/**
 * 统一收尾：从磁盘现读最终占比、逐会话归因、打印摘要、落报告。
 * host 引擎与 deepseek 引擎共用，避免两套数字口径漂移。
 */
function finalizeReport(report, { estimate = null, attempted = null, usedRuns = [], stoppedReason = '' } = {}) {
  const afterLib = readLibrary()
  report.after = { catalog: catalogStats(afterLib), disk: diskStats(root) }
  const skelMapEnd = skeletonSessions(root)
  const remainingSkeletonSessions = [...skelMapEnd.values()].filter((b) => b.skeletonIds.length > 0).length

  let success = 0
  let failedSessions = 0
  let noContent = 0
  let rounds = usedRuns.length
  let attemptedCount = 0

  if (attempted instanceof Map) {
    // host 引擎：按轮次与批次失败归因
    attemptedCount = attempted.size
    for (const [sid, rec] of attempted) {
      const stillSkeleton = (skelMapEnd.get(sid)?.skeletonIds?.length || 0) > 0
      const hasReal = (skelMapEnd.get(sid)?.distilledIds?.length || 0) > 0
      if (hasReal) success += 1
      else if (rec.batchFailed) failedSessions += 1
      else if (stillSkeleton) noContent += 1
      report.attempted[sid] = {
        runs: rec.runs,
        batchFailed: rec.batchFailed,
        outcome: hasReal ? 'distilled' : rec.batchFailed ? 'failed' : stillSkeleton ? 'empty' : 'unknown',
      }
    }
  } else if (report.local?.summary) {
    // deepseek 引擎：逐会话结果已在 report.local.results 里
    const ls = report.local.summary
    success = ls.success
    failedSessions = ls.failed
    noContent = ls.empty + ls.rejected
    attemptedCount = ls.calls
    rounds = 1
    for (const r of report.local.results || []) {
      if (r.sid) report.attempted[r.sid] = { runs: [1], batchFailed: r.outcome === 'failed', outcome: r.outcome }
    }
  }

  report.summary = {
    beforeRatio: report.before.catalog.ratio,
    afterRatio: report.after.catalog.ratio,
    beforeSkeletons: report.before.catalog.skeletons,
    afterSkeletons: report.after.catalog.skeletons,
    beforeTotal: report.before.catalog.total,
    afterTotal: report.after.catalog.total,
    threshold,
    met: report.after.catalog.ratio != null && report.after.catalog.ratio < threshold,
    rounds,
    attempted: attemptedCount,
    success,
    failedSessions,
    noContent,
    remainingSkeletonSessions,
    usage: report.usage,
    failedBatches: (report.batches || []).reduce((a, b) => a + (Array.isArray(b.failures) ? b.failures.length : 0), 0),
  }

  log('')
  log('═'.repeat(68))
  log('【后】结果')
  log(
    `  目录：${report.after.catalog.total} 条 · 骨架 ${report.after.catalog.skeletons} 条 · ` +
      `占比 ${pct(report.after.catalog.ratio)}（目标 < ${pct(threshold)}）→ ${report.summary.met ? '达标' : '未达标'}`
  )
  log(
    `  磁盘：${report.after.disk.total} 文件 / current ${report.after.disk.current} / expired ${report.after.disk.expired} · ` +
      `current 骨架 ${report.after.disk.currentSkeletons}`
  )
  log(
    `  提炼：${rounds} 轮 · 尝试 ${attemptedCount} 个会话 · 成功 ${success} · ` +
      `失败 ${failedSessions} · 无产出/未通过 ${noContent}`
  )
  log(`  仍只有骨架的会话：${remainingSkeletonSessions}（失败的保留骨架不动）`)
  if (stoppedReason) log(`  停止原因：${stoppedReason}`)
  for (const line of formatCost(report.usage, estimate)) log(`  ${line}`)

  const reportPath = saveJson(`report-${stamp}.json`, report)
  saveJson('latest.json', report)
  flushLog()
  if (reportPath) log(`\n报告：${reportPath}\n日志：${logFile}`)
  return report
}

function summarizePlan(plan) {
  return {
    ok: plan?.ok === true,
    busy: plan?.busy === true,
    queue: plan?.queue ?? null,
    remaining: plan?.remaining ?? null,
    realTotal: plan?.realTotal ?? null,
    scannedAt: plan?.scannedAt ?? null,
    stale: plan?.stale === true,
    currentModel: plan?.currentModel ?? null,
    currentProvider: plan?.currentProvider ?? null,
    stats: plan?.stats ?? null,
    plan: plan?.plan ?? null,
    willDistill: (plan?.willDistill || []).map((s) => ({
      sid: s.sid,
      title: s.title,
      admission: s.admission,
      shape: s.shape,
      qualityScore: s.qualityScore,
    })),
  }
}

try {
  await main()
} catch (e) {
  log('')
  log(`✗ 失败：${e?.message || e}`)
  flushLog()
  process.exitCode = 1
}
