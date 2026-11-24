#!/usr/bin/env node
/**
 * manual_read 读退役条目 —— 2026-11-24（整改 4.3-8）回归。
 *
 * 事故：退役（status=expired）条目不在目录投影里，而 manual_read 只认
 * volume/chapter、详情接口只认目录投影 —— 结果「旧记录」可搜可点，
 * 点进去 404 / 读不到。但退役条目的文件一直在盘上，退役只是「不再作为
 * 当前结论展示」，不是删除。
 *
 * 本测试钉住三件事：
 *   ① 按 entry_id 能读到退役条目正文
 *   ② 输出必须标注「该条目已退役（被 <replacedBy> 取代）」
 *   ③ 文件不存在 / id 非法 / front-matter 坏掉时给明确错误，不静默返回空
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readManualEntry, retireNoteOf } from '../lib/index.js'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-ms-manual-read-'))
const LIB = join(TMP, 'library')
const CH = join(LIB, 'vol-03', 'ch-plugin')
mkdirSync(CH, { recursive: true })

function writeEntry(id, front, body) {
  writeFileSync(join(CH, id + '.md'), `---\n${front}\n---\n${body}\n`)
}

writeEntry(
  'e-old00000001',
  `id: "e-old00000001"
title: "双排针选型的旧记录"
volume: "vol-03"
chapter: "ch-plugin"
confidence: "speculation"
authority: "L3"
claim: "1 轮 · 252 次工具调用 · 1 个交付物"
why: "旧结论正文：2.0mm 双排针 2x10P。"
meta: {"status":"expired","retiredAt":"2026-11-12T06:32:13.658Z","retiredReason":"superseded-by-distilled-entry","replacedBy":"e-new00000001"}`,
  '正文占位。',
)
writeEntry(
  'e-new00000001',
  `id: "e-new00000001"
title: "双排针选型的现行结论"
volume: "vol-03"
chapter: "ch-plugin"
confidence: "high"
authority: "L2"
claim: "2.0mm 双排针 2x10P，间距 ≥2.54mm。"
why: "现行结论正文。"`,
  '正文占位。',
)
writeEntry(
  'e-old00000002',
  `id: "e-old00000002"
title: "没有 replacedBy 的退役记录"
volume: "vol-03"
chapter: "ch-plugin"
claim: "3 轮 · 2 次工具调用 · 0 个交付物"
meta: {"status":"expired","retiredAt":"2026-11-12T06:32:13.658Z"}`,
  '旧记录正文。',
)
// front-matter id 非法：getLibraryEntry 会抛错，readManualEntry 必须转成明确错误。
writeEntry('e-badfrontmatter', 'id: "../evil"\ntitle: "坏条目"', '坏正文。')

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

console.log('\n── 1. 退役条目可读 + 标注取代者 ──')

check('按 entry_id 能读退役条目正文', () => {
  const r = readManualEntry(LIB, 'e-old00000001')
  assert(r.ok === true, r.ok ? '' : r.error)
  assert(r.text.includes('旧结论正文：2.0mm 双排针 2x10P。'), '正文缺失：' + r.text)
  assert(r.text.includes('e-old00000001'), '缺条目 id')
  return '正文 + id 都在'
})

check('输出标注「该条目已退役（被 <replacedBy> 取代）」', () => {
  const r = readManualEntry(LIB, 'e-old00000001')
  assert(r.text.startsWith('该条目已退役（被 e-new00000001 取代）'), '首行标注不对：' + r.text.split('\n')[0])
  return r.text.split('\n')[0]
})

check('没有 replacedBy 时如实标注，不编造取代者', () => {
  const r = readManualEntry(LIB, 'e-old00000002')
  assert(r.ok === true, r.error)
  assert(r.text.includes('该条目已退役（未记录 replacedBy）'), r.text.split('\n')[0])
  return '未记录 replacedBy'
})

check('现行条目可读且不带退役标注', () => {
  const r = readManualEntry(LIB, 'e-new00000001')
  assert(r.ok === true, r.error)
  assert(!r.text.includes('已退役'), '现行条目被误标退役：' + r.text)
  assert(r.text.includes('现行结论正文。'), '正文缺失')
  return '现行 · 无退役标注'
})

check('没有独立正文时如实说明，并保留摘要内容', () => {
  const r = readManualEntry(LIB, 'e-old00000002')
  assert(r.ok === true, r.error)
  assert(r.text.includes('无独立正文'), r.text)
  assert(r.text.includes('3 轮 · 2 次工具调用 · 0 个交付物'), '摘要内容丢失')
  return '无独立正文 · 摘要仍在'
})

console.log('\n── 2. 明确错误：不静默返回空 ──')

check('条目文件不存在 → 明确报错', () => {
  const r = readManualEntry(LIB, 'e-doesnotexist')
  assert(r.ok === false, '不存在的条目竟然读成功')
  assert(r.error.includes('条目文件不存在'), r.error)
  return r.error
})

check('id 非法 → 明确拒绝（不拼路径）', () => {
  const r = readManualEntry(LIB, '../etc/passwd')
  assert(r.ok === false, '非法 id 竟然读成功')
  assert(r.error.includes('非法字符'), r.error)
  return r.error
})

check('front-matter 坏掉 → 明确报错，不吞异常', () => {
  const r = readManualEntry(LIB, 'e-badfrontmatter')
  assert(r.ok === false, '坏 front-matter 竟然读成功')
  assert(r.error.includes('读取条目失败'), r.error)
  return r.error
})

console.log('\n── 3. 标注纯函数 ──')

check('retireNoteOf：只对 expired 生效', () => {
  assert(retireNoteOf({ status: 'current' }) === '', '现行条目不该有退役标注')
  assert(retireNoteOf(null) === '', '空值不该有退役标注')
  assert(retireNoteOf({ status: 'expired', replacedBy: 'e-x' }) === '该条目已退役（被 e-x 取代）', '格式不对')
  assert(retireNoteOf({ meta: { status: 'expired', replacedBy: 'e-y' } }) === '该条目已退役（被 e-y 取代）', 'meta 形态未识别')
})

console.log('\n' + '='.repeat(60))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
if (fail > 0) {
  for (const f of failures) console.log('  · ' + f)
  process.exit(1)
}
