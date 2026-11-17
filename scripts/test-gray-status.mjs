#!/usr/bin/env node
/**
 * test-gray-status.mjs —— 「打灰」（status=grayed）的投影 / 时间线 / 检索契约。
 *
 * 背景（2026-11-17）：骨架重提炼后，模型明确判定「这个会话没有可提炼的结论」。
 * 这类条目既不该继续留在目录里，也不能冒充 expired —— expired 的语义是
 * 「已有同会话真结论取代了它（有内容，只是旧）」，grayed 的语义是「本身没内容」。
 *
 * 本测试锁住四条硬要求：
 *   ① 目录投影（chapterList / counts）看不见 grayed，但 counts.grayed 有数；
 *   ② 时间线默认视图不出现 grayed；
 *   ③ 关键词检索与语义语料**仍然包含** grayed（可搜），命中项带 grayed:true；
 *   ④ 文件仍在盘上、可按 id 定位（可读）。
 *
 * 全程 os.tmpdir()，不碰真实书库。
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  catalogFromEntries,
  writeMarkdownEntry,
  scanMarkdownLibrary,
  findMarkdownEntryFile,
} from '../lib/markdown-library.js'
import { toSummary } from '../lib/library.js'
import { matchEntries, buildSemanticIndex, semanticRecall } from '../lib/index.js'
import { buildTimeline } from '../lib/entry-save.js'

let pass = 0
let fail = 0
const failures = []

function check(name, fn) {
  try {
    const detail = fn()
    pass += 1
    console.log(`✓ ${name}${detail ? '  ' + detail : ''}`)
  } catch (e) {
    fail += 1
    failures.push(`${name} → ${e.message}`)
    console.log(`✗ ${name}\n    ${e.message}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const TMP = mkdtempSync(join(tmpdir(), 'ms-gray-'))
const now = new Date().toISOString()

const grayed = {
  id: 'e-gray-0001',
  title: '翻译请求',
  claim: '1 轮 · 0 次工具调用 · 0 个交付物',
  why: '',
  volume: 'vol-03',
  chapter: 'ch-01',
  confidence: 'speculation',
  authority: 'L3',
  provenance: { session_id: 'sid-grayed' },
  status: 'grayed',
  grayedAt: now,
  grayedReason: 'model-found-no-extractable-conclusion',
  updatedAt: now,
  createdAt: now,
}

const current = {
  id: 'e-cur-0001',
  title: '现行条目：插件热加载需要重启宿主',
  claim: '插件服务端代码改动不会热加载，必须重启 dsh web 进程。',
  why: '服务端模块在进程启动时加载。',
  volume: 'vol-03',
  chapter: 'ch-01',
  confidence: 'high',
  authority: 'L2',
  provenance: { session_id: 'sid-current' },
  status: 'current',
  distilled: true,
  updatedAt: now,
  createdAt: now,
}

const expired = {
  id: 'e-exp-0001',
  title: '已退役的旧骨架',
  claim: '2 轮 · 5 次工具调用 · 0 个交付物',
  volume: 'vol-03',
  chapter: 'ch-01',
  status: 'expired',
  retiredReason: 'superseded-by-distilled-entry',
  updatedAt: now,
  createdAt: now,
}

try {
  writeMarkdownEntry(TMP, grayed)
  writeMarkdownEntry(TMP, current)
  writeMarkdownEntry(TMP, expired)

  const md = scanMarkdownLibrary(TMP)
  const lib = md.library

  check('扫描：grayed 状态从 front-matter 正确回读', () => {
    const g = md.entries.find((e) => e.id === grayed.id)
    assert(g, 'grayed 条目没被扫到')
    assert(g.status === 'grayed', `status=${g.status}`)
    assert(g.grayedReason === 'model-found-no-extractable-conclusion', 'grayedReason 丢了')
  })

  check('目录投影：grayed 不进 chapterList，但 counts.grayed 有数', () => {
    const ids = []
    for (const v of lib.volumes) for (const c of v.chapterList || []) for (const e of c.entries) ids.push(e.id)
    assert(!ids.includes(grayed.id), 'grayed 混进了目录')
    assert(ids.includes(current.id), '现行条目不在目录里')
    assert(!ids.includes(expired.id), 'expired 混进了目录')
    assert(lib.counts.grayed === 1, `counts.grayed=${lib.counts.grayed}`)
    assert(lib.counts.retired === 1, `counts.retired=${lib.counts.retired}`)
  })

  check('检索专用投影：grayedEntries 带定位信息', () => {
    assert(Array.isArray(lib.grayedEntries) && lib.grayedEntries.length === 1, 'grayedEntries 数量不对')
    const g = lib.grayedEntries[0]
    assert(g.id === grayed.id, 'id 不对')
    assert(g.grayed === true && g.status === 'grayed', 'grayed 标记缺失')
    assert(g.volumeName && g.chapterTitle, '缺 volumeName/chapterTitle，检索层无法拼定位符')
  })

  check('时间线：grayed 不出现在默认视图', () => {
    const tl = buildTimeline(TMP, 30)
    assert(tl.ok, 'buildTimeline 失败：' + (tl.error || ''))
    const ids = tl.days.flatMap((d) => d.entries.map((e) => e.id))
    assert(!ids.includes(grayed.id), 'grayed 出现在时间线')
    assert(ids.includes(current.id), '现行条目应从时间线可见')
  })

  check('关键词检索：grayed 可搜，且带 grayed:true', () => {
    const snapshot = { summary: toSummary(lib), library: lib }
    const hits = matchEntries(snapshot, '翻译请求', 8)
    const hit = hits.find((h) => h.id === grayed.id)
    assert(hit, 'grayed 条目搜不到（违反「可搜」）')
    assert(hit.grayed === true, '命中项没标 grayed')
  })

  check('语义语料：grayed 也在索引里', () => {
    const snapshot = { summary: toSummary(lib), library: lib }
    const idx = buildSemanticIndex(snapshot)
    assert(idx.docs.some((d) => d.entry.id === grayed.id && d.grayed === true), 'grayed 不在语义语料')
    // 纯中文长查询走语义路（标题 4 字，凑够门槛）。
    const hits = semanticRecall(snapshot, '翻译请求怎么处理', 8)
    assert(Array.isArray(hits), 'semanticRecall 应返回数组')
  })

  check('可读：grayed 文件仍在盘上、可按 id 定位', () => {
    const file = findMarkdownEntryFile(TMP, grayed.id)
    assert(file && existsSync(file), 'grayed 文件找不到')
  })

  check('纯函数：catalogFromEntries 对 grayed 的过滤不依赖磁盘', () => {
    const l = catalogFromEntries([current, grayed, expired])
    assert(l.counts.grayed === 1, 'counts.grayed 不对')
    assert(l.grayedEntries.length === 1, 'grayedEntries 不对')
    const ids = []
    for (const v of l.volumes) for (const c of v.chapterList || []) for (const e of c.entries) ids.push(e.id)
    assert(!ids.includes(grayed.id), 'grayed 进了纯函数目录')
  })
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

console.log('')
console.log('════════════════════════════════════════════════════════════════════')
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail > 0) {
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过')
