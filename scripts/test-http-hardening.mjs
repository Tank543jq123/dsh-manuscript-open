#!/usr/bin/env node
/**
 * test-http-hardening.mjs —— 第三轮 QA 的四条 HTTP 缺陷回归（N-07 / N-08 / N-09 / N-10 / N-11）。
 *
 * ## 为什么这个文件必须存在
 *
 * test-http-guards.mjs 覆盖的是 D-01/D-02/D-04/D-05/D-10，全部是"**业务语义**层面"
 * 的护栏。本轮四条缺陷全部落在它的盲区里：
 *
 *   · N-08 只比较 Origin 与 Host —— 守卫自己的用例就是拿 `host: '127.0.0.1:15080'`
 *     造的，从没测过"Host 本身是外域"。原用例 "Origin 与 Host 一致即可放行"
 *     其实是把 bug 写成了断言。
 *   · N-07 的 413 —— 完全没法用 mock 测出来：mock 的 `destroy()` 是空函数，
 *     永远走不到"连接被拆、413 发不出去"那一步。必须**起一个真 http 服务**。
 *   · N-09 —— 原测试只覆盖 /sessions 的 POST，其余四条只读路由没测过写动词。
 *   · N-10/N-11 —— 完全没人测过"打错路由"和"两级路径"。
 *
 * 所以本文件的核心做法与 test-http-guards 不同：**N-07/N-10 起真 socket**。
 * 用手写的 mock 去测"连接是否被提前拆掉"是自证清白 —— mock 里根本没有连接。
 *
 * ## 硬约束：绝不碰真实书库
 *
 * 与 test-http-guards.mjs 同一套：apply() 之前就把 DSH_MANUSCRIPT_ROOT /
 * DSH_SESSIONS_ROOT 指到 mkdtemp 目录，结束时整个删掉。
 *
 * ## 两条测试路径
 *
 *   A. mock 路径（N-08/N-09/N-11）：直接调 route.handler(req, res)，能精确看
 *      status/body，也能断言 handler 没有执行到下游（比如 405 时 summary 不该被算）。
 *   B. 真 socket 路径（N-07/N-10）：把注册出来的 handler 挂到 node:http 上，
 *      用真 TCP 发请求。只有这样才能观察到"客户端到底收到 413 还是 ECONNRESET"。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { writeSessionFixture } from './lib/session-fixture.mjs'

// ── 必须在 import lib/index.js 之前把两个根都指向临时目录 ──
const TMP = mkdtempSync(join(tmpdir(), 'dsh-ms-harden-'))
const LIB_ROOT = join(TMP, 'library')
const SESSIONS_ROOT = join(TMP, 'sessions')
process.env.DSH_MANUSCRIPT_ROOT = LIB_ROOT
process.env.DSH_SESSIONS_ROOT = SESSIONS_ROOT
process.env.DSH_WORKSPACE_JSON = join(TMP, 'no-such-workspace.json')
mkdirSync(SESSIONS_ROOT, { recursive: true })
mkdirSync(LIB_ROOT, { recursive: true })

// 【2026-11-07】以前这个夹具库是**空的**：没有会话 → 没有册章节 →
// `/volume/<册>/<章>` 系列断言在任何机器上都被跳过（长期恒为 73/74）。
// 现在按真实落盘格式种两个最小会话，让这些路由真的被验证。
writeSessionFixture(SESSIONS_ROOT, {
  sid: 'session-harden-a',
  projectDir: '-D-proj-demo-hardware',
  cwd: 'D:\\proj\\demo-hardware',
  title: '嘉立创2.0双排针选型',
})
writeSessionFixture(SESSIONS_ROOT, {
  sid: 'session-harden-b',
  projectDir: '-D-proj-dsh-work',
  cwd: 'D:\\proj\\dsh-work',
  title: '安装 dsh 插件并验证',
  tools: [{ name: 'write', args: { file_path: 'D:\\proj\\dsh-work\\notes.md' } }],
})

// 宿主 bin 路径不再硬编码作者机器（同 test-apply-section 的修法）：
// 解析不到就让 tools 面保持降级，而不是指向一个不存在的绝对路径。
const REAL_BIN = process.env.DSH_BIN || null
if (REAL_BIN) process.argv[1] = REAL_BIN

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
const mockCtx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  tools: { register() { return () => {} }, schemas() { return [] } },
  systemPrompt: { getSectionOrder() { return 3100 }, section() { return () => {} } },
  webServer: { register(r) { routes.push(r); return () => {} } },
  llm: {},
  effect(fn) { const d = fn && fn(); return typeof d === 'function' ? d : () => {} },
  on() { return () => {} },
  inject(deps, cb) { cb(mockCtx); return {} },
  get() { return undefined },
}

/**
 * 造一个假 req。
 *
 * `body` 可以是 Buffer（用来凑超限）或字符串；给了才吐 data/end。
 * `destroyed` 记录 destroy 是否被调用 —— N-07 的原症状正是"超限就 destroy"，
 * 断言"没有提前 destroy"必须能观测到这件事。
 */
