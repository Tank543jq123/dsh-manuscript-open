#!/usr/bin/env node
/**
 * 章（主题聚合）与分诊（smoke 判据）的回归测试 —— 2026-11-07 新增。
 *
 * 为什么需要：这两处都是"判据类"改动，出错不会崩，只会**悄悄把内容分错**。
 * 而它们各自踩过一次真实的坑：
 *   · 章用 cwd 项目名 → 112 条里 64 条堆进「default workspace」，目录失去索引价值
 *   · smoke 用"动没动工具" → 4 条「测试」+4 条「模型测试」以 real 进册，目录出现同名条目
 *
 * 夹具刻意只用**字符串**，不读磁盘、不扫描会话：换台机器也能跑。
 */

import { chapterSpec, chapterOf, TOPIC_DEFS, VOLUME_DEFS } from '../lib/library.js'
import { renderCatalogSection } from '../lib/index.js'
import { categorize, isSmokeTest, isEmptySession, triageAll } from '../lib/triage.js'

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

console.log('\n── 1. 主题章：标题命中主题词 ──')
for (const [title, project, slug, topicTitle] of [
  ['安装更新 dsh-workbuddy-connect 插件', 'default-workspace', 'ch-plugin', '插件安装与升级'],
  ['嘉立创2.0双排针选型', 'ngw p项目管理', 'ch-hw', '硬件与器件'],
  ['KiCad 最新版本查询', 'default-workspace', 'ch-eda', 'EDA 与 PCB'],
  ['领英求职人信息抓取可行性', 'hr信息收集', 'ch-scrape', '网页抓取与检索'],
  ['昨晚myhot未产出', '定时工作', 'ch-schedule', '定时任务与巡检'],
  ['本地部署 Granite 4.0-H-tiny', 'default-workspace', 'ch-llm-env', '本地模型与推理环境'],
]) {
  const spec = chapterSpec({ title, project })
  check(`「${title}」→ ${topicTitle}`, spec.slug === slug, `实际 ${spec.slug}`)
  check(`「${title}」的章标题是人话`, spec.title === topicTitle, `实际 ${spec.title}`)
}

console.log('\n── 2. 主题词都没有时：回退项目名，但兜底目录名不算主题 ──')
{
  const spec = chapterSpec({ title: '我们的接口约定', project: 'ngw p项目管理' })
  check('普通项目名 → 当章（可读）', spec.slug.startsWith('ch-ngw'), `实际 ${spec.slug}`)
  check('项目名原样作为章标题', spec.title === 'ngw p项目管理', spec.title)
}
for (const project of ['default workspace', 'default-workspace', '1e7f6d9597241db0', 'tmp']) {
  const spec = chapterSpec({ title: '一点都看不懂的标题', project })
  check(`「${project}」不当章 → 未分类`, spec.slug === 'ch-未分类', `实际 ${spec.slug}`)
}

console.log('\n── 3. 章 slug 不把长名字切成半词 ──')
{
  const long = 'review-demo-workspace-abcdefghijklmnop'
  const spec = chapterSpec({ title: '无关标题', project: long })
  check('长项目名的 slug 不超过 28+5 字符', spec.slug.length <= 33, `${spec.slug}（${spec.slug.length}）`)
  check('超长时附 4 位哈希以避免撞章', /-[0-9a-f]{4}$/.test(spec.slug), spec.slug)
  const again = chapterSpec({ title: '另一个无关标题', project: long })
  check('同一项目名 → 同一章（确定性）', again.slug === spec.slug, `${spec.slug} vs ${again.slug}`)
  const other = chapterSpec({ title: '无关', project: long + '-v2' })
  check('不同项目名 → 不同章（哈希起作用）', other.slug !== spec.slug, `${spec.slug} vs ${other.slug}`)
}

console.log('\n── 4. 主题表本身的自洽 ──')
{
  const ids = TOPIC_DEFS.map((t) => t.id)
  check('主题 id 唯一', new Set(ids).size === ids.length, ids.join(','))
  check('每个主题都有标题与关键词', TOPIC_DEFS.every((t) => t.title && Array.isArray(t.keywords) && t.keywords.length > 0))
  check('主题关键词不重复（同表内）', new Set(TOPIC_DEFS.flatMap((t) => t.keywords)).size === TOPIC_DEFS.flatMap((t) => t.keywords).length)
  check('chapterOf 仍是字符串（兼容旧调用方）', typeof chapterOf({ title: '插件', project: 'x' }) === 'string')
  // 【2026-11-09】7 → 9：新增 VOL.08 网页抓取与检索、VOL.09 系统与运维。
  // 收件箱里 62 个会话"没有任何信号命中"，不是分数判不准，是册表缺这两类。
  check('册表 9 册且含收件箱', VOLUME_DEFS.length === 9 && VOLUME_DEFS.some((v) => v.inbox), `${VOLUME_DEFS.length} 册`)
  check('册 id 唯一', new Set(VOLUME_DEFS.map((v) => v.id)).size === VOLUME_DEFS.length)
  check('收件箱永远是最后一册', VOLUME_DEFS[VOLUME_DEFS.length - 1].inbox === true)
}

