#!/usr/bin/env node
/**
 * 一次性迁移：旧 JSON 库 → Markdown 真相层。
 *
 * ## 安全顺序（fail-closed）
 *
 *   1. 只读源库，算出「预期条目 id 集合 / 册集合」
 *   2. 整目录备份（排除 models/、锁、staging）——备份失败就停
 *   3. 写 `<vol>/<chapter>/<id>.md`
 *   4. 用**扫描结果**与第 1 步逐一比对（id 集合、条数、册集合）
 *   5. 只有 4 通过，才把 entries/ volumes/ library.json 移入 legacy-json/
 *   6. 最后写新的派生 library.json
 *
 * 任何一步失败都不移动旧数据、不写新索引 —— 旧库仍可原样使用。
 *
 * 用法：
 *   node scripts/migrate-json-to-md.mjs                  # 原地迁移当前生效根
 *   node scripts/migrate-json-to-md.mjs --to /shared/lib # 复制到共享路径再迁移
 *   node scripts/migrate-json-to-md.mjs --dry-run        # 只统计，不写盘
 *   node scripts/migrate-json-to-md.mjs --json           # 机读报告
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  cpSync,
  statSync,
} from 'node:fs'
import { join, resolve, basename, isAbsolute, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFileAtomic } from '../lib/atomic.js'
import { resolveLibraryRoot } from '../lib/library-root.js'
import {
  writeMarkdownEntry,
  readAllMarkdownEntries,
  rebuildMarkdownIndex,
} from '../lib/markdown-library.js'

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** child 是否在 parent 内部（含相等）。用于拒绝复制到自己的子目录。 */
function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function pathExists(p) {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

function dirIsEmpty(p) {
  try {
    return readdirSync(p).length === 0
  } catch {
    return false
  }
}

/** 备份时排除的东西：可重建/运行时状态，不是知识。 */
function backupFilter(src) {
  const name = basename(src)
  if (name === 'models' || name === 'node_modules') return false
  if (name === '.build.lock' || name.startsWith('.staging-') || name.startsWith('.tmp-')) return false
  if (name.includes('.tmp-')) return false
  return true
}

function copyTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (src) => {
      // 备份目标本身绝不能递归进去
      if (resolve(src) === resolve(to)) return false
      return backupFilter(src)
    },
  })
}

function readJsonEntries(root) {
  const dir = join(root, 'entries')
  if (!pathExists(dir)) return []
  const out = []
  const errors = []
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const e = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (e && typeof e === 'object' && e.id) out.push(e)
      else errors.push({ file: name, error: '缺少 id' })
    } catch (e) {
      errors.push({ file: name, error: e?.message || String(e) })
    }
  }
  return { entries: out, errors }
}

