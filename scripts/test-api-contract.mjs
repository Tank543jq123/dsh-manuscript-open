#!/usr/bin/env node
/**
 * test-api-contract.mjs —— 接口契约回归（CI 用，零真实语料）。
 *
 * 2026-11-14 QA 报告建议把「手工验过的口径」钉进 CI，这里覆盖：
 *   · search 的 topK 非法值报错文案是 `topK`（曾误写成 limit）
 *   · search 的 topK 超上限时回 topK 实际值 + clamped:true（不静默夹取）
 *   · GET /api/trace 的四种结果：正常 / 缺参 400 / 未知 id 404 / POST 405
 *   · POST 端点缺守门头 403
 *
 * 语料是临时目录里手写的两条 .md —— 不依赖本机书库，CI 上也能跑。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-ms-contract-'))
const LIB = join(TMP, 'library')
mkdirSync(join(LIB, 'vol-03', 'ch-plugin'), { recursive: true })
writeFileSync(join(LIB, 'vol-03', 'ch-plugin', 'e-aaaa00000001.md'), `---
id: "e-aaaa00000001"
title: "插件热加载不需要重启"
volume: "vol-03"
chapter: "ch-plugin"
confidence: "high"
authority: "L2"
claim: "把插件装进运行中的 profile 后，HMR 会热加载，刷新页面即可。"
why: "服务端也能把客户端清单下发给浏览器。"
---
正文占位。
`)
writeFileSync(join(LIB, 'vol-03', 'ch-plugin', 'e-aaaa00000002.md'), `---
id: "e-aaaa00000002"
title: "web_fetch 有 30 秒超时"
volume: "vol-03"
chapter: "ch-plugin"
confidence: "medium"
authority: "L2"
claim: "抓 GitHub 会撞 30 秒上限，要分段或换直连。"
---
正文占位。
`)

process.env.DSH_MANUSCRIPT_ROOT = LIB
process.env.DSH_SESSIONS_ROOT = join(TMP, 'sessions')
process.env.DSH_WORKSPACE_JSON = join(TMP, 'no-such-workspace.json')
process.argv[1] = 'C:/Users/<user>/AppData/Local/OpenClaw/deps/portable-node/node_modules/@deepseek-ai/dsh/lib/bin.js'

const { apply } = await import('../lib/index.js')

let pass = 0
const failures = []
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✓ ${name}${extra ? '  ' + extra : ''}`) }
  else { failures.push(name); console.log(`✗ ${name}${extra ? '  ' + extra : ''}`) }
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
  const out = { status: 0, body: null }
  out.res = { writeHead(c) { out.status = c }, end(b) { try { out.body = JSON.parse(String(b ?? '')) } catch { out.body = null } } }
  return out
}
function mkReq({ url = '/', method = 'GET', headers = {}, body = null } = {}) {
  const ls = new Map()
  const req = { url, method, headers, on(e, f) { (ls.get(e) || ls.set(e, []).get(e)).push(f); return req }, destroy() {} }
  if (body !== null) {
    const buf = Buffer.from(String(body), 'utf8')
    setImmediate(() => { for (const f of ls.get('data') || []) f(buf); for (const f of ls.get('end') || []) f() })
  }
  return req
}
const find = (p) => routes.find((r) => r.path === p && r.kind === 'exact')

await apply(mockCtx)
const callPath = async (path, opts = {}) => {
  const route = find(path)
  if (!route) throw new Error('未找到路由 ' + path)
  const o = mkRes()
  await route.handler(mkReq({ ...opts, url: opts.url || path }), o.res)
  return o
}
// 等首次扫描完成：轮询 summary，直到 200（小库通常 <2s）。
for (let i = 0; i < 60; i += 1) {
  await new Promise((r) => setTimeout(r, 250))
  try { const o = await callPath('/dsh-manuscript/api/summary'); if (o.status === 200) break } catch {}
}

check('注册了 /api/search', !!find('/dsh-manuscript/api/search'))


const bad = await callPath('/dsh-manuscript/api/search', { url: '/dsh-manuscript/api/search?q=插件&topK=abc' })
check('topK 非法值报错用参数名 topK', bad.status === 400 && /topK 必须是/.test(bad.body?.error || ''), bad.body?.error)

const big = await callPath('/dsh-manuscript/api/search', { url: '/dsh-manuscript/api/search?q=插件&topK=999' })
check('topK 超上限回 clamped:true 与实际 topK', big.body?.clamped === true && big.body?.topK === 50, `topK=${big.body?.topK} clamped=${big.body?.clamped}`)

const trace = find('/dsh-manuscript/api/trace')
check('注册了 /api/trace', !!find('/dsh-manuscript/api/trace'))
const tr = await callPath('/dsh-manuscript/api/trace', { url: '/dsh-manuscript/api/trace?entry_id=e-aaaa00000001' })
check('trace 正常返回条目', tr.status === 200 && tr.body?.entry?.id === 'e-aaaa00000001', tr.body?.entry?.title)

const tr400 = await callPath('/dsh-manuscript/api/trace', { url: '/dsh-manuscript/api/trace' })
check('trace 缺参 400', tr400.status === 400)
const tr404 = await callPath('/dsh-manuscript/api/trace', { url: '/dsh-manuscript/api/trace?entry_id=e-nope' })
check('trace 未知 id 404', tr404.status === 404)
const tr405 = await callPath('/dsh-manuscript/api/trace', { url: '/dsh-manuscript/api/trace?entry_id=e-aaaa00000001', method: 'POST', body: '{}' })
check('trace POST 405', tr405.status === 405)

const save = find('/dsh-manuscript/api/entry-save')
check('注册了 /api/entry-save', !!find('/dsh-manuscript/api/entry-save'))
const saveNoGuard = await callPath('/dsh-manuscript/api/entry-save', { url: '/dsh-manuscript/api/entry-save', method: 'POST', body: '{"title":"x","claim":"y","why":"z"}' })
check('entry-save 缺守门头 403', saveNoGuard.status === 403)

console.log('\n' + '='.repeat(60))
console.log(`结果：${pass} 通过 / ${failures.length} 失败 / 共 ${pass + failures.length}`)
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
if (failures.length) { for (const f of failures) console.log('  · ' + f); process.exit(1) }