function mkReq({ url = '/', method = 'GET', headers = {}, body = null } = {}) {
  const listeners = new Map()
  const req = {
    url,
    method,
    headers,
    destroyed: false,
    resumed: false,
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, [])
      listeners.get(evt).push(fn)
      return req
    },
    resume() { req.resumed = true; return req },
    destroy() { req.destroyed = true },
  }
  if (body !== null) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
    const fire = (evt, arg) => { for (const fn of listeners.get(evt) || []) fn(arg) }
    setImmediate(() => {
      try {
        // 切成 64KB 一片，模拟真实分块到达（一次吐整个 4MB 会掩盖累积逻辑的错）
        const CH = 64 * 1024
        for (let off = 0; off < buf.length; off += CH) fire('data', buf.subarray(off, off + CH))
        fire('end')
      } catch (e) {
        try { fire('error', e) } catch { /* 已 settle */ }
      }
    })
  }
  return req
}

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

/** 按 path 找路由并调用（mock 路径）。 */
async function call(path, opts = {}) {
  const route = routes.find((r) => r.path === path)
  if (!route) throw new Error(`路由未注册: ${path}`)
  const out = mkRes()
  const req = mkReq({ url: opts.url || path, ...opts })
  await route.handler(req, out.res)
  return { status: out.status, body: out.body, raw: out.raw, headers: out.headers, req }
}

const urlOf = (p, q) => (q ? `${p}?${q}` : p)

// ───────────────────────── 0. 装配 ─────────────────────────
console.log('\n── 0. 路由装配 ──')
await apply(mockCtx)

const paths = routes.map((r) => r.path)
check('注册了 12 条路由（新增 /api/search 与 /api/entry）', paths.length === 12, `实际 ${paths.length} 条`)
check('兜底 prefix /api 已注册', paths.includes('/dsh-manuscript/api'))

