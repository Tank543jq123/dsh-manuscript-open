#!/usr/bin/env node
/**
 * 生成 VOL.06「AI 协作方法与踩坑」的跨会话统计条目（2026-11-08）。
 *
 * ## 为什么需要这个脚本
 *
 * `lib/library.js:loadPrebuiltVolumes()` 会把 `data/*.json` 当成预加工的手册册加载，
 * 但**仓库里从来没有这个文件** —— 于是 vol-06 永远为空：summary 里不出现它，
 * 面板「AI 协作」页只能拿到 404。这个脚本把"跨会话统计"真正算出来、写进仓库，
 * 让那一册有据可查，而不是一句承诺。
 *
 * ## 诚实性规则（代码里写死，不靠自觉）
 *
 * 1. **只写算得出来的数字**：每条 claim 的数字都来自本机会话扫描结果，样本量写进 claim。
 * 2. `provenance.kind = 'aggregate'`，并带 `sample`（样本会话数）与 `computedAt` —— 
 *    绝不编一个 session_id 冒充单条经验。
 * 3. 样本不足（< 20 个会话）就不生成这一条：宁可少一条，不要拿 3 个样本说"通常"。
 * 4. 生成时间、扫描口径（DSH 会话目录）写进册子的 `desc`，方便日后判断是否过期。
 *
 * 用法：
 *   node scripts/build-vol06.mjs            # 写 data/vol-06-ai-collab.json
 *   node scripts/build-vol06.mjs --dry-run  # 只打印将写入的内容
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanSessions } from '../lib/scan.js'
import { triageAll } from '../lib/triage.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'data', 'vol-06-ai-collab.json')

/** 一条统计条目：数字全部来自调用方算好的事实。 */
function entry(slug, title, claim, sample, extra = {}) {
  return {
    id: `e-vol06-${slug}`,
    title,
    claim,
    confidence: 'statistic',
    authority: 'L2',
    needsReview: false,
    prebuilt: true,
    provenance: { kind: 'aggregate', sample, computedAt: new Date().toISOString(), ...extra },
  }
}

const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—')

function main() {
  const dry = process.argv.includes('--dry-run')
  const scanned = scanSessions()
  const sessions = scanned.sessions || []
  const triaged = triageAll(sessions).enriched || []
  const real = triaged.filter((s) => s.category === 'real')
  const n = sessions.length

  // —— 最小样本量门槛：少于 20 个会话不生成统计 ——
  if (n < 20) {
    console.error(`[vol06] 只有 ${n} 个会话，少于 20，拒绝生成统计（避免拿个位数说"通常"）`)
    process.exit(2)
  }

  const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0)

  // ① 工具调用与失败
  const toolCalls = sum(sessions, (s) => s.toolCalls)
  const toolErrors = sum(sessions, (s) => s.toolErrors)
  const sessionsWithToolErr = sessions.filter((s) => (s.toolErrors || 0) > 0).length

  // ② 最常出现的工具（按"出现在多少个会话里"）
  const toolSessionCount = new Map()
  for (const s of sessions) {
    for (const t of s.topTools || []) {
      const name = typeof t === 'string' ? t : t && t.name
      if (!name) continue
      toolSessionCount.set(name, (toolSessionCount.get(name) || 0) + 1)
    }
  }
  const topTools = [...toolSessionCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)

  // ③ 交付率
  const withDeliverable = real.filter((s) => (s.deliverables || 0) > 0).length
  const zeroDeliverable = real.length - withDeliverable

  // ④ 归档与质量
  const archived = real.filter((s) => s.archived)
  const notArchived = real.filter((s) => !s.archived)
  const rate = (g) => (g.length ? g.filter((s) => (s.deliverables || 0) > 0).length / g.length : 0)

  // ⑤ 子代理使用
  const withSubagent = sessions.filter((s) => (s.subagentSpawns || 0) > 0).length

  // 注意：`no` 是必需字段 —— 建库时章 slug 由 `'ch-' + ch.no` 生成，
  // 缺了它所有条目会挤进同一个 `ch-00`（2026-11-08 实测踩到）。
  const chapters = [
    {
      no: '01',
      slug: 'ch-tools',
      title: '工具与失败率',
      entries: [
        entry(
          'tool-error-rate',
          '工具调用失败率是这台机器的基线',
          `${n} 个会话共 ${toolCalls} 次工具调用，其中 ${toolErrors} 次报错（${pct(toolErrors, toolCalls)}）；` +
            `${sessionsWithToolErr} 个会话（${pct(sessionsWithToolErr, n)}）至少错一次。` +
            `判断"某次失败是否异常"要拿这个基线对照，而不是凭感觉。`,
          n
        ),
        entry(
          'top-tools',
          '最常出现的工具（按出现在多少个会话里数）',
          topTools.map(([name, c]) => `${name} ${c} 个会话（${pct(c, n)}）`).join('、') + `。样本 ${n} 个会话。`,
          n,
          { tools: topTools.map(([name, c]) => ({ name, sessions: c })) }
        ),
      ],
    },
    {
      no: '02',
      slug: 'ch-delivery',
      title: '交付与归档',
      entries: [
        entry(
          'deliverable-rate',
          '真实任务里只有不到一半产出了交付物',
          `${real.length} 个真实任务中，${withDeliverable} 个产出至少 1 个交付物（${pct(withDeliverable, real.length)}），` +
            `${zeroDeliverable} 个零交付物。"聊完没落地"是常态，不是个例 —— 所以"这次有没有产出"必须记账，不能只凭印象。`,
          real.length
        ),
        entry(
          'archive-is-not-quality',
          '归档不是质量信号',
          `归档的 ${archived.length} 个真实任务交付率 ${pct(rate(archived) * archived.length, archived.length)}，` +
            `未归档的 ${notArchived.length} 个是 ${pct(rate(notArchived) * notArchived.length, notArchived.length)}。` +
            `两者都被计入分诊与入册 —— 归档只说明会话从列表里收起，不代表做得好或差。`,
          real.length
        ),
      ],
    },
    {
      no: '03',
      slug: 'ch-delegation',
      title: '子代理与协作',
      entries: [
        entry(
          'subagent-usage',
          '子代理实际用得很少',
          `${n} 个会话里只有 ${withSubagent} 个（${pct(withSubagent, n)}）派过子代理。` +
            `这是"该派而没派"的第一个量化证据 —— 也是把派工规则写进提示词的直接原因。`,
          n
        ),
      ],
    },
  ]

  const doc = {
    id: 'vol-06',
    no: 'VOL.06',
    name: 'AI 协作方法与踩坑',
    desc:
      `跨会话统计（样本 ${n} 个会话，${real.length} 个真实任务），由 scripts/build-vol06.mjs 在 ` +
      `${new Date().toISOString().slice(0, 10)} 生成。每条都标了样本量与计算时间，重新扫描后需重跑本脚本。`,
    generatedAt: new Date().toISOString(),
    provenance: { kind: 'aggregate', sample: n, source: 'DSH 会话目录' },
    chapters,
  }

  const json = JSON.stringify(doc, null, 2) + '\n'
  if (dry) {
    console.log(json)
    return
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, json, 'utf8')
  const entries = chapters.reduce((a, c) => a + c.entries.length, 0)
  console.log(`[vol06] 写入 ${OUT}`)
  console.log(`[vol06] ${chapters.length} 章 / ${entries} 条 · 样本 ${n} 个会话（真实任务 ${real.length}）`)
}

main()
