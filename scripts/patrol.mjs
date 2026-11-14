#!/usr/bin/env node
/**
 * 书阁每日巡检（2026-11-12）
 *
 * ## 为什么需要
 *
 * 书阁的价值全在「召回可信」：该命中的要命中，不该命中的必须 0 命中。
 * 这两件事都可能**悄悄退化** —— 改一次打分权重、删一条条目、建库漏掉一章，
 * 界面照常打开、目录照常渲染，只有真正去查的时候才发现查不到了。
 * 所以每天用固定的一小组「金标准」跑一遍，退化当天就能知道。
 *
 * ## 巡检三件事
 *
 *   1. 正向回归：5 条写死的 query，各自必须命中写死的 entry id（top 8 内）。
 *   2. 负控：3 条库里不可能有记录的 query，必须 0 命中（fail-closed）。
 *   3. 全量测试：`node scripts/test-all.mjs`，任何一份失败都算退化。
 *
 * 任一不满足即 `ok=false`，退出码 1；推送桥失败退出码 2。
 *
 * ## 边界（重要）
 *
 * - **只读**：只读 `<root>/library.json`，不建库、不写 entries、不碰 runs。
 * - 唯一的写盘是巡检自身的状态文件（默认 `~/.local/state/shuge-patrol/last.json`），
 *   用于留证与排错，不在手册库内。
 * - 正向/负控直接复用插件的 `matchEntries`（topK=8，与 `manual_recall` 一致），
 *   不另写一套匹配逻辑 —— 否则巡检通过的可能是另一套算法。
 *
 * ## 用法
 *
 *   node scripts/patrol.mjs                 # 人类摘要 + 一行 JSON，并推送
 *   node scripts/patrol.mjs --json          # 只输出 JSON（机器消费）
 *   node scripts/patrol.mjs --no-push       # 不推送（调试用）
 *   node scripts/patrol.mjs --root <dir>    # 指定库目录（默认 $DSH_MANUSCRIPT_ROOT 或 ~/.dsh/dsh-manuscript）
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { matchEntries } from '../lib/index.js'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/**
 * 推送桥（systemd user 服务 weixin-push-bridge.service，常驻 127.0.0.1:8199）。
 * 可用 SHUGE_PATROL_PUSH_URL 覆盖 —— 仅用于自测告警文案（指向假桥），生产别改。
 */
const PUSH_URL = process.env.SHUGE_PATROL_PUSH_URL || 'http://127.0.0.1:8199/push'

/** 单条微信消息的硬上限（按字符数，不是字节）。 */
const PUSH_MAX_CHARS = 100

/**
 * 正向金标准：query 必须把 expected 条目召回到 top 8 内。
 *
 * 选条标准：
 *   · 都是**真结论**（claim 是完整事实，不是「N 轮 · M 次调用」的骨架）；
 *   · 覆盖不同册（VOL.01 / VOL.03 / VOL.05 / VOL.07），避免只测一个章节；
 *   · query 是人工写的自然问法，不是标题原文照抄 —— 照抄标题测不出退化。
 */
const POSITIVE = [
  {
    query: 'web_search agentbrowser exit code 1 崩溃',
    expected: 'e-sessiond931c-2',
    note: 'VOL.01 · web_search 子进程崩溃',
  },
  {
    query: 'read_image 8192 像素 报错',
    expected: 'e-session152c4',
    note: 'VOL.03 · read_image 单边上限',
  },
  {
    query: '微信 发送完成 没有返回 DNS',
    expected: 'e-sessionb495f',
    note: 'VOL.05 · 微信通道静默失败',
  },
  {
    query: 'MinerU standard 档 图片 PDF flash',
    expected: 'e-sessiona29f0',
    note: 'VOL.05 · MinerU 档位限制',
  },
  {
    query: '本地 27B 模型上下文 256000 超时',
    expected: 'e-session6fb26',
    note: 'VOL.07 · 大上下文长任务超时',
  },
]

/**
 * 负控：手册里确实没有这些主题，必须 0 命中。
 *
 * 选法：拿「真实存在但与本项目无关」的技术主题，而不是乱码。
 * 乱码只能测出「匹配器不会返回随机结果」，测不出「会不会因为通用词假召回」。
 */
const NEGATIVE = [
  'Kubernetes ingress 证书轮换',
  'PostgreSQL 主从复制延迟',
  'Rust 所有权 生命周期',
]

const fmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

function timeParts(d = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]))
  return p
}