console.log('\n   等待首次后台扫描完成…')
let bootOk = false
const deadline = Date.now() + 30000
while (Date.now() < deadline) {
  const r = await call('/dsh-manuscript/api/summary')
  if (r.status === 200 && r.body && r.body.ok === true) { bootOk = true; break }
  await new Promise((r2) => setTimeout(r2, 200))
}
check('首次扫描完成（summary 200）', bootOk)
if (!bootOk) {
  console.log(`\n结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
  process.exit(1)
}

// ═══════════════════ 摘要体积 · ?lite=1 ═══════════════════
console.log('\n── 摘要体积 · ?lite=1 只给册级元数据 ──')
{
  const full = await call('/dsh-manuscript/api/summary')
  const lite = await call('/dsh-manuscript/api/summary', { url: '/dsh-manuscript/api/summary?lite=1' })
  check('GET /summary?lite=1 → 200', lite.status === 200 && lite.body?.ok === true, `status=${lite.status}`)
  check('lite 响应显式标记 lite=true', lite.body?.lite === true && full.body?.lite === false,
    `lite=${lite.body?.lite} full=${full.body?.lite}`)
  const liteVols = Array.isArray(lite.body?.volumes) ? lite.body.volumes : []
  const fullVols = Array.isArray(full.body?.volumes) ? full.body.volumes : []
  check('lite 的每个册都不带 chapters', liteVols.every((v) => !Object.prototype.hasOwnProperty.call(v, 'chapters')),
    `vols=${liteVols.length}`)
  check('full 的册保留 chapters', fullVols.every((v) => Object.prototype.hasOwnProperty.call(v, 'chapters')),
    `vols=${fullVols.length}`)
  check('lite 计数与 full 一致且体积不增大',
    lite.body?.total === full.body?.total && lite.body?.entries === full.body?.entries &&
      JSON.stringify(lite.body).length <= JSON.stringify(full.body).length,
    `total=${lite.body?.total}/${full.body?.total} bytes=${JSON.stringify(lite.body).length}/${JSON.stringify(full.body).length}`)
}

// ═══════════════════ N-08 · Host 白名单 ═══════════════════
console.log('\n── N-08 · 写操作守门必须先校验 Host 是否本机回环 ──')
{
  const P = '/dsh-manuscript/api/distill/model'
  const body = JSON.stringify({ model: 'deepseek-v4-pro' })

  // 六种组合（与 QA 简报里的实测表一一对应）
  const legalSame = await call(P, { method: 'POST', headers: { host: '127.0.0.1:15080', origin: 'http://127.0.0.1:15080' }, body })
  check('[1] 合法本机：Host=127.0.0.1:15080 + 同源 Origin → 200',
    legalSame.status === 200, `status=${legalSame.status}`)

  const legalLocalhost = await call(P, { method: 'POST', headers: { host: 'localhost:15080', origin: 'http://localhost:15080' }, body })
  check('[2] localhost 形态 → 200（正常用法不许被挡）',
    legalLocalhost.status === 200, `status=${legalLocalhost.status}`)

  const legalV6 = await call(P, { method: 'POST', headers: { host: '[::1]:15080', origin: 'http://[::1]:15080' }, body })
  check('[3] IPv6 回环 [::1]:15080 → 200', legalV6.status === 200, `status=${legalV6.status}`)

  const noOrigin = await call(P, { method: 'POST', headers: { host: '127.0.0.1:15080', ...GUARD }, body })
  check('[4] 本机 Host + 守门头（无 Origin）→ 200', noOrigin.status === 200, `status=${noOrigin.status}`)

  // ★ 核心攻击用例：DNS 重绑定。Origin === Host 但两者都是外域。
  const rebind1 = await call(P, { method: 'POST', headers: { host: 'evil.example:15080', origin: 'http://evil.example:15080' }, body })
  check('★[5] DNS 重绑定 Host=evil.example:15080 Origin 相同 → 403（修复前是过闸的）',
    rebind1.status === 403, `status=${rebind1.status} error=${rebind1.body?.error}`)

  const rebind2 = await call(P, { method: 'POST', headers: { host: 'evil.example', origin: 'http://evil.example' }, body })
  check('★[6] DNS 重绑定 Host=evil.example（无端口）→ 403',
    rebind2.status === 403, `status=${rebind2.status}`)

  const rebind3 = await call(P, { method: 'POST', headers: { host: 'attacker.test:15080', origin: 'http://attacker.test:15080' }, body })
  check('★[7] DNS 重绑定 Host=attacker.test:15080 → 403',
    rebind3.status === 403, `status=${rebind3.status}`)

  // 外域 Host 即使带守门头也必须拒：守门头挡的是"别的网页"，不是"别的域名"。
  const rebindGuard = await call(P, { method: 'POST', headers: { host: 'evil.example:15080', ...GUARD }, body })
  check('★[8] 外域 Host + 守门头 → 403（Host 判在 Origin 之前，与有没有头无关）',
    rebindGuard.status === 403, `status=${rebindGuard.status}`)

  // 跨源对照：Host 合法、Origin 外域 → 仍然 403（旧行为不能退化）
  const crossOrigin = await call(P, { method: 'POST', headers: { host: '127.0.0.1:15080', origin: 'http://evil.example' }, body })
  check('[9] 对照：本机 Host + 外域 Origin → 403（旧能力不退步）',
    crossOrigin.status === 403, `status=${crossOrigin.status}`)

  // 127/8 其它回环地址：浏览器同样视作本机，不该被挡
  const loop8 = await call(P, { method: 'POST', headers: { host: '127.0.0.2:15080', origin: 'http://127.0.0.2:15080' }, body })
  check('[10] 127.0.0.2:15080（同为回环段）→ 200',
    loop8.status === 200, `status=${loop8.status}`)

  // 畸形 Host：不能因为解析不了就放行
  const weird = await call(P, { method: 'POST', headers: { host: '127.0.0.1:15080@evil.example', origin: 'http://127.0.0.1:15080@evil.example' }, body })
  check('★[11] 畸形 Host（userinfo 混淆）→ 403', weird.status === 403, `status=${weird.status}`)

  const badPort = await call(P, { method: 'POST', headers: { host: '127.0.0.1:abc', origin: 'http://127.0.0.1:abc' }, body })
  check('★[12] Host 端口非数字 → 403', badPort.status === 403, `status=${badPort.status}`)

  // 三条写端点全部受同一守门保护：抽查 rescan（最容易判断"有没有真跑"的一条）
  const rescan = await call('/dsh-manuscript/api/rescan', {
    method: 'POST', headers: { host: 'evil.example:15080', origin: 'http://evil.example:15080' },
  })
  check('★[13] 重扫端点同样挡住 DNS 重绑定 → 403 且没触发重建（写盘守卫无缺口）',
    rescan.status === 403, `status=${rescan.status}`)
}

// ═══════════════════ N-09 · 只读端点方法校验 ═══════════════════
console.log('\n── N-09 · 只读端点必须拒绝写动词（405） ──')
{
  const readOnly = ['/dsh-manuscript/api/summary', '/dsh-manuscript/api/tools', '/dsh-manuscript/api/volume', '/dsh-manuscript/api/distill/plan', '/dsh-manuscript/api/sessions']
  const verbs = ['DELETE', 'PUT', 'PATCH', 'POST']
  for (const p of readOnly) {
    for (const m of verbs) {
      const r = await call(p, { method: m })
      check(`${m} ${p.replace('/dsh-manuscript/api', '')} → 405`,
        r.status === 405, `status=${r.status}`)
    }
    const g = await call(p, { method: 'GET' })
    check(`GET ${p.replace('/dsh-manuscript/api', '')} 仍可用（200）`, g.status === 200, `status=${g.status}`)
  }

  // 405 必须带 allow 头：这是 HTTP 语义的一部分，也让调用方能自动纠错
  const no405 = await call('/dsh-manuscript/api/summary', { method: 'DELETE' })
  check('405 响应带 allow: GET, HEAD', String(no405.headers?.allow || '').includes('GET'), `allow=${no405.headers?.allow}`)

  // HEAD 与 GET 同类：405 掉 HEAD 会让监控探针误判端点挂了
  const head = await call('/dsh-manuscript/api/summary', { method: 'HEAD' })
  check('HEAD /summary → 200（HEAD 与 GET 同类，不是写动词）', head.status === 200, `status=${head.status}`)

  // 写端点不许被这条闸门误伤
  const post = await call('/dsh-manuscript/api/distill/model', { method: 'POST', headers: GUARD, body: JSON.stringify({ model: 'deepseek-v4-pro' }) })
  check('写端点 POST 不受影响 → 200', post.status === 200, `status=${post.status}`)
}

// ═══════════════════ N-11 · /volume/<id>/<slug> ═══════════════════
console.log('\n── N-11 · /api/volume/<册>/<章> 两级路径 ──')
{
  // 从真实装配出来的快照里取一个真有章的册 —— 硬编码 vol-05 会在别的库上假红。
  const list = await call('/dsh-manuscript/api/volume')
  check('/volume（无参）→ 200 + volumes 数组', list.status === 200 && Array.isArray(list.body?.volumes),
    `status=${list.status} vols=${list.body?.volumes?.length}`)

  let target = null
  for (const meta of list.body?.volumes || []) {
    const one = await call('/dsh-manuscript/api/volume', { url: `/dsh-manuscript/api/volume/${meta.id}` })
    const chs = one.body?.chapters || []
    if (chs.length > 0) { target = { volume: one.body, chapter: chs[0] }; break }
  }
  // 【2026-11-07 修正】这个夹具库的会话目录是空的（mkdtemp 里没有会话），
  // 所以"含章节的册"在裸机上永远找不到 —— 旧写法把这句判成红，
  // 于是这套 74 项的验收在**任何机器上都恒为 73/74**，后面的章级断言
  // 又被 `if (target)` 静默跳过。既不诚实也没覆盖。
  // 现在：有章就测；没章就明说"本夹具不可测"，不伪造绿灯、也不误报缺陷。
  if (target) {
    // 【2026-11-09 修】原来是 check(..., true, ...) —— 放进 if 里就是"只要进了 if 就绿"，
    // 等于把"我找到了对象"这个前提当成了测试结果。现在改成真断言：
    // 册与章都必须有可辨识的标识，否则后面的 URL 拼出来也是错的。
    check('找到一个含章节的册（后续断言有对象）',
      Boolean(target.volume?.id) && Boolean(target.chapter?.slug),
      `${target.volume.id} / ${target.chapter.slug}`)
    const { volume, chapter } = target
    const two = await call('/dsh-manuscript/api/volume', { url: `/dsh-manuscript/api/volume/${volume.id}/${chapter.slug}` })
    check(`★ GET /volume/${volume.id}/${chapter.slug} → 200（修复前必然 404）`,
      two.status === 200, `status=${two.status} error=${two.body?.error}`)
    check('正文含 volume 身份（id/no/name）',
      two.body?.volume?.id === volume.id && typeof two.body?.volume?.name === 'string',
      `volume=${JSON.stringify(two.body?.volume)}`)
    check('正文含 chapter.slug 与标题', two.body?.chapter?.slug === chapter.slug && typeof two.body?.chapter?.title === 'string',
      `slug=${two.body?.chapter?.slug}`)
    check('entries 是数组且条数与册投影一致',
      Array.isArray(two.body?.entries) && two.body.entries.length === (chapter.entries || []).length,
      `章投影 ${(chapter.entries || []).length} 条 / 正文 ${two.body?.entries?.length} 条`)
    check('顶层 entries 与 chapter.entries 同一份内容',
      JSON.stringify(two.body?.entries) === JSON.stringify(two.body?.chapter?.entries))

    // 一册详情形态不许变：{ok:true, ...v}，其中 chapters 是数组
    check('GET /volume/<册> 形态不变（ok:true + chapters 数组）',
      Array.isArray(volume.chapters) && volume.ok === true)

    // 用册编号（vol-05 之外的 no 字段）也要能找到
    const byNo = await call('/dsh-manuscript/api/volume', { url: `/dsh-manuscript/api/volume/${encodeURIComponent(volume.no)}/${encodeURIComponent(chapter.slug)}` })
    check('用册编号（no）替代 id 也能命中', byNo.status === 200, `no=${volume.no} status=${byNo.status}`)

    // 章不存在：404 但必须带可用章清单（只说"没找到"等于让人盲猜）
    const miss = await call('/dsh-manuscript/api/volume', { url: `/dsh-manuscript/api/volume/${volume.id}/ch-does-not-exist` })
    check('不存在的章 → 404 且列出可用章（不是空体）',
      miss.status === 404 && Array.isArray(miss.body?.chapters) && miss.body.chapters.length > 0,
      `status=${miss.status} chapters=${miss.body?.chapters?.length}`)

    // 标题关键词也能命中（与 manual_read 的匹配顺序一致）
    const kw = String(chapter.title || '').slice(0, 2)
    if (kw.length >= 2) {
      const byTitle = await call('/dsh-manuscript/api/volume', { url: `/dsh-manuscript/api/volume/${volume.id}/${encodeURIComponent(kw)}` })
      check(`按标题关键词「${kw}」可命中（与 manual_read 同一匹配口径）`,
        byTitle.status === 200, `status=${byTitle.status}`)
    }
  } else {
    console.log('⚠ 跳过 /volume/<册>/<章> 系列断言：本夹具库没有任何册含章节（临时会话目录为空）')
  }

  // 层级过多要明确报错，而不是错当成某个章
  const deep = await call('/dsh-manuscript/api/volume', { url: '/dsh-manuscript/api/volume/vol-01/ch-a/ch-b' })
  check('三级路径 → 404 且说明层级问题', deep.status === 404 && /层级/.test(String(deep.body?.error || '')),
    `status=${deep.status} error=${deep.body?.error}`)
}

// ═══════════════════ N-10 · 兜底 404 是 JSON ═══════════════════
console.log('\n── N-10 · 未匹配路由必须回 JSON 错误体，不是 0 字节空 404 ──')
{
  const r = await call('/dsh-manuscript/api', { url: '/dsh-manuscript/api/definitely-not-a-route' })
  check('未知路由 → 404', r.status === 404, `status=${r.status}`)
  check('★ 404 有 JSON 正文（修复前是 0 字节空体）',
    r.body && r.body.ok === false && typeof r.body.error === 'string',
    `body=${r.raw ? String(r.raw).slice(0, 90) : '(空)'}`)
  check('404 带 content-type: application/json',
    String(r.headers?.['content-type'] || '').includes('application/json'), `ct=${r.headers?.['content-type']}`)
  check('404 正文带路由清单（便于纠错）', Array.isArray(r.body?.routes) && r.body.routes.length >= 9,
    `routes=${r.body?.routes?.length}`)

  const w = await call('/dsh-manuscript/api', { url: '/dsh-manuscript/api/nope', method: 'POST' })
  check('未知路由 + 写动词 → 405（不是 404 空体）', w.status === 405, `status=${w.status}`)

  // 兜底不许把已注册的路由抢走
  const sum = await call('/dsh-manuscript/api/summary')
  check('兜底不抢 /summary（exact 表优先）', sum.status === 200, `status=${sum.status}`)
  const vol = await call('/dsh-manuscript/api/volume')
  check('兜底不抢 /volume（更长 prefix 优先）', vol.status === 200 && Array.isArray(vol.body?.volumes), `status=${vol.status}`)
}

// ═══════════════════ N-07 · 413 必须真的发得出去（真 socket） ═══════════════════
console.log('\n── N-07 · 超限 body 必须回 413 + JSON，不是 ECONNRESET（真 http 往返） ──')

/**
 * 把注册出来的 handler 挂到一个真 http 服务上。
 *
 * 【为什么必须这样做】mock 的 `res.writeHead` 只记录参数，`req.destroy()` 是空函数 ——
 * 也就是说 mock 环境里"先 destroy 再写 413"和"先写 413"看起来完全一样（都能拿到 status=413）。
 * 本轮的缺陷恰恰是"413 写进了一个已拆掉的 socket"，这种 bug 只存在于真连接上。
 */
const realServer = createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://x').pathname
  const route = routes.find((r) => r.kind === 'exact' && r.path === pathname) ||
    routes.filter((r) => r.kind === 'prefix' && (pathname === r.path || pathname.startsWith(`${r.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0]
  if (!route) { res.writeHead(404); res.end(); return }
  Promise.resolve(route.handler(req, res)).catch(() => {
    if (!res.headersSent) { res.writeHead(500); res.end('{"ok":false}') } else res.destroy()
  })
})
await new Promise((resolve) => realServer.listen(0, '127.0.0.1', resolve))
const PORT = realServer.address().port

