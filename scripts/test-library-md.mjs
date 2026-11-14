#!/usr/bin/env node
/**
 * test-library-md.mjs —— Markdown 真相层 / 可配置库根 / JSON→MD 迁移。
 *
 * 覆盖这次改动最容易「看起来正常、其实读到空库」的四条链路：
 *   ① 条目 Markdown 往返（front-matter 为准，正文只是人读副本）
 *   ② 索引删除后可由扫描重建
 *   ③ 改配置指向新目录后读到**同一批** id/title（多实例共享的最小验证）
 *   ④ 旧 JSON 库迁移后条目数/册数/id 集合一致，且源库有备份
 *
 * 全程 os.tmpdir()，不碰 ~/.dsh/dsh-manuscript。
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  cpSync,
  unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import 任何库模块之前隔离配置，避免读到本机真实配置。
const TMP = mkdtempSync(join(tmpdir(), 'ms-md-'))
const CONFIG = join(TMP, 'library-config.json')
process.env.DSH_MANUSCRIPT_CONFIG = CONFIG
delete process.env.DSH_MANUSCRIPT_ROOT

const {
  writeMarkdownEntry,
  entryToMarkdown,
  markdownToEntry,
  scanMarkdownLibrary,
  rebuildMarkdownIndex,
  readAllLibraryEntries,
  getLibraryEntry,
  isMarkdownLibrary,
  markdownHealth,
} = await import('../lib/markdown-library.js')
const { readLibraryConfig, writeLibraryConfig } = await import('../lib/library-root.js')
const { defaultLibraryRoot } = await import('../lib/library.js')
const { commitEntries } = await import('../lib/commit.js')
const { migrateJsonToMarkdown } = await import('../scripts/migrate-json-to-md.mjs')

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
    failures.push({ name, error: e })
    console.log(`✗ ${name}`)
    console.log(`    ${e?.message || String(e)}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const roots = []
function makeRoot(name) {
  const d = join(TMP, name)
  mkdirSync(d, { recursive: true })
  roots.push(d)
  return d
}

function sampleEntry(n, over = {}) {
  return {
    id: `e-${String(n).padStart(12, '0')}`,
    title: `条目 ${n}：I2C 从机 ISR 里不要调阻塞日志`,
    volume: n % 2 === 0 ? 'vol-02' : 'vol-03',
    chapter: n % 2 === 0 ? 'ch-通信协议' : 'ch-提示词与技能',
    confidence: 'high',
    authority: 'L2',
    claim: `第 ${n} 条结论：中断里写日志会拉长 ISR，导致主机超时。`,
    why: n === 1 ? '实测改成环形缓冲后超时消失。' : '',
    provenance: { session_id: `session-${n}`, turn: n, timestamp: `2026-11-12T0${n}:00:00+08:00` },
    status: 'current',
    qualityScore: 7 + n,
    hits: n,
    tags: ['i2c', 'isr'],
    evidence: { tools: ['bash'], files: ['lib/i2c.c'] },
    ...over,
  }
}

function seedLibrary(name, count = 2) {
  const root = makeRoot(name)
  for (let i = 1; i <= count; i += 1) writeMarkdownEntry(root, sampleEntry(i))
  const rebuilt = rebuildMarkdownIndex(root)
  assert(rebuilt.ok, `种子库索引重建失败：${rebuilt.error}`)
  return root
}

console.log('=== ① Markdown 往返 ===\n')

check('一条目一 .md，路径是 <册>/<章>/<id>.md', () => {
  const root = makeRoot('roundtrip')
  const e = sampleEntry(1)
  const w = writeMarkdownEntry(root, e)
  assert(w.relativePath === 'vol-03/ch-提示词与技能/e-000000000001.md', `路径不符：${w.relativePath}`)
  assert(existsSync(w.path), '文件未落盘')
  return w.relativePath
})

check('front-matter 解析回来字段一致（含 provenance/meta）', () => {
  const root = makeRoot('roundtrip2')
  const e = sampleEntry(2)
  writeMarkdownEntry(root, e)
  const text = readFileSync(join(root, 'vol-02', 'ch-通信协议', e.id + '.md'), 'utf8')
  const back = markdownToEntry(text)
  assert(back.id === e.id, 'id 不一致')
  assert(back.title === e.title, 'title 不一致')
  assert(back.claim === e.claim, 'claim 不一致')
  assert(back.why === e.why, 'why 不一致')
  assert(back.provenance.session_id === e.provenance.session_id, 'provenance 不一致')
  assert(back.tags.join(',') === 'i2c,isr', 'tags 未从 meta 还原')
  assert(back.qualityScore === e.qualityScore, 'qualityScore 未从 meta 还原')
  return `${back.id} / ${back.volume} / ${back.chapter}`
})

check('正文是渲染副本，以 front-matter 为准', () => {
  const md = entryToMarkdown(sampleEntry(1))
  assert(md.includes('> Why:'), '正文缺 Why 渲染')
  assert(md.startsWith('---\n'), '缺 front-matter')
})

check('手写 Markdown（无 front-matter）按首个标题/文件名推导，标 handwritten', () => {
  // 【2026-11-12 并发新增】另一个改动让「直接扔进来的普通 Markdown」也能进馆：
  // 标题优先取首个 # 标题、没有就取文件名；id 用路径哈希；claim 取第一段非标题文字。
  const e = markdownToEntry('# 我的笔记\n第一段：手写也能进馆。\n', 'notes/文件名不同.md')
  assert(/^md-[0-9a-f]{12}$/.test(e.id), `推导 id 形状不对：${e.id}`)
  assert(e.title === '我的笔记', `标题未取首个标题：${e.title}`)
  assert(e.claim.includes('手写也能进馆'), `claim 未取正文首段：${e.claim}`)
  assert(e.handwritten === true, '未标 handwritten:true')
  const e2 = markdownToEntry('没有标题的纯文本\n', 'notes/只有文件名.md')
  assert(e2.title === '只有文件名', `无标题时未取文件名：${e2.title}`)
  return `${e.id} / ${e.title}`
})

check('空 MD 文件不崩、跳过并计数', () => {
  const root = makeRoot('empty-md')
  mkdirSync(join(root, 'vol-01', 'ch-x'), { recursive: true })
  writeFileSync(join(root, 'vol-01', 'ch-x', 'empty.md'), '   \n\n', 'utf8')
  const scan = scanMarkdownLibrary(root)
  assert(scan.entries.length === 0, `空文件不应入册，实际 ${scan.entries.length}`)
  assert(scan.errors.length === 1, `应记录 1 个坏文件，实际 ${scan.errors.length}`)
  assert(scan.errors[0].code === 'md-unparsable', `code=${scan.errors[0].code}`)
  return scan.errors[0].message
})

console.log('\n=== ② 索引由扫描重建 ===\n')

check('扫描结果与写盘条目一致', () => {
  const root = seedLibrary('scan', 3)
  const r = scanMarkdownLibrary(root)
  assert(r.entries.length === 3, `条目数 ${r.entries.length}`)
  assert(r.library.counts.entries === 3, `索引 entries=${r.library.counts.entries}`)
  assert(r.library.volumes.filter((v) => v.entries > 0).length === 2, '册数不是 2')
  return '3 条 / 2 册'
})

check('删掉 library.json 后仍能识别为 MD 库并由扫描恢复', () => {
  const root = seedLibrary('no-index', 2)
  unlinkSync(join(root, 'library.json'))
  assert(isMarkdownLibrary(root), '缺索引时未识别为 MD 库')
  const scan = scanMarkdownLibrary(root)
  assert(scan.entries.length === 2, '扫描条目数不对')
  assert(scan.library.counts.entries === 2, '内存重建计数不对')
  const rebuilt = rebuildMarkdownIndex(root)
  assert(rebuilt.ok, `重建失败：${rebuilt.error}`)
  assert(JSON.parse(readFileSync(join(root, 'library.json'), 'utf8')).storage === 'markdown', '索引未标 storage')
  return '缺索引 → 扫描 → 重建'
})

check('体检：健康 MD 库为 healthy', () => {
  const root = seedLibrary('health', 2)
  const h = markdownHealth(root)
  assert(h.level === 'healthy', `level=${h.level} issues=${JSON.stringify(h.issues)}`)
  assert(h.facts.actualEntryFiles === 2, 'actualEntryFiles 不对')
  return 'healthy / 2 条'
})

check('体检：front-matter 写坏 → broken，且拒绝覆盖索引', () => {
  const root = seedLibrary('bad', 1)
  mkdirSync(join(root, 'vol-01', 'ch-x'), { recursive: true })
  // 有 --- 但行内缺冒号：这是真坏，不是「没有 front-matter 的手写 Markdown」。
  writeFileSync(join(root, 'vol-01', 'ch-x', 'bad.md'), '---\nid: "e-bad"\noops-no-colon\n---\n正文\n', 'utf8')
  const h = markdownHealth(root)
  assert(h.level === 'broken', `level=${h.level}`)
  const rebuilt = rebuildMarkdownIndex(root)
  assert(rebuilt.ok === false, '有坏条目时不应覆盖索引')
  return h.issues.map((i) => i.code).join(',')
})

console.log('\n=== ③ 可配置库根 + 同一批 MD ===\n')

check('默认（无配置、无环境变量）仍是 ~/.dsh/dsh-manuscript', () => {
  delete process.env.DSH_MANUSCRIPT_ROOT
  const r = readLibraryConfig(process.env)
  assert(r.source === 'default', `source=${r.source}`)
  assert(r.root === join(process.env.HOME || '', '.dsh', 'dsh-manuscript'), `root=${r.root}`)
  return r.root
})

check('写配置 → 生效根切换，读到 A 的条目', () => {
  const a = seedLibrary('shared-a', 2)
  const w = writeLibraryConfig(a, { configFile: CONFIG })
  assert(w.ok, `写配置失败：${w.error}`)
  const cfg = readLibraryConfig(process.env)
  assert(cfg.source === 'config', `source=${cfg.source}`)
  assert(cfg.root === a, `root=${cfg.root}`)
  assert(defaultLibraryRoot() === a, 'defaultLibraryRoot 未跟随配置')
  const ids = readAllLibraryEntries(a).entries.map((e) => e.id).sort()
  assert(ids.length === 2, `A 读到 ${ids.length} 条`)
  return ids.join(',')
})

check('改配置指向新目录 B（同一批 MD 复制）→ 读到同一批 id/title', () => {
  const a = seedLibrary('shared-b-a', 3)
  const b = join(TMP, 'shared-b')
  cpSync(a, b, { recursive: true })
  writeLibraryConfig(b, { configFile: CONFIG })
  const cfg = readLibraryConfig(process.env)
  assert(cfg.root === b, '配置未指向 B')
  const sa = scanMarkdownLibrary(a).entries
  const sb = scanMarkdownLibrary(b).entries
  assert(sa.length === sb.length, `条目数 ${sa.length} vs ${sb.length}`)
  assert(
    sa.every((e, i) => e.id === sb[i].id && e.title === sb[i].title),
    'B 读到的 id/title 与 A 不一致'
  )
  return `${sa[0].id} / ${sa[0].title.slice(0, 18)}…`
})

check('环境变量 DSH_MANUSCRIPT_ROOT 压过面板配置', () => {
  const a = seedLibrary('env-a', 1)
  const c = join(TMP, 'env-c')
  cpSync(a, c, { recursive: true })
  writeLibraryConfig(a, { configFile: CONFIG })
  process.env.DSH_MANUSCRIPT_ROOT = c
  const cfg = readLibraryConfig(process.env)
  assert(cfg.source === 'env', `source=${cfg.source}`)
  assert(cfg.root === c, `root=${cfg.root}`)
  delete process.env.DSH_MANUSCRIPT_ROOT
  return 'env 优先'
})

console.log('\n=== ④ 非法配置回退（不崩） ===\n')

check('坏 JSON → 回退默认 + warning', () => {
  writeFileSync(CONFIG, '{ 截断', 'utf8')
  const r = readLibraryConfig(process.env)
  assert(r.source === 'default', `source=${r.source}`)
  assert(r.warnings.length > 0, '没有 warning')
  return r.warnings[0].slice(0, 40)
})

check('相对路径 → 回退 + warning', () => {
  writeFileSync(CONFIG, JSON.stringify({ root: 'relative/path' }), 'utf8')
  const r = readLibraryConfig(process.env)
  assert(r.source === 'default', `source=${r.source}`)
  assert(r.warnings.some((w) => w.includes('绝对路径')), `warnings=${r.warnings.join('；')}`)
  return r.warnings[0]
})

check('不存在的路径 → 回退 + warning', () => {
  writeFileSync(CONFIG, JSON.stringify({ root: join(TMP, 'no-such-dir') }), 'utf8')
  const r = readLibraryConfig(process.env)
  assert(r.source === 'default', `source=${r.source}`)
  assert(r.warnings.some((w) => w.includes('不存在')), `warnings=${r.warnings.join('；')}`)
  return r.warnings[0]
})

console.log('\n=== ⑤ 旧 JSON → Markdown 迁移 ===\n')

function makeJsonLibrary(name, count = 3) {
  const root = makeRoot(name)
  mkdirSync(join(root, 'entries'), { recursive: true })
  mkdirSync(join(root, 'volumes', 'vol-01'), { recursive: true })
  for (let i = 1; i <= count; i += 1) {
    const e = sampleEntry(i)
    writeFileSync(join(root, 'entries', e.id + '.json'), JSON.stringify(e, null, 2), 'utf8')
  }
  writeFileSync(join(root, 'volumes', 'vol-01', 'MANUAL.md'), '# 硬件\n', 'utf8')
  writeFileSync(join(root, 'library.json'), JSON.stringify({
    version: 1,
    counts: { entries: count, total: 194, real: 164, archived: 79 },
    volumes: [
      { id: 'vol-02', entries: 2 },
      { id: 'vol-03', entries: 1 },
    ],
  }, null, 2), 'utf8')
  return root
}

check('dry-run 只统计、不写盘', () => {
  const root = makeJsonLibrary('dry', 2)
  const before = readdirSync(root).sort().join(',')
  const r = migrateJsonToMarkdown({ from: root, dryRun: true })
  assert(r.ok, r.error)
  assert(r.entries === 2, `entries=${r.entries}`)
  assert(readdirSync(root).sort().join(',') === before, 'dry-run 改了目录')
  return `wouldWrite=${r.wouldWrite}`
})

check('迁移后条目数/册数/id 集合一致，旧 JSON 进 legacy-json/', () => {
  const root = makeJsonLibrary('migrate', 3)
  const expected = readdirSync(join(root, 'entries')).filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5)).sort()
  const r = migrateJsonToMarkdown({ from: root })
  assert(r.ok, r.error || '迁移失败')
  assert(r.verified, '未标记校验通过')
  assert(r.entries === 3, `报告条目数 ${r.entries}`)
  const scan = scanMarkdownLibrary(root)
  assert(scan.entries.length === 3, `MD 条目数 ${scan.entries.length}`)
  assert(scan.library.volumes.filter((v) => v.entries > 0).length === 2, '册数不是 2')
  assert(scan.entries.map((e) => e.id).sort().join(',') === expected.join(','), 'id 集合不一致')
  assert(existsSync(join(root, 'legacy-json', 'entries')), '旧 entries 未进 legacy-json')
  assert(existsSync(r.backup), '没有备份目录')
  assert(existsSync(join(r.backup, 'entries')), '备份里没有旧 entries')
  assert(JSON.parse(readFileSync(join(root, 'library.json'), 'utf8')).storage === 'markdown', '新索引未标 markdown')
  return `${r.entries} 条 / ${r.volumes} 册 · backup=${r.backup.split('/').pop()}`
})

check('迁移保留旧索引的会话统计（不编新数字）', () => {
  const root = makeJsonLibrary('migrate-counts', 2)
  const r = migrateJsonToMarkdown({ from: root })
  assert(r.ok, r.error)
  const lib = JSON.parse(readFileSync(join(root, 'library.json'), 'utf8'))
  assert(lib.counts.total === 194, `total=${lib.counts.total}`)
  assert(lib.counts.real === 164, `real=${lib.counts.real}`)
  return 'total=194 / real=164 原样保留'
})

check('对已迁移库重复迁移 → 明确拒绝，不覆盖', () => {
  const root = makeJsonLibrary('migrate-twice', 1)
  assert(migrateJsonToMarkdown({ from: root }).ok, '第一次迁移失败')
  const again = migrateJsonToMarkdown({ from: root })
  assert(again.ok === false, '第二次迁移不应成功')
  assert(/已经是 Markdown 库/.test(again.error), `error=${again.error}`)
  return again.error
})

console.log('\n=== ⑥ MD 库入册 / 按 id 读取 ===\n')

check('commitEntries 写 MD 并更新索引，重复提交被跳过', () => {
  const root = seedLibrary('commit', 1)
  const r1 = commitEntries([{
    title: '新结论：共享库用 Markdown 存',
    claim: '一条目一 .md，索引派生。',
    volume: 'vol-03',
    chapter: 'ch-架构',
    provenance: { session_id: 's-commit' },
  }], { root })
  assert(r1.ok && r1.written === 1, `第一次入册：${JSON.stringify(r1)}`)
  const r2 = commitEntries([{
    title: '新结论：共享库用 Markdown 存',
    claim: '一条目一 .md，索引派生。',
    volume: 'vol-03',
    chapter: 'ch-架构',
    provenance: { session_id: 's-commit' },
  }], { root })
  assert(r2.ok && r2.written === 0 && r2.skipped === 1, '重复提交未被跳过')
  assert(scanMarkdownLibrary(root).entries.length === 2, '索引/磁盘条目数不是 2')
  return `id=${r1.ids[0]}`
})

check('按 id 直读（manual_trace 走的就是这条）', () => {
  const root = seedLibrary('get', 1)
  const e = getLibraryEntry(root, 'e-000000000001')
  assert(e && e.id === 'e-000000000001', '按 id 未读到')
  assert(getLibraryEntry(root, 'e-not-exist') === null, '不存在的 id 应返回 null')
  assert(getLibraryEntry(root, '../etc/passwd') === null, '非法 id 应返回 null')
  return e.title.slice(0, 20) + '…'
})

console.log('\n' + '='.repeat(60))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
try {
  rmSync(TMP, { recursive: true, force: true })
} catch {
  /* 清理失败不影响结果 */
}
process.exit(fail === 0 ? 0 : 1)
