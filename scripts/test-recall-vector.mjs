#!/usr/bin/env node
/**
 * 向量召回回归 —— 2026-11-12。
 *
 * ## 为什么这个脚本必须存在
 *
 * 仓库里已经有一份 `test-recall-semantic.mjs`，锁的是**词频语义路**
 * （字符 2-gram TF-IDF，要求 ≥2 个 bigram 重合）。词频路的硬边界是
 * 「字面必须有重合」：用户把「插件装完要重启吗」改写成
 * 「换了扩展就要重开吗」，两路关键词/词频一起归零。
 * 本脚本锁的是**向量路**：字面零重合时靠余弦把条目接回来，
 * 同时不许它变成假召回的后门。
 *
 * ## 三组事实，缺一不可
 *
 *   ① 同义改写：关键词/词频都 0 命中时，向量路能补回真条目；
 *   ② fail-closed：域外查询余弦不够就 0 条（不能因为"多了语义"就硬编）；
 *   ③ 可降级：provider 缺失/索引没建好/嵌入抛错时，检索结果与改动前一致，
 *      且 `searchEntries` 绝不抛错。
 *
 * ## 为什么用假 provider
 *
 * 真实 bge 权重不一定每台机器都有（它是 26MB 的本地模型，不随插件分发）。
 * 用确定性假 provider 才能让「融合/降级/增量」这些**逻辑契约**在任何机器上
 * 可复现。真实权重上的标定数字（余弦分布、延迟、体积）写在交付报告里，
 * 不进断言；需要真模型时设 `DSH_MANUSCRIPT_TEST_EMBED=1` 跑最后一组。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  matchEntries,
  searchEntries,
  isRecallPolluted,
  isSkeletonEntry,
} from '../lib/index.js'
import {
  createVectorStore,
  fuseRanked,
  loadVectorIndex,
  searchVectorIndex,
  vectorEntryHash,
  RRF_WEIGHTS,
  VECTOR_INDEX_FILE,
} from '../lib/vectors.js'

let pass = 0
let fail = 0
const failures = []
async function check(name, fn) {
  try {
    const detail = await fn()
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
    confidence: 'high',
    authority: 'L2',
    ...extra,
  }
}

// ── 夹具：复刻真实分布（含骨架、含一条无关硬件条目）──────────────────
const pluginEntry = entry(
  'e-plugin-1',
  'DSH 插件安装后会被热挂载，不用重启就已生效',
  '装入运行中的 profile 后，插件由宿主热加载；显式重启只是心理安慰。',
)
const lockEntry = entry(
  'e-lock-1',
  '多人同时建库会抢锁，第二个进程直接跳过',
  '建库有文件锁，两个进程同时扫描时后者拿到 EBUILDLOCKED，不报错只跳过。',
)
const pinEntry = entry(
  'e-pin-1',
  '嘉立创2.0双排针选型',
  '2.0mm 双排针 2x10P 的立创商城料号与封装。',
)
const skeletonEntry = entry('e-skel-1', '模型评测', '1 轮 · 0 次工具调用 · 0 个交付物 · （一次性模板任务）', {
  confidence: 'speculation',
  authority: 'L3',
})

function makeSnapshot(entries) {
  return {
    summary: {
      volumes: [
        {
          id: 'vol-03',
          no: 'VOL.03',
          name: 'DSH 插件开发',
          chapters: [{ slug: 'ch-01', title: '夹具', entries }],
        },
      ],
    },
  }
}

// ── 确定性假 provider：按"概念"而非字面产生向量 ──────────────────────
// 真实 embedding 的同义能力来自训练；夹具只需要证明**接口与融合逻辑**：
// 「扩展/重开」与「插件/热挂载/重启」映射到同一维，字面没有共同 bigram。
const CONCEPTS = [
  ['插件', '扩展', '热挂载', '热加载', '重开', '重启', '安装'],
  ['锁', '并发', '同时', '抢', '冲突'],
  ['排针', '立创', '封装', '选型'],
  ['天气', '诗', '股票', '笑话', '红烧肉'],
  ['检索', '召回', '查', '搜'],
]
function fakeVector(text) {
  const v = new Float32Array(CONCEPTS.length)
  const s = String(text || '')
  CONCEPTS.forEach((words, i) => {
    for (const w of words) if (s.includes(w)) v[i] += 1
  })
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n)
  if (n === 0) return v // 与任何概念都正交 → 余弦 0 → 必须被阈值挡住
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

function makeFakeProvider(opts = {}) {
  const calls = []
  let failNext = false
  return {
    id: 'fake',
    kind: 'fake',
    model: opts.model || 'fake-embed',
    dim: CONCEPTS.length,
    fingerprint: opts.fingerprint || 'fake-fp-1',
    minCos: opts.minCos || 0.62,
    maxBatch: 8,
    calls,
    setFail(v) {
      failNext = v
    },
    async embed(texts) {
      calls.push([...texts])
      if (failNext) throw new Error('模拟嵌入失败')
      return texts.map((t) => fakeVector(t))
    },
    embedSync(texts) {
      calls.push([...texts])
      if (failNext) throw new Error('模拟嵌入失败')
      return texts.map((t) => fakeVector(t))
    },
  }
}

/** 统一给 store 注入插件的真实过滤器 —— 夹具与生产必须同一口径。 */
function newStore(opts = {}) {
  return createVectorStore({
    filterEntry: isRecallPolluted,
    isSkeleton: isSkeletonEntry,
    ...opts,
  })
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-manuscript-vector-'))
const cleanup = () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}
process.on('exit', cleanup)

