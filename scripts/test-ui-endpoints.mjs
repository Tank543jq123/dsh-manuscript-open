#!/usr/bin/env node
/**
 * test-ui-endpoints.mjs —— 验证 2026-11-12 新增的两条「给人用」的只读端点。
 *
 *   GET /dsh-manuscript/api/search?q=<关键词>&topK=8
 *   GET /dsh-manuscript/api/entry?id=<条目 id>
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

import { mkdtempSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs'
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

function mkReq({ url = '/', method = 'GET', headers = {} } = {}) {
  return { url, method, headers, on() { return this }, destroy() {} }
}

async function call(path, opts = {}) {
  const route = routes.find((r) => r.kind === 'exact' && r.path === path)
  if (!route) throw new Error('没有注册路由：' + path)
  const out = mkRes()
  await route.handler(mkReq({ url: opts.url || path, ...opts }), out.res)
  return { status: out.status, body: out.body, raw: out.raw }
}

console.log('\n── 0. 装配 ──')
await apply(mockCtx)
check('注册了 /api/search', routes.some((r) => r.path === '/dsh-manuscript/api/search'))
check('注册了 /api/entry', routes.some((r) => r.path === '/dsh-manuscript/api/entry'))

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

console.log(`\n结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
rmSync(TMP, { recursive: true, force: true })
if (fail > 0) {
  console.log('失败用例：', failures.join('；'))
  process.exit(1)
}
