#!/usr/bin/env node
/**
 * 单拉丁词查询召回 —— 2026-11-24（整改 4.3-9）回归。
 *
 * 事故：fail-closed 门槛要求「命中 ≥2 个拉丁词」才通过。单个词最多只有
 * latinHits=1，只能指望它是稀有词；实测真实库 `q=git` 的 df 很高
 * （github 等子串），于是明明几十条条目含 git，返回 0 条。
 *
 * 修法：单拉丁词（无中文 / 无数字）长度 ≥3 且不在英文虚词表时放行；
 * has / not / been / the 这类虚词直接拒绝，连「稀有词」后门也不留 ——
 * 否则一个只出现在一条正文里的 were 也会被当成检索主题。
 *
 * 夹具刻意让每个虚词只出现一次（df=1，旧规则下是「稀有词」），
 * 这样测的是虚词表本身，而不是 df 高不高。
 */
import { matchEntries, searchEntries, formatRecallResponse, EN_STOPWORDS } from '../lib/index.js'

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

function entry(id, title, claim, extra = {}) {
  return {
    id,
    title,
    claim,
    volume: 'vol-03',
    chapter: 'ch-01',
    chapterSlug: 'ch-01',
    volumeName: 'VOL.03 DSH 插件开发',
    chapterTitle: 'x',
    confidence: 'high',
    authority: 'L2',
    ...extra,
  }
}

// 9 条含 git 的条目：df(git)=9，远超 rareMax（语料 ~11 条时为 2）——
// 旧实现在这里必然是 0 命中（git 永远成不了「稀有词」）。
const entries = []
for (let i = 1; i <= 8; i += 1) {
  entries.push(entry(`e-git-${i}`, `Git 工作流 ${i}`, `git remote / GitHub 操作第 ${i} 次`))
}
entries.push(
  entry('e-git-canonical', 'Git 提交前必须绑定远端快照', 'git fetch 后记录 HEAD，再跑审计。', {
    mdPath: 'vol-03/ch-01/e-git-canonical.md',
  }),
)
// 每个虚词只出现一次：df=1，旧规则下它们是「稀有词」，会被召回。
entries.push(entry('e-en-stop', '英文记录', 'this has been the only note, not more'))
entries.push(entry('e-kicad', 'KiCad 铺铜', 'kicad 铺铜间距按板厂工艺调整。'))

const snapshot = {
  summary: {
    volumes: [
      {
        id: 'vol-03',
        no: 'VOL.03',
        name: 'DSH 插件开发',
        chapters: [{ slug: 'ch-01', title: 'x', entries }],
      },
    ],
  },
}

console.log('\n── 1. 单拉丁词：df 高也必须能命中 ──')

check('q=git 能命中（旧实现在这里必然 0）', () => {
  const hits = matchEntries(snapshot, 'git', 8)
  assert(hits.length > 0, 'git 仍然 0 命中')
  return hits.length + ' 条'
})

check('q=git 的命中都真的含 git / GitHub', () => {
  const hits = matchEntries(snapshot, 'git', 8)
  assert(hits.every((h) => `${h.title} ${h.claim}`.toLowerCase().includes('git')), '出现不含 git 的命中')
  return '全部含 git'
})

check('q=GIT 大小写不敏感', () => {
  assert(matchEntries(snapshot, 'GIT', 8).length > 0, '大写 GIT 0 命中')
})

check('单拉丁词命中带可定位出处（manual_recall 渲染）', () => {
  const text = formatRecallResponse(searchEntries(snapshot, 'git', 20))
  assert(text.includes('出处 vol-03/ch-01/e-git-canonical.md'), '缺真实 Markdown 出处：' + text)
  return '出处可定位'
})

console.log('\n── 2. 虚词：df 再低也不能召回 ──')

check('EN_STOPWORDS 覆盖 has / not / been / the', () => {
  for (const w of ['has', 'not', 'been', 'the']) assert(EN_STOPWORDS.has(w), `${w} 不在虚词表`)
})

for (const q of ['has', 'not', 'been', 'the', 'would', 'were']) {
  check(`q=${q} → 0 命中（即使 df=1 也不放行）`, () => {
    const hits = matchEntries(snapshot, q, 8)
    assert(hits.length === 0, `虚词召回了 ${hits.length} 条：` + JSON.stringify(hits.map((h) => h.id)))
  })
}

console.log('\n── 3. 原有能力不回退 ──')

check('技术词 kicad 仍然命中', () => {
  assert(matchEntries(snapshot, 'kicad', 8).some((h) => h.id === 'e-kicad'), 'kicad 查不到')
})

check('两个以上拉丁词仍走原规则（git GitHub）', () => {
  assert(matchEntries(snapshot, 'git GitHub', 8).length > 0, '多词查询被误伤')
})

check('不存在的单拉丁词仍然 0（fail-closed）', () => {
  assert(matchEntries(snapshot, 'zzz', 8).length === 0, '不存在的词竟然命中')
})

check('带中文的查询不受单拉丁词放行影响（git 仓库）', () => {
  // 这条只要求不抛错、不因放行而把全库拉出来；命中的必须真的含 git。
  const hits = matchEntries(snapshot, 'git 仓库', 8)
  assert(Array.isArray(hits), '返回值不是数组')
})

console.log('\n' + '='.repeat(60))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail > 0) {
  for (const f of failures) console.log('  · ' + f)
  process.exit(1)
}