// ── ① 索引构建 / 持久化 ───────────────────────────────────────────────
await check('建索引：全部条目都嵌入，并落盘 vectors.json', async () => {
  const snapshot = makeSnapshot([pluginEntry, lockEntry, pinEntry, skeletonEntry])
  const fake = makeFakeProvider()
  const store = newStore({ root: dir, provider: fake })
  await store.ensure(snapshot)
  const st = store.stats(snapshot)
  assert(st.indexed === 4, `索引应有 4 条，实际 ${st.indexed}`)
  assert(st.fresh === true, 'indexed 与当前语料应一致')
  assert(existsSync(join(dir, VECTOR_INDEX_FILE)), 'vectors.json 未生成')
  const bytes = statSync(join(dir, VECTOR_INDEX_FILE)).size
  assert(bytes > 0, 'vectors.json 为空')
  const loaded = loadVectorIndex(dir)
  assert(loaded && loaded.entries.size === 4, '重新加载索引条数不符')
  assert(loaded.provider.fingerprint === fake.fingerprint, 'provider 指纹未落盘')
  return `${bytes} B`
})

await check('索引记录的是内容 hash，可回查', async () => {
  const snapshot = makeSnapshot([pluginEntry])
  const fake = makeFakeProvider()
  const store = newStore({ root: dir, provider: fake })
  await store.ensure(snapshot)
  const idx = loadVectorIndex(dir)
  const rec = idx.entries.get(pluginEntry.id)
  assert(rec, '插件条目不在索引里')
  assert(rec.h === vectorEntryHash(pluginEntry), 'hash 与条目内容不对应')
})

// ── ② 增量：没变的条目复用，不重复嵌入 ───────────────────────────────
await check('增量构建：语料不变时一次嵌入都不发', async () => {
  const snapshot = makeSnapshot([pluginEntry, lockEntry, pinEntry, skeletonEntry])
  const fake = makeFakeProvider()
  const store = newStore({ root: dir, provider: fake })
  await store.ensure(snapshot)
  const before = fake.calls.length
  await store.ensure(snapshot)
  assert(fake.calls.length === before, `不应再嵌入，实际多发了 ${fake.calls.length - before} 次`)
})

await check('增量构建：只重嵌改动过的条目', async () => {
  const snapshot = makeSnapshot([pluginEntry, lockEntry, pinEntry, skeletonEntry])
  const fake = makeFakeProvider()
  const store = newStore({ root: dir, provider: fake })
  await store.ensure(snapshot)
  const changed = { ...lockEntry, claim: lockEntry.claim + '（补充：锁是 per-root 的）' }
  const snap2 = makeSnapshot([pluginEntry, changed, pinEntry, skeletonEntry])
  const before = fake.calls.length
  await store.ensure(snap2)
  const added = fake.calls.slice(before)
  const texts = added.flat()
  assert(texts.length === 1, `应只重嵌 1 条，实际 ${texts.length}`)
  assert(texts[0].includes('补充'), '重嵌的不是改动条目')
  const idx = loadVectorIndex(dir)
  assert(idx.entries.get(lockEntry.id).h === vectorEntryHash(changed), '索引 hash 未更新')
})

