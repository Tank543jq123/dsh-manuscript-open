#!/usr/bin/env node
/**
 * T0 统计骨架的检索行为 —— 2026-11-12 验收回归。
 *
 * 事故：线上 320 条里 155 条（48.4%）claim 是「N 轮 · M 次工具调用 · K 个交付物」。
 * 它们靠标题里的词命中，却把「会话有多长」混进「会话教会了什么」；
 * 问「AIHOT 为什么把微信直发排除在代理外」，top1 就是一条
 * 「1 轮 · 36 次工具调用 · 0 个交付物」的骨架。
 *
 * 为什么是**降权**而不是剔除：剔除会让「插件」「排针」这类只靠标题的
 * 短查询查不到任何东西 —— 而骨架的标题确实是一段会话的索引
 * （test-recall-short 锁的就是这条）。所以：
 *   ① 骨架照样可被标题召回
 *   ② 但永远排在真结论之后
 *   ③ 渲染时明确标注「仅会话统计，无结论」
 *   ④ 判据够窄，不误杀正文里提到「轮」的真实结论
 */

import { matchEntries, isSkeletonEntry } from '../lib/index.js'

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

function entry(id, title, claim) {
  return { id, title, claim, volume: 'vol-03', chapter: 'ch-01', confidence: 'high', authority: 'verified' }
}

const skeleton = entry('e-skel-0001', 'AI 应用岗位调研报告', '7 轮 · 3 次工具调用 · 0 个交付物 · （多轮讨论）')
const skeleton2 = entry('e-skel-0002', '模型测试', '1 轮 · 0 次工具调用 · 0 个交付物 · （一次性模板任务）')
const real = entry(
  'e-real-0001',
  '微信直发必须绕过出口代理',
  '微信直发若走 10809 代理会连不上 ilinkai.weixin.qq.com，所以 NO_PROXY 里要保留该域名。',
)
const realMentionsTurns = entry(
  'e-real-0002',
  '长会话提炼会丢晚段内容',
  '实测 214 轮的会话只提炼出 2 条结论，后半段提到的内容全丢；需要分段提炼。',
)

const snapshot = {
  summary: {
    volumes: [
      {
        id: 'vol-03',
        no: 'VOL.03',
        name: 'DSH 插件开发',
        chapters: [{ slug: 'ch-01', title: '定时任务与巡检', entries: [skeleton, skeleton2, real, realMentionsTurns] }],
      },
    ],
  },
}

check('骨架条目被判定为骨架', () => {
  assert(isSkeletonEntry(skeleton), '骨架未被识别')
  assert(isSkeletonEntry(skeleton2), '第二种骨架未被识别')
})
check('真实结论不被误判为骨架', () => {
  assert(!isSkeletonEntry(real), '真实结论被误判')
  assert(!isSkeletonEntry(realMentionsTurns), '提到「轮」的真实结论被误判')
})
check('真结论与骨架同时命中时，真结论排第一', () => {
  const hits = matchEntries(snapshot, '微信直发 代理 AI 应用岗位调研报告', 8)
  assert(hits.length >= 2, '应有至少两条命中，实际 ' + hits.length)
  assert(hits[0].id === 'e-real-0001', 'top1 应为真结论，实际 ' + hits[0].id + '（skeleton=' + hits[0].skeleton + '）')
  const skel = hits.find((h) => h.id === 'e-skel-0001')
  assert(skel && skel.skeleton === true, '骨架应仍在结果中并带 skeleton 标记')
  assert(hits.indexOf(skel) > 0, '骨架应排在真结论之后')
})
check('骨架仍可被标题召回（短查询不被废掉）', () => {
  const hits = matchEntries(snapshot, '模型测试', 8)
  assert(hits.length === 1 && hits[0].id === 'e-skel-0002', '短查询应召回骨架，实际：' + JSON.stringify(hits.map((h) => h.id)))
  assert(hits[0].skeleton === true, '应带 skeleton 标记')
})
check('命中项带 id，可用 manual_trace 溯源', () => {
  const hits = matchEntries(snapshot, '微信直发 代理', 3)
  assert(hits.length > 0, '应有命中')
  assert(typeof hits[0].id === 'string' && hits[0].id.startsWith('e-'), '命中项缺 id：' + JSON.stringify(hits[0]))
})

console.log('\n' + '='.repeat(60))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail > 0) {
  for (const f of failures) console.log('  ' + f)
  process.exit(1)
}
