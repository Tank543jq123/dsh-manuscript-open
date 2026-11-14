#!/usr/bin/env node
/**
 * 一把跑完所有测试脚本（2026-11-08）。
 *
 * ## 为什么需要
 *
 * 现在有 24 份脚本、800+ 项断言。手工逐个跑不仅烦，还容易漏跑某个 ——
 * 而"漏跑的那份"恰恰可能是唯一能发现这次改动问题的那份。
 *
 * ## 它做什么
 *
 * 按固定顺序跑全部脚本，收集每份的「结果：X 通过 / Y 失败 / 共 Z」，
 * 最后打一张表 + 汇总；**任何一份失败或退出码非 0 都让整体退出码非 0**。
 *
 * ## 它不做什么
 *
 * - 不并行（这些脚本会互相抢临时目录、抢端口，串行才稳）
 * - 不改任何文件；每份脚本自己管自己的临时目录
 * - 不读 lib 内部状态，只看进程输出的汇总行
 *
 * 用法：
 *   node scripts/test-all.mjs            # 全部
 *   node scripts/test-all.mjs --filter merge   # 只跑名字含 merge 的
 *   node scripts/test-all.mjs --fail-fast      # 第一份失败就停
 */

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

/**
 * 固定顺序：**便宜且基础的先跑**（纯函数 → 模块 → HTTP → 端到端）。
 * 这样一旦基础层坏了，能立刻看到，而不是等 3 分钟到最后一个脚本才报。
 */
export const SUITES = [
  'check-p0.mjs',
  'test-toolpacks.mjs',
  'test-distill-state.mjs',
  'test-adjudicate.mjs',
  'test-pipeline.mjs',
  'test-dupjudge.mjs',
  'test-host-model.mjs',
  'test-atomic.mjs',
  'test-commit.mjs',
  'test-library-md.mjs',
  'test-health.mjs',
  'test-volume-fallback.mjs',
  'test-skeleton-retire.mjs',
  'test-chapter-triage.mjs',
  'test-recall-filter.mjs',
  'test-recall-skeleton.mjs',
  'test-recall-short.mjs',
  'test-recall-no-needle.mjs',
  'test-recall-semantic.mjs',
  'test-recall-vector.mjs',
  'test-scan-fixture.mjs',
  'test-toolshelf.mjs',
  'test-api-tools.mjs',
  'test-mount.mjs',
  'test-apply-section.mjs',
  'test-client-load.mjs',
  'test-http-guards.mjs',
  'test-http-hardening.mjs',
  'test-ui-endpoints.mjs',
  'test-entry-save.mjs',
  'test-distill-e2e.mjs',
  'test-merge.mjs',
  'selfcheck.mjs',
]

/** 从脚本输出里抽「结果：X 通过 / Y 失败 …」。 */
export function parseResultLine(text) {
  const m = /结果：\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败(?:\s*\/\s*(\d+)\s*跳过)?\s*\/\s*共\s*(\d+)/.exec(String(text || ''))
  if (!m) return null
  return {
    pass: Number(m[1]),
    fail: Number(m[2]),
    skipped: Number(m[3] || 0),
    total: Number(m[4]),
  }
}

const args = process.argv.slice(2)
const failFast = args.includes('--fail-fast')
const filterIdx = args.indexOf('--filter')
const filter = filterIdx >= 0 ? String(args[filterIdx + 1] || '') : ''

const list = SUITES.filter((s) => !filter || s.includes(filter))
if (list.length === 0) {
  console.error(`没有匹配的脚本（filter=${filter}）。可用：${SUITES.join(', ')}`)
  process.exit(2)
}

const rows = []
const t0 = Date.now()
let broken = 0

for (const file of list) {
  const started = Date.now()
  let out = ''
  let code = 0
  try {
    const r = await run(process.execPath, [join(here, file)], {
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    out = r.stdout
  } catch (e) {
    code = typeof e.code === 'number' ? e.code : 1
    out = `${e.stdout || ''}\n${e.stderr || ''}`
  }
  const parsed = parseResultLine(out)
  const ms = Date.now() - started
  const ok = code === 0 && parsed && parsed.fail === 0
  rows.push({ file, ok, code, ms, parsed })
  if (!ok) {
    broken += 1
    // 失败时把脚本尾部打出来 —— 汇总行 + 失败明细都在最后几行
    const tail = String(out).trim().split('\n').slice(-8).join('\n')
    console.log(`✗ ${file}（exit=${code}）`)
    console.log(
      tail
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n')
    )
    if (failFast) break
  } else {
    const p = parsed
    console.log(
      `✓ ${file.padEnd(28)} ${String(p.pass).padStart(3)} 通过` +
        (p.skipped ? ` / ${p.skipped} 跳过` : '') +
        `  ${(ms / 1000).toFixed(1)}s`
    )
  }
}

const totalPass = rows.reduce((a, r) => a + (r.parsed?.pass || 0), 0)
const totalFail = rows.reduce((a, r) => a + (r.parsed?.fail || 0), 0)
const totalSkip = rows.reduce((a, r) => a + (r.parsed?.skipped || 0), 0)
const secs = ((Date.now() - t0) / 1000).toFixed(1)

console.log('')
console.log('═'.repeat(64))
console.log(
  `跑了 ${rows.length} 份脚本 · ${totalPass} 通过 / ${totalFail} 失败` +
    (totalSkip ? ` / ${totalSkip} 跳过` : '') +
    ` · ${secs}s`
)
if (broken > 0) {
  console.log(`失败的脚本：${rows.filter((r) => !r.ok).map((r) => r.file).join(', ')}`)
  console.log('═'.repeat(64))
  process.exit(1)
}
console.log('全部通过')
console.log('═'.repeat(64))
process.exit(0)