await check('provider 换指纹（换模型）时整份重建', async () => {
  const snapshot = makeSnapshot([pluginEntry, lockEntry])
  const store1 = newStore({ root: dir, provider: makeFakeProvider({ fingerprint: 'fp-A' }) })
  await store1.ensure(snapshot)
  const fake2 = makeFakeProvider({ fingerprint: 'fp-B' })
  const store2 = newStore({ root: dir, provider: fake2 })
  await store2.ensure(snapshot)
  assert(fake2.calls.flat().length === 2, `换模型应全量重嵌 2 条，实际 ${fake2.calls.flat().length}`)
  assert(loadVectorIndex(dir).provider.fingerprint === 'fp-B', '指纹未更新')
})

// ── ③ 同义改写：关键词/词频 0 命中，向量路补回来 ─────────────────────
await check('同义改写：字面零重合时向量路命中（且标注 semantic/vector）', async () => {
  const snapshot = makeSnapshot([pluginEntry, lockEntry, pinEntry, skeletonEntry])
  const fake = makeFakeProvider()
  const store = newStore({ root: dir, provider: fake })
  await store.ensure(snapshot)
  const query = '换了扩展就要重开吗'
  // 前提：关键词路确实 0 命中（否则这条断言证明不了向量路的贡献）
  const kw = matchEntries(snapshot, query, 8)
  assert(kw.length === 0, '夹具前提不成立：关键词路不该命中，实际 ' + JSON.stringify(kw.map((h) => h.id)))
  const hits = searchEntries(snapshot, query, 5, { vectorStore: store })
  const hit = hits.find((h) => h.id === pluginEntry.id)
  assert(hit, '向量路未召回插件条目，实际：' + JSON.stringify(hits.map((h) => h.id)))
  assert(hit.match === 'semantic' && hit.semanticKind === 'vector', '来源标注不对：' + JSON.stringify({ match: hit.match, kind: hit.semanticKind }))
  assert(hit.score > 0.9, '余弦应接近 1，实际 ' + hit.score)
})

await check('同义改写：锁/并发条目同样能被改写命中', async () => {
  const snapshot = makeSnapshot([pluginEntry, lockEntry, pinEntry, skeletonEntry])
  const fake = makeFakeProvider()
  const store = newStore({ root: dir, provider: fake })
  await store.ensure(snapshot)
  const query = '两个人同时写会冲突吗'
  const hits = searchEntries(snapshot, query, 5, { vectorStore: store })
  assert(hits.some((h) => h.id === lockEntry.id), '应命中锁条目，实际：' + JSON.stringify(hits.map((h) => h.id)))
})

// ── ④ fail-closed：无关查询仍然 0 命中 ───────────────────────────────
await check('fail-closed：域外查询余弦不够 → 0 命中', async () => {
  const snapshot = makeSnapshot([pluginEntry, lockEntry, pinEntry, skeletonEntry])
  const fake = makeFakeProvider()
  const store = newStore({ root: dir, provider: fake })
  await store.ensure(snapshot)
  const query = '今天上海天气怎么样'
  const vec = store.searchSync(snapshot, query, 8)
  assert(vec.length === 0, '向量路不该命中，实际：' + JSON.stringify(vec.map((h) => h.id)))
  const hits = searchEntries(snapshot, query, 8, { vectorStore: store })
  assert(hits.length === 0, 'searchEntries 不该命中，实际：' + JSON.stringify(hits.map((h) => h.id)))
})

await check('fail-closed：带英文/数字的查询不走向量路（确定性由关键词路承担）', async () => {
  const snapshot = makeSnapshot([pluginEntry, lockEntry, pinEntry, skeletonEntry])
  const fake = makeFakeProvider()
  const store = newStore({ root: dir, provider: fake })
  await store.ensure(snapshot)
  const before = fake.calls.length
  const hits = searchEntries(snapshot, 'Docker exit code 137 内存不足', 8, { vectorStore: store })
  assert(hits.length === 0, '应 0 命中，实际：' + JSON.stringify(hits.map((h) => h.id)))
  // 查询闸门在调用 provider 之前就返回，不能白白 spawn 一次嵌入
  assert(fake.calls.length === before, '带英文的查询不该触发嵌入调用')
})

