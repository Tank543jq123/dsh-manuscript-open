#!/usr/bin/env node
/**
 * probe-guard-n08.mjs —— 只产出「N-08 修复后的六种 Host/Origin 组合」对照表。
 *
 * 为什么单独一个脚本：交付要求里明确要这张表，而 test-http-hardening.mjs 的
 * 输出混在 83 条断言里，翻起来费劲。这里的产出是可直接贴进报告的表格 +
 * 一份 JSON，供 lead 核对。
 *
 * 用的是**新代码 + 真 socket**（不是活体 15080 —— 那个进程还跑着旧代码，不能重启）。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request } from 'node:http'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-n08-'))
const LIB_ROOT = join(TMP, 'library')
process.env.DSH_MANUSCRIPT_ROOT = LIB_ROOT
process.env.DSH_SESSIONS_ROOT = join(TMP, 'sessions')
process.env.DSH_WORKSPACE_JSON = join(TMP, 'nope.json')
mkdirSync(LIB_ROOT, { recursive: true })
mkdirSync(process.env.DSH_SESSIONS_ROOT, { recursive: true })
process.argv[1] = 'C:/Users/<user>/AppData/Local/OpenClaw/deps/portable-node/node_modules/@deepseek-ai/dsh/lib/bin.js'

const { apply } = await import('../lib/index.js')

const routes = []
const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  tools: { register() { return () => {} }, schemas() { return [] } },
  systemPrompt: { getSectionOrder() { return 3100 }, section() { return () => {} } },
  webServer: { register(r) { routes.push(r); return () => {} } },
  llm: {},
  effect(fn) { const d = fn && fn(); return typeof d === 'function' ? d : () => {} },
  on() { return () => {} },
  inject(d, cb) { cb(ctx); return {} },
  get() { return undefined },
}
await apply(ctx)

const server = createServer((req, res) => {
  const pn = new URL(req.url || '/', 'http://x').pathname
  const route = routes.find((r) => r.kind === 'exact' && r.path === pn) ||
    routes.filter((r) => r.kind === 'prefix' && (pn === r.path || pn.startsWith(`${r.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0]
  if (!route) { res.writeHead(404); res.end('{}'); return }
  Promise.resolve(route.handler(req, res)).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end('{}') } })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

function post(headers, path = '/dsh-manuscript/api/distill/model', body = JSON.stringify({ model: 'deepseek-v4-pro' })) {
  return new Promise((resolve) => {
    const payload = Buffer.from(body, 'utf8')
    const r = request({
      host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'content-length': String(payload.length), ...headers },
    }, (res) => {
      const cs = []
      res.on('data', (c) => cs.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString('utf8') }))
    })
    r.on('error', (e) => resolve({ status: null, body: `ERR:${e.code || e.message}` }))
    r.end(payload)
  })
}

const CASES = [
  { n: 1, desc: '合法本机（Origin==Host，都在回环）', h: { host: '127.0.0.1:15080', origin: 'http://127.0.0.1:15080' }, expect: 200 },
  { n: 2, desc: '合法本机 localhost 形态', h: { host: 'localhost:15080', origin: 'http://localhost:15080' }, expect: 200 },
  { n: 3, desc: '合法本机 IPv6 [::1]', h: { host: '[::1]:15080', origin: 'http://[::1]:15080' }, expect: 200 },
  { n: 4, desc: '本机 Host + 无 Origin + 守门头（curl/本机进程）', h: { host: '127.0.0.1:15080', 'x-dsh-manuscript': '1' }, expect: 200 },
  { n: 5, desc: '跨源对照：本机 Host + 外域 Origin', h: { host: '127.0.0.1:15080', origin: 'http://evil.example' }, expect: 403 },
  { n: 6, desc: '★DNS 重绑定：外域 Host + 同一外域 Origin', h: { host: 'evil.example:15080', origin: 'http://evil.example:15080' }, expect: 403 },
  { n: 7, desc: '★DNS 重绑定：无端口形态', h: { host: 'evil.example', origin: 'http://evil.example' }, expect: 403 },
  { n: 8, desc: '★DNS 重绑定：另一外域', h: { host: 'attacker.test:15080', origin: 'http://attacker.test:15080' }, expect: 403 },
  { n: 9, desc: '★外域 Host + 守门头（Host 判在 Origin 之前）', h: { host: 'evil.example:15080', 'x-dsh-manuscript': '1' }, expect: 403 },
]

const rows = []
console.log('| # | 组合 | Host | Origin | 期望 | 实测 | 判定 |')
console.log('|:--|:---|:---|:---|:---:|:---:|:---:|')
for (const c of CASES) {
  const r = await post(c.h)
  const ok = r.status === c.expect
  rows.push({ ...c, got: r.status, ok, body: r.body })
  console.log(`| ${c.n} | ${c.desc} | \`${c.h.host}\` | ${c.h.origin ? '`' + c.h.origin + '`' : '(无)'} | ${c.expect} | ${r.status} | ${ok ? '✅' : '❌'} |`)
}

// 六种核心组合（简报原文的四行 + localhost + IPv6 两种正常形态）单独强调
const SIX = [1, 2, 3, 5, 6, 7]
console.log('\n── 简报点名的六种组合 ──')
for (const n of SIX) {
  const r = rows.find((x) => x.n === n)
  console.log(`[${n}] ${r.desc} → ${r.got} ${r.ok ? '✅' : '❌'}`)
}

const allOk = rows.every((r) => r.ok)
console.log(`\n结论：${allOk ? '全部符合期望' : '存在不符合项'}（${rows.filter((r) => r.ok).length}/${rows.length}）`)

try {
  writeFileSync(process.env.PROBE_OUT || join(process.cwd(), 'n08-matrix.json'), JSON.stringify({ at: new Date().toISOString(), port: PORT, rows, allOk }, null, 2), 'utf8')
} catch { /* 写不出不影响结论 */ }

await new Promise((r) => server.close(r))
rmSync(TMP, { recursive: true, force: true })
process.exit(allOk ? 0 : 1)
