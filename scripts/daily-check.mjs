#!/usr/bin/env node
/**
 * 书阁每日巡检（2026-11-12）
 *
 * ## 为什么需要
 *
 * 书阁的召回质量靠两条腿：**正向召回**（手册里真有的问题必须查得到）
 * 和**负控**（手册里没有的问题必须查不到，fail-closed）。只跑测试套件不够 ——
 * 测试用的是临时 fixture，测不出线上 `data/` 目录里 300+ 条目的真实召回表现。
 * 所以每天对**正在运行的 3080 服务**做一次黑盒回归 + 跑一遍全量测试。
 *
 * ## 它做什么（四段，全部只读）
 *
 * 1. 正向集：8 条手册里确实有答案的问题，每条必须命中写死的 entry id（top 8 内）；
 * 2. 负控集：3 条手册里没有的问题，要求 `hits: []`（查到任何东西都算红）；
 * 3. claim-only 采样：从 `/summary` 目录里按固定步长抽 30 条，逐条读
 *    `/api/entry`，统计 `bodyIsClaim:true`（正文退化成一句话摘要）的占比。
 *    这是「能答率」基线：目标 <20%，当前（2026-11-12）实测约 57%，属历史遗留，
 *    所以**不作为每日硬红门槛**，只在比上次记录恶化 ≥5pt 时标红（否则每天永久红，
 *    红灯就失去信号意义）。原始数字仍然逐日记录，便于看趋势。
 * 4. 跑 `scripts/test-all.mjs`（26 份脚本，超时 10 分钟），取通过/失败计数。
 *
 * ## 失败即自证
 *
 * 汇总一句话（≤100 字）推微信；任一项红就在句首加「❌」并写明哪项、差多少。
 * 结果同时追加到 `~/.dsh/logs/manuscript-daily.jsonl`（一行一条 JSON），
 * 即使推送失败也先落日志 —— 微信桥挂了不能让巡检记录跟着丢。
 *
 * ## 它不做什么
 *
 * - 不写 `lib/`、不写 `data/`、不重启 3080/3082；只 GET，唯一写是日志文件；
 * - 不自动修数据；红了就是红了，交给人判断。
 *
 * 用法：
 *   node scripts/daily-check.mjs                # 全量巡检 + 推微信
 *   node scripts/daily-check.mjs --no-push      # 不推送（本地调试）
 *   node scripts/daily-check.mjs --skip-tests   # 跳过测试套件（只查召回）
 *   node scripts/daily-check.mjs --dry-run      # 只打印，不推送也不落日志
 *
 * 环境变量：
 *   MANUSCRIPT_BASE  默认 http://127.0.0.1:3080/dsh-manuscript/api
 *   PUSH_URL         默认 http://127.0.0.1:8199/push
 *   DAILY_LOG        默认 ~/.dsh/logs/manuscript-daily.jsonl
 *
 * 退出码：0 全绿；1 有红项（推送与日志已尽力完成）。
 */

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { appendFileSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')

const BASE = process.env.MANUSCRIPT_BASE || 'http://127.0.0.1:3080/dsh-manuscript/api'
const PUSH_URL = process.env.PUSH_URL || 'http://127.0.0.1:8199/push'
const LOG_PATH = process.env.DAILY_LOG || join(homedir(), '.dsh', 'logs', 'manuscript-daily.jsonl')
// 2026-11-12：巡检结果不再单独推微信，改为写这一行文件，由每天 08:30 的早间提醒一起带出。
const LATEST_PATH = process.env.DAILY_LATEST || join(homedir(), '.dsh', 'logs', 'manuscript-daily-latest.md')

const argv = new Set(process.argv.slice(2))
const NO_PUSH = argv.has('--no-push') || argv.has('--dry-run')
const SKIP_TESTS = argv.has('--skip-tests') || argv.has('--dry-run')
const DRY_RUN = argv.has('--dry-run')

/** 单次请求超时（毫秒）。服务在本机，8 秒足够；超时即视为该项失败，不重试。 */
const HTTP_TIMEOUT = 8000
/** 测试套件超时：10 分钟（正常约 22 秒，留足余量给慢机器）。 */
const TESTS_TIMEOUT_MS = 10 * 60 * 1000
/** claim-only 抽样条数。 */
const CLAIM_SAMPLE = 30
/** claim-only 变化多少个百分点算「恶化」（仅作提示，不单独硬红）。 */
const CLAIM_REGRESS_PT = 5

/**
 * 正向集：问题必须来自手册已记内容，且线上必须召回**指定条目**。
 * 每条附 `label`（汇总句里报缺时用，越短越好）与 `expect`（entry id）。
 *
 * 【为什么必须写死 id（2026-11-12）】原版只要求 `/api/search` 返回 ≥1 条命中。
 * 这漏掉了最危险的一种退化：查询命中了别的条目，而原先那条真结论跌出结果集 ——
 * 界面照样有结果、测试照样全绿，但用户再也查不到那条经验。
 * 只断「有结果」等于把「召回质量」降级成「接口没挂」。
 * 2026-11-12 已逐条实测：下列 id 均在各自 query 的 top 1。
 */
const POSITIVES = [
  { label: '插件重启', q: 'DSH 插件装完要不要重启', expect: 'e-sessionebf14' },
  { label: '先读后写', q: 'write 工具报 file has not been read 怎么处理', expect: 'e-sessionc1c39' },
  { label: 'GitHub超时', q: 'web_fetch 抓 GitHub 30 秒超时怎么绕', expect: 'e-sessionb9184' },
  { label: '无头截图', q: 'computer_screenshot frame grab timed out', expect: 'e-sessionadf82' },
  { label: 'clamped字段', q: '截断 clamped 字段', expect: 'e-cd67bf4c5f44' },
  { label: '定时巡检', q: '定时任务巡检怎么做', expect: 'e-sessionc9735' },
  { label: '显存容量', q: '本地模型显存不够怎么调', expect: 'e-session7755e' },
  { label: 'HMR热加载', q: 'HMR 热加载', expect: 'e-session22acc-2' },
]

/**
 * 负控集：手册里确实没有的内容。要求 fail-closed —— 返回任何命中都算红，
 * 因为那意味着召回在「瞎兜底」，正向命中也随之不可信。
 */
const NEGATIVES = [
  // 2026-11-12：手册已收录「Docker 137」这条经验，它不再是负控；换成库里确实没有的主题。
  { label: 'Rust生命周期', q: 'Rust 借用检查器的生命周期标注' },
  { label: 'Vulkan投机', q: 'Vulkan 投机解码参数' },
  { label: 'Nuxt缓存', q: 'Nuxt 3 SSR 缓存' },
]

/** 带超时的 fetch，返回解析后的 JSON；非 2xx 抛错。 */
async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT) })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('响应不是合法 JSON')
  }
}

