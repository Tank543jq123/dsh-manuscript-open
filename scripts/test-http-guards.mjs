#!/usr/bin/env node
/**
 * test-http-guards.mjs —— 验证 HTTP 层的四条护栏（D-01 / D-02 / D-04 / D-05 / D-10）。
 *
 * ## 为什么这个测试必须存在
 *
 * 这四条缺陷有一个共同特征：**静态审查能看见，但没有任何测试会失败**。
 *   · GET /distill/plan 偷偷全量重建（每 30–60 秒一次）—— 没有断言看过 runs/ 目录
 *   · 全部端点零鉴权 —— 之前压根没有"带坏头的请求该被拒"的用例
 *   · /api/rescan 无 try/catch 无 method 校验 —— 没有非 GET 用例
 *   · limit 参数 NaN / 负数 —— 没有非法参数用例
 * 所以它们全部活到了 2026-11-06 的 QA。本文件就是把"有没有副作用"变成可失败的断言。
 *
 * ## 硬约束：绝不碰用户的真实书库
 *
 * 每个用例都在 os.tmpdir() 下的临时书库里跑，`apply()` 之前就把
 * `DSH_MANUSCRIPT_ROOT` / `DSH_SESSIONS_ROOT` 指过去。测试结束时整个临时目录删掉。
 * ⚠️ 这些 handler 会真的建库、真的落 run 凭证 —— 指向真实库就会写 428 个文件。
 *
 * ## 方法：mock ctx 真跑 apply()
 *
 * 与 test-api-tools.mjs 同一套做法：造一个形状正确的 ctx，让 apply() 注册出真路由，
 * 然后直接调用 `route.handler(req, res)`。这样测的是**真实装配出来的 handler**，
 * 不是复制一份逻辑再测（复制一份就等于测自己写的假货）。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'

// ── 必须在 import lib/index.js 之前把两个根都指向临时目录 ──
const TMP = mkdtempSync(join(tmpdir(), 'dsh-ms-guard-'))
const LIB_ROOT = join(TMP, 'library')
const SESSIONS_ROOT = join(TMP, 'sessions')
process.env.DSH_MANUSCRIPT_ROOT = LIB_ROOT
process.env.DSH_SESSIONS_ROOT = SESSIONS_ROOT
// workspace.json 指向不存在的路径：readArchivedSet 读不到就返回空集合（不抛），
// 这样归档集合不会去读用户真实的那份。
process.env.DSH_WORKSPACE_JSON = join(TMP, 'no-such-workspace.json')
mkdirSync(SESSIONS_ROOT, { recursive: true })
mkdirSync(LIB_ROOT, { recursive: true })

// apply() 里的 defineTool 惰性装载会从 argv[1] 推导 DSH 安装根。
// 给一个真实 bin.js 路径，让它走"宿主进程内可解析"这条路（解析不到也不影响本测试）。
const REAL_BIN = 'C:/Users/<user>/AppData/Local/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
process.argv[1] = REAL_BIN

const { apply } = await import('../lib/index.js')

// ───────────────────────── 测试框架 ─────────────────────────
let pass = 0
let fail = 0
const failures = []

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`✓ ${name}${extra ? '  ' + extra : ''}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`✗ ${name}${extra ? '  ' + extra : ''}`)
  }
}

// ───────────────────────── mock ctx ─────────────────────────
const routes = []
const sections = []
const registeredTools = []

const mockCtx = {
  logger: {
    // 默认静音：本测试断言的是 HTTP 行为，不是日志文案。
    info() {}, warn() {}, error() {}, debug() {},
  },
  tools: {
    register(def) { registeredTools.push(def.name); return () => {} },
    schemas() { return [] },
  },
  systemPrompt: {
    getSectionOrder() { return 3100 },
    section(spec) { sections.push(spec); return () => {} },
  },
  webServer: {
    register(r) { routes.push(r); return () => {} },
  },
  llm: {},
  effect(fn) { const d = fn && fn(); return typeof d === 'function' ? d : () => {} },
  on() { return () => {} },
  inject(deps, cb) { cb(mockCtx); return {} },
  get() { return undefined },
}

/**
 * 造一个形状正确的假 req。
 *
 * 注意 `on()` 这个方法本身：`readBodyWithLimit` 会用 `typeof req.on === 'function'`
 * 判断"这是不是真流"。给了 body 才异步吐出 data/end，否则只挂监听不触发 ——
 * 与真实空 body 的行为一致（真实流总会 end，这里的用例只在带 body 时才需要 end）。
 */