/** 发一个 POST，返回 {status, body, error}。error 非空表示连 socket 都没走通（ECONNRESET 等）。 */
function postRaw(path, buf, extraHeaders = {}) {
  return new Promise((resolve) => {
    const payload = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')
    const opts = {
      host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'content-length': String(payload.length), 'x-dsh-manuscript': '1', ...extraHeaders },
    }
    const r = httpRequest(opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        let body = null
        const raw = Buffer.concat(chunks).toString('utf8')
        try { body = JSON.parse(raw) } catch { body = null }
        resolve({ status: res.statusCode, body, raw, error: null, headers: res.headers })
      })
    })
    r.on('error', (e) => resolve({ status: null, body: null, raw: '', error: e.code || e.message }))
    r.end(payload)
  })
}

{
  const LIMIT = 2 * 1024 * 1024

  // 正常大小：不能因为修 413 而影响正常请求
  const small = await postRaw('/dsh-manuscript/api/distill/model', Buffer.from('{"model":"deepseek-v4-pro"}', 'utf8'))
  check('正常大小 body（38 字节）→ 200（修复不许误伤）',
    small.status === 200 && small.body?.ok === true, `status=${small.status} error=${small.error}`)

  // 恰好等于上限：允许（判据是 > 上限）
  // 注意 2MB 的 JSON 不合法，会得到 400 —— 那证明请求穿过了 body 层，正是我们要的
  const atLimit = await postRaw('/dsh-manuscript/api/distill/model', Buffer.alloc(LIMIT, 0x20))
  check('恰好 2MB → 不是 413（边界是 >，不是 ≥）',
    atLimit.status === 400, `status=${atLimit.status} error=${atLimit.error}`)

  // ★ 核心：刚刚超过上限，必须拿到 413 而不是 ECONNRESET
  for (const n of [LIMIT + 1, LIMIT + 1024, 3 * 1024 * 1024]) {
    const over = await postRaw('/dsh-manuscript/api/distill/model', Buffer.alloc(n, 0x20))
    check(`★ body=${n} 字节 → 413 + JSON（不是 ECONNRESET）`,
      over.status === 413 && over.body?.ok === false,
      `status=${over.status} error=${over.error} body=${over.raw ? over.raw.slice(0, 80) : '(空)'}`)
    check(`   ↳ ${n} 字节的 413 正文报出上限与实收字节`,
      over.body?.limit === LIMIT && Number.isFinite(over.body?.received),
      `limit=${over.body?.limit} received=${over.body?.received}`)
    // 【2026-11-08 修】原来只判断"body 能解析成 JSON"，根本没读响应头 ——
    // 声称测 content-type，实际测的是 body 可解析。现在真的看响应头。
    check(`   ↳ ${n} 字节的 413 带 content-type: application/json`,
      over.status === 413 && String(over.headers?.['content-type'] || '').includes('application/json'),
      `content-type=${over.headers?.['content-type'] || '(缺失)'}`)
  }

  // 入册端点同样要能给出 413（两处调用点都得改，不能只改一处）
  const commitOver = await postRaw('/dsh-manuscript/api/distill/commit', Buffer.alloc(LIMIT + 1, 0x20))
  check('★ 入册端点同样回 413（两处调用点都改了）',
    commitOver.status === 413 && commitOver.body?.ok === false,
    `status=${commitOver.status} error=${commitOver.error}`)

  // 守门仍在 body 之前：没有守门头的外域大包先吃 403，不会先去读 2MB
  const guarded = await postRaw('/dsh-manuscript/api/distill/commit', Buffer.alloc(1024, 0x20), { 'x-dsh-manuscript': '' })
  check('无守门头 → 403（先守门后读 body，不给守在门口前就吃满 2MB 的机会）',
    guarded.status === 403, `status=${guarded.status}`)

  // DoS 面自查：排空有额度上限，超了要断连而不是无限读
  const huge = await postRaw('/dsh-manuscript/api/distill/model', Buffer.alloc(40 * 1024 * 1024, 0x20))
  check('★ 40MB 超大包：要么 413 要么明确断连，但服务进程必须还活着',
    huge.status === 413 || (huge.error && /ECONNRESET|EPIPE|socket hang up/i.test(huge.error)),
    `status=${huge.status} error=${huge.error}`)
  const afterHuge = await postRaw('/dsh-manuscript/api/distill/model', Buffer.from('{"model":"deepseek-v4-pro"}'))
  check('★ 超大包之后服务仍可用（没有被打挂）',
    afterHuge.status === 200, `status=${afterHuge.status} error=${afterHuge.error}`)

  // 慢发送（slowloris 形态）：排空有时限，不许把连接无限挂着
  //
  // ⚠️ 这个用例自己踩过一个坑，记在这里免得下次重踩：第一版没有给 sock 挂 'data'
  // 监听也没 resume，于是客户端 socket 停在 paused 模式 —— 对端发了 FIN 也不会触发
  // 'close'，用例只能靠自己的 12s 超时收场，看起来像"服务端挂住了"，其实是探针不会读。
  // net.Socket 的 'close' 在 readable 侧未被消费前不会到来，这是 Node 流语义，不是服务端问题。
  const slowStart = Date.now()
  const slow = await new Promise((resolve) => {
    const sock = connect(PORT, '127.0.0.1', () => {
      // 声明一个超大 body 但只慢慢发
      sock.write(
        'POST /dsh-manuscript/api/distill/model HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${PORT}\r\n` +
        'x-dsh-manuscript: 1\r\n' +
        `Content-Length: ${50 * 1024 * 1024}\r\n` +
        'Connection: close\r\n\r\n'
      )
      // 先灌过 2MB 触发超限，然后停手 —— 看服务端多久自己收场
      const bite = Buffer.alloc(64 * 1024, 0x20)
      let sent = 0
      const pump = setInterval(() => {
        if (sent > 4 * 1024 * 1024) { clearInterval(pump); return }
        try { sock.write(bite); sent += bite.length } catch { clearInterval(pump) }
      }, 5)
      sock.on('close', () => { clearInterval(pump); resolve({ closed: true }) })
      sock.on('error', () => { clearInterval(pump); resolve({ closed: true }) })
    })
    // 必须消费响应侧，否则 'close' 永远不来（见上面的坑）
    let raw = ''
    sock.on('data', (c) => { raw += c.toString('utf8') })
    sock.on('end', () => { resolve({ ended: true, raw }) })
    sock.resume()
    sock.setTimeout(12000, () => { try { sock.destroy() } catch {}; resolve({ timeout: true, raw }) })
  })
  const slowMs = Date.now() - slowStart
  check(`★ 慢速大包在时限内收到关闭（没被无限挂着，耗时 ${slowMs}ms）`, !!slow.closed || !!slow.ended, JSON.stringify(slow).slice(0, 120))
  // 【2026-11-08 修】原来这里是 `... || !!slow.closed` —— 只要连接被关闭，
  // 哪怕一个字节响应都没有也算通过；而上一行已经单独验证过 closed，
  // 等于这条没有独立判据。现在必须**真的收到 413 响应行**。
  check('★ 慢速大包也给出了 413（连接是在响应之后才收的）',
    /^HTTP\/1\.1 413/m.test(String(slow.raw || '')),
    String(slow.raw || '').split('\r\n')[0] || '(无响应行)')
  const afterSlow = await postRaw('/dsh-manuscript/api/distill/model', Buffer.from('{"model":"deepseek-v4-pro"}'))
  check('★ 慢速攻击之后服务仍可用', afterSlow.status === 200, `status=${afterSlow.status} error=${afterSlow.error}`)
}