function readLibrary(root) {
  try {
    const v = JSON.parse(readFileSync(join(root, 'library.json'), 'utf8'))
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

function setOf(iterable) {
  return new Set([...iterable].map(String))
}

function sameSet(a, b) {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

/**
 * @param {{
 *   from?: string, to?: string, dryRun?: boolean, force?: boolean,
 *   backupDir?: string, logger?: object
 * }} [opts]
 */
export function migrateJsonToMarkdown(opts = {}) {
  const startedAt = Date.now()
  const from = resolve(opts.from || resolveLibraryRoot())
  const to = resolve(opts.to || from)
  const dryRun = opts.dryRun === true
  const force = opts.force === true
  const logger = opts.logger
  const report = {
    ok: false,
    dryRun,
    from,
    to,
    backup: null,
    entries: 0,
    volumes: 0,
    verified: false,
    movedLegacy: false,
    durationMs: 0,
  }

  if (!pathExists(from) || !statSync(from).isDirectory()) {
    report.error = `源库不存在或不是目录：${from}`
    report.durationMs = Date.now() - startedAt
    return report
  }
  if (to !== from && (isInside(from, to) || isInside(to, from))) {
    report.error = `--to 不能是源库的子目录，也不能包含源库：from=${from} to=${to}`
    report.durationMs = Date.now() - startedAt
    return report
  }
  const fromEntriesDir = join(from, 'entries')
  const fromLib = readLibrary(from)
  const alreadyMd = fromLib?.storage === 'markdown' && !pathExists(fromEntriesDir)
  if (alreadyMd) {
    report.error = '源库已经是 Markdown 库，无需重复迁移'
    report.durationMs = Date.now() - startedAt
    return report
  }
  if (!pathExists(fromEntriesDir)) {
    report.error = `源库没有 entries/ 目录，不像旧 JSON 库：${from}`
    report.durationMs = Date.now() - startedAt
    return report
  }

  const source = readJsonEntries(from)
  if (source.errors.length > 0) {
    report.error = `有 ${source.errors.length} 个旧条目无法解析，拒绝迁移`
    report.errors = source.errors
    report.durationMs = Date.now() - startedAt
    return report
  }
  if (source.entries.length === 0) {
    report.error = '源库条目数为 0，拒绝迁移（避免产出一个空书库）'
    report.durationMs = Date.now() - startedAt
    return report
  }

  const expectedIds = setOf(source.entries.map((e) => e.id))
  const expectedVolumes = setOf(source.entries.map((e) => e.volume || 'vol-05'))
  report.entries = source.entries.length
  report.volumes = expectedVolumes.size

  if (dryRun) {
    report.ok = true
    report.wouldWrite = source.entries.length
    report.durationMs = Date.now() - startedAt
    return report
  }

  // ── 目标目录检查 ──
  if (to !== from) {
    if (pathExists(to) && !statSync(to).isDirectory()) {
      report.error = `目标不是目录：${to}`
      report.durationMs = Date.now() - startedAt
      return report
    }
    if (pathExists(to) && !dirIsEmpty(to) && !force) {
      report.error = `目标目录非空：${to}（确认可覆盖请加 --force；本脚本会先备份目标）`
      report.durationMs = Date.now() - startedAt
      return report
    }
  }
  if (pathExists(join(to, 'legacy-json')) && !force) {
    report.error = `目标已有 legacy-json/，看起来迁移过。确认覆盖请加 --force`
    report.durationMs = Date.now() - startedAt
    return report
  }

  // ── 备份 ──
  const backup = opts.backupDir
    ? resolve(opts.backupDir)
    : `${from}.backup-${stamp()}`
  if (isInside(from, backup) || isInside(backup, from)) {
    report.error = `备份目录不能位于源库内部（也不能包含源库）：${backup}`
    report.durationMs = Date.now() - startedAt
    return report
  }
  try {
    if (pathExists(backup)) {
      report.error = `备份路径已存在：${backup}`
      report.durationMs = Date.now() - startedAt
      return report
    }
    logger?.info?.('[migrate] 备份 %s → %s', from, backup)
    copyTree(from, backup)
    report.backup = backup
  } catch (e) {
    report.error = `备份失败，已中止：${e?.message || String(e)}`
    report.durationMs = Date.now() - startedAt
    return report
  }

  // 目标非空且 --force：先把目标也备份一份，再覆盖。
  if (to !== from && pathExists(to) && !dirIsEmpty(to)) {
    const targetBackup = `${to}.backup-${stamp()}`
    try {
      copyTree(to, targetBackup)
      report.targetBackup = targetBackup
    } catch (e) {
      report.error = `目标备份失败，已中止：${e?.message || String(e)}`
      report.durationMs = Date.now() - startedAt
      return report
    }
    try {
      cpSync(from, to, { recursive: true, force: true, filter: backupFilter })
    } catch (e) {
      report.error = `复制到目标失败：${e?.message || String(e)}`
      report.durationMs = Date.now() - startedAt
      return report
    }
  } else if (to !== from) {
    try {
      cpSync(from, to, { recursive: true, force: false, errorOnExist: false, filter: backupFilter })
    } catch (e) {
      report.error = `复制到目标失败：${e?.message || String(e)}`
      report.durationMs = Date.now() - startedAt
      return report
    }
  }

  const targetLib = readLibrary(to) || fromLib || null
  const targetEntries = readJsonEntries(to)
  if (targetEntries.errors.length > 0) {
    report.error = `目标 entries/ 有 ${targetEntries.errors.length} 个坏文件，拒绝继续`
    report.errors = targetEntries.errors
    report.durationMs = Date.now() - startedAt
    return report
  }

  // ── 写 Markdown ──
  try {
    for (const e of targetEntries.entries) {
      writeMarkdownEntry(to, {
        ...e,
        // 迁移不猜归属：entry 自己的 volume/chapter 原样保留。
        volume: e.volume || 'vol-05',
        chapter: e.chapter || 'ch-inbox',
      })
    }
  } catch (e) {
    report.error = `写 Markdown 失败：${e?.message || String(e)}`
    report.durationMs = Date.now() - startedAt
    return report
  }

  // ── 校验：id 集合 + 条数 + 册集合 ──
  const scanned = readAllMarkdownEntries(to)
  const actualIds = setOf(scanned.entries.map((e) => e.id))
  const actualVolumes = setOf(scanned.entries.map((e) => e.volume || 'vol-05'))
  const problems = []
  if (scanned.errors.length > 0) {
    problems.push(`有 ${scanned.errors.length} 个 Markdown 条目解析失败`)
  }
  if (scanned.entries.length !== source.entries.length) {
    problems.push(`条目数不一致：JSON ${source.entries.length} / MD ${scanned.entries.length}`)
  }
  if (!sameSet(expectedIds, actualIds)) {
    const missing = [...expectedIds].filter((id) => !actualIds.has(id)).slice(0, 10)
    const extra = [...actualIds].filter((id) => !expectedIds.has(id)).slice(0, 10)
    problems.push(`id 集合不一致（缺：${missing.join('、') || '无'}；多：${extra.join('、') || '无'}）`)
  }
  if (!sameSet(expectedVolumes, actualVolumes)) {
    problems.push(`册集合不一致：JSON ${[...expectedVolumes].join('、')} / MD ${[...actualVolumes].join('、')}`)
  }
  if (problems.length > 0) {
    report.error = problems.join('；')
    report.errors = scanned.errors
    report.actualEntries = scanned.entries.length
    report.actualVolumes = actualVolumes.size
    report.durationMs = Date.now() - startedAt
    return report
  }
  report.verified = true

  // ── 保留人读的册导览（MANUAL/TOC），再移动旧真相层 ──
  const legacyDir = join(to, pathExists(join(to, 'legacy-json')) ? `legacy-json-${stamp()}` : 'legacy-json')
  try {
    mkdirSync(legacyDir, { recursive: true })
    const oldVolumesDir = join(to, 'volumes')
    if (pathExists(oldVolumesDir)) {
      for (const name of readdirSync(oldVolumesDir)) {
        const src = join(oldVolumesDir, name)
        try {
          if (!statSync(src).isDirectory()) continue
          const destVol = join(to, name)
          mkdirSync(destVol, { recursive: true })
          for (const doc of ['MANUAL.md', 'TOC.md']) {
            const f = join(src, doc)
            if (pathExists(f) && !pathExists(join(destVol, doc))) copyFileSync(f, join(destVol, doc))
          }
        } catch {
          /* 单册导览复制失败不影响迁移主流程 */
        }
      }
    }
    for (const name of ['entries', 'volumes']) {
      const p = join(to, name)
      if (pathExists(p)) renameSync(p, join(legacyDir, name))
    }
    const libPath = join(to, 'library.json')
    if (pathExists(libPath)) renameSync(libPath, join(legacyDir, 'library.json'))
    report.legacyDir = legacyDir
    report.movedLegacy = true
  } catch (e) {
    report.error = `移动旧 JSON 到 legacy-json/ 失败：${e?.message || String(e)}`
    report.durationMs = Date.now() - startedAt
    return report
  }

  // ── 重建派生索引（带上旧索引里的会话统计） ──
  const rebuilt = rebuildMarkdownIndex(to, { baseLibrary: targetLib })
  if (!rebuilt.ok) {
    report.error = `索引重建失败：${rebuilt.error}`
    report.errors = rebuilt.errors
    report.durationMs = Date.now() - startedAt
    return report
  }
  report.ok = true
  report.library = {
    entries: rebuilt.library?.counts?.entries ?? rebuilt.entries,
    volumes: rebuilt.library?.volumes?.filter((v) => v.entries > 0).length ?? actualVolumes.size,
  }
  report.durationMs = Date.now() - startedAt

  // 报告落在备份目录，不污染新库。
  try {
    writeFileAtomic(join(backup, 'migration-report.json'), JSON.stringify(report, null, 2) + '\n')
  } catch {
    /* 报告写不进去不影响迁移结果 */
  }
  return report
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--force') out.force = true
    else if (a === '--json') out.json = true
    else if (a === '--from') out.from = argv[++i]
    else if (a.startsWith('--from=')) out.from = a.slice(7)
    else if (a === '--to') out.to = argv[++i]
    else if (a.startsWith('--to=')) out.to = a.slice(5)
    else if (a === '--backup-dir') out.backupDir = argv[++i]
    else if (a === '-h' || a === '--help') out.help = true
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法：node scripts/migrate-json-to-md.mjs [--from DIR] [--to DIR] [--dry-run] [--force] [--json]')
    return 0
  }
  if (args.from && !isAbsolute(args.from)) {
    console.error('--from 必须是绝对路径')
    return 2
  }
  if (args.to && !isAbsolute(args.to)) {
    console.error('--to 必须是绝对路径')
    return 2
  }
  const r = migrateJsonToMarkdown(args)
  if (args.json) {
    console.log(JSON.stringify(r, null, 2))
  } else if (r.ok) {
    console.log(`✓ 迁移完成${r.dryRun ? '（dry-run，未写盘）' : ''}`)
    console.log(`  源：${r.from}`)
    console.log(`  目标：${r.to}`)
    if (r.backup) console.log(`  备份：${r.backup}`)
    console.log(`  条目：${r.entries} · 册：${r.volumes} · 校验：${r.verified ? '通过' : '未执行'}`)
    if (r.legacyDir) console.log(`  旧 JSON：${r.legacyDir}`)
  } else {
    console.error(`✗ 迁移失败：${r.error}`)
    if (r.backup) console.error(`  备份（原库未动）：${r.backup}`)
    if (Array.isArray(r.errors)) {
      for (const e of r.errors.slice(0, 10)) console.error(`  - ${e.file || ''} ${e.error || e.message || ''}`)
    }
  }
  return r.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(e?.stack || e)
    process.exit(1)
  })
}