// ── ⑤ 可降级：无 provider / 索引缺失 / 嵌入抛错 ──────────────────────
await check('降级：provider 为 null 时退回关键词结果，且与 matchEntries 一致', () => {
  const snapshot = makeSnapshot([pluginEntry, lockEntry, pinEntry])
  const store = newStore({ root: dir, provider: null })
  const q = '插件'
  const kw = matchEntries(snapshot, q, 8)
  const hits = searchEntries(snapshot, q, 8, { vectorStore: store })
  assert(hits.length === kw.length, `条数不一致：${hits.length} != ${kw.length}`)
  assert(JSON.stringify(hits.map((h) => h.id)) === JSON.stringify(kw.map((h) => h.id)), 'id 顺序不一致')
  assert(hits.every((h) => h.match === 'keyword'), '降级后不应有 semantic 标注')
})

await check('降级：索引没建好时 searchSync 返回 [] 而不是抛错', () => {
  const snapshot = makeSnapshot([pluginEntry])
  const store = newStore({ root: join(dir, 'no-such-index'), provider: makeFakeProvider() })
  const hits = store.searchSync(snapshot, '换了扩展就要重开吗', 5)
  assert(Array.isArray(hits) && hits.length === 0, '应返回空数组')
})

await check('降级：嵌入抛错时 ensure 不抛，检索继续走关键词', async () => {
  const snapshot = makeSnapshot([pluginEntry, lockEntry])
  const fake = makeFakeProvider()
  fake.setFail(true)
  const store = newStore({ root: join(dir, 'fail-index'), provider: fake })
  let threw = false
  await store.ensure(snapshot).catch(() => {
    threw = true
  })
  assert(!threw, 'ensure 不该把异常抛给调用方')
  assert(store.lastError, '应记录失败原因，不能静默')
  const hits = searchEntries(snapshot, '插件', 5, { vectorStore: store })
  assert(hits.length > 0 && hits.every((h) => h.match === 'keyword'), '应继续走关键词路')
})

await check('降级：searchSync 内部异常被吞掉（坏 snapshot 也不炸）', () => {
  const store = createVectorStore({ root: dir, provider: makeFakeProvider() })
  let threw = false
  try {
    const hits = store.searchSync({ summary: { volumes: [{ chapters: [{ entries: [{ id: 1 }] }] }] } }, '查询', 3)
    assert(Array.isArray(hits), '应返回数组')
  } catch {
    threw = true
  }
  assert(!threw, 'searchSync 不应抛错')
})

// ── ⑥ RRF 融合与骨架排序 ─────────────────────────────────────────────
await check('RRF：关键词命中永远排在纯语义项之前', () => {
  const kw = [1, 2, 3, 4, 5].map((n) => ({ id: 'k' + n, score: 9 - n, match: 'keyword' }))
  const vec = [1, 2].map((n) => ({ id: 'v' + n, score: 0.99 - n / 100, match: 'semantic', semanticKind: 'vector' }))
  const fused = fuseRanked(
    [
      { name: 'keyword', weight: RRF_WEIGHTS.keyword, hits: kw },
      { name: 'vector', weight: RRF_WEIGHTS.vector, hits: vec },
    ],
    { topK: 7 },
  )
  assert(fused.length === 7, `应融合 7 条，实际 ${fused.length}`)
  assert(fused[0].id === 'k1' && fused[4].id === 'k5', '关键词顺序应保持在最前')
  assert(fused[5].id === 'v1', '纯语义项应排在关键词之后')
})

await check('RRF：同一 id 在两路出现只有一条，得分累加、来源记全', () => {
  const kw = [{ id: 'a', score: 2, match: 'keyword' }, { id: 'b', score: 2, match: 'keyword' }]
  const vec = [{ id: 'b', score: 0.9, match: 'semantic', semanticKind: 'vector' }]
  const fused = fuseRanked(
    [
      { name: 'keyword', weight: 1, hits: kw },
      { name: 'vector', weight: 0.5, hits: vec },
    ],
    { topK: 5 },
  )
  assert(fused.length === 2, `应去重成 2 条，实际 ${fused.length}`)
  const b = fused.find((h) => h.id === 'b')
  assert(b.sources.includes('keyword') && b.sources.includes('vector'), '来源未合并：' + JSON.stringify(b.sources))
  assert(b.match === 'keyword', '两路都有时应保留关键词身份')
})

