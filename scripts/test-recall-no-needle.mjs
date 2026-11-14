#!/usr/bin/env node
/**
 * 无针语料（no-needle corpus）—— 2026-11-14 新增，进 CI。
 *
 * 事故背景：CHANGELOG v1.1.1 记过「双排针」这类旧条目被骨架退役规则停用后，
 * 搜索仍会返回几条自我指涉的命中。用户看不出「库里根本没有这条」，只会觉得答非所问。
 *
 * 这份测试锁的是另一半：**当库里确实没有答案时，检索要敢于返回空**，
 * 而不是靠几个虚词 bigram 凑出 3 条似是而非的条目。语料全部是「针」不存在
 * （问的是制冷机选型，库里只有插件/巡检/招聘），命中就说明门槛失效了。
 *
 * 判据分三层：
 *   ① 完全无关的查询 → 0 条（fail-closed）
 *   ② 只共享虚词（「为什么」「怎么」）的查询 → 0 条
 *   ③ 同一语料里换个真存在的查询 → 仍能召回（确认不是把检索整体关死）
 * 第③条很重要：只测 ①② 的话，把阈值调到无穷大也能过。
 */

import { matchEntries } from '../lib/index.js'

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

function entry(id, title, claim, volume = 'vol-03', chapter = 'ch-01') {
  return { id, title, claim, volume, chapter, confidence: 'high', authority: 'verified' }
}

// 语料：只收插件开发 / 定时巡检 / 招聘采集三类，刻意不含制冷、量子、法务。
const plugin = entry(
  'e-needle-0001',
  'DSH 插件装进运行中的 profile 后无需重启',
  'HMR 会热加载插件，刷新页面即可看到侧栏入口；只有安装并不需要重启 dsh web。',
)
const cron = entry(
  'e-needle-0002',
  '定时巡检要在插件面板上可配置时间点',
  '巡检开关与时间点必须暴露到面板，写死 cron 会让用户无法停用。',
)
const hr = entry(
  'e-needle-0003',
  '招聘网站未登录时薪资字段不展示',
  '未登录状态只显示部分字段，必须先确保登录态再采集，否则统计系统性偏差。',
)
const skeletonOnly = entry(
  'e-needle-0004',
  '模型测试',
  '1 轮 · 0 次工具调用 · 0 个交付物 · （一次性模板任务）',
)

const snapshot = {
  summary: {
    volumes: [
      {
        id: 'vol-03',
        no: 'VOL.03',
        name: 'DSH 插件开发',
        chapters: [{ slug: 'ch-01', title: '插件与巡检', entries: [plugin, cron, hr, skeletonOnly] }],
      },
    ],
  },
}

const ids = (hits) => hits.map((h) => h.id).join(',')

check('完全无关的查询返回 0 条（fail-closed）', () => {
  const hits = matchEntries(snapshot, '量子退火稀释制冷机选型与低温接线', 8)
  assert(hits.length === 0, '应返回空，实际命中：' + ids(hits))
})

check('中文长查询只共享虚词时返回 0 条', () => {
  const hits = matchEntries(snapshot, '为什么我们的法务合同审批一直卡住', 8)
  assert(hits.length === 0, '应返回空，实际命中：' + ids(hits))
})

check('英文/数字 token 也不该凭空命中', () => {
  const hits = matchEntries(snapshot, 'zirconium 4090 benchmark throughput', 8)
  assert(hits.length === 0, '应返回空，实际命中：' + ids(hits))
})

check('同一语料里真存在的查询仍能召回（证明不是把检索关死）', () => {
  const hits = matchEntries(snapshot, '插件 HMR 热加载 需要重启吗', 8)
  assert(hits.length > 0, '应能召回插件条目，实际 0 条')
  assert(hits.some((h) => h.id === 'e-needle-0001'), '应召回 e-needle-0001，实际：' + ids(hits))
})

check('薪资字段那条能按标题召回', () => {
  const hits = matchEntries(snapshot, '招聘网站 薪资 字段', 8)
  assert(hits.some((h) => h.id === 'e-needle-0003'), '应召回 e-needle-0003，实际：' + ids(hits))
})

check('空查询与非字符串输入不抛错、返回空', () => {
  assert(matchEntries(snapshot, '', 8).length === 0, '空串应返回空')
  assert(matchEntries(snapshot, '   ', 8).length === 0, '空白应返回空')
  assert(matchEntries(snapshot, undefined, 8).length === 0, 'undefined 应返回空')
})

console.log('\n' + '='.repeat(60))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail > 0) {
  for (const f of failures) console.log('  ' + f)
  process.exit(1)
}