console.log('\n── 5. smoke 判据：看交付物，不看工具调用数 ──')
const S = (o) => ({ humanMessages: 2, turnEnds: 2, ...o })
{
  check('标题「测试」+ 0 交付物 + 有工具调用 → smoke',
    isSmokeTest(S({ title: '测试', toolCalls: 121, deliverables: 0 })) === true)
  check('标题「模型测试」+ 0 交付物 → smoke',
    isSmokeTest(S({ title: '模型测试', toolCalls: 41, deliverables: 0 })) === true)
  check('标题「测试」但有交付物 → 不是 smoke（真干活了）',
    isSmokeTest(S({ title: '测试', toolCalls: 20, deliverables: 3 })) === false)
  check('普通标题 + 0 交付物 + 有工具调用 → 仍是 real',
    isSmokeTest(S({ title: '排查启动失败', toolCalls: 30, deliverables: 0 })) === false)
  check('零工具 + 零人类输入 → empty', isEmptySession(S({ title: 'x', toolCalls: 0, humanMessages: 0 })) === true)
  check('categorize 顺序：empty 优先于 smoke',
    categorize(S({ title: '测试', toolCalls: 0, humanMessages: 0 })) === 'empty')
  check('categorize：有交付物的测试会话是 real',
    categorize(S({ title: '测试', toolCalls: 9, deliverables: 1 })) === 'real')
}

console.log('\n── 6. triageAll 的统计口径自洽 ──')
{
  const sessions = [
    S({ sid: 'a', title: '模型测试', toolCalls: 40, deliverables: 0, category: undefined }),
    S({ sid: 'b', title: '嘉立创选型', toolCalls: 12, deliverables: 2 }),
    S({ sid: 'c', title: '', toolCalls: 0, humanMessages: 0 }),
  ]
  const t = triageAll(sessions)
  const total = t.enriched.length
  const sum = Object.values(t.counts || {}).reduce((x, y) => x + y, 0)
  check('分诊总数 = 各分类之和', sum === total, `sum=${sum} total=${total}`)
  check('测试会话被归为 noise 侧而非 real', t.counts.smoke + t.counts.empty >= 1, JSON.stringify(t.counts))
}

console.log('\n── 7. 目录渲染对畸形 summary 的容错 ──')
{
  // 【2026-11-08】renderCatalogSection 是导出 API（verify-prefetch / selfcheck /
  // 将来的图书馆都会调）。实测传 `/summary?lite=1` 那种"volumes 里没有 chapters"
  // 的形态会直接 TypeError（`v.chapters.slice` 不是函数）。
  const base = { total: 3, real: 3, entries: 3 }
  const cases = [
    ['volumes 为空数组', { ...base, volumes: [] }],
    ['volume 没有 chapters（lite 形态）', { ...base, volumes: [{ id: 'v', no: 'V', name: 'n', entries: 3, chapterCount: 2 }] }],
    ['chapter 没有 entries 数组', { ...base, volumes: [{ id: 'v', no: 'V', name: 'n', entries: 1, chapterCount: 1, chapters: [{ slug: 'c', title: '章' }] }] }],
    ['summary 缺 total/real', { entries: 0, volumes: [] }],
    ['volumes 不是数组', { ...base, volumes: null }],
  ]
  for (const [name, summary] of cases) {
    let threw = null
    let r = null
    try { r = renderCatalogSection({ summary }) } catch (e) { threw = e.message }
    check(`「${name}」不崩且给出文本`, threw === null && r && r.text.length > 0, threw || `lines=${r?.lines}`)
  }
  // lite 形态要如实说明"只有计数、没有章明细"，而不是假装没有章
  const lite = renderCatalogSection({ summary: { ...base, volumes: [{ id: 'v', no: 'V', name: 'n', entries: 3, chapterCount: 2 }] } })
  check('lite 形态里说明"未包含章明细"', /未包含章明细/.test(lite.text), lite.text.split('\n').slice(-3).join(' | '))
}

console.log('\n' + '═'.repeat(74))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail) {
  console.log('失败用例：')
  for (const f of failures) console.log('  ✗ ' + f)
}
console.log('═'.repeat(74))
process.exit(fail ? 1 : 0)