/**
 * 抽 30 条目录条目 id。
 * 用**排序后定步长**而不是随机数：同一天重跑得到同一批样本，
 * 指标可比；条目增删时步长自适应，抽样覆盖面不会塌到某一册。
 */
function pickSampleIds(summary) {
  const ids = []
  const seen = new Set()
  for (const v of summary.volumes || []) {
    for (const c of v.chapters || []) {
      for (const e of c.entries || []) {
        if (e && e.id && !seen.has(e.id)) {
          seen.add(e.id)
          ids.push(e.id)
        }
      }
    }
  }
  ids.sort()
  if (ids.length <= CLAIM_SAMPLE) return ids
  const stride = Math.max(1, Math.floor(ids.length / CLAIM_SAMPLE))
  const out = []
  for (let i = 0; i < ids.length && out.length < CLAIM_SAMPLE; i += stride) out.push(ids[i])
  return out
}

/** 逐条读 /api/entry，数 bodyIsClaim。读不到的条目单独计数，不混进分母。 */
async function measureClaimOnly(summary) {
  const ids = pickSampleIds(summary)
  let claim = 0
  let read = 0
  let failed = 0
  for (const id of ids) {
    try {
      const j = await getJson(`${BASE}/entry?id=${encodeURIComponent(id)}`)
      if (!j.ok || !j.entry) throw new Error('bad payload')
      read += 1
      if (j.entry.bodyIsClaim === true) claim += 1
    } catch {
      failed += 1
    }
  }
  const ratio = read > 0 ? (claim / read) * 100 : null
  return { sampled: ids.length, read, claim, failed, ratio }
}

