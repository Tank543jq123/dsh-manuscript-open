#!/usr/bin/env node
/**
 * 命中必须能「翻回原文」—— 可定位出处（2026-11-17）。
 *
 * ## 为什么要有这个测试
 *
 * manual_recall 此前每条命中给：标题 / 册·章 · 条目 id / 相关度 / 摘要。
 * 这些都不是**文件位置**：用户想自己翻原文核对时，不知道去哪翻；
 * Agent 想把「出处」交给用户时，也只能给一个 id。手册的信任基础是
 * 「用户能自己翻回原文核对」，所以每条命中必须带一处可定位的出处。
 *
 * ## 本文件锁定的行为
 *
 *   ① Markdown 库：命中带 `mdPath`，形如 `vol-03/ch-prompt/e-xxx.md`，
 *      且该路径在磁盘上真实存在（库内相对路径，不含个人绝对路径）。
 *   ② 手写条目：id 是从文件名派生的 `md-<hash>`，**不能**按 volume/chapter/id
 *      拼路径 —— 必须给真正扫描到的那个文件（`笔记/双排针.md`）。
 *   ③ 没有真实路径时（旧 JSON 库 / 夹具）：退给 `manual_read` 能直接用的
 *      册/章标识；绝不能编一个 `.md` 路径出来。
 *   ④ 连册/章都没有：显式写「无」，不拼任何片段。
 *   ⑤ L2 首轮预取同样带出处：≤3 条、每条仍是两行、体积只增加 id+路径本身。
 *   ⑥ 工具说明写明「把该路径给用户，或用它翻回原文」。
 *   ⑦ `__mdPath` 是非枚举属性：不会写回 front-matter / library.json。
 *
 * 夹具全部是临时目录里的真文件（走真实 scanMarkdownLibrary），
 * 不碰本机真实库 —— 否则换台机器（条目数不同）就测不出来。
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  matchEntries,
  formatRecallHit,
  buildPrefetchDecision,
  buildSemanticIndex,
  truncateClaim,
  MANUAL_RECALL_DESCRIPTION,
} from '../lib/index.js'
import { scanMarkdownLibrary, entryToMarkdown } from '../lib/markdown-library.js'
import { toSummary } from '../lib/library.js'

let pass = 0
let fail = 0
const failures = []
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`✓ ${name}${extra ? '  ' + extra : ''}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`✗ ${name}${extra ? '  ' + extra : ''}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ── 沙箱：任何情况下都不许落到真实库 ──────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'recall-locate-'))
process.env.DSH_MANUSCRIPT_ROOT = root
process.on('exit', () => {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
})

/** 造一条带 front-matter 的册内条目。 */
function mdEntry({ id, title, claim, volume = 'vol-03', chapter = 'ch-prompt' }) {
  return [
    '---',
    `id: ${JSON.stringify(id)}`,
    `title: ${JSON.stringify(title)}`,
    `volume: ${JSON.stringify(volume)}`,
    `chapter: ${JSON.stringify(chapter)}`,
    'confidence: "high"',
    'authority: "L2"',
    `claim: ${JSON.stringify(claim)}`,
    'provenance: {"session_id":"s-1","timestamp":"2026-11-01T00:00:00.000Z"}',
    '---',
    '',
    `# ${title}`,
    '',
    claim,
    '',
  ].join('\n')
}

function writeEntry(rel, text) {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text, 'utf8')
}

// 三条正常册内条目（真实文件），标题目的是让短查询「插件」能稳定命中 3 条
writeEntry('vol-03/ch-prompt/e-plugin-1.md', mdEntry({
  id: 'e-plugin-1',
  title: '安装更新 dsh-workbuddy-connect 插件',
  claim: '插件安装后要先卸载旧版本再重装，否则工具列表不刷新',
}))
writeEntry('vol-03/ch-prompt/e-plugin-2.md', mdEntry({
  id: 'e-plugin-2',
  title: '插件安装失败排查',
  claim: '插件装完工具列表没变，先看 host 的插件装配日志',
}))
writeEntry('vol-03/ch-prompt/e-plugin-3.md', mdEntry({
  id: 'e-plugin-3',
  title: '插件工具架刷新',
  claim: '插件重装后工具架需要重新加载一次',
}))
// 手写条目：没有 front-matter，id 由文件名派生（md-<hash>），
// 与文件路径不同名 —— 这正是"按 id 拼路径会编造"的那类数据。
writeEntry('笔记/双排针.md', '# 嘉立创2.0双排针选型\n\n双排针间距 2.54mm，排针长度按板厚留余量。\n')

const scan = scanMarkdownLibrary(root)
const snapshot = {
  summary: toSummary(scan.library),
  library: scan.library,
  root,
  at: Date.now(),
}

const relOf = (id) => {
  for (const v of scan.library.volumes) {
    for (const c of v.chapterList || []) {
      const e = c.entries.find((x) => x.id === id)
      if (e) return e.mdPath
    }
  }
  return null
}