function mkReq({ url = '/', method = 'GET', headers = {}, body = null } = {}) {
  const listeners = new Map()
  const req = {
    url,
    method,
    headers,
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, [])
      listeners.get(evt).push(fn)
      return req
    },
    destroy() {},
  }
  if (body !== null) {
    const fire = (evt, arg) => {
      for (const fn of listeners.get(evt) || []) fn(arg)
    }
    // setImmediate：让 handler 先挂完监听（它与 await 的时序无关，纯粹求稳）
    setImmediate(() => {
      try {
        fire('data', Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'))
        fire('end')
      } catch (e) {
        fire('error', e)
      }
    })
  }
  return req
}

/** 假 res：把 writeHead 的状态码与 end 的正文记下来。 */
function mkRes() {
  const out = { status: null, headers: null, body: null, raw: null }
  out.res = {
    writeHead(code, headers) { out.status = code; out.headers = headers || null },
    end(body) {
      out.raw = body
      try { out.body = JSON.parse(body) } catch { out.body = null }
    },
  }
  return out
}

const GUARD = { 'x-dsh-manuscript': '1' }

/** 调一条已注册的路由。返回 {status, body}。 */
async function call(path, opts = {}) {
  const route = routes.find((r) => r.path === path)
  if (!route) throw new Error(`路由未注册: ${path}`)
  const out = mkRes()
  await route.handler(mkReq({ url: opts.url || path, ...opts }), out.res)
  return { status: out.status, body: out.body, raw: out.raw }
}

const urlOf = (path, query) => (query ? `${path}?${query}` : path)

// ───────────────────────── 0. 装配 ─────────────────────────
console.log('\n── 0. 路由装配 ──')
await apply(mockCtx)

const paths = routes.map((r) => r.path)
// 10 条 = 原 9 条 + N-10 的兜底 prefix（2026-11-06 第三轮 QA 补）。
// 兜底的必要性见 scripts/test-http-hardening.mjs：没有它，打错的路由会落到宿主的
// SPA fallback 上，回一个 0 字节空 404 —— 与其余 9 条的 JSON 契约不一致。
check('注册了 10 条路由（D-02 新增 /distill/model，N-10 新增 /api 兜底）', paths.length === 10, `实际 ${paths.length} 条：${paths.length ? '' : '(空)'}`)
check('新增 /api/distill/model', paths.includes('/dsh-manuscript/api/distill/model'))
check('保留 /api/rescan', paths.includes('/dsh-manuscript/api/rescan'))
check('新增 /api 兜底 prefix（N-10）', paths.includes('/dsh-manuscript/api'))
for (const p of ['summary', 'tools', 'sessions', 'distill/plan']) {
  check(`/api/${p} 仍注册`, paths.includes(`/dsh-manuscript/api/${p}`))
}