/** 跑测试套件，解析汇总行。超时/非零退出都算红，并带上原因。 */
function runTests() {
  return new Promise((resolve) => {
    const t0 = Date.now()
    execFile(
      process.execPath,
      [join(ROOT, 'scripts', 'test-all.mjs')],
      { cwd: ROOT, timeout: TESTS_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '') + String(stderr || '')
        const secs = Math.round((Date.now() - t0) / 1000)
        // 汇总行：`跑了 26 份脚本 · 866 通过 / 0 失败`；失败脚本名在下一行
        const m = out.match(/跑了\s*(\d+)\s*份脚本\s*·\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/)
        const failedScripts = out.match(/失败的脚本：(.+)/)?.[1]?.trim() || ''
        const timedOut = err && (err.killed === true || /timed? ?out|ETIMEDOUT/i.test(String(err.message || '')))
        return resolve({
          ok: !err && !!m && m[3] === '0',
          ran: m ? Number(m[1]) : 0,
          pass: m ? Number(m[2]) : 0,
          fail: m ? Number(m[3]) : 0,
          secs,
          failedScripts,
          error: err ? (timedOut ? `套件超时（>${TESTS_TIMEOUT_MS / 60000} 分钟）` : String(err.message || '').slice(0, 160)) : '',
        })
      }
    )
  })
}

/** 读上一行日志，用于算 claim-only 的环比。日志坏了就当作没有基线，不抛。 */
function readLastRecord() {
  try {
    if (!existsSync(LOG_PATH)) return null
    const lines = readFileSync(LOG_PATH, 'utf8').split('\n').filter((l) => l.trim())
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i])
      } catch {
        /* 半写行：继续往前找 */
      }
    }
    return null
  } catch {
    return null
  }
}

/** 按码点计长并截断，末尾补省略号（微信侧长文本会被截，自己截更可控）。 */
function clip(s, max) {
  const cs = Array.from(s)
  return cs.length <= max ? s : cs.slice(0, max - 1).join('') + '…'
}

/** 拼汇总句。绿：`书阁巡检 11-12：正向 8/8、负控 3/3、测试 866 全过、仅元信息 57%` */
function buildMessage(r) {
  const mmdd = `${String(r.at.getMonth() + 1).padStart(2, '0')}-${String(r.at.getDate()).padStart(2, '0')}`
  const claimTxt = r.claim.ratio == null ? '仅元信息 未取到' : `仅元信息 ${Math.round(r.claim.ratio)}%`

  // 红项明细：只写「哪项、差多少、差在哪条」，不铺开长句
  const reds = []
  if (!r.api.ok) reds.push(`接口不可达（${r.api.error}）`)
  if (r.pos.failed.length) reds.push(`正向 ${r.pos.pass}/${r.pos.total}（缺 ${r.pos.failed.join('、')}）`)
  if (r.neg.failed.length) reds.push(`负控 ${r.neg.pass}/${r.neg.total}（误命中 ${r.neg.failed.join('、')}）`)
  if (!r.tests.ok) {
    const why = r.tests.error
      ? r.tests.error
      : r.tests.fail > 0
        ? `失败 ${r.tests.fail}，红脚本 ${r.tests.failedScripts || '未知'}`
        : '套件未跑出汇总'
    reds.push(`测试 ${why}`)
  }
  if (r.claim.regressed) reds.push(`仅元信息 ${Math.round(r.claim.ratio)}%（较上次 +${Math.round(r.claim.delta)}pt）`)

  const testTxt = r.tests.skipped ? '测试 已跳过' : r.tests.ok ? `测试 ${r.tests.pass} 全过` : `测试 ${r.tests.pass}过/${r.tests.fail}挂`
  const head = `${reds.length ? '❌ ' : ''}书阁巡检 ${mmdd}：`
  const base = `正向 ${r.pos.pass}/${r.pos.total}、负控 ${r.neg.pass}/${r.neg.total}、${testTxt}、${claimTxt}`

  if (!reds.length) return clip(head + base, 100)
  // 红：把明细塞在指标后面；超长时先砍明细条数，保住四项核心指标不被截掉
  let msg = `${head}${base}｜${reds.join('；')}`
  if (Array.from(msg).length <= 100) return msg
  for (let keep = reds.length - 1; keep >= 1; keep--) {
    msg = `${head}${base}｜${reds.slice(0, keep).join('；')}（另 ${reds.length - keep} 项红）`
    if (Array.from(msg).length <= 100) return msg
  }
  return clip(`${head}${base}｜${reds[0]}`, 100)
}