await check('骨架：向量召回命中的骨架条目排在真结论之后', async () => {
  const skel = entry('e-skel-2', '扩展插件的评测', '1 轮 · 0 次工具调用 · 0 个交付物', {
    confidence: 'speculation',
    authority: 'L3',
  })
  const snapshot = makeSnapshot([skel, pluginEntry])
  const fake = makeFakeProvider()
  const store = newStore({ root: join(dir, 'skel-index'), provider: fake })
  await store.ensure(snapshot)
  const hits = searchEntries(snapshot, '换了扩展就要重开吗', 5, { vectorStore: store })
  assert(hits.length >= 2, '应至少命中两条，实际 ' + hits.length)
  assert(!hits[0].skeleton, '骨架不该排第一')
  assert(hits[hits.length - 1].skeleton === true, '骨架应排在最后并带标记')
})

// ── ⑦ 逐条 hash 校验：索引陈旧时不拿旧向量冒充新文本 ─────────────────
await check('索引陈旧：文本改过的条目被跳过，其余照常命中', async () => {
  const fake = makeFakeProvider()
  const store = newStore({ root: join(dir, 'stale-index'), provider: fake })
  await store.ensure(makeSnapshot([pluginEntry]))
  const idx = loadVectorIndex(join(dir, 'stale-index'))
  const changed = { ...pluginEntry, claim: '完全换了一段正文' }
  const hits = searchVectorIndex(makeSnapshot([changed]), idx, fakeVector('插件 热挂载'), { minCos: 0.5 })
  assert(hits.length === 0, 'hash 不匹配的条目应被跳过，实际命中 ' + hits.length)
})

await check('阈值：minCos 可被显式调高，挡住边缘候选', async () => {
  const snapshot = makeSnapshot([pluginEntry])
  const fake = makeFakeProvider()
  const store = newStore({ root: join(dir, 'th-index'), provider: fake })
  await store.ensure(snapshot)
  // 构造一个与插件概念部分重合的查询：余弦 0.5（过默认阈值则命中）
  const q = '检索 扩展'
  const low = store.searchSync(snapshot, q, 3, { minCos: 0.4 })
  const high = store.searchSync(snapshot, q, 3, { minCos: 0.9 })
  assert(low.length === 1, '低阈值应命中，实际 ' + low.length)
  assert(high.length === 0, '高阈值应挡住，实际 ' + high.length)
})

// ── ⑧ 可选：真模型端到端（默认跳过，保持测试离线可跑）──────────────────
const realModel = process.env.DSH_MANUSCRIPT_EMBED_MODEL
if (process.env.DSH_MANUSCRIPT_TEST_EMBED === '1' && realModel && existsSync(realModel)) {
  // 用真实 bge-small-zh 实测过的改写对：查询与条目字面零重合，
  // 余弦 0.718（2026-11-12 实测），高于 fail-closed 阈值 0.62。
  // 注意：这不是"所有改写都能命中"的承诺 —— 见交付报告的标定段，
  // 「换了扩展就要重开吗」只有 0.572，会被阈值挡住。
  await check('真模型：同义改写端到端命中（扩展→插件）', async () => {
    const realEntry = entry('e-real-plugin', '建议安装插件', '插件市场里选好后按 README 装，装入 profile 即可。')
    const snapshot = makeSnapshot([realEntry, pinEntry])
    const store = newStore({
      root: join(dir, 'real-index'),
      env: { ...process.env, DSH_MANUSCRIPT_EMBED_MODEL: realModel },
    })
    await store.ensure(snapshot)
    assert(store.stats(snapshot).indexed === 2, '真模型索引未建好')
    const hits = searchEntries(snapshot, '遇到建议装扩展该怎么处理', 5, { vectorStore: store })
    assert(hits.some((h) => h.id === realEntry.id), '真模型应命中插件条目，实际：' + JSON.stringify(hits.map((h) => h.id)))
    return `${Math.round(store.stats(snapshot).buildMs)}ms`
  })
} else {
  console.log('⚠ 跳过 真模型端到端（DSH_MANUSCRIPT_TEST_EMBED≠1 或无本地权重）')
}

console.log('\n' + '='.repeat(60))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail > 0) {
  for (const f of failures) console.log('  ' + f)
  process.exit(1)
}