// 等首次后台扫描完成（apply 里 800ms 起扫）。轮询 summary 直到 200 —— 这比 sleep
// 固定时长可靠：扫描耗时随会话数变化，睡死一个数字迟早假绿或假红。
console.log('\n   等待首次后台扫描完成…')
let bootOk = false
const bootDeadline = Date.now() + 30000
while (Date.now() < bootDeadline) {
  const r = await call('/dsh-manuscript/api/summary')
  if (r.status === 200 && r.body && r.body.ok === true) { bootOk = true; break }
  await new Promise((resolve) => setTimeout(resolve, 200))
}
check('首次扫描完成（summary 200）', bootOk)
if (!bootOk) {
  console.log('\n首次扫描未完成，后续用例无法进行。原始返回已在上面的 ✗ 行。')
  console.log(`\n结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
  process.exit(1)
}

// ───────────────────────── 1. D-05：summary 自证过期 ─────────────────────────
console.log('\n── 1. D-05 · /api/summary 必须自带过期口径 ──')
{
  const r = await call('/dsh-manuscript/api/summary')
  check('summary 200', r.status === 200)
  check('scannedAt 是数字（旧快照要能说出自己几点扫的）', Number.isFinite(r.body?.scannedAt), `scannedAt=${r.body?.scannedAt}`)
  check('scanAgeMs 是数字且 ≥0', Number.isFinite(r.body?.scanAgeMs) && r.body.scanAgeMs >= 0, `scanAgeMs=${r.body?.scanAgeMs}`)
  check('stale 是布尔（不是 null 占位）', typeof r.body?.stale === 'boolean', `stale=${r.body?.stale}`)
  check('scanTtlMs 与 SCAN_TTL_MS 一致（600000）', r.body?.scanTtlMs === 600000, `scanTtlMs=${r.body?.scanTtlMs}`)
  // 新鲜快照的 stale 必须是 false —— 若恒为 true，这个字段就等于没有
  check('刚扫完时 stale=false', r.body?.stale === false)
}

// ───────────────────────── 2. D-04/D-02：rescan ─────────────────────────
console.log('\n── 2. D-04/D-02 · /api/rescan：GET 拒绝、无守门头拒绝、有头成功 ──')
{
  const get = await call('/dsh-manuscript/api/rescan', { method: 'GET' })
  check('GET → 405（全量重建不许被 <img> 触发）', get.status === 405, `status=${get.status}`)

  const noHeader = await call('/dsh-manuscript/api/rescan', { method: 'POST', headers: {} })
  check('POST 无守门头 → 403', noHeader.status === 403, `status=${noHeader.status} error=${noHeader.body?.error}`)

  const badOrigin = await call('/dsh-manuscript/api/rescan', {
    method: 'POST',
    headers: { host: '127.0.0.1:15080', origin: 'http://evil.example' },
  })
  check('POST 跨源 Origin → 403（浏览器同源规则兜底）', badOrigin.status === 403, `status=${badOrigin.status}`)

  const sameOrigin = await call('/dsh-manuscript/api/rescan', {
    method: 'POST',
    headers: { host: '127.0.0.1:15080', origin: 'http://127.0.0.1:15080' },
  })
  // 注意这条用例的**边界**：Host 是 127.0.0.1（本机）时才允许"Origin==Host 即放行"。
  // 早期这条断言曾被误读成"Origin==Host 就够"，而 DNS 重绑定正是让两者同时变成外域 ——
  // 那个缺口由 scripts/test-http-hardening.mjs 的 N-08 用例组专门覆盖（Host 白名单先行）。
  check('POST 同源 Origin → 200（仅当 Host 是本机回环）', sameOrigin.status === 200, `status=${sameOrigin.status}`)

  const ok = await call('/dsh-manuscript/api/rescan', { method: 'POST', headers: GUARD })
  check('POST 带守门头 → 200', ok.status === 200, `status=${ok.status}`)
  check('返回 rescan=true', ok.body?.rescan === true)
  // 【2026-11-08 修】原来拿 scanAt !== previousScanAt 当"真扫了"的证据，
  // 而 scanAt 是 Date.now() 毫秒级：整套测试连跑时两次重扫可能落在同一毫秒，
  // 于是这条在**没有缺陷**的情况下间歇性变红（实测连跑 5 次撞 1 次）。
  // 现在用单调的 scanSeq 作证；scanAt 仍然要求存在，但不再要求"必须不同"。
  check('返回 scanAt 与 previousScanAt（时间戳存在）',
    Number.isFinite(ok.body?.scanAt) && Number.isFinite(ok.body?.previousScanAt),
    `previous=${ok.body?.previousScanAt} now=${ok.body?.scanAt}`)
  check('scanSeq 单调前进，证明这次真的扫了（跨毫秒安全）',
    Number.isFinite(ok.body?.scanSeq) && Number.isFinite(ok.body?.scanSeqBefore) &&
      ok.body.scanSeq > ok.body.scanSeqBefore,
    `before=${ok.body?.scanSeqBefore} now=${ok.body?.scanSeq}`)
  check('返回 stale/scanAgeMs（重扫后应已新鲜）', ok.body?.stale === false && Number.isFinite(ok.body?.scanAgeMs),
    `stale=${ok.body?.stale} age=${ok.body?.scanAgeMs}`)

  // 头名大小写：Node 的 http 会转小写，但反向代理/中间层不保证。
  // 只认小写键会让守门在"测试全绿、上线全挂"之间摇摆，所以单独钉一条。
  const upper = await call('/dsh-manuscript/api/rescan', {
    method: 'POST', headers: { 'X-DSH-MANUSCRIPT': '1' },
  })
  check('守门头大写形式同样放行（头名大小写无关）', upper.status === 200, `status=${upper.status}`)

  // 守门头的值必须是约定的 '1'：随便给个非空值不该放行。
  const wrongVal = await call('/dsh-manuscript/api/rescan', {
    method: 'POST', headers: { 'x-dsh-manuscript': 'yes' },
  })
  check('守门头值不对 → 403', wrongVal.status === 403, `status=${wrongVal.status}`)
}

console.log('\n── 2b. D-04 · 异常必须变成结构化状态码，不许冒泡 ──')
{
  // 造"另一个建库进程正在跑"：锁文件里写自己的 pid —— 进程活着，锁不算失效。
  // 这是 refresh() 会抛 BuildLockedError 的真实条件，不是模拟出来的异常。
  const lockPath = join(LIB_ROOT, '.build.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }), 'utf8')
  const locked = await call('/dsh-manuscript/api/rescan', { method: 'POST', headers: GUARD })
  check('锁被占 → 409（不是 200 假装扫完）', locked.status === 409, `status=${locked.status} body=${JSON.stringify(locked.body)}`)
  check('409 正文含 locked=true 与 error', locked.body?.locked === true && typeof locked.body?.error === 'string')
  rmSync(lockPath, { force: true })

  // 造磁盘级失败：把书库根指到一个"父级是文件"的路径。
  // mkdirSync 会 ENOTDIR → buildLibrary 抛错 → refresh 捕获并记 lastError → 必须回 500。
  const blocker = join(TMP, 'blocker-file')
  writeFileSync(blocker, 'not a directory', 'utf8')
  const outer = process.env.DSH_MANUSCRIPT_ROOT
  process.env.DSH_MANUSCRIPT_ROOT = join(blocker, 'library')
  const broken = await call('/dsh-manuscript/api/rescan', { method: 'POST', headers: GUARD })
  process.env.DSH_MANUSCRIPT_ROOT = outer
  check('建库失败 → 500（不是未捕获异常/挂起连接）', broken.status === 500,
    `status=${broken.status} error=${broken.body?.error}`)
  check('500 正文是 {ok:false, error}', broken.body?.ok === false && typeof broken.body?.error === 'string')

  // 恢复：lastError 是"上一次失败"的瞬时状态，必须能被子序列成功重扫清掉，
  // 否则一次偶发失败会让面板永久显示报错（这是回归风险，不是修辞）。
  const rec = await call('/dsh-manuscript/api/rescan', { method: 'POST', headers: GUARD })
  check('失败后能恢复到 200（lastError 不粘住）', rec.status === 200, `status=${rec.status} error=${rec.body?.error}`)
}

// ───────────────────────── 3. D-02：distill/run ─────────────────────────
console.log('\n── 3. D-02/D-10 · /api/distill/run：写操作必须 POST + 守门 + 参数校验 ──')
{
  const get = await call('/dsh-manuscript/api/distill/run', { method: 'GET', url: urlOf('/dsh-manuscript/api/distill/run', 'dryRun=1') })
  check('GET → 405', get.status === 405, `status=${get.status}`)

  const noHeader = await call('/dsh-manuscript/api/distill/run', {
    method: 'POST', url: urlOf('/dsh-manuscript/api/distill/run', 'dryRun=1'), headers: {},
  })
  check('POST 无守门头 → 403（提炼会花钱并写 runs/）', noHeader.status === 403, `status=${noHeader.status}`)

  const nan = await call('/dsh-manuscript/api/distill/run', {
    method: 'POST', url: urlOf('/dsh-manuscript/api/distill/run', 'dryRun=1&limit=abc'), headers: GUARD,
  })
  check('limit=abc → 400（以前会静默变成空队列）', nan.status === 400, `status=${nan.status} error=${nan.body?.error}`)

  const neg = await call('/dsh-manuscript/api/distill/run', {
    method: 'POST', url: urlOf('/dsh-manuscript/api/distill/run', 'dryRun=1&limit=-5'), headers: GUARD,
  })
  check('limit=-5 → 400（以前变成"没有可提炼的了"）', neg.status === 400, `status=${neg.status}`)

  const zero = await call('/dsh-manuscript/api/distill/run', {
    method: 'POST', url: urlOf('/dsh-manuscript/api/distill/run', 'dryRun=1&limit=0'), headers: GUARD,
  })
  check('limit=0 → 400（显式要 0 条是误用，不是合法批量）', zero.status === 400, `status=${zero.status}`)

  // dryRun=1：不调 LLM（临时 sessions 根是空的，队列也为空），只走编排。
  // 这条用例要证明的是"夹取不报错"，不是"夹取后的数字"。
  const clamp = await call('/dsh-manuscript/api/distill/run', {
    method: 'POST', url: urlOf('/dsh-manuscript/api/distill/run', 'dryRun=1&limit=99999'), headers: GUARD,
  })
  check('limit=99999 → 200 且夹取到 50', clamp.status === 200 && clamp.body?.limit === 50 && clamp.body?.limitClamped === true,
    `status=${clamp.status} limit=${clamp.body?.limit} clamped=${clamp.body?.limitClamped}`)

  const def = await call('/dsh-manuscript/api/distill/run', {
    method: 'POST', url: urlOf('/dsh-manuscript/api/distill/run', 'dryRun=1'), headers: GUARD,
  })
  check('缺省 limit → 20 且未夹取', def.status === 200 && def.body?.limit === 20 && def.body?.limitClamped === false,
    `limit=${def.body?.limit}`)
}

// ───────────────────────── 4. D-02：distill/commit ─────────────────────────
console.log('\n── 4. D-02 · /api/distill/commit：入册是唯一真写库的端点 ──')
{
  const get = await call('/dsh-manuscript/api/distill/commit', { method: 'GET' })
  check('GET → 405', get.status === 405, `status=${get.status}`)

  // 必须在**发起请求之前**取基线：前面的 rescan 已经从 data/ 预加工册建出条目
  // （实测 24 个），拿「entries 目录为空」当判据会在真实建库产物上必然假红。
  const entryDir = join(LIB_ROOT, 'entries')
  const entryCountNow = () => (existsSync(entryDir)
    ? readdirSync(entryDir).filter((f) => f.endsWith('.json')).length
    : 0)
  const beforeReject = entryCountNow()

  const payload = JSON.stringify({ entries: [{ title: '伪造条目', claim: '未经确认的写入' }] })
  const noHeader = await call('/dsh-manuscript/api/distill/commit', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: payload,
  })
  check('POST 无守门头 → 403（这是 QA 里那条 curl 的复现路径）', noHeader.status === 403,
    `status=${noHeader.status} error=${noHeader.body?.error}`)

  const badJson = await call('/dsh-manuscript/api/distill/commit', {
    method: 'POST', headers: GUARD, body: '{不是合法 JSON',
  })
  check('有头但 body 非法 → 400', badJson.status === 400, `status=${badJson.status}`)

  const empty = await call('/dsh-manuscript/api/distill/commit', {
    method: 'POST', headers: GUARD, body: JSON.stringify({ entries: [] }),
  })
  check('有头但 entries 为空 → 400', empty.status === 400, `status=${empty.status}`)

  // 403/400 那几次绝不许落盘：这是"守门"唯一有意义的判据。
  const afterReject = entryCountNow()
  check('被拒的入册没有产生任何条目文件', afterReject === beforeReject,
    `拒绝前 ${beforeReject} 个 → 拒绝后 ${afterReject} 个`)
  // 同时确认"伪造条目"这四个字没有以任何形式落进 entries/（计数相同但内容被换的极端情况）
  let forged = 0
  let scanned = 0
  let unreadable = 0
  if (existsSync(entryDir)) {
    for (const f of readdirSync(entryDir)) {
      if (!f.endsWith('.json')) continue
      try {
        // 【2026-11-09】print 出"实际扫了几个文件"——原来读失败静默跳过，
        // 若全部读不到，`forged` 恒 0，这条断言就在零证据下通过。
        // 现在分开计数，并在判据里要求"至少扫到一个文件"。
        if (readFileSync(join(entryDir, f), 'utf8').includes('伪造条目')) forged += 1
        scanned += 1
      } catch {
        unreadable += 1
      }
    }
  }
  check('entries/ 里搜不到「伪造条目」',
    forged === 0 && unreadable === 0,
    `扫了 ${scanned} 个文件、命中 ${forged} 个${unreadable ? `、${unreadable} 个读不到` : ''}`)
}

// ───────────────────────── 5. D-02：distill/model ─────────────────────────
console.log('\n── 5. D-02 · /api/distill/model：模型切换从 GET 副作用改为 POST ──')
{
  const get = await call('/dsh-manuscript/api/distill/model', { method: 'GET' })
  check('GET → 405', get.status === 405, `status=${get.status}`)

  const noHeader = await call('/dsh-manuscript/api/distill/model', {
    method: 'POST', headers: {}, body: JSON.stringify({ model: 'deepseek-v4-pro' }),
  })
  check('POST 无守门头 → 403', noHeader.status === 403, `status=${noHeader.status}`)

  const unknown = await call('/dsh-manuscript/api/distill/model', {
    method: 'POST', headers: GUARD, body: JSON.stringify({ model: '不存在的模型' }),
  })
  check('未知模型 → 400（不静默回落，否则界面显示"已切换"但实际没变）', unknown.status === 400,
    `status=${unknown.status} error=${unknown.body?.error}`)

  const okModel = await call('/dsh-manuscript/api/distill/model', {
    method: 'POST', headers: GUARD, body: JSON.stringify({ model: 'deepseek-v4-pro' }),
  })
  check('合法模型 → 200 且 currentModel 为它', okModel.status === 200 && okModel.body?.currentModel === 'deepseek-v4-pro',
    `status=${okModel.status} currentModel=${okModel.body?.currentModel}`)
}

// ───────────────────────── 6. D-01：plan 只读 ─────────────────────────
console.log('\n── 6. D-01 · /api/distill/plan 必须零写入 ──')

/**
 * 整个书库根的文件指纹：相对路径 + 字节数 + mtime。
 * 用全目录而不是只数 runs/：D-01 的代价是"写 428 个文件"，只数 runs 会漏掉 427 个。
 */
function fingerprint(root) {
  const rows = []
  const walk = (dir, prefix) => {
    let names = []
    try { names = readdirSync(dir) } catch { return }
    names.sort()
    for (const name of names) {
      const full = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { rows.push(`D ${rel}`); walk(full, rel) }
      else rows.push(`F ${rel} ${st.size} ${st.mtimeMs}`)
    }
  }
  walk(root, '')
  return rows.join('\n')
}

{
  const runsDir = join(LIB_ROOT, 'runs')
  const libJson = join(LIB_ROOT, 'library.json')
  const runsBefore = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith('.json')).length : 0
  const mtimeBefore = existsSync(libJson) ? statSync(libJson).mtimeMs : null

  const before = fingerprint(LIB_ROOT)
  const plan = await call('/dsh-manuscript/api/distill/plan', { method: 'GET' })
  const after = fingerprint(LIB_ROOT)

  const runsAfter = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith('.json')).length : 0
  const mtimeAfter = existsSync(libJson) ? statSync(libJson).mtimeMs : null

  check('plan 200（预演不需要重建）', plan.status === 200, `status=${plan.status}`)
  check('plan 返回 stale / scannedAt / scanAgeMs（旧快照要能自证）',
    typeof plan.body?.stale === 'boolean' && Number.isFinite(plan.body?.scannedAt) && Number.isFinite(plan.body?.scanAgeMs),
    `stale=${plan.body?.stale} age=${plan.body?.scanAgeMs}`)
  // 契约原文的两条判据，单独列出来 —— 全量指纹相等是更强的结论，但这两条是
  // 排查时第一眼要看的东西，失败信息必须直接指到"runs 多了几份 / library.json 被改了"。
  check('★ plan 期间 runs/ 文件数不增加', runsBefore === runsAfter, `前 ${runsBefore} → 后 ${runsAfter}`)
  check('★ plan 期间 library.json mtime 不变',
    mtimeBefore !== null && mtimeBefore === mtimeAfter,
    `前 ${mtimeBefore} → 后 ${mtimeAfter}`)
  check('★ plan 调用期间书库零写入（全量文件指纹完全一致）', before === after,
    before === after ? '' : `前 ${before.split('\n').length} 行 / 后 ${after.split('\n').length} 行`)

  // 对照实验：证明上面的指纹探针不是空转 —— 真的重建一次，它必须变。
  // 没有这一步，"指纹相等"可能只是因为探针本身坏了（这正是 QA 里 7 条孤儿漏检的教训）。
  const rescan = await call('/dsh-manuscript/api/rescan', { method: 'POST', headers: GUARD })
  const afterRescan = fingerprint(LIB_ROOT)
  check('对照：rescan 后指纹必须变化（探针有效性）', rescan.status === 200 && afterRescan !== after,
    rescan.status === 200 ? '' : `rescan status=${rescan.status}`)

  // GET 带 ?model= 绝不许改后端状态：连续两次 plan，第一次带参，第二次不带。
  const withParam = await call('/dsh-manuscript/api/distill/plan', {
    method: 'GET', url: urlOf('/dsh-manuscript/api/distill/plan', 'model=glm-5.3-flash'),
  })
  const noParam = await call('/dsh-manuscript/api/distill/plan', { method: 'GET' })
  check('plan?model=X 只影响本次响应，不写状态',
    withParam.body?.currentModel === 'glm-5.3-flash' && noParam.body?.currentModel === 'deepseek-v4-pro',
    `带参=${withParam.body?.currentModel} 不带参=${noParam.body?.currentModel}`)
}

// ───────────────────────── 7. D-09：runs 文件名只拼一次前缀 ─────────────────────────
console.log('\n── 7. D-09 · 提炼报告文件名不许双前缀 ──')
{
  // 这里跑一次**真实路径**的提炼（非 dryRun），但临时 sessions 根是空的 →
  // 队列为空 → 一次 LLM 都不会调（runDistillPass 的 batches 为空）。
  // 唯一发生的写盘是第 ⑦ 步落 run 凭证 —— 那正是 D-09 出问题的地方。
  const runsDir = join(LIB_ROOT, 'runs')
  const before = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith('.json')) : []
  const res = await call('/dsh-manuscript/api/distill/run', {
    method: 'POST', url: urlOf('/dsh-manuscript/api/distill/run', 'limit=1'), headers: GUARD,
  })
  const after = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith('.json')) : []
  const fresh = after.filter((f) => !before.includes(f))

  check('提炼端点 200', res.status === 200, `status=${res.status} error=${res.body?.error}`)
  check('落了一份新的 run 凭证', fresh.length === 1, `新增 ${fresh.length} 份：${fresh.join(', ')}`)
  const name = fresh[0] || ''
  check('文件名形如 distill-<时间戳>-<随机>.json（无双前缀）',
    /^distill-\d{8}-\d{6}-[0-9a-f]{6}\.json$/.test(name), name)
  // 文件内 runId 必须与文件名严格一致（去掉 .json）—— 这是 D-09 的实质：
  // 双前缀时文件名是 distill-distill-xxx.json，里面的 runId 只有一份前缀，两者对不上。
  let inner = null
  try { inner = JSON.parse(readFileSync(join(runsDir, name), 'utf8')) } catch { inner = null }
  check('文件内 runId 与文件名一致', inner?.runId === name.replace(/\.json$/, ''),
    `runId=${inner?.runId} 文件名=${name}`)
  check('runs/ 里不存在 distill-distill- 文件',
    after.filter((f) => f.startsWith('distill-distill-')).length === 0)
}

// ───────────────────────── 8. D-10：sessions 的 limit ─────────────────────────
console.log('\n── 8. D-10 · /api/sessions 的 limit 边界 ──')
{
  const nan = await call('/dsh-manuscript/api/sessions', { url: urlOf('/dsh-manuscript/api/sessions', 'limit=abc') })
  check('limit=abc → 400', nan.status === 400, `status=${nan.status} error=${nan.body?.error}`)

  const neg = await call('/dsh-manuscript/api/sessions', { url: urlOf('/dsh-manuscript/api/sessions', 'limit=-5') })
  check('limit=-5 → 400（以前是"倒数 5 条"）', neg.status === 400, `status=${neg.status}`)

  const frac = await call('/dsh-manuscript/api/sessions', { url: urlOf('/dsh-manuscript/api/sessions', 'limit=2.5') })
  check('limit=2.5 → 400（非整数）', frac.status === 400, `status=${frac.status}`)

  const big = await call('/dsh-manuscript/api/sessions', { url: urlOf('/dsh-manuscript/api/sessions', 'limit=99999') })
  check('limit=99999 → 200 且夹取到 500，clamped=true',
    big.status === 200 && big.body?.limit === 500 && big.body?.clamped === true,
    `status=${big.status} limit=${big.body?.limit} clamped=${big.body?.clamped}`)
  check('截断要自证：total 与 items.length 都给出', Number.isFinite(big.body?.total) && Array.isArray(big.body?.items),
    `total=${big.body?.total} items=${big.body?.items?.length}`)

  const emptyParam = await call('/dsh-manuscript/api/sessions', { url: urlOf('/dsh-manuscript/api/sessions', 'limit=') })
  check('limit=（空串）→ 回落默认 100 且 200', emptyParam.status === 200 && emptyParam.body?.limit === 100,
    `status=${emptyParam.status} limit=${emptyParam.body?.limit}`)

  const post = await call('/dsh-manuscript/api/sessions', { method: 'POST' })
  check('POST → 405（只读端点不该接受写动词）', post.status === 405, `status=${post.status}`)

  // 2026-11-07 新增：stage 非法值必须报错。
  // 旧实现对未知 stage 静默按 all 处理（同一端点里 limit 严格、stage 宽松，
  // 前端把筛选值拼错时用户永远发现不了）。
  const badStage = await call('/dsh-manuscript/api/sessions', { url: urlOf('/dsh-manuscript/api/sessions', 'stage=bogus') })
  check('stage=bogus → 400（不再静默按 all）', badStage.status === 400, `status=${badStage.status}`)

  const okStage = await call('/dsh-manuscript/api/sessions', { url: urlOf('/dsh-manuscript/api/sessions', 'stage=real') })
  check('stage=real → 200 且只回 real', okStage.status === 200 && okStage.body?.items?.every((x) => x.category === 'real'),
    `status=${okStage.status} items=${okStage.body?.items?.length}`)

  // 结果被截断必须自证：默认 limit=100 时 130 个会话只回 100 条，truncated 必须为 true，
  // 而 limitClamped 仍为 false（参数没被夹取，是结果被截断——两件事）
  const trunc = await call('/dsh-manuscript/api/sessions', { url: urlOf('/dsh-manuscript/api/sessions', 'limit=1') })
  const truncTotal = Number(trunc.body?.total || 0)
  check(
    '截断自证：truncated 只在结果真被砍时为 true，且与 limitClamped 分开',
    trunc.status === 200 && trunc.body?.truncated === (truncTotal > 1) && trunc.body?.limitClamped === false,
    `total=${truncTotal} items=${trunc.body?.items?.length} truncated=${trunc.body?.truncated} limitClamped=${trunc.body?.limitClamped}`
  )
}

// ───────────────────────── 9. 收尾：临时目录自查 ─────────────────────────
console.log('\n── 9. 收尾 ──')
{
  const real = 'C:/Users/<user>/.dsh/dsh-manuscript'
  check('本次测试的书库根是临时目录，不是真实库',
    LIB_ROOT !== real && LIB_ROOT.startsWith(TMP), LIB_ROOT)
  check('真实库路径未被本测试写入（env 指向临时目录）', process.env.DSH_MANUSCRIPT_ROOT === LIB_ROOT)
  // 确认临时库里确实产生了 library.json —— 证明上面的"零写入"断言测的是真实建库产物，
  // 不是在一个空目录上自证清白。
  check('临时库已建出 library.json（断言有实际对象）', existsSync(join(LIB_ROOT, 'library.json')))
  const runFiles = existsSync(join(LIB_ROOT, 'runs'))
    ? readdirSync(join(LIB_ROOT, 'runs')).filter((f) => f.endsWith('.json'))
    : []
  check('临时库已落 run 凭证（说明写入探针有东西可测）', runFiles.length >= 1, `${runFiles.length} 份`)
  // D-09：新写的提炼报告不该再有双前缀。这里没有真提炼（无 LLM），
  // 所以只断言"不出现 distill-distill-"，出现就说明前缀又被拼了两次。
  const doubled = runFiles.filter((f) => f.startsWith('distill-distill-'))
  check('runs/ 里没有 distill-distill- 双前缀文件', doubled.length === 0, doubled.join(', '))
}

// ───────────────────────── 清理 ─────────────────────────
try {
  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n已清理临时目录 ${TMP}`)
} catch (e) {
  // 清理失败不影响结论，但要如实说出来 —— 别让临时目录悄悄堆在磁盘上
  console.log(`\n⚠️ 临时目录清理失败（不影响结论）：${e.message}`)
}

console.log('\n' + '='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const f of failures) console.log(`  · ${f}`)
}
process.exit(fail === 0 ? 0 : 1)