// ─────────────────────────────────────────────
console.log('\n── 1. 正常册内条目：id + 册/章 + 真实路径 ──')
// ─────────────────────────────────────────────
{
  const hits = matchEntries(snapshot, '插件', 3)
  check('查询「插件」命中 3 条', hits.length === 3, `${hits.length} 条`)
  const h = hits.find((x) => x.id === 'e-plugin-1')
  assert(h, '没命中 e-plugin-1')
  check('命中带 mdPath', typeof h.mdPath === 'string', h.mdPath)
  check('mdPath 是库内相对路径（不带个人的绝对路径）', !h.mdPath.startsWith('/') && !h.mdPath.includes(root), h.mdPath)
  check('mdPath 指向的文件真实存在', existsSync(join(root, h.mdPath)), h.mdPath)
  check('mdPath 与派生路径一致（id 文件名）', h.mdPath === 'vol-03/ch-prompt/e-plugin-1.md', h.mdPath)

  const text = formatRecallHit(h, 0)
  check('渲染含条目 id', text.includes('e-plugin-1'))
  check('渲染含册名', text.includes(h.volumeName), h.volumeName)
  check('渲染含章名', text.includes(h.chapterTitle), h.chapterTitle)
  check('渲染含「出处」行', /^   出处 /m.test(text))
  check('「出处」行是真实路径', (text.match(/^   出处 (.+)$/m) || [])[1] === h.mdPath)

  // 库里每一条有 mdPath 的投影都必须指向真文件 —— 不许出现"看起来像路径"的字符串
  const all = scan.library.volumes.flatMap((v) => (v.chapterList || []).flatMap((c) => c.entries))
  const withPath = all.filter((e) => typeof e.mdPath === 'string')
  check('库投影里每条都有 mdPath', withPath.length === all.length, `${withPath.length}/${all.length}`)
  check('每条 mdPath 都真实存在', withPath.every((e) => existsSync(join(root, e.mdPath))), `${withPath.length} 条`)
}

// ─────────────────────────────────────────────
console.log('\n── 2. 手写条目：用真实文件名，不按 id 拼假路径 ──')
// ─────────────────────────────────────────────
{
  const hits = matchEntries(snapshot, '双排针', 3)
  check('查询「双排针」能命中手写条目', hits.length >= 1, `${hits.length} 条`)
  const hw = hits.find((x) => x.handwritten === true)
  assert(hw, '没命中手写条目')
  check('手写条目 id 是 md-<hash> 形式', /^md-[0-9a-f]+$/.test(hw.id), hw.id)
  check('手写条目 mdPath 就是文件名', hw.mdPath === '笔记/双排针.md', hw.mdPath)
  check('手写条目 mdPath 真实存在', existsSync(join(root, hw.mdPath)))

  const text = formatRecallHit(hw, 0)
  check('渲染给出真实手写文件路径', text.includes('笔记/双排针.md'))
  check('渲染不出现按 id 拼出来的假路径', !text.includes(`ch-inbox/${hw.id}.md`), text)
  // 派生路径的另一种拼法（vol-05/ch-inbox/<id>.md）也一并不许出现
  check('渲染不出现任何 md-<hash>.md 假路径', !new RegExp(`${hw.id}\\.md`).test(text))
}

// ─────────────────────────────────────────────
console.log('\n── 3. 没有真实路径：退给 manual_read 标识，不编造 ──')
// ─────────────────────────────────────────────
{
  // 旧 JSON 库 / 测试夹具：命中项有册章信息，但没有 Markdown 文件。
  const bare = {
    id: 'e-json-1',
    title: '旧 JSON 库里的条目',
    claim: '旧库只有 entries/*.json，没有 Markdown 文件',
    volumeName: 'VOL.03 DSH 插件开发',
    chapterTitle: '提示词与技能',
    volumeId: 'vol-03',
    chapterSlug: 'ch-prompt',
    score: 4,
    confidence: 'high',
    authority: 'L2',
  }
  const text = formatRecallHit(bare, 0)
  check('退给 manual_read 可直接用的标识', text.includes('manual_read vol-03 / ch-prompt'), text)
  check('没有编造 .md 路径', !/\.md\b/.test(text))
  check('仍带 id + 册/章', text.includes('e-json-1') && text.includes('VOL.03 DSH 插件开发') && text.includes('提示词与技能'))

  // 连册/章都没有：显式「无」，不拼片段。
  const unknown = {
    id: 'e-unknown-1',
    title: '连册章都缺失的条目',
    claim: '无出处时的占位',
    score: 1,
  }
  const u = formatRecallHit(unknown, 0)
  check('无册/章时显式写「无」', /^   出处 （无/m.test(u), u.split('\n')[3])
  check('无册/章时不编造任何路径片段', !u.includes('.md') && !u.includes('vol-'), u)
  check('无册/章时也不编 manual_read 标识', !u.includes('manual_read'))
}

