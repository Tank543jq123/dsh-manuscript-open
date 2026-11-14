#!/usr/bin/env node
/**
 * test-ui-endpoints.mjs —— 验证 2026-11-12 新增的「给人用」端点。
 *
 *   GET  /dsh-manuscript/api/search?q=<关键词>&topK=8
 *   GET  /dsh-manuscript/api/entry?id=<条目 id>
 *   GET  /dsh-manuscript/api/check-settings          （巡检设置读）
 *   POST /dsh-manuscript/api/check-settings          （巡检设置写）
 *   POST /dsh-manuscript/api/check-run               （立即跑一轮巡检）
 *
 * ## 为什么用「真实库的副本」而不是夹具
 *
 * 这两个端点的价值全在**真实语料上的排序与正文读取**：search 复用 matchEntries，
 * entry 回读 entries/<id>.json。用 3 条假条目测，等于只测了 JSON 拼装。
 * 所以这里把 ~/.dsh/dsh-manuscript 整个复制到 tmpdir 再跑 —— 真实规模，
 * 但写入只落在副本上，用户书库一个字节都不动。
 *
 * 会话根指向空目录：buildLibrary 靠 entries/ 做幂等合并，不扫会话也能保留全部条目。
 */

import { mkdtempSync, mkdirSync, cpSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'

const REAL_ROOT = join(homedir(), '.dsh', 'dsh-manuscript')
const TMP = mkdtempSync(join(tmpdir(), 'dsh-ms-ui-'))
const LIB_ROOT = join(TMP, 'library')
const SESSIONS_ROOT = join(TMP, 'sessions')

mkdirSync(SESSIONS_ROOT, { recursive: true })
if (existsSync(REAL_ROOT)) cpSync(REAL_ROOT, LIB_ROOT, { recursive: true })
else mkdirSync(LIB_ROOT, { recursive: true })

// 巡检设置从"文件不存在"开始测：真实库副本里可能已经有用户设置，
// 带着它跑会让默认值断言随用户当前配置漂移（假红/假绿都难查）。
const SETTINGS_FILE = join(LIB_ROOT, 'check-settings.json')
rmSync(SETTINGS_FILE, { force: true })

process.env.DSH_MANUSCRIPT_ROOT = LIB_ROOT
process.env.DSH_SESSIONS_ROOT = SESSIONS_ROOT
process.env.DSH_WORKSPACE_JSON = join(TMP, 'no-such-workspace.json')

process.argv[1] = 'C:/Users/<user>/AppData/Local/OpenClaw/deps/portable-node/node_modules/@deepseek-ai/dsh/lib/bin.js'

const { apply } = await import('../lib/index.js')

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

function mkRes() {
  const out = { status: 0, body: null, raw: '' }
  out.res = {
    writeHead(code) { out.status = code },
    end(body) { out.raw = body == null ? '' : String(body); try { out.body = JSON.parse(out.raw) } catch { out.body = null } },
  }
  return out
}

/**
 * 造一个假 req。
 *
 * `body` 给了才吐 data/end —— 巡检设置是 POST 端点，走 readBodyWithLimit；
 * 没有 data/end 的 mock 会让它永远等下去（测试直接挂住，而不是报错）。
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
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
    setImmediate(() => {
      for (const fn of listeners.get('data') || []) fn(buf)
      for (const fn of listeners.get('end') || []) fn()
    })
  }
  return req
}

async function call(path, opts = {}) {
  const route = routes.find((r) => r.kind === 'exact' && r.path === path)
  if (!route) throw new Error('没有注册路由：' + path)
  const out = mkRes()
  await route.handler(mkReq({ url: opts.url || path, ...opts }), out.res)
  return { status: out.status, body: out.body, raw: out.raw }
}

const GUARD = { 'x-dsh-manuscript': '1' }
const postJsonBody = (obj) => ({ method: 'POST', headers: GUARD, body: JSON.stringify(obj) })

console.log('\n── 0. 装配 ──')
await apply(mockCtx)
check('注册了 /api/search', routes.some((r) => r.path === '/dsh-manuscript/api/search'))
check('注册了 /api/entry', routes.some((r) => r.path === '/dsh-manuscript/api/entry'))
check('注册了 /api/check-settings', routes.some((r) => r.path === '/dsh-manuscript/api/check-settings'))
check('注册了 /api/check-run', routes.some((r) => r.path === '/dsh-manuscript/api/check-run'))

// 等首次扫描完成
let ok = false
const deadline = Date.now() + 30000
while (Date.now() < deadline) {
  const r = await call('/dsh-manuscript/api/summary')
  if (r.status === 200 && r.body && r.body.ok === true) { ok = true; break }
  await new Promise((resolve) => setTimeout(resolve, 200))
}
check('首次扫描完成', ok)
if (!ok) {
  console.log('\n扫描未完成，后续用例跳过。')
  rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
}

console.log('\n── 1. /api/search ──')
{
  const r = await call('/dsh-manuscript/api/search', { url: '/dsh-manuscript/api/search?q=' + encodeURIComponent('插件') + '&topK=5' })
  check('搜索「插件」→ 200', r.status === 200)
  check('返回 ok:true 且 hits 是数组', r.body?.ok === true && Array.isArray(r.body?.hits))
  check('有命中（真实语料里「插件」不可能 0 条）', (r.body?.hits?.length || 0) > 0, `hits=${r.body?.hits?.length}`)
  const h = r.body?.hits?.[0] || {}
  check('命中项含 id/title/claim/volume/volumeName/chapter', ['id', 'title', 'claim', 'volume', 'volumeName', 'chapter'].every((k) => k in h), JSON.stringify(h).slice(0, 160))
  check('命中项 id 非空、score 是数字', !!h.id && Number.isFinite(h.score))
  console.log('   样例：', JSON.stringify(r.body?.hits?.slice(0, 2), null, 1).slice(0, 700))

  const miss = await call('/dsh-manuscript/api/search', { url: '/dsh-manuscript/api/search?q=' + encodeURIComponent('zzzqqq') })
  check('无关查询 → 200 且 hits 为空（fail-closed，不假召回）', miss.status === 200 && miss.body?.ok === true && Array.isArray(miss.body?.hits) && miss.body.hits.length === 0, `hits=${miss.body?.hits?.length}`)

  const noQ = await call('/dsh-manuscript/api/search')
  check('缺 q → 400', noQ.status === 400, `status=${noQ.status}`)

  const badTopK = await call('/dsh-manuscript/api/search', { url: '/dsh-manuscript/api/search?q=插件&topK=-1' })
  check('非法 topK → 400', badTopK.status === 400, `status=${badTopK.status}`)

  const post = await call('/dsh-manuscript/api/search', { method: 'POST', url: '/dsh-manuscript/api/search?q=插件' })
  check('POST → 405', post.status === 405, `status=${post.status}`)
}

console.log('\n── 2. /api/entry ──')
let sampleId = null
{
  const s = await call('/dsh-manuscript/api/search', { url: '/dsh-manuscript/api/search?q=' + encodeURIComponent('插件') + '&topK=1' })
  sampleId = s.body?.hits?.[0]?.id || null
}
check('取得一个真实条目 id 用于详情测试', !!sampleId, String(sampleId))
{
  const r = await call('/dsh-manuscript/api/entry', { url: '/dsh-manuscript/api/entry?id=' + encodeURIComponent(sampleId) })
  check('条目详情 → 200', r.status === 200)
  const e = r.body?.entry || {}
  check('含 id/title/claim/body', ['id', 'title', 'claim', 'body'].every((k) => k in e))
  check('body 非空', typeof e.body === 'string' && e.body.length > 0, `bodyLen=${e.body?.length}`)
  check('含 volumeName/chapter', !!e.volumeName && !!e.chapter, `${e.volumeName} / ${e.chapter}`)
  check('bodyIsClaim 是布尔（不是 null 占位）', typeof e.bodyIsClaim === 'boolean', `bodyIsClaim=${e.bodyIsClaim}`)
  console.log('   样例：', JSON.stringify({ id: e.id, title: e.title, body: String(e.body || '').slice(0, 120), bodyIsClaim: e.bodyIsClaim, volumeName: e.volumeName, chapter: e.chapter }, null, 1))

  // 已提炼的条目必须能拿到 why（正文），而不是只有 claim。
  // e-b905855e6d7b 是真实库里的已提炼条目（write 先读后写那条），正文与摘要不同。
  const deep = await call('/dsh-manuscript/api/entry', { url: '/dsh-manuscript/api/entry?id=e-b905855e6d7b' })
  check('已提炼条目 → 200 且 bodyIsClaim=false', deep.status === 200 && deep.body?.entry?.bodyIsClaim === false, `status=${deep.status} bodyIsClaim=${deep.body?.entry?.bodyIsClaim}`)
  check('正文来自 why（与 claim 不同）', !!deep.body?.entry?.body && deep.body.entry.body !== deep.body.entry.claim)
  console.log('   正文样例：', String(deep.body?.entry?.body || '').slice(0, 120))

  const noId = await call('/dsh-manuscript/api/entry')
  check('缺 id → 400', noId.status === 400, `status=${noId.status}`)

  const traversal = await call('/dsh-manuscript/api/entry', { url: '/dsh-manuscript/api/entry?id=' + encodeURIComponent('../../etc/passwd') })
  check('目录穿越 id → 400（不是 500）', traversal.status === 400, `status=${traversal.status}`)

  const missing = await call('/dsh-manuscript/api/entry', { url: '/dsh-manuscript/api/entry?id=e-no-such-entry-000' })
  check('不存在的条目 → 404', missing.status === 404, `status=${missing.status}`)
}

console.log('\n── 3. /api/check-settings（巡检设置）──')
{
  // ① 默认值：文件不存在 = 启用 + 07:00。这不是"没数据"，是刻意的默认调度。
  const first = await call('/dsh-manuscript/api/check-settings')
  check('默认读 → 200', first.status === 200, `status=${first.status}`)
  check('默认 settings = enabled:true / time:07:00',
    first.body?.settings?.enabled === true && first.body?.settings?.time === '07:00',
    JSON.stringify(first.body?.settings))
  check('默认 nextRun 是带时区的本地 ISO',
    typeof first.body?.nextRun === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/.test(first.body.nextRun),
    String(first.body?.nextRun))
  check('nextRun 落在未来', new Date(first.body?.nextRun || 0).getTime() > Date.now())
  check('warnings 是数组且为空（首次无文件不算异常）',
    Array.isArray(first.body?.warnings) && first.body.warnings.length === 0,
    JSON.stringify(first.body?.warnings))

  // ② 非法输入必须 400，而且**不能**把坏值写到磁盘上。
  const bad = [
    ['25:00', '{enabled:true,time:"25:00"} 非法小时'],
    ['7:00', '{time:"7:00"} 非两位数小时'],
    ['07:60', '{time:"07:60"} 非法分钟'],
    ['07:00:00', '{time:"07:00:00"} 带秒'],
    ['noon', '{time:"noon"} 非时间'],
  ]
  for (const [label, desc] of bad) {
    const r = await call('/dsh-manuscript/api/check-settings', postJsonBody({ enabled: true, time: label }))
    check(`time="${label}" → 400（${desc}）`, r.status === 400, `status=${r.status} error=${r.body?.error}`)
  }
  const badEnabled = await call('/dsh-manuscript/api/check-settings', postJsonBody({ enabled: 'yes', time: '07:00' }))
  check('enabled 非布尔 → 400', badEnabled.status === 400, `status=${badEnabled.status}`)
  const missing = await call('/dsh-manuscript/api/check-settings', postJsonBody({ time: '07:00' }))
  check('缺 enabled → 400（不静默补默认值）', missing.status === 400, `status=${missing.status}`)
  const notJson = await call('/dsh-manuscript/api/check-settings', { method: 'POST', headers: GUARD, body: 'not-json' })
  check('body 非 JSON → 400', notJson.status === 400, `status=${notJson.status}`)
  check('非法请求没有写盘（文件仍不存在）', !existsSync(SETTINGS_FILE))
  check('非法请求后 GET 仍是默认 07:00',
    (await call('/dsh-manuscript/api/check-settings')).body?.settings?.time === '07:00')

  // ③ 守门：跨源/无守门头的写请求必须 403
  const noGuard = await call('/dsh-manuscript/api/check-settings', {
    method: 'POST',
    body: JSON.stringify({ enabled: false, time: '09:30' }),
  })
  check('无守门头 → 403', noGuard.status === 403, `status=${noGuard.status}`)
  const getWithBody = await call('/dsh-manuscript/api/check-settings', { method: 'POST', body: '{}' })
  check('无守门头的 POST 没写盘', !existsSync(SETTINGS_FILE))

  // ④ 合法写入：停用 + 23:45
  const off = await call('/dsh-manuscript/api/check-settings', postJsonBody({ enabled: false, time: '23:45' }))
  check('写入 enabled:false / 23:45 → 200', off.status === 200 && off.body?.ok === true, `status=${off.status}`)
  check('响应回显写入值', off.body?.settings?.enabled === false && off.body?.settings?.time === '23:45',
    JSON.stringify(off.body?.settings))
  check('停用时 nextRun = null（不是空字符串）', off.body?.nextRun === null, `nextRun=${JSON.stringify(off.body?.nextRun)}`)
  const onDisk = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
  check('磁盘上的设置与响应一致',
    onDisk.enabled === false && onDisk.time === '23:45', JSON.stringify(onDisk))
  check('settingsFile 指向临时库（证明没有碰用户真实书库）',
    String(off.body?.settingsFile || '').startsWith(LIB_ROOT), String(off.body?.settingsFile))

  // ⑤ 再读一次：读到的必须是刚存的值（不是内存里的旧值）
  const again = await call('/dsh-manuscript/api/check-settings')
  check('重读 → enabled:false / 23:45',
    again.body?.settings?.enabled === false && again.body?.settings?.time === '23:45',
    JSON.stringify(again.body?.settings))
  check('重读 nextRun 仍为 null', again.body?.nextRun === null)

  // ⑥ 恢复 07:00 + 启用：nextRun 必须重新出现，且时分正确
  const restore = await call('/dsh-manuscript/api/check-settings', postJsonBody({ enabled: true, time: '07:00' }))
  check('恢复 enabled:true / 07:00 → 200', restore.status === 200)
  check('恢复后 nextRun 时分是 07:00',
    /T07:00:00[+-]\d{2}:\d{2}$/.test(String(restore.body?.nextRun || '')), String(restore.body?.nextRun))

  // ⑦ 只读端点的方法闸门仍在（GET 路径不允许 DELETE/PUT）
  const del = await call('/dsh-manuscript/api/check-settings', { method: 'DELETE' })
  check('DELETE → 405', del.status === 405, `status=${del.status}`)

  // ⑧ 文件被外部写坏：GET 不许 500，回落默认值并把原因说出来。
  // 这是"用户手改 settings.json 改坏了"的真实场景 —— 静默回落等于骗人。
  writeFileSync(SETTINGS_FILE, '{ this is not json')
  const broken = await call('/dsh-manuscript/api/check-settings')
  check('坏文件 → 200（不 500）', broken.status === 200, `status=${broken.status}`)
  check('坏文件回落默认值 enabled:true / 07:00',
    broken.body?.settings?.enabled === true && broken.body?.settings?.time === '07:00',
    JSON.stringify(broken.body?.settings))
  check('坏文件回落有 warnings 说明（不静默）',
    Array.isArray(broken.body?.warnings) && broken.body.warnings.length >= 1,
    JSON.stringify(broken.body?.warnings))
  // 复位，避免留下坏文件影响后续（同一次进程里可能还有别的用例）
  writeFileSync(SETTINGS_FILE, JSON.stringify({ enabled: true, time: '07:00' }, null, 2) + '\n')
}

console.log('\n── 4. /api/check-run（立即运行）──')
{
  const get = await call('/dsh-manuscript/api/check-run')
  check('GET → 405（这是写操作）', get.status === 405, `status=${get.status}`)

  const noGuard = await call('/dsh-manuscript/api/check-run', { method: 'POST' })
  check('无守门头 → 403', noGuard.status === 403, `status=${noGuard.status}`)

  // 用桩替代真正的 systemctl：这个测试**绝不能**真的启动一轮巡检
  // （那会写用户真实日志、跑几分钟全量套件）。这里只验证"命令被正确发出"。
  const callsLog = join(TMP, 'systemctl-calls.log')
  const stubOk = join(TMP, 'stub-systemctl-ok.sh')
  writeFileSync(stubOk, `#!/bin/sh\necho "$@" >> "${callsLog}"\nexit 0\n`)
  chmodSync(stubOk, 0o755)
  process.env.DSH_MANUSCRIPT_SYSTEMCTL = stubOk

  const started = await call('/dsh-manuscript/api/check-run', { method: 'POST', headers: GUARD, body: '{}' })
  check('POST → 200 且 started:true', started.status === 200 && started.body?.ok === true && started.body?.started === true,
    `status=${started.status} body=${JSON.stringify(started.body)}`)
  const calls = existsSync(callsLog) ? readFileSync(callsLog, 'utf8').trim() : ''
  check('发出的是 --user start --no-block manuscript-daily-check.service',
    calls.includes('--user start --no-block manuscript-daily-check.service'), calls)

  // 失败路径：systemctl 非零退出 → 503，且错误正文里带 stderr（不吞）
  const stubFail = join(TMP, 'stub-systemctl-fail.sh')
  writeFileSync(stubFail, '#!/bin/sh\necho "Unit manuscript-daily-check.service not found." >&2\nexit 5\n')
  chmodSync(stubFail, 0o755)
  process.env.DSH_MANUSCRIPT_SYSTEMCTL = stubFail
  const failed = await call('/dsh-manuscript/api/check-run', { method: 'POST', headers: GUARD, body: '{}' })
  check('systemctl 失败 → 503（不是假成功）', failed.status === 503, `status=${failed.status}`)
  check('503 正文带真实原因', String(failed.body?.error || '').includes('not found'), String(failed.body?.error))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
rmSync(TMP, { recursive: true, force: true })
if (fail > 0) {
  console.log('失败用例：', failures.join('；'))
  process.exit(1)
}
