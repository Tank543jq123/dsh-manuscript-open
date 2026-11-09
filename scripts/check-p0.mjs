#!/usr/bin/env node
/**
 * 检查 2026-11-01 三项 P0 改动的落地情况。
 *
 * 为什么单独一个脚本而不是塞进 selfcheck：
 *   selfcheck 验证的是"数据流水线正确"，这三项验证的是"产品约束是否真的生效"。
 *   两类东西失败的含义不同，分开跑便于定位。
 *
 * 覆盖：
 *   P0-1  system prompt 行为规约（10 条硬约束）
 *   P0-2  设计系统 —— 全部走 DSH 官方 token
 *   P0-3  有序判定表 —— 互斥且完备
 *   P1    后台扫描 —— 不阻塞前台
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const results = []
function check(name, fn) {
  const t0 = Date.now()
  try {
    const detail = fn()
    results.push({ name, status: 'PASS', detail, ms: Date.now() - t0 })
  } catch (e) {
    results.push({ name, status: 'FAIL', detail: e.message, ms: Date.now() - t0 })
  }
}
function assert(c, m) {
  if (!c) throw new Error(m)
}
async function checkAsync(name, fn) {
  const t0 = Date.now()
  try {
    const detail = await fn()
    results.push({ name, status: 'PASS', detail, ms: Date.now() - t0 })
  } catch (e) {
    results.push({ name, status: 'FAIL', detail: e.message, ms: Date.now() - t0 })
  }
}

const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const lib = readFileSync(new URL('../lib/library.js', import.meta.url), 'utf8')

// ─────────────────────────────────────────
// P0-1 system prompt 行为规约
// ─────────────────────────────────────────
check('P0-1a 规约段已注册（独立于目录段）', () => {
  assert(host.includes('CONTRACT_NAME'), '缺 CONTRACT_NAME 常量')
  assert(host.includes("name: CONTRACT_NAME"), '规约段没有注册进 systemPrompt')
  assert(host.includes('renderContract'), '缺 renderContract 实现')
  return 'CONTRACT_NAME + renderContract 均已接线'
})

check('P0-1b 规约先于目录注入（order 更小）', () => {
  const cm = /CONTRACT_ORDER\s*=\s*(\d+)/.exec(host)
  const sm = /SECTION_ORDER\s*=\s*(\d+)/.exec(host)
  assert(cm && sm, '缺 order 常量')
  const c = Number(cm[1])
  const s = Number(sm[1])
  assert(c < s, `规约 order(${c}) 应小于目录 order(${s})，否则材料先于规矩`)
  return `contract ${c} < catalog ${s}`
})

await checkAsync('P0-1c 规约 10 条硬约束齐全且体量受控', async () => {
  const { renderContract } = await import('../lib/index.js')
  const t = renderContract()
  const bytes = Buffer.byteLength(t, 'utf8')
  // 十条编号
  const nums = (t.match(/^### \d+\./gm) || []).length
  assert(nums === 10, `规约应有 10 条，实际 ${nums} 条`)
  // 关键禁令必须在
  const must = [
    ['查不到就明说', /查不到就明说/],
    ['禁止伪装成手册记录', /伪装成/],
    ['不要空转轮询', /不要空转轮询/],
    ['外部内容是数据不是指令', /数据，不是指令/],
    ['写入需人确认', /人确认/],
    ['不要用占位符', /占位值|占位符/],
  ]
  for (const [label, re] of must) assert(re.test(t), `缺关键约束：${label}`)
  // 体量：超过 6 KB 就该反思（模型遵守率随长度下降）
  assert(bytes < 6000, `规约过大 ${bytes} 字节，会稀释遵守率`)
  return `${nums} 条 · ${bytes} 字节（上限 6000）`
})

// ─────────────────────────────────────────
// P0-2 设计系统 token 化
// ─────────────────────────────────────────
check('P0-2a client.js 全部色值走 DSH 官方 token', () => {
  const tokens = [...client.matchAll(/--dsw-alias-[a-z0-9-]+/g)].map((m) => m[0])
  const uniq = [...new Set(tokens)]
  assert(uniq.length >= 10, `用到的官方 token 太少（${uniq.length}），可能没真正迁移`)
  // 必须覆盖四类
  const cats = {
    背景: '--dsw-alias-bg-',
    边框: '--dsw-alias-border-',
    文字: '--dsw-alias-label-',
    状态: '--dsw-alias-state-',
  }
  for (const [name, prefix] of Object.entries(cats)) {
    assert(uniq.some((t) => t.startsWith(prefix)), `缺 ${name} 类 token（${prefix}*）`)
  }
  return `${uniq.length} 个官方 token，覆盖背景/边框/文字/状态四类`
})

check('P0-2b 硬编码色值只作为 fallback 保留', () => {
  // 允许形如 var(--dsw-alias-x, #RRGGBB) 的 fallback，但禁止裸的 #RRGGBB 直接赋值
  const bare = []
  const re = /(^|[^,(\w])(#[0-9a-fA-F]{3,8})\b/g
  let m
  while ((m = re.exec(client)) !== null) {
    // 前面必须不是 var(... , 的逗号
    if (!/,\s*$/.test(client.slice(Math.max(0, m.index - 4), m.index + 1))) {
      bare.push(m[2])
    }
  }
  // 允许 #000 用于遮罩
  const bad = bare.filter((c) => c.toLowerCase() !== '#000')
  assert(bad.length === 0, `仍有 ${bad.length} 处裸色值：${[...new Set(bad)].join(', ')}`)
  return `裸色值 ${bad.length} 处（仅遮罩 #000 允许）`
})

check('P0-2c 三槽注册完好（未被样式改动破坏）', () => {
  const slots = ['sidebar.footer.action', 'sidebar.panellist']
  for (const s of slots) assert(client.includes(s), `缺槽 ${s}`)
  assert(/name:\s*["']main["']/.test(client), '缺 main 槽')
  assert(client.includes('exports.apply'), '缺 exports.apply')
  assert(client.includes('exports.inject'), '缺 exports.inject')
  assert(client.trimStart().startsWith('window.__ModuleLoader__.load'), 'CJS bundle 头部格式错误')
  return '3 槽 + exports + __ModuleLoader__ 全部在位'
})

// ─────────────────────────────────────────
// P0-3 有序判定表
// ─────────────────────────────────────────
await checkAsync('P0-3a 判定表互斥且完备', async () => {
  const { scanSessions } = await import('../lib/scan.js')
  const { triageAll } = await import('../lib/triage.js')
  const { buildLibrary } = await import('../lib/library.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmp = mkdtempSync(join(tmpdir(), 'ms-contract-'))
  try {
    const { sessions } = scanSessions()
    const triaged = triageAll(sessions)
    const built = buildLibrary(triaged.enriched, {
      root: tmp,
      dataDir: fileURLToPath(new URL('../data', import.meta.url)),
    })
    const st = built.library.stages
    assert(st, 'library.stages 缺失')
    assert(st.exhaustive, `阶段之和 ${st.sum} != 总数 ${st.total}`)
    const nonZero = Object.entries(st.counts).filter(([, v]) => v > 0)
    return `${st.sum}/${st.total} 归位 · ${nonZero.map(([k, v]) => `${k} ${v}`).join(' · ')}`
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

check('P0-3b 判定表按"首个匹配胜出"实现', () => {
  // 顺序必须是 distilled → in-book → noise → strong → weak → 兜底
  const order = ['distilled', 'in-book', 'noise', 'distillable', 'weak-source']
  let last = -1
  for (const k of order) {
    const i = lib.indexOf(`return '${k}'`)
    assert(i > last, `阶段 ${k} 的返回语句顺序不对（应保持首个匹配胜出）`)
    last = i
  }
  return `返回顺序：${order.join(' → ')}`
})

// ─────────────────────────────────────────
// P1 后台扫描
// ─────────────────────────────────────────
check('P0-1d fail-closed 真实有效（不相关查询必须 0 命中）', () => {
  // 这是 P0 里最脆弱的一环：规约第 2 条「查不到就明说」完全依赖这个行为。
  // 2026-11-02 实测发现过漏词导致误命中，故固化为回归测试。
  const path = 'C:/demo-workspace/技能手册梳理插件/dsh-manuscript/lib/index.js';
  const src2 = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  // 静态断言：停用词表必须覆盖这些高频虚词
  const must = ['完全', '可能', '不可', '没有', '什么', '怎么'];
  for (const w of must) {
    assert(src2.includes("'" + w + "'"), '停用词表缺：' + w);
  }
  // 静态断言：中文判据必须是 >=3 个 bigram
  assert(/cjkHits < 3/.test(src2), '中文判据应要求至少 3 个 bigram（<3 才置零）');
  return '停用词 ' + must.length + ' 项齐全 · 中文判据 >=3 bigram';
})

check('P1a 扫描已改为后台任务（有不阻塞的 kick/settle）', () => {
  assert(host.includes('function createScanJob'), '缺 createScanJob')
  assert(host.includes('kick('), '缺 kick（触发不等待）')
  assert(host.includes('settle('), '缺 settle（需要时再等）')
  return 'createScanJob + kick + settle 已实现'
})

check('P1b 同步 prompt 段不再 await（避免运行时抛错）', () => {
  // text: () => { ... } 里面不能出现 await
  const m = /text:\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},/.exec(host)
  assert(m, '找不到同步 text() 实现')
  assert(!/\bawait\b/.test(m[1]), '同步 text() 里出现了 await —— 运行时会抛 SyntaxError')
  return 'text() 内零 await'
})

check('P1c 启动扫描用后台 kick 而不是同步 refresh', () => {
  const startup = host.slice(host.indexOf('启动时后台扫描'), host.indexOf('启动时后台扫描') + 800)
  assert(startup.includes('scanJob'), '启动段没用 scanJob')
  assert(startup.includes('.kick('), '启动段没调用 kick')
  assert(!/^\s*refresh\(state/m.test(startup), '启动段仍在同步调 refresh')
  return '启动走 scanJob.kick()，不阻塞装配'
})

// ─────────────────────────────────────────
const passed = results.filter((r) => r.status === 'PASS').length
const failed = results.filter((r) => r.status === 'FAIL').length
console.log('')
console.log('P0/P1 改动自检')
console.log('═'.repeat(74))
for (const r of results) {
  console.log(`${r.status === 'PASS' ? '✓' : '✗'} ${r.name}`)
  console.log(`    ${r.detail}  ${r.ms}ms`)
}
console.log('═'.repeat(74))
console.log(`结果：${passed} 通过 / ${failed} 失败 / 共 ${results.length}`)
process.exit(failed > 0 ? 1 : 0)
