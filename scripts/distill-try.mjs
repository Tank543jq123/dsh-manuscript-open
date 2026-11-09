#!/usr/bin/env node
/**
 * LLM 提炼的本地试跑器（CLI）。
 *
 * 为什么需要它：插件跑在 DSH 里，改一行代码就要重启一次，而 LLM 提炼的
 * **调参是最费试错的环节**（prompt 措辞、批次大小、温度）。如果每改一次
 * prompt 都要重启 DSH，迭代成本高到不可接受。
 *
 * 这个脚本让你直接对着真实会话跑，看到 LLM 的原始输出、解析结果、
 * 被拒绝的原因，全部在终端里。**它不写任何书库文件**，只打印和可选写报告。
 *
 * 用法：
 *   node scripts/distill-try.mjs --limit 3                # 试跑 3 个会话
 *   node scripts/distill-try.mjs --sid <id>               # 指定会话
 *   node scripts/distill-try.mjs --limit 1 --digest-only  # 只看压缩结果，不调 LLM
 *   node scripts/distill-try.mjs --limit 3 --raw          # 打印 LLM 原始返回
 *
 * 注意：这个脚本需要 DSH 的 llm 服务。它通过直接 import 插件模块并用
 * 环境变量注入的方式工作；如果拿不到 llm，会明确报错而不是静默降级。
 */

import { parseArgs } from 'node:util'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')

const { values: argv } = parseArgs({
  options: {
    limit: { type: 'string', default: '3' },
    sid: { type: 'string' },
    provider: { type: 'string', default: process.env.DSH_DISTILL_PROVIDER || 'workbuddy' },
    model: { type: 'string', default: process.env.DSH_DISTILL_MODEL || 'deepseek-v4.1-flash' },
    'digest-only': { type: 'boolean', default: false },
    raw: { type: 'boolean', default: false },
    out: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (argv.help) {
  console.log(`
书阁 · LLM 提炼试跑器

  --limit <n>        试跑几个会话（默认 3）
  --sid <sessionId>  只试跑指定会话
  --provider <p>     模型提供方（默认 workbuddy）
  --model <m>        模型（默认 deepseek-v4.1-flash）
  --digest-only      只跑会话压缩，不调 LLM
  --raw              打印 LLM 原始返回（便于调 prompt）
  --out <path>       把结果写到文件

这个脚本只读 ~/.dsh/sessions，不写书库。
`)
  process.exit(0)
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

// ── 动态 import：模块还没写出来时给出清晰提示，而不是崩在 stack 里 ──
async function tryImport(name) {
  const p = join(LIB, name)
  if (!existsSync(p)) return null
  try {
    return await import(`file://${p.replace(/\\/g, '/')}`)
  } catch (e) {
    fail(`import ${name} 失败：${e.message}`)
  }
}

const scan = await tryImport('scan.js')
const triage = await tryImport('triage.js')
const distill = await tryImport('distill.js')

if (!scan) fail('缺 lib/scan.js')
if (!triage) fail('缺 lib/triage.js')
if (!distill) {
  fail('缺 lib/distill.js —— LLM 提炼模块还没写出来。\n  想看压缩效果可以等它出现，或先跑 --help。')
}

// ── 选样本 ──
console.log('扫描会话…')
const { sessions } = scan.scanSessions()
const triaged = triage.triageAll(sessions).enriched

let picked
if (argv.sid) {
  picked = triaged.filter((s) => s.sid === argv.sid)
  if (picked.length === 0) fail(`找不到会话 ${argv.sid}`)
} else {
  // 挑"有东西可提炼"的：real + strong，按质量分降序
  const real = triaged.filter((s) => s.category === 'real')
  const strong = real.filter((s) => s.admission === 'strong')
  const pool = strong.length >= Number(argv.limit) ? strong : real
  picked = pool.sort((a, b) => b.qualityScore - a.qualityScore).slice(0, Number(argv.limit))
}

console.log(`\n选中 ${picked.length} 个会话：`)
for (const s of picked) {
  console.log(
    `  ${s.sid.slice(0, 24)}  ${String(s.toolCalls).padStart(4)} 次调用  ` +
      `${s.shape.padEnd(10)} 分数 ${String(s.qualityScore).padStart(5)}  ${(s.title || '').slice(0, 34)}`
  )
}

// ── 压缩 ──
console.log('\n── 会话压缩 ──')
const digests = []
for (const s of picked) {
  let d
  try {
    d = distill.renderSessionDigest(s, {})
  } catch (e) {
    console.log(`  ✗ ${s.sid.slice(0, 20)} 压缩失败：${e.message}`)
    continue
  }
  const bytes = Buffer.byteLength(d, 'utf8')
  const flag = bytes > 6144 ? ' ⚠ 超 6KB' : ''
  console.log(`  ${s.sid.slice(0, 24)}  ${String(bytes).padStart(6)} 字节${flag}`)
  digests.push({ session: s, digest: d, bytes })
}

if (digests.length === 0) fail('没有可用的压缩结果')

// 展示第一个的前 1200 字符，让人判断"压得够不够信息"
console.log('\n── 压缩样本（第 1 个，前 1200 字符）──')
console.log(digests[0].digest.slice(0, 1200))
if (digests[0].digest.length > 1200) console.log(`… 另有 ${digests[0].digest.length - 1200} 字符`)

if (argv['digest-only']) {
  console.log('\n（--digest-only，跳过 LLM 调用）')
  process.exit(0)
}

// ── 调 LLM ──
// 拿 llm 服务：这个脚本不在 DSH 进程里，无法直接拿 ctx.llm。
// 所以要求调用方注入一个 llm 实现，或者用环境变量指向一个可用的桥。
if (!globalThis.__DSH_DISTILL_LLM__) {
  console.log(`
── 无法调用 LLM ──

这个 CLI 跑在 DSH 进程之外，拿不到 ctx.llm。

两种用法：
  ① 只在本地看压缩效果：加 --digest-only（推荐，零成本）
  ② 真跑提炼：在 DSH 会话里让 Agent 调用插件的 manual_* 工具，
     或者把下面的 llm 适配器注入进来：

     globalThis.__DSH_DISTILL_LLM__ = {
       stream(options) { /* 返回 AsyncIterable<StreamChunk> */ }
     }
`)
  process.exit(0)
}

const llm = globalThis.__DSH_DISTILL_LLM__
console.log('\n── 调用 LLM ──')
const t0 = Date.now()
const result = await distill.distillBatch(
  digests.map((d) => d.session),
  { llm, provider: argv.provider, model: argv.model, maxSessionsPerCall: digests.length }
)
const ms = Date.now() - t0

console.log(`  耗时 ${ms} ms`)
if (argv.raw && result.rawText) {
  console.log('\n── LLM 原始返回 ──')
  console.log(result.rawText.slice(0, 3000))
}
if (result.error) {
  console.log(`\n  ✗ ${result.error}`)
} else {
  console.log(`\n── 解析出 ${result.proposals.length} 条 ──`)
  for (const [i, p] of result.proposals.entries()) {
    console.log(`\n[${i + 1}] ${p.title}`)
    console.log(`    ${p.claim}`)
    if (p.why) console.log(`    为什么：${p.why}`)
    console.log(`    ${p.confidence} · ${(p.tags || []).join(',')}`)
  }
}

if (argv.out) {
  mkdirSync(dirname(argv.out), { recursive: true })
  writeFileSync(
    argv.out,
    JSON.stringify({ at: new Date().toISOString(), picked: picked.map((s) => s.sid), digests, result, ms }, null, 2),
    'utf8'
  )
  console.log(`\n结果已写入 ${argv.out}`)
}