// ─────────────────────────────────────────────
console.log('\n── 4. L2 首轮预取：同样带出处，≤3 条、体积不膨胀 ──')
// ─────────────────────────────────────────────
{
  const decide = () =>
    buildPrefetchDecision({
      turn: 1,
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '插件' }] }],
      seen: new Set(),
      agentId: 'agent-locate-1',
      snapshot,
    })
  const d = decide()
  check('首轮预取触发', !!d.injected)
  const text = d.injected?.content?.[0]?.text || ''
  const bullets = text.split('\n').filter((l) => l.startsWith('· '))
  const details = text.split('\n').filter((l) => /^  \S+ · \S+ · /.test(l))
  check('注入 ≤ 3 条', bullets.length <= 3 && bullets.length >= 1, `${bullets.length} 条`)
  check('每条命中都有第二行（id · 出处 · 摘要）', bullets.length === details.length, `${details.length}/${bullets.length}`)

  let allHaveRealPath = true
  let idsSeen = new Set()
  for (const line of details) {
    const m = /^  (\S+) · (\S+) · /.exec(line)
    assert(m, `第二行格式不符：${line}`)
    const [, id, loc] = m
    idsSeen.add(id)
    if (loc.startsWith('manual_read')) continue // 夹具都有 mdPath，正常不该走到这
    if (!loc.endsWith('.md') || !existsSync(join(root, loc))) allHaveRealPath = false
  }
  check('每条出处都指向真实文件（或 manual_read 标识）', allHaveRealPath && idsSeen.size === bullets.length)
  check('注入里没有 undefined', !text.includes('undefined'))
  check('注入说明写了「把该路径给用户…翻回原文」', text.includes('把该路径给用户') && text.includes('翻回原文'))

  // 体积：与旧格式（无 id / 无出处）比，只多出 id + 路径本身。
  const hits = matchEntries(snapshot, '插件', 3)
  const legacy = [
    '【书阁 · 本轮可能相关的手册条目】',
    ...hits.map((h) => `· ${h.volumeName} / ${h.chapterTitle} — ${h.title}\n  ${truncateClaim(h.claim) || '（无摘要）'}`),
    '',
    '若相关：先用 manual_read 读正文再回答。若都不相关：直接说明「手册无记录」，不要编造。',
  ].join('\n')
  const grow = text.length - legacy.length
  const overhead = hits.reduce((s, h) => s + String(h.id || '').length + String(h.mdPath || '').length, 0)
  check(
    '体积只增加 id+路径（不含额外重复内容）',
    grow >= 0 && grow <= overhead + 3 * 20 + 80,
    `+${grow} 字符（id+路径本身 ${overhead}，含分隔符与说明增补）`,
  )
}

// ─────────────────────────────────────────────
console.log('\n── 5. 语义路命中同样带 mdPath ──')
// ─────────────────────────────────────────────
{
  const idx = buildSemanticIndex(snapshot)
  const docs = idx.docs.filter((x) => x.entry?.id === 'e-plugin-1')
  check('语义索引里能取到 e-plugin-1', docs.length === 1, `${docs.length} 条`)
  check('语义索引的条目投影带 mdPath', docs[0]?.entry?.mdPath === 'vol-03/ch-prompt/e-plugin-1.md', docs[0]?.entry?.mdPath)
}

// ─────────────────────────────────────────────
console.log('\n── 6. 工具说明 + 不污染文件 ──')
// ─────────────────────────────────────────────
{
  check('manual_recall 说明写了「把该路径给用户」', MANUAL_RECALL_DESCRIPTION.includes('把该路径给用户'))
  check('manual_recall 说明写了「翻回原文」', MANUAL_RECALL_DESCRIPTION.includes('翻回原文'))
  check('manual_recall 说明写了缺出处不要编造', MANUAL_RECALL_DESCRIPTION.includes('不要编造'))

  const entry = scan.entries.find((e) => e.id === 'e-plugin-1')
  check('扫描结果上带真实路径', entry?.__mdPath === 'vol-03/ch-prompt/e-plugin-1.md', entry?.__mdPath)
  const md = entryToMarkdown(entry)
  check('路径不写回 front-matter', !md.includes('__mdPath') && !md.includes('mdPath'), 'front-matter 干净')
  check('路径不进 library.json 的条目正文（投影字段仅 mdPath）', !JSON.stringify(scan.library).includes('__mdPath'))
  // 重新解析写出的文本：路径信息不该被当成条目字段读回来
  const reparsed = entryToMarkdown(entry)
  check('再次序列化仍是同一份干净文本', reparsed === md)
  // 读回真实库文件确认未被测试改动
  check('测试没有改写磁盘上的条目文件', readFileSync(join(root, 'vol-03/ch-prompt/e-plugin-1.md'), 'utf8').includes('id: "e-plugin-1"'))
}

console.log('\n' + '═'.repeat(74))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail) {
  console.log('失败用例：')
  for (const f of failures) console.log('  ✗ ' + f)
}
console.log('═'.repeat(74))
process.exit(fail ? 1 : 0)