/** 推微信。返回 {ok, messageId?, error?}。桥返回 sent:false 也算失败，不假装送达。 */
async function push(text) {
  try {
    const res = await fetch(PUSH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15000),
    })
    const j = await res.json().catch(() => null)
    if (!res.ok || !j) return { ok: false, error: `HTTP ${res.status}` }
    if (j.sent === false) return { ok: false, error: j.error || 'bridge sent=false' }
    return { ok: true, messageId: j.messageId ?? null }
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) }
  }
}

function appendLog(record) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, JSON.stringify(record) + '\n')
    return null
  } catch (e) {
    return String(e.message || e).slice(0, 160)
  }
}

async function main() {
  const at = new Date()
  const r = {
    at,
    api: { ok: false, error: '' },
    pos: { pass: 0, total: POSITIVES.length, failed: [] },
    neg: { pass: 0, total: NEGATIVES.length, failed: [] },
    claim: { sampled: 0, read: 0, claim: 0, failed: 0, ratio: null, target: 20, delta: null, regressed: false },
    tests: { ok: false, ran: 0, pass: 0, fail: 0, secs: 0, failedScripts: '', error: '' },
  }

  // ① 服务健康 + 目录快照（正向/负控/抽样都要它）
  let summary = null
  try {
    summary = await getJson(`${BASE}/summary`)
    if (!summary.ok) throw new Error('summary ok:false')
    r.api.ok = true
    r.api.total = summary.total ?? null
    r.api.entries = summary.entries ?? null
  } catch (e) {
    r.api.error = String(e.message || e).slice(0, 120)
  }

  // ② 正向集：必须命中写死的 entry id（top 8 内）
  //    不是「有命中就算过」—— 那只能证明接口还活着，证明不了召回没退化。
  for (const p of POSITIVES) {
    if (!summary) break
    try {
      const j = await getJson(`${BASE}/search?q=${encodeURIComponent(p.q)}`)
      const hits = Array.isArray(j.hits) ? j.hits : []
      if (hits.some((h) => h && h.id === p.expect)) r.pos.pass += 1
      else r.pos.failed.push(p.label)
    } catch {
      r.pos.failed.push(p.label)
    }
  }
  // 接口整体不可达时不在明细里逐条报缺失：红项「接口不可达」已说明根因，
  // 把 8 条问题名全塞进 100 字里只会挤掉真正的指标数字。
  if (!summary) r.pos.failed = []

  // ③ 负控集：必须 0 命中（fail-closed）
  for (const n of NEGATIVES) {
    if (!summary) break
    try {
      const j = await getJson(`${BASE}/search?q=${encodeURIComponent(n.q)}`)
      if (Array.isArray(j.hits) && j.hits.length === 0) r.neg.pass += 1
      else r.neg.failed.push(n.label)
    } catch {
      r.neg.failed.push(n.label)
    }
  }
  if (!summary) r.neg.failed = []

  // ④ claim-only 基线
  if (summary) {
    try {
      const c = await measureClaimOnly(summary)
      Object.assign(r.claim, c)
      const prev = readLastRecord()
      const prevRatio = prev?.claim?.ratio
      if (typeof prevRatio === 'number' && typeof c.ratio === 'number') {
        r.claim.delta = Number((c.ratio - prevRatio).toFixed(1))
        r.claim.regressed = r.claim.delta >= CLAIM_REGRESS_PT
      }
    } catch (e) {
      r.claim.error = String(e.message || e).slice(0, 120)
    }
  }

  // ⑤ 测试套件
  if (SKIP_TESTS) {
    r.tests = { ok: true, ran: 26, pass: 0, fail: 0, secs: 0, failedScripts: '', error: '', skipped: true }
  } else {
    r.tests = await runTests()
  }

  const message = buildMessage(r)
  const red = message.startsWith('❌')

  // ⑥ 推送 + 落日志。顺序：先推（拿 messageId），再落日志；推送异常不影响落日志。
  // 先落地一行给人看的摘要：08:30 的早间提醒会读它。
  try {
    mkdirSync(dirname(LATEST_PATH), { recursive: true })
    writeFileSync(LATEST_PATH, `- **书阁巡检**（${at.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)}）：${message}\n`)
  } catch (e) {
    console.error('写巡检摘要失败：' + (e && e.message))
  }

  const pushed = NO_PUSH ? { ok: false, error: 'skipped' } : await push(message)

  const record = {
    time: at.toISOString(),
    timeLocal: at.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T'),
    ok: !red,
    api: r.api,
    positives: { pass: r.pos.pass, total: r.pos.total, failed: r.pos.failed },
    negatives: { pass: r.neg.pass, total: r.neg.total, failed: r.neg.failed },
    claimOnly: {
      sampled: r.claim.sampled,
      read: r.claim.read,
      claim: r.claim.claim,
      failed: r.claim.failed,
      ratio: r.claim.ratio == null ? null : Number(r.claim.ratio.toFixed(1)),
      target: r.claim.target,
      delta: r.claim.delta,
      regressed: r.claim.regressed,
    },
    tests: { ...r.tests, skipped: !!r.tests.skipped },
    message,
    push: NO_PUSH ? { skipped: true } : pushed,
  }
  const logErr = DRY_RUN ? null : appendLog(record)
  if (logErr) record.push = { ...record.push, logError: logErr }

  // ⑦ 人看的输出
  const pad = (s) => String(s).padEnd(14)
  console.log(`书阁每日巡检 · ${record.timeLocal}`)
  console.log(`${pad('接口')} ${r.api.ok ? `ok（${r.api.total} 会话 / ${r.api.entries} 条目）` : `❌ ${r.api.error}`}`)
  console.log(`${pad('正向')} ${r.pos.pass}/${r.pos.total}${r.pos.failed.length ? `  缺：${r.pos.failed.join(', ')}` : ''}`)
  console.log(`${pad('负控')} ${r.neg.pass}/${r.neg.total}${r.neg.failed.length ? `  误命中：${r.neg.failed.join(', ')}` : ''}`)
  console.log(
    `${pad('仅元信息')} ${r.claim.ratio == null ? '未取到' : `${Math.round(r.claim.ratio)}%（${r.claim.claim}/${r.claim.read}，目标 <${r.claim.target}%）`}` +
      (r.claim.delta == null ? '  无基线' : `  较上次 ${r.claim.delta >= 0 ? '+' : ''}${r.claim.delta}pt`)
  )
  console.log(`${pad('测试')} ${r.tests.skipped ? '已跳过' : r.tests.ok ? `${r.tests.pass} 通过 / ${r.tests.ran} 份 · ${r.tests.secs}s` : `❌ ${r.tests.error || `${r.tests.fail} 失败`}`}`)
  console.log(`${pad('推送')} ${NO_PUSH ? '未推送（--no-push/--dry-run）' : pushed.ok ? `ok messageId=${pushed.messageId}` : `❌ ${pushed.error}`}`)
  console.log(`${pad('日志')} ${DRY_RUN ? 'dry-run 未写入' : logErr ? `❌ ${logErr}` : LOG_PATH}`)
  console.log(`\n${message}`)
  console.log(`字数 ${Array.from(message).length}/100`)

  // 退出码：1 = 手册退化；2 = 巡检本身绿、但微信没送达。
  // 后者必须也让 unit 变红 —— 否则推送桥挂了没人知道，等于告警静默失效。
  if (red) process.exitCode = 1
  else if (!NO_PUSH && !DRY_RUN && !pushed.ok) process.exitCode = 2
}

main().catch((e) => {
  // 脚本自身炸了也要让人知道：尽量推一句，退出码 1
  const msg = `❌ 书阁巡检脚本异常：${String(e.message || e).slice(0, 60)}`
  push(msg).finally(() => {
    console.error(e)
    process.exitCode = 1
  })
})
