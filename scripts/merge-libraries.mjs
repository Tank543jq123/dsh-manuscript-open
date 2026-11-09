#!/usr/bin/env node
/**
 * 多设备书库合并（同步层工具，给"图书馆"用）。
 *
 * ## 它做什么
 *
 * 把 `<incoming>/entries/*.json` 并进 `<base>/entries/`，规则见 `lib/merge.js`：
 * 只在一边的 → 新增；内容相同 → 跳过；内容不同且时间可比 → 新的赢（旧的那份
 * **另存为冲突副本**）；时间不可比 → **不猜**，base 保留，另一份进 conflicts/。
 *
 * ## 它绝不做什么
 *
 * · **不删除任何条目**（书阁的红线；这里也不破）
 * · **不动** `library.json` / `volumes/` —— 它们是投影，合并后由任一台设备
 *   正常建库即可重新生成（`entries/` 才是真相）
 * · 不动 `runs/` —— 那是设备本地凭证
 *
 * ## 用法
 *
 * ```bash
 * # 先看计划（默认 dry-run，不写任何文件）
 * node scripts/merge-libraries.mjs --base ~/.dsh/dsh-manuscript --incoming /mnt/usb/other-device
 *
 * # 真写（新增/更新 + 冲突留档）
 * node scripts/merge-libraries.mjs --base ~/.dsh/dsh-manuscript --incoming /tmp/device-b --apply
 * ```
 *
 * 退出码：0 = 完成（含 dry-run）；2 = 用法/前置检查失败。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { planMerge } from '../lib/merge.js'

function parseArgs(argv) {
  const out = { apply: false, base: null, incoming: null, conflicts: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--base') out.base = argv[++i]
    else if (a === '--incoming') out.incoming = argv[++i]
    else if (a === '--conflicts') out.conflicts = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else {
      console.error(`未知参数：${a}`)
      out.help = true
    }
  }
  return out
}

/** 读一个书库的 entries/*.json；读不出来的文件单独计数（不静默吞掉）。 */
function readEntries(root) {
  const dir = join(root, 'entries')
  const entries = []
  const invalid = []
  if (!existsSync(dir)) return { entries, invalid }
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (e && typeof e.id === 'string' && e.id) entries.push(e)
      else invalid.push(f)
    } catch {
      invalid.push(f)
    }
  }
  return { entries, invalid }
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.base || !args.incoming) {
  console.error('用法：node scripts/merge-libraries.mjs --base <书库目录> --incoming <另一侧书库目录> [--apply] [--conflicts <目录>]')
  process.exit(2)
}

const base = args.base
const incoming = args.incoming
if (!existsSync(join(base, 'library.json'))) {
  console.error(`[merge] base 不像一个书库（缺 library.json）：${base}`)
  process.exit(2)
}
if (!existsSync(join(incoming, 'entries'))) {
  console.error(`[merge] incoming 里没有 entries/：${incoming}`)
  process.exit(2)
}
if (join(base, 'entries') === join(incoming, 'entries')) {
  console.error('[merge] base 与 incoming 是同一个库，拒绝执行')
  process.exit(2)
}

const baseSide = readEntries(base)
const incSide = readEntries(incoming)
const plan = planMerge(baseSide.entries, incSide.entries)

console.log(`[merge] base=${base}（${baseSide.entries.length} 条${baseSide.invalid.length ? `，坏文件 ${baseSide.invalid.length}` : ''}）`)
console.log(`[merge] incoming=${incoming}（${incSide.entries.length} 条${incSide.invalid.length ? `，坏文件 ${incSide.invalid.length}` : ''}）`)
console.log('')
console.log(`  新增 ${plan.stats.added} · 更新 ${plan.stats.updated} · 相同 ${plan.stats.same} · 冲突 ${plan.stats.conflicts} · 跳过 ${plan.stats.skipped}`)

for (const op of plan.operations) {
  if (op.action === 'same') continue
  const label = { add: '＋新增', update: '↻更新', conflict: '⚠冲突' }[op.action] || op.action
  const who = op.winner?.origin?.device ? `（${op.winner.origin.device}）` : ''
  console.log(`  ${label} ${op.id}${op.action === 'update' ? ` — ${op.reason}` : ''}${who}`)
}

if (plan.conflicts.length > 0) {
  console.log('')
  console.log('  冲突明细（不猜先后，两份都留）：')
  for (const c of plan.conflicts) {
    console.log(`   · ${c.id}：${c.reason}`)
  }
}

if (!args.apply) {
  console.log('')
  console.log('（dry-run：没有写任何文件。加 --apply 才落盘）')
  process.exit(0)
}

// ── 落盘 ──
const conflictDir = args.conflicts || join(base, 'conflicts')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
let written = 0
let archived = 0

function writeEntryFile(entry) {
  mkdirSync(join(base, 'entries'), { recursive: true })
  writeFileSync(join(base, 'entries', entry.id + '.json'), JSON.stringify(entry, null, 2) + '\n', 'utf8')
  written += 1
}

function archiveConflict(entry, why) {
  mkdirSync(conflictDir, { recursive: true })
  const dev = String(entry?.origin?.device || 'unknown').replace(/[^\w.-]+/g, '_').slice(0, 32)
  const name = `${entry.id}.${dev}.${stamp}.${why}.json`
  writeFileSync(join(conflictDir, name), JSON.stringify(entry, null, 2) + '\n', 'utf8')
  archived += 1
}

for (const op of plan.operations) {
  if (op.action === 'same') continue
  if (op.action === 'add') {
    writeEntryFile(op.winner)
    continue
  }
  if (op.action === 'update') {
    // 赢家覆盖正式位置；输家**另存副本** —— 不删任何东西
    writeEntryFile(op.winner)
    archiveConflict(op.loser, op.reason === 'base 更新' ? 'incoming-older' : 'base-older')
    continue
  }
  if (op.action === 'conflict') {
    // base 原件保持不动，只把 incoming 那份留档
    archiveConflict(op.loser, 'unresolved')
  }
}

console.log('')
console.log(`[merge] 已写入 ${written} 个条目文件，冲突副本 ${archived} 个 → ${conflictDir}`)
console.log('[merge] 提示：library.json 与 volumes/ 是投影，下一次正常建库会自动重算')