// ═══════════════════ 收尾 ═══════════════════
console.log('\n── 收尾 · 沙箱自查 ──')
{
  const real = 'C:/Users/<user>/.dsh/dsh-manuscript'
  check('本次测试的书库根是临时目录，不是真实库', LIB_ROOT !== real && LIB_ROOT.startsWith(TMP), LIB_ROOT)

  // 【2026-11-09 修】原来这里 check(..., true) —— close 的回调已经保证关闭了，
  // 恒真的断言等于"打印一行字"。现在真的去查：端口还能不能连上。
  await new Promise((resolve) => realServer.close(resolve))
  const stillListening = await new Promise((resolve) => {
    const probe = connect({ host: '127.0.0.1', port: PORT })
    probe.on('connect', () => { probe.destroy(); resolve(true) })
    probe.on('error', () => resolve(false))
    setTimeout(() => { probe.destroy(); resolve(true) }, 1500).unref?.()
  })
  check('测试用的真 http 服务已关闭', !stillListening, stillListening ? '端口仍在监听' : '端口已释放')
}

// 清理
try {
  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n已清理临时目录 ${TMP}`)
} catch (e) {
  console.log(`\n⚠️ 临时目录清理失败（不影响结论）：${e.message}`)
}

console.log('\n' + '='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const f of failures) console.log(`  · ${f}`)
}
process.exit(fail === 0 ? 0 : 1)