function stamp(d = new Date()) {
  const p = timeParts(d)
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`
}

function fullTime(d = new Date()) {
  const p = timeParts(d)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

function parseArgs(argv) {
  const opts = {
    json: false,
    push: true,
    root: process.env.DSH_MANUSCRIPT_ROOT || join(homedir(), '.dsh', 'dsh-manuscript'),
    stateDir: process.env.SHUGE_PATROL_STATE || join(homedir(), '.local', 'state', 'shuge-patrol'),
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--no-push') opts.push = false
    else if (a === '--root') opts.root = argv[++i]
    else if (a.startsWith('--root=')) opts.root = a.slice('--root='.length)
    else if (a === '--state-dir') opts.stateDir = argv[++i]
    else if (a.startsWith('--state-dir=')) opts.stateDir = a.slice('--state-dir='.length)
    else if (a === '--help' || a === '-h') {
      console.log('用法：node scripts/patrol.mjs [--json] [--no-push] [--root <dir>] [--state-dir <dir>]')
      process.exit(0)
    } else {
      throw new Error(`未知参数：${a}`)
    }
  }
  return opts
}

/**
 * 从 library.json 造一个 matchEntries 认识的 snapshot。
 *
 * 插件的 snapshot 来自 scan+buildLibrary；这里直接吃建库产物，避免巡检自己再建一次库
 * （建库会写盘、要锁、还慢）。字段差异只有一处：library.json 里章列表叫 chapterList。
 */
function loadSnapshot(root) {
  const p = join(root, 'library.json')
  if (!existsSync(p)) throw new Error(`找不到 ${p}（库未建？）`)
  const library = JSON.parse(readFileSync(p, 'utf8'))
  if (!Array.isArray(library.volumes)) throw new Error('library.json 缺 volumes 数组')
  const volumes = library.volumes.map((v) => ({ ...v, chapters: v.chapterList || [] }))
  return {
    library,
    snapshot: { summary: { volumes } },
    generatedAt: library.generatedAt || null,
    counts: library.counts || null,
  }
}

/** 目录里是否有这个 entry id（防止金标准写错 id 导致永远失败/假通过）。 */
function catalogIds(snapshot) {
  const ids = new Set()
  for (const v of snapshot.summary.volumes) {
    for (const c of v.chapters) for (const e of c.entries) ids.add(e.id)
  }
  return ids
}

function checkPositive(snapshot, ids) {
  const items = POSITIVE.map(({ query, expected, note }) => {
    if (!ids.has(expected)) {
      return { query, expected, note, ok: false, rank: null, top: [], reason: '期望条目已不在目录中' }
    }
    const hits = matchEntries(snapshot, query, 8)
    const idx = hits.findIndex((h) => h.id === expected)
    return {
      query,
      expected,
      note,
      ok: idx >= 0,
      rank: idx >= 0 ? idx + 1 : null,
      top: hits.slice(0, 3).map((h) => ({ id: h.id, title: h.title, score: h.score })),
      reason: idx >= 0 ? null : hits.length ? '未进 top 8' : '0 命中',
    }
  })
  const passed = items.filter((x) => x.ok).length
  return { ok: passed === items.length, passed, total: items.length, items }
}

function checkNegative(snapshot) {
  const items = NEGATIVE.map((query) => {
    const hits = matchEntries(snapshot, query, 8)
    return {
      query,
      ok: hits.length === 0,
      hits: hits.map((h) => ({ id: h.id, title: h.title, score: h.score })),
    }
  })
  const passed = items.filter((x) => x.ok).length
  return { ok: passed === items.length, passed, total: items.length, items }
}

/**
 * 跑全量测试。
 *
 * 判定口径与 test-all 自身一致：退出码 0 **且**能解析出汇总行且失败数为 0。
 * 只解析不到汇总行 = 失败（fail-closed）—— 否则输出格式一改，巡检会假装通过。
 */
async function checkTests() {
  const started = Date.now()
  let stdout = ''
  let stderr = ''
  let code = 0
  let reason = null
  try {
    const r = await run(process.execPath, [join(repoRoot, 'scripts', 'test-all.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    })
    stdout = r.stdout
    stderr = r.stderr
  } catch (e) {
    code = typeof e.code === 'number' ? e.code : 1
    stdout = String(e.stdout || '')
    stderr = String(e.stderr || '')
    reason = e.killed ? `测试超时（30 分钟）` : `测试进程异常退出（exit=${code}）`
  }
  const seconds = Number(((Date.now() - started) / 1000).toFixed(1))

  const m = /跑了\s+(\d+)\s+份脚本\s+·\s+(\d+)\s+通过\s+\/\s+(\d+)\s+失败(?:\s+\/\s+(\d+)\s+跳过)?\s+·\s+([\d.]+)s/.exec(stdout)
  if (!m) {
    return {
      ok: false,
      suites: null,
      passed: 0,
      failed: null,
      skipped: 0,
      total: 0,
      seconds,
      failedSuites: [],
      reason: reason || '无法解析 test-all 汇总行（输出格式变了？）',
      tail: stdout.trim().split('\n').slice(-6),
    }
  }
  const failedSuites = []
  const fm = /失败的脚本：(.+)/.exec(stdout)
  if (fm) for (const s of fm[1].split(',')) failedSuites.push(s.trim())
  if (failedSuites.length === 0) {
    // 没有汇总行时从逐行结果兜底提取，保证「含失败项」。
    for (const line of stdout.split('\n')) {
      const x = /^✗\s+(\S+)/.exec(line.trim())
      if (x) failedSuites.push(x[1])
    }
  }
  const failed = Number(m[3])
  const ok = code === 0 && failed === 0 && failedSuites.length === 0
  return {
    ok,
    suites: Number(m[1]),
    passed: Number(m[2]),
    failed,
    skipped: Number(m[4] || 0),
    total: Number(m[2]) + failed,
    seconds: Number(m[5]) || seconds,
    failedSuites,
    reason: ok ? null : reason || `失败脚本：${failedSuites.join(', ') || `${failed} 项断言失败`}`,
    tail: ok ? [] : stdout.trim().split('\n').slice(-6),
  }
}

function clip(text, max = PUSH_MAX_CHARS) {
  const chars = [...String(text)]
  return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('') + '…'
}

/**
 * 推送文案：成功只报三组数字；失败只列**失败**类别，且把失败项名字带上。
 * 硬上限 100 字符（中文按 1 字算）—— 超了才截断，截断处标 `…`。
 */
export function buildPushText(report) {
  const s = stamp(new Date(report.at))
  if (report.ok) {
    return clip(
      `书阁巡检✅ ${s} 正例${report.positive.passed}/${report.positive.total} ` +
        `负控${report.negative.passed}/${report.negative.total} ` +
        `测试${report.tests.suites}份全过(${report.tests.seconds}s)`,
    )
  }
  const parts = [`书阁巡检❌ ${s}`]
  if (report.error) {
    parts.push(`巡检异常:${report.error}`)
  } else {
    const pos = report.positive
    if (!pos.ok) {
      const missing = pos.items.filter((x) => !x.ok).map((x) => x.expected)
      parts.push(
        missing.length === 1
          ? `正例${pos.passed}/${pos.total}缺${missing[0]}`
          : `正例${pos.passed}/${pos.total}缺${missing.length}条[${missing[0]}等]`,
      )
    }
    const neg = report.negative
    if (!neg.ok) {
      const bad = neg.items.filter((x) => !x.ok).length
      parts.push(`负控${neg.passed}/${neg.total}假召回${bad}条`)
    }
    const t = report.tests
    if (!t.ok) {
      const names = t.failedSuites.map((x) => x.replace(/\.mjs$/, ''))
      const detail = names.length
        ? `${names.slice(0, 3).join(',')}${names.length > 3 ? `等${names.length}份` : ''}`
        : `${t.failed ?? '?'}项断言`
      parts.push(`测试${t.passed}/${t.suites ?? '?'}失败${detail}`)
    }
  }
  return clip(parts.join(' '))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 调本机推送桥。成功必须同时满足 HTTP 2xx 且响应不是 `{"sent":false}`；
 * 只看 HTTP 200 会漏掉「服务端收下了但没投递」的情况。
 */
async function pushWeixin(text, attempts = 3) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(20_000),
      })
      const raw = await res.text()
      let body = null
      try {
        body = JSON.parse(raw)
      } catch {
        /* 非 JSON 响应按失败处理，原文留在 body 里 */
      }
      if (res.ok && body && body.sent !== false) {
        return { ok: true, text, status: res.status, messageId: body.messageId ?? null, attempts: i + 1 }
      }
      last = { ok: false, text, status: res.status, body: raw.slice(0, 300), attempts: i + 1 }
    } catch (e) {
      last = { ok: false, text, error: e?.message || String(e), attempts: i + 1 }
    }
    if (i < attempts - 1) await sleep(1000 * (i + 1))
  }
  return last || { ok: false, text, error: '未发出请求' }
}

function renderHuman(report) {
  const lines = []
  lines.push(`书阁巡检 · ${fullTime(new Date(report.at))} · ${report.root}`)
  lines.push(`结论：${report.ok ? '✅ 正常' : '❌ 退化'}`)
  if (report.error) lines.push(`巡检异常：${report.error}`)

  const p = report.positive
  lines.push(`\n正向回归 ${p.passed}/${p.total}`)
  for (const x of p.items) {
    const mark = x.ok ? '✓' : '✗'
    const where = x.ok ? `rank ${x.rank}` : x.reason
    lines.push(`  ${mark} ${x.query} → ${x.expected}（${where}）`)
    if (!x.ok && x.top.length) {
      lines.push(`      实际 top: ${x.top.map((h) => `${h.id}(${h.score})`).join(', ')}`)
    }
  }

  const n = report.negative
  lines.push(`\n负控 ${n.passed}/${n.total}（要求 0 命中）`)
  for (const x of n.items) {
    const mark = x.ok ? '✓' : '✗'
    lines.push(`  ${mark} ${x.query}${x.ok ? '' : ` → 假召回 ${x.hits.length} 条: ${x.hits.map((h) => h.id).join(', ')}`}`)
  }

  const t = report.tests
  lines.push(`\n全量测试 ${t.ok ? '✓' : '✗'}`)
  if (t.suites != null) {
    lines.push(
      `  跑了 ${t.suites} 份 · ${t.passed} 通过 / ${t.failed} 失败` +
        (t.skipped ? ` / ${t.skipped} 跳过` : '') +
        ` · ${t.seconds}s`,
    )
  }
  if (!t.ok) {
    lines.push(`  原因：${t.reason}`)
    if (t.failedSuites.length) lines.push(`  失败脚本：${t.failedSuites.join(', ')}`)
    for (const l of t.tail || []) lines.push(`  | ${l}`)
  }

  if (report.push) {
    lines.push(
      `\n推送：${report.push.ok ? 'sent=true' : 'sent=false'} ` +
        (report.push.ok ? `messageId=${report.push.messageId ?? '(缺)'}` : `原因=${report.push.error || report.push.body || report.push.status || '未知'}`),
    )
    lines.push(`  文本：${report.push.text}`)
  }

  lines.push(`\nJSON: ${JSON.stringify(report)}`)
  return lines.join('\n')
}

async function runPatrol(opts) {
  const report = {
    patrol: 'shuge-daily',
    version: 1,
    at: new Date().toISOString(),
    root: resolve(opts.root),
    ok: false,
    error: null,
    library: null,
    positive: null,
    negative: null,
    tests: null,
    push: null,
  }

  const { snapshot, generatedAt, counts } = loadSnapshot(report.root)
  report.library = {
    generatedAt,
    volumes: snapshot.summary.volumes.length,
    entries: counts?.entries ?? null,
  }

  report.positive = checkPositive(snapshot, catalogIds(snapshot))
  report.negative = checkNegative(snapshot)
  report.tests = await checkTests()

  report.ok = report.positive.ok && report.negative.ok && report.tests.ok
  return report
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  let report
  try {
    report = await runPatrol(opts)
  } catch (e) {
    report = {
      patrol: 'shuge-daily',
      version: 1,
      at: new Date().toISOString(),
      root: resolve(opts.root),
      ok: false,
      error: e?.message || String(e),
      library: null,
      positive: { ok: false, passed: 0, total: POSITIVE.length, items: [] },
      negative: { ok: false, passed: 0, total: NEGATIVE.length, items: [] },
      tests: { ok: false, suites: null, passed: 0, failed: null, skipped: 0, total: 0, seconds: 0, failedSuites: [], reason: '巡检未跑到测试阶段', tail: [] },
      push: null,
    }
  }

  if (opts.push) {
    report.push = await pushWeixin(buildPushText(report))
  }

  // 留证：状态文件在库外，便于事后看「昨天到底哪条失败了」。
  try {
    mkdirSync(opts.stateDir, { recursive: true })
    writeFileSync(join(opts.stateDir, 'last.json'), JSON.stringify(report, null, 2) + '\n')
  } catch {
    /* 状态文件写不了不影响巡检结论；journal 里仍有完整输出 */
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderHuman(report))
  }

  // 退出码：0 全好；1 手册/测试退化；2 巡检本身正常但推送失败（告警通道坏了也是故障）。
  if (!report.ok) process.exit(1)
  if (report.push && !report.push.ok) process.exit(2)
  process.exit(0)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
