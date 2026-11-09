#!/usr/bin/env node
/**
 * test-distill.mjs —— 验证 T1 提炼轨的纯函数与编排逻辑。
 *
 * 测试分三层，层层递进：
 *   ① 纯函数：`parseProposals` / `renderSessionDigest` / `looksDeclarative`
 *      —— 不需要 LLM，可完全脱机验证，是回归的主力。
 *   ② 编排：用 **mock LLM**（不真调用）验证 distillBatch / distillSessions
 *      的批次切分、失败隔离、超时收敛。
 *   ③ 真实样本：从 ~/.dsh/sessions 读真实会话，验证压缩体积与信息保真。
 *      这一层不 mock —— 因为压缩是纯本地计算，用真实数据才有意义。
 *
 * 关于「不许编造」的测试是重点：光靠 prompt 约束不住 LLM，
 * 必须有一道机械校验兜底。这里用真实会踩的编造形态造样本。
 */

import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')
const mod = (f) => pathToFileURL(join(LIB, f)).href

const D = await import(mod('distill.js'))
const scan = await import(mod('scan.js'))
const triage = await import(mod('triage.js'))

const {
  parseProposals, renderSessionDigest, looksDeclarative,
  distillBatch, distillSessions, chunkBatch, buildUserMessage,
  SYSTEM_PROMPT, CONFIDENCE_LEVELS, DISTILL_DEFAULTS,
} = D

// ───────────────────────── 测试框架 ─────────────────────────
let pass = 0
let fail = 0
const failures = []
const cleanups = []

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function check(name, fn) {
  const t0 = Date.now()
  try {
    const detail = await fn()
    pass++
    console.log(`✓ ${name}`)
    if (detail) console.log(`    ${detail}  ${Date.now() - t0}ms`)
  } catch (e) {
    fail++
    failures.push({ name, error: e })
    console.log(`✗ ${name}`)
    console.log(`    ${e.message}`)
  }
}

function tmpRoot(tag) {
  const d = mkdtempSync(join(tmpdir(), `distill-${tag}-`))
  cleanups.push(d)
  return d
}

/** 造一个合法的 LLM 输出。 */
function okJson(entries) {
  return JSON.stringify({ entries })
}

const GOOD_ENTRY = {
  title: '同一文件被切分成多个小步编辑时锚点会失效',
  claim: '当一个大文件被拆成几十次 edit 逐个修改时，只要中间任何一步改动了后续锚点附近的文本，下一次 edit 就会报 old_string not found，必须重新读取文件才能继续。',
  why: 'edit 用「精确匹配一段原文」来定位，而这段原文来自上一次读取的快照；文件一变，快照就过期了。',
  confidence: 'high',
  tags: ['edit', '并发'],
}

// ═══════════════════════════════════════════════════════════
// 1. looksDeclarative —— 陈述句判定
// ═══════════════════════════════════════════════════════════
console.log('\n── 1. 陈述句判定（looksDeclarative）──')

await check('接受真实陈述句', () => {
  const ok = [
    'I2C 从机 ISR 里调阻塞日志会死锁',
    '同一文件被切分成多个小步编辑时锚点会失效',
    'Windows 上 rename 遇到被打开的文件会返回 EPERM',
    'subagent depth 超过 maxDepth 时派活会直接报错',
  ]
  for (const t of ok) {
    const r = looksDeclarative(t)
    assert(r.ok, `应接受但被拒: "${t}" → ${r.reason}`)
  }
  return `${ok.length} 条陈述句全部通过`
})

// 【2026-11-08 新增】旧白名单只收了"是/有/用/改/换/跑/写/读…"，
// 漏掉大量真动词，导致合格结论被当名词堆丢掉（实测「KiCad 封装库迁移
// 先冻结符号版本」整条提案被丢弃）。这批用例钉住"真句子要放行"。
await check('接受带动作动词/先后关系的陈述句（2026-11-08 扩充）', () => {
  const ok = [
    'KiCad 封装库迁移先冻结符号版本',
    '安装 dsh 插件后槽位不显示',
    '本地模型量化对比要先比精度',
    '升级宿主前先备份 library.json',
    '封装库重建之前要清缓存',
  ]
  for (const t of ok) {
    const r = looksDeclarative(t)
    assert(r.ok, `应接受但被拒: "${t}" → ${r.reason}`)
  }
  return `${ok.length} 条动作句全部通过`
})

// 放宽谓词后必须仍然挡住"标签堆"：多段空格分隔、没有虚词也没有结构词。
await check('仍然拒绝标签堆（多段空格、无虚词）', () => {
  const bad = ['封装 符号库 版本 缓存', 'ESP32 电源 纹波 测试 数据', '模型 部署 vllm 显存 不足']
  for (const t of bad) {
    const r = looksDeclarative(t)
    assert(!r.ok, `应拒绝但被放行: "${t}"`)
  }
  return `${bad.length} 条标签堆全部被拒`
})

await check('拒绝名词堆（关于/浅谈/总结 开头）', () => {
  const bad = [
    '关于 I2C 的问题',
    '浅谈并发写入',
    '总结一下这次会话',
    '关于 Windows 权限的思考',
  ]
  for (const t of bad) {
    const r = looksDeclarative(t)
    assert(!r.ok, `应拒绝但被接受: "${t}"`)
  }
  return `${bad.length} 条名词堆全部拒绝`
})

await check('拒绝过短/过长标题', () => {
  assert(!looksDeclarative('I2C 问题').ok, '过短应拒绝')
  // 【2026-11-08 修】原来这句末尾有 `|| true`，整个条件恒真 —— 是条死断言。
  // 该字符串 8+120=128 字符，超过 60 上限，应当被拒绝。
  assert(!looksDeclarative('会'.repeat(8) + '导致'.repeat(30)).ok, '超长标题应被拒绝')
  const long = '这个结论会导致' + '很长的描述'.repeat(20)
  assert(!looksDeclarative(long).ok, '过长应拒绝')
  return '长度边界正确'
})

// ═══════════════════════════════════════════════════════════
// 2. parseProposals —— 合法输入
// ═══════════════════════════════════════════════════════════
console.log('\n── 2. parseProposals：合法输入 ──')

await check('接受标准 JSON', () => {
  const r = parseProposals(okJson([GOOD_ENTRY]))
  assert(r.ok, `应通过：${r.reason}`)
  assert(r.proposals.length === 1, '应解析出 1 条')
  const p = r.proposals[0]
  assert(p.title === GOOD_ENTRY.title, 'title 丢了')
  assert(p.confidence === 'high', 'confidence 丢了')
  assert(Array.isArray(p.tags) && p.tags.length === 2, 'tags 丢了')
  return '1 条完整解析'
})

await check('接受 markdown 代码块围栏包裹的 JSON', () => {
  const raw = '```json\n' + okJson([GOOD_ENTRY]) + '\n```'
  const r = parseProposals(raw)
  assert(r.ok, `围栏应能剥掉：${r.reason}`)
  return '围栏已剥离'
})

await check('接受 JSON 前后有解释文字', () => {
  const raw = '好的，这是提炼结果：\n' + okJson([GOOD_ENTRY]) + '\n希望有帮助。'
  const r = parseProposals(raw)
  assert(r.ok, `应容忍前后文字：${r.reason}`)
  return '前后噪声已忽略'
})

await check('接受 entries 为空数组（明确的"无可提炼"）', () => {
  const r = parseProposals('{"entries":[]}')
  assert(r.ok, '空数组应是合法答案')
  assert(r.proposals.length === 0, '应为 0 条')
  return '空数组合法 ✓（这是重要行为：不许为了有产出而硬凑）'
})

await check('confidence 三档全部接受', () => {
  for (const c of CONFIDENCE_LEVELS) {
    const r = parseProposals(okJson([{ ...GOOD_ENTRY, confidence: c }]))
    assert(r.ok, `confidence=${c} 应接受：${r.reason}`)
  }
  return CONFIDENCE_LEVELS.join(' / ')
})

// ═══════════════════════════════════════════════════════════
// 3. parseProposals —— 非法输入
// ═══════════════════════════════════════════════════════════
console.log('\n── 3. parseProposals：结构性错误整批拒绝，单条内容问题只淘汰自己 ──')

await check('拒绝空输出', () => {
  assert(!parseProposals('').ok, '空字符串应拒绝')
  assert(!parseProposals('   ').ok, '空白应拒绝')
  assert(!parseProposals(null).ok, 'null 应拒绝')
  return '空输入被拒'
})

await check('拒绝坏 JSON（不做兜底修补）', () => {
  const cases = [
    '{"entries":[{"title":"x"',          // 括号不闭合
    '{"entries":[{"title":"x",}]}',      // 多余逗号
    '{entries:[]}',                       // 键没引号
    'not json at all',
  ]
  for (const c of cases) {
    const r = parseProposals(c)
    assert(!r.ok, `坏 JSON 应被拒: ${c.slice(0, 30)}`)
  }
  return `${cases.length} 种坏 JSON 全部拒绝（不做"尽量解析"）`
})

await check('拒绝缺字段的条目（单条淘汰，其余保留）', () => {
  const cases = [
    [{ ...GOOD_ENTRY, title: '' }],
    [{ ...GOOD_ENTRY, claim: '' }],
    [{ ...GOOD_ENTRY, confidence: 'very-high' }],
    [{ ...GOOD_ENTRY, confidence: '' }],
  ]
  for (const c of cases) {
    const r = parseProposals(okJson(c))
    // 语义变了：单条不合格 → 该条被丢弃，整批仍是 ok（产出 0 条 + dropped 1 条）
    assert(r.ok, `单条缺字段不应整批失败: ${JSON.stringify(c[0]).slice(0, 60)}`)
    assert(r.proposals.length === 0, `不合格条目不应被采纳: ${JSON.stringify(c[0]).slice(0, 60)}`)
    assert(r.dropped?.length === 1, `应记录 1 条淘汰: ${JSON.stringify(c[0]).slice(0, 60)}`)
  }
  return '4 种缺字段全部被单条淘汰，并留下原因'
})

await check('拒绝 claim 过短（不自包含）', () => {
  const r = parseProposals(okJson([{ ...GOOD_ENTRY, claim: '会死锁' }]))
  assert(r.ok, '单条过短不应拖垮整批')
  assert(r.proposals.length === 0, '过短 claim 不应被采纳')
  assert(/过短/.test(r.dropped[0].reason), `原因应说明过短，实为 ${r.dropped[0].reason}`)
  return r.dropped[0].reason
})

await // 【2026-11-02 规则调整】原来超 3 条整批拒绝。实测太粗暴：
// glm-5.3-flash 产出 4 条里有 3 条是好的，整批丢弃等于 100% 失败。
// 现在改为：略超（4-6）截断保留前 3 条；超得多（>6）才拒绝。
check('条目数 4-6 时截断保留前 3 条（不再整批丢）', () => {
  const many = Array.from({ length: 4 }, (_, i) => ({
    ...GOOD_ENTRY,
    title: `第 ${i + 1} 条会导致这个问题出现`,
  }))
  const r = parseProposals(okJson(many))
  assert(r.ok, '4 条应通过（截断）')
  assert(r.proposals.length === 3, `应保留 3 条，实为 ${r.proposals.length}`)
  assert(r.truncated === 1, `应记录截断 1 条，实为 ${r.truncated}`)
  return `保留 3 条，截断 ${r.truncated} 条`
})

check('条目数 > 6 仍然整批拒绝（模型跑偏）', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    ...GOOD_ENTRY,
    title: `第 ${i + 1} 条会导致这个问题出现`,
  }))
  const r = parseProposals(okJson(many))
  assert(!r.ok, '8 条应拒绝')
  return r.reason
})

await check('混合校验：坏条目只淘汰自己，好条目保留（2026-11-07 改）', () => {
  const mixed = [GOOD_ENTRY, { ...GOOD_ENTRY, title: '关于问题' }]
  const r = parseProposals(okJson(mixed))
  assert(r.ok, '坏一条不应再拖垮整批')
  assert(r.proposals.length === 1, `应保留 1 条，实为 ${r.proposals.length}`)
  assert(Array.isArray(r.dropped) && r.dropped.length === 1, `应记录 1 条淘汰，实为 ${r.dropped?.length}`)
  assert(/title/.test(r.dropped[0].reason), `淘汰原因应点名 title，实为 ${r.dropped[0].reason}`)
  return `保留 1 条，淘汰 1 条：${r.dropped[0].reason}`
})

await check('全部条目都不合格时返回 ok 但空数组（按空产出处理，不按失败）', () => {
  const allBad = [{ ...GOOD_ENTRY, title: '关于问题' }, { ...GOOD_ENTRY, claim: '短' }]
  const r = parseProposals(okJson(allBad))
  assert(r.ok, '全坏应当仍是 ok:true —— 它没失败，只是没有可用内容')
  assert(r.proposals.length === 0, `应产出 0 条，实为 ${r.proposals.length}`)
  assert(r.dropped.length === 2, `应记录 2 条淘汰，实为 ${r.dropped.length}`)
  return '产出 0 条 + 2 条淘汰原因，区分了「失败」与「空产出」'
})

await check('编造数字只淘汰那一条，同批其余保留（2026-11-09 改）', () => {
  // 【为什么改了】原来"一条编造 → 整批作废"。实测数据推翻了它：新模型源 23 轮里
  // 3 轮 failed，全部因为模型写了个「30」（如"约 30 秒"），而这些会话 digest 里
  // 确实没有 30 —— 拦截是对的，但 15 个会话白跑。而同一批里其余条目的数字
  // 往往完全对得上，说明编造是**局部**的，不是"整批都在撒谎"。
  const digest = '调用统计：pwsh×156'
  const mixed = [
    { ...GOOD_ENTRY, claim: '这次会话调用了 156 次 pwsh，说明任务主要靠命令行推进而非文件编辑。' },
    { ...GOOD_ENTRY, title: '另一条编了数字应被单独丢掉', claim: '这次会话里 pwsh 共被调用 777 次，远超其它工具的总和。' },
  ]
  const r = parseProposals(okJson(mixed), { digest })
  assert(r.ok, `不该整批失败：${r.reason}`)
  assert(r.proposals.length === 1, `应保留 1 条，实为 ${r.proposals.length}`)
  assert(r.proposals[0].claim.includes('156'), '保留的应是数字对得上的那条')
  assert(Array.isArray(r.dropped) && r.dropped.length === 1, `应有 1 条进 dropped，实为 ${JSON.stringify(r.dropped)}`)
  assert(/777/.test(r.dropped[0].reason), `dropped 原因应点名 777，实为 ${r.dropped[0].reason}`)
  return `保留 1 条 / 丢 1 条：${r.dropped[0].reason.slice(0, 40)}`
})

// ═══════════════════════════════════════════════════════════
// 4. 编造数字检测（这是本模块最有价值的一道闸）
// ═══════════════════════════════════════════════════════════
console.log('\n── 4. 编造数字检测（防幻觉核心）──')

await check('拒绝 digest 里不存在的数字', () => {
  const digest = '调用统计：pwsh×156, write×50\n工具报错=0次'
  const liar = {
    ...GOOD_ENTRY,
    claim: '这次会话里 pwsh 共被调用 999 次，说明命令行是绝对主力，远超其它所有工具的总和。',
  }
  const r = parseProposals(okJson([liar]), { digest })
  assert(r.ok, '单条编造不该让整批失败')
  assert(r.proposals.length === 0, '编造的那条必须被丢掉')
  assert(r.dropped.length === 1 && /999/.test(r.dropped[0].reason), `dropped 应点名 999，实为：${JSON.stringify(r.dropped)}`)
  return r.dropped[0].reason
})

await check('单条淘汰不会被后续坏条目吞掉（dropped 必须完整保留）', () => {
  // 【2026-11-09 实测缺陷】原来 `entries[N] 不是对象` 是 `return {ok:false}` ——
  // 它会把前面已经 push 进 dropped 的条目**一起丢掉**：
  //   entries[0] 编造数字 + entries[1]=null → 只回 reason，dropped 消失，
  //   "为什么这条被丢"再也看不到。现在那一类也降级成单条淘汰。
  const digest = '调用统计：pwsh×156'
  const body = JSON.stringify({
    entries: [
      { title: '这条编了数字要丢掉', claim: '这次会话里 pwsh 共被调用 777 次，远超其它工具的总和。', confidence: 'high', tags: [] },
      null,
      { title: '这条正常应保留下来', claim: '这次会话调用了 156 次 pwsh，说明任务主要靠命令行推进。', confidence: 'high', tags: [] },
    ],
  })
  const r = parseProposals(body, { digest })
  assert(r.ok, `不该整批失败：${r.reason}`)
  assert(r.proposals.length === 1, `应保留 1 条，实为 ${r.proposals.length}`)
  assert(r.proposals[0].title.includes('正常'), '保留的应是数字对得上、结构完整的那条')
  assert(r.dropped.length === 2, `应有 2 条进 dropped，实为 ${JSON.stringify(r.dropped)}`)
  assert(/777/.test(r.dropped[0].reason), '第一条原因应点名 777')
  assert(/不是对象/.test(r.dropped[1].reason), '第二条原因应说明不是对象')
  return `保留 1 / 丢 2：${r.dropped.map((d) => d.at).join(',')}`
})

await check('散文里夹着花括号时，仍能捞回后面真正的 JSON（2026-11-09 实测缺陷）', () => {
  // 真实失败样本：模型把分析写进正文，正文里恰好有花括号 ——
  //   我会提炼。注意 {不确定} 这点。然后是结果：{"entries":[]}
  // 原来取"第一个 { 到最后一个 }"，会把 {不确定} 一起算进主体，解析直接崩，
  // 后面那个真正的 JSON 完全被淹掉。
  const raw = '我会提炼。注意 {不确定} 这点。然后是结果：{"entries":[]}'
  const r = parseProposals(raw, { digest: '' })
  assert(r.ok, `应能捞回 JSON：${r.reason}`)
  assert(Array.isArray(r.proposals) && r.proposals.length === 0, '应解析出空 entries')
  return '散文花括号被跳过'
})

await check('散文里无关的 JSON 对象不会被当成结果', () => {
  // 跳过 {"type":"text"}，找到真正带 entries 的那个
  const raw = '先看 {"type":"text"} 再给结果 {"entries":[]}'
  const r = parseProposals(raw, { digest: '' })
  assert(r.ok, `应找到带 entries 的对象：${r.reason}`)
  return '只认带 entries 的对象'
})

await check('纯散文仍然判失败（不是所有输出都能救）', () => {
  // 这条重要：加宽了提取不代表"什么都能解析成功"。没有 JSON 就该失败。
  const r = parseProposals('我会从三个会话中提炼经验。会话1：HR信息收集。', { digest: '' })
  assert(!r.ok, '纯散文应判失败')
  return '纯散文 → 失败（符合预期）'
})

await check('接受 digest 里确实存在的数字', () => {
  const digest = '调用统计：pwsh×156, write×50\n工具调用=273次 · 工具报错=0次'
  const honest = {
    ...GOOD_ENTRY,
    claim: '这次会话调用了 156 次 pwsh，是占比最高的工具，说明任务主要靠命令行推进而非文件编辑。',
  }
  const r = parseProposals(okJson([honest]), { digest })
  assert(r.ok, `156 在 digest 里，应通过：${r.reason}`)
  return '真实数字通过 ✓'
})

await check('拒绝"算术推断出来的数字"（digest 没有的推导值）', () => {
  // digest 只有 12 和 3，模型算出 25% —— 这正是最隐蔽的编造形态
  const digest = '工具调用=12次 · 工具报错=3次'
  const infer = {
    ...GOOD_ENTRY,
    claim: '错误率高达 25%，说明这批工具在 Windows 环境下非常不稳定，需要整体替换方案。',
  }
  const r = parseProposals(okJson([infer]), { digest })
  assert(r.ok, '单条编造不该让整批失败')
  assert(r.proposals.length === 0, '25 是算出来的、digest 里没有，必须丢掉')
  assert(/25/.test(r.dropped[0].reason), `dropped 应点名 25，实为 ${JSON.stringify(r.dropped)}`)
  return '算术推断的 25 被单独拦下（这类最隐蔽）'
})

await check('小数字（1-2 位）不强制校验，避免误杀量词', () => {
  const digest = '工具调用=273次'
  const q = {
    ...GOOD_ENTRY,
    claim: '这次会话里出现了一次典型的锚点失效，说明分步编辑在文件被并行改动时并不安全，需要重新读取。',
  }
  const r = parseProposals(okJson([q]), { digest })
  assert(r.ok, `"一次"这类量词不该被拒：${r.reason}`)
  return '量词不误杀'
})

await check('不传 digest 时跳过数字校验（保持纯函数可单测）', () => {
  const r = parseProposals(okJson([{ ...GOOD_ENTRY, claim: '这里有 99999 个数字但没给 digest，所以跳过校验。' }]))
  assert(r.ok, '未传 digest 时不应做数字校验')
  return '无 digest → 跳过'
})

// ═══════════════════════════════════════════════════════════
// 5. renderSessionDigest —— 真实会话压缩
// ═══════════════════════════════════════════════════════════
console.log('\n── 5. renderSessionDigest：真实会话压缩 ──')

let realSessions = []
await check('从 ~/.dsh/sessions 读到真实会话', () => {
  const { sessions, errors } = scan.scanSessions()
  const t = triage.triageAll(sessions).enriched
  realSessions = t.filter((s) => s.category === 'real').sort((a, b) => b.toolCalls - a.toolCalls)
  assert(realSessions.length > 0, `没读到真实会话（errors=${errors?.join(',')}）`)
  return `${realSessions.length} 个 real 会话`
})

await check('最大会话压到 ≤ 6 KB（UTF-8 字节）', () => {
  const s = realSessions[0]
  assert(s, '无样本')
  const digest = renderSessionDigest(s, {})
  const bytes = Buffer.byteLength(digest, 'utf8')
  assert(bytes <= 6144, `超预算：${bytes} 字节（上限 6144）`)
  return `会话 ${s.sid.slice(0, 20)}（${s.toolCalls} 次调用）→ ${bytes} 字节`
})

await check('全部真实会话都 ≤ 6 KB（不只看一个）', () => {
  let over = 0
  let max = 0
  let worst = null
  let threw = 0
  for (const s of realSessions) {
    let d
    try {
      d = renderSessionDigest(s, {})
    } catch {
      // 【2026-11-09 修】原来是 `catch { continue }` —— 如果**所有**会话都抛异常，
      // 循环体一次都不执行，over 恒 0，这条照样 PASS 并打印"全部达标"。
      // 那是假绿灯。现在计数并在下面断言：至少要有一个样本真的算出来了。
      threw += 1
      continue
    }
    const b = Buffer.byteLength(d, 'utf8')
    if (b > max) { max = b; worst = s.sid }
    if (b > 6144) over++
  }
  const ok = realSessions.length - threw
  assert(ok > 0, `全部 ${realSessions.length} 个会话在 renderSessionDigest 里抛异常，这条什么都没测到`)
  assert(over === 0, `${over} 个会话超 6KB，最差 ${worst}`)
  return `${ok}/${realSessions.length} 个会话达标（${threw} 个抛异常跳过），最大 ${max} 字节`
})

await check('压缩后仍保留可提炼信息（不能是空壳）', () => {
  // 验收口径：能看出"发生了什么"。
  // 判据要**抗真实数据差异**：不能用"有没有截断标记"这种依赖样本的特征
  // （很多真实会话的人类消息本来就短，根本不会产生截断标记）。
  const s = realSessions[0]
  const digest = renderSessionDigest(s, {})

  // ① 四个结构块必须齐全
  const blocks = ['【会话元信息】', '【需求演进】', '【做了什么】', '【结果】']
  for (const b of blocks) {
    assert(digest.includes(b), `缺结构块 ${b}（digest 成了空壳）`)
  }

  // ② 人类消息正文必须出现：直接从会话文件读事件（scan 的记录里不带 eventList）
  const events = (() => {
    try {
      const { decompressMultiFrame, parseJsonl } = scan
      const fsmod = require('node:fs')
      if (!s.file) return []
      const buf = fsmod.readFileSync(s.file)
      return parseJsonl(decompressMultiFrame(buf).text).events
    } catch {
      return []
    }
  })()
  assert(events.length > 0, '样本会话读不到事件，无法验证保真')
  const firstHuman = (() => {
    for (const ev of events) {
      if (ev?.type !== 'user/message') continue
      if (ev?.data?.source?.kind !== 'user') continue
      const t = (ev.data.content || [])
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      if (t) return t
    }
    return null
  })()
  assert(firstHuman, '源会话里没有人类消息，样本不适用')
  // 取前 20 个字符（压缩会截断，但开头一定保留）
  const probe = firstHuman.replace(/\s+/g, ' ').slice(0, 20)
  assert(digest.includes(probe), `人类消息正文丢失（找不到"${probe}"）—— 这正是要避免的空壳`)

  // ③ 工具统计必须在
  assert(/调用统计：/.test(digest), '缺工具调用统计')

  const bytes = Buffer.byteLength(digest, 'utf8')
  return `4 块齐全 + 人类正文"${probe.slice(0, 12)}…"保留（${bytes} 字节）`
})

await check('短的决策消息不被长度过滤掉（实测反例保护）', () => {
  // 真实反例：24 字的"你看一下根目录的文件"是决策点，比 779 字的长消息更关键。
  // 这里造一个含极短指令的会话，验证它不会被压缩丢掉。
  const ev = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我重构这个模块' }] } },
    { type: 'tool/call', data: { name: 'read', arguments: '{}' } },
    { type: 'tool/result', data: { message: { isError: false, content: [] } } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '执行吧' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已完成重构' }] } } },
  ]
  const digest = renderSessionDigest({ sid: 'x', eventList: ev, title: 't' }, {})
  assert(digest.includes('执行吧'), '极短决策指令被丢了 —— 这会导致 LLM 丢掉关键信息')
  return '"执行吧"（3 字）被保留'
})

await check('非人类消息（plugin/审批注入）不算进需求演进', () => {
  const ev = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真正的人类指令' }] } },
    { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'user-approval' }, content: [{ type: 'text', text: '审批策略变更了' }] } },
  ]
  const digest = renderSessionDigest({ sid: 'x', eventList: ev, title: 't' }, {})
  assert(digest.includes('真正的人类指令'), '人类指令丢了')
  assert(!digest.includes('审批策略变更了'), 'plugin 注入被误当人类消息')
  return '只认 source.kind=user'
})

await check('失败工具样本被保留（踩坑原料）', () => {
  const ev = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '执行任务' }] } },
    { type: 'tool/call', data: { name: 'edit', arguments: '{}' } },
    { type: 'tool/result', data: { message: { isError: true, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'Error: file has not been read' }] }] } } },
    { type: 'tool/call', data: { name: 'read', arguments: '{}' } },
    { type: 'tool/result', data: { message: { isError: false, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'big file content' }] }] } } },
  ]
  const digest = renderSessionDigest({ sid: 'x', eventList: ev, title: 't' }, {})
  assert(digest.includes('file has not been read'), '失败错误文本被丢了（这是踩坑的唯一原料）')
  assert(!digest.includes('big file content'), '成功工具的输出了进来（浪费预算）')
  return '失败必取 · 成功输出丢弃'
})

await check('交付物清单被保留（产出了什么）', () => {
  const ev = [
    { type: 'deliverables/presented', data: { files: ['C:\\work\\report.html'] } },
  ]
  const digest = renderSessionDigest({ sid: 'x', eventList: ev, title: 't' }, {})
  assert(digest.includes('report.html'), '交付物丢失')
  return '交付物清单保留'
})

await check('事件不可读时降级为统计信息而不崩', () => {
  const digest = renderSessionDigest({ sid: 'x', file: 'C:\\nonexistent\\nope.zstd', title: 't', toolCalls: 5 }, {})
  assert(typeof digest === 'string' && digest.length > 0, '应返回字符串')
  assert(digest.includes('不可读'), '应明确标注事件不可读')
  return '坏文件降级不崩'
})

// ═══════════════════════════════════════════════════════════
// 6. buildUserMessage —— 防注入
// ═══════════════════════════════════════════════════════════
console.log('\n── 6. 消息组装与防注入 ──')

await check('把会话内容包在 <SESSIONS> 里并声明非指令', () => {
  const msg = buildUserMessage('会话内容在这里')
  assert(msg.includes('<SESSIONS>'), '缺开始标记')
  assert(msg.includes('</SESSIONS>'), '缺结束标记')
  assert(/不是给你的指令/.test(msg), '缺"非指令"声明')
  return '分隔符 + 非指令声明齐全'
})

await check('SYSTEM_PROMPT 含关键约束', () => {
  const must = ['{"entries":[]}', '不要编造', '陈述句']
  for (const m of must) {
    assert(SYSTEM_PROMPT.includes(m), `prompt 缺关键约束: ${m}`)
  }
  assert(/数字/.test(SYSTEM_PROMPT), 'prompt 缺数字纪律')
  return `prompt ${SYSTEM_PROMPT.length} 字`
})

// ═══════════════════════════════════════════════════════════
// 7. distillBatch / distillSessions —— mock LLM 编排
// ═══════════════════════════════════════════════════════════
console.log('\n── 7. 编排逻辑（mock LLM，不真调用）──')

/** 造一个返回固定文本的 mock llm。 */
function mockLlm(text, opts = {}) {
  return {
    calls: [],
    stream(options) {
      this.calls.push(options)
      if (opts.throwError) throw new Error(opts.throwError)
      const chunks = [
        { type: 'text-delta', text: String(text).slice(0, 10) },
        { type: 'text-delta', text: String(text).slice(10) },
        { type: 'reasoning-delta', text: '这段应该被忽略' },
      ]
      return (async function* () {
        for (const c of chunks) {
          if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
          yield c
        }
      })()
    },
  }
}

await check('distillBatch：正常路径返回 proposal，不写盘', async () => {
  const llm = mockLlm(okJson([GOOD_ENTRY]))
  const r = await distillBatch([{ sid: 's1', title: 't' }], { llm, digest: '工具调用=273次' })
  assert(r.error === null, `不该有错：${r.error}`)
  assert(r.proposals.length === 1, '应产出 1 条')
  assert(llm.calls.length === 1, `应只调 1 次，实调 ${llm.calls.length}`)
  assert(llm.calls[0].messages[0].content[0].type === 'text', '消息结构不对')
  return '1 次调用 · 1 条产出 · 零写盘'
})

await check('distillBatch：llm 不可用时返回 error 而不是抛', async () => {
  const r = await distillBatch([{ sid: 's1' }], { llm: null })
  assert(r.error && /llm\.stream/.test(r.error), `应给出明确错误：${r.error}`)
  assert(r.proposals.length === 0, '应为空 proposals')
  return r.error
})

await check('distillBatch：LLM 抛错被收敛成 error（不冒泡）', async () => {
  const llm = mockLlm('', { throwError: 'network down' })
  const r = await distillBatch([{ sid: 's1' }], { llm, digest: 'x' })
  assert(r.error && /network down/.test(r.error), `应捕获网络错误：${r.error}`)
  return '异常被收敛 ✓'
})

await check('distillBatch：输出校验失败时记 error 且带 rawHead 便于排查', async () => {
  const llm = mockLlm('这不是 JSON')
  const r = await distillBatch([{ sid: 's1' }], { llm, digest: 'x' })
  assert(r.error, '应记 error')
  assert(r.rawHead, '应保留原始输出头部用于排查')
  return r.error
})

await check('distillBatch：被截断的 JSON 会自动重试一次并救回', async () => {
  // 【2026-11-08 实测】真实 LLM 第一次跑就吐出半截 JSON（maxTokens 到顶被截断），
  // 整批报废；换个时刻同批会话又正常。这不是"模型不会做"，是偶发预算不足。
  const truncated = okJson([GOOD_ENTRY]).slice(0, 40)  // 故意截断
  let n = 0
  const llm = {
    calls: [],
    stream(opts) {
      this.calls.push(opts)
      n += 1
      const text = n === 1 ? truncated : okJson([GOOD_ENTRY])
      return (async function* () { yield { type: 'text-delta', text } })()
    },
  }
  const r = await distillBatch([{ sid: 's1', title: 't' }], { llm, digest: '工具调用=273次' })
  assert(r.error === null, `重试后应成功：${r.error}`)
  assert(r.proposals.length === 1, '应产出 1 条')
  assert(llm.calls.length === 2, `应恰好重试 1 次，实调 ${llm.calls.length}`)
  assert(llm.calls[1].maxTokens > llm.calls[0].maxTokens, '重试应放大 maxTokens')
  return `第 1 次 ${llm.calls[0].maxTokens} tok → 第 2 次 ${llm.calls[1].maxTokens} tok`
})

await check('distillBatch：一直吐坏 JSON 时只重试一次就放弃', async () => {
  const truncated = okJson([GOOD_ENTRY]).slice(0, 40)
  const llm = {
    calls: [],
    stream(opts) {
      this.calls.push(opts)
      return (async function* () { yield { type: 'text-delta', text: truncated } })()
    },
  }
  const r = await distillBatch([{ sid: 's1', title: 't' }], { llm, digest: 'x' })
  assert(r.error && /重试/.test(r.error), `错误里要写明重试过：${r.error}`)
  assert(llm.calls.length === 2, `只应重试一次，实调 ${llm.calls.length}`)
  return '重试 1 次后记失败'
})

await check('distillBatch：散文型坏输出也会重试一次（实测 2/7 批是这个形态）', async () => {
  // 真实 LLM 失败的第二形态：整段散文、一个花括号都没有（推理写进正文，JSON 没写）。
  // 这类"看起来不像截断"的失败同样值得重试 —— 第一次全量跑 7 次调用里 2 次如此。
  let n = 0
  const llm = {
    calls: [],
    stream(opts) {
      this.calls.push(opts)
      n += 1
      const text = n === 1 ? 'Let me analyze the sessions. Session 1 looks reusable...' : okJson([GOOD_ENTRY])
      return (async function* () { yield { type: 'text-delta', text } })()
    },
  }
  const r = await distillBatch([{ sid: 's1', title: 't' }], { llm, digest: 'x' })
  assert(r.error === null, `重试后应成功：${r.error}`)
  assert(llm.calls.length === 2, `应重试一次，实调 ${llm.calls.length}`)
  assert(/只输出一个 JSON/.test(String(llm.calls[1].system || '')), '重试时应追加"只输出 JSON"的强指令')
  return '散文 → 重试 → 成功'
})

await check('distillBatch：provider 不理会 AbortSignal 时也会被判超时（不会永远挂住）', async () => {
  // 【2026-11-09 实测】50 个会话那轮跑了 50 分钟没有任何产出，宿主进程 S 状态、
  // CPU 9% —— 就是卡在一次永远不返回的流上。超时不能只靠 AbortSignal。
  const llm = {
    calls: 0,
    stream() {
      this.calls += 1
      // 永远不 yield、也不结束
      return (async function* () { await new Promise(() => {}) })()
    },
  }
  const t0 = Date.now()
  const r = await distillBatch([{ sid: 's1', title: 't' }], { llm, digest: 'x', timeoutMs: 300 })
  const ms = Date.now() - t0
  assert(r.error, '应判失败而不是挂住')
  assert(/超时|timeout/i.test(r.error), `错误应说明超时：${r.error}`)
  assert(ms < 3000, `应在 timeoutMs 附近返回，实际 ${ms}ms`)
  return `${ms}ms 内返回：${r.error.slice(0, 40)}`
})

await check('distillBatch：空 batch 直接失败，不浪费调用', async () => {
  const llm = mockLlm(okJson([]))
  const r = await distillBatch([], { llm })
  assert(r.error, '应报错')
  assert(llm.calls.length === 0, '不该发起调用')
  return '零成本失败'
})

await check('distillBatch：超时收敛成 error 而非崩溃', async () => {
  // 真正模拟"LLM 卡住"：流迟迟不结束，并且在 signal 中止时抛 AbortError。
  // 注意不能靠 stream() 同步抛错 —— 那只测到 catch，测不到超时路径。
  const llm = {
    stream(options) {
      const signal = options.signal
      return (async function* () {
        // 先吐一点，再挂住，直到被 abort
        yield { type: 'text-delta', text: '{"entries":[' }
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 5000)
          if (signal) {
            signal.addEventListener('abort', () => {
              clearTimeout(t)
              const e = new Error('aborted')
              e.name = 'AbortError'
              reject(e)
            })
          }
        })
        yield { type: 'text-delta', text: ']}' }
      })()
    },
  }
  const t0 = Date.now()
  const r = await distillBatch([{ sid: 's1' }], { llm, digest: 'x', timeoutMs: 60 })
  const elapsed = Date.now() - t0
  assert(r.error, '应超时')
  assert(/超时|中止/.test(r.error), `错误应指明超时/中止，实为：${r.error}`)
  assert(elapsed < 3000, `应在超时后立即返回，实际耗时 ${elapsed}ms`)
  return `${elapsed}ms 后收敛：${r.error}`
})

await check('chunkBatch：按容量切块，调用次数可预算', () => {
  const list = Array.from({ length: 7 }, (_, i) => ({ sid: `s${i}` }))
  const b2 = chunkBatch(list, 2)
  assert(b2.length === 4, `7 个按 2 切应 4 块，实为 ${b2.length}`)
  assert(b2[0].length === 2 && b2[3].length === 1, '块大小不对')
  const b3 = chunkBatch(list, 3)
  assert(b3.length === 3, `7 个按 3 切应 3 块，实为 ${b3.length}`)
  return `7 会话 → 2/批=4 块, 3/批=3 块`
})

await check('distillSessions：调用次数 = ceil(n/perCall)，不随会话数翻倍', async () => {
  const llm = mockLlm(okJson([GOOD_ENTRY]))
  const list = Array.from({ length: 5 }, (_, i) => ({ sid: `s${i}`, title: 't' }))
  const r = await distillSessions(list, { llm, maxSessionsPerCall: 2, digest: 'x' })
  assert(llm.calls.length === 3, `5 会话按 2 切应为 3 次调用，实为 ${llm.calls.length}`)
  assert(r.report.blocks === 3, '块数不对')
  assert(r.proposals.length === 3, `每块 1 条应得 3 条，实为 ${r.proposals.length}`)
  return `5 会话 → 3 次调用（而非 5 次）`
})

await check('distillSessions：失败的块不丢会话，记进 failedSessionIds', async () => {
  // 第 1 次成功，第 2 次失败
  let n = 0
  const llm = {
    stream() {
      n++
      const text = n === 1 ? okJson([GOOD_ENTRY]) : 'BROKEN NOT JSON'
      return (async function* () {
        yield { type: 'text-delta', text }
      })()
    },
  }
  const list = [
    { sid: 'a1', title: 't' }, { sid: 'a2', title: 't' },
    { sid: 'b1', title: 't' }, { sid: 'b2', title: 't' },
  ]
  const r = await distillSessions(list, { llm, maxSessionsPerCall: 2, digest: 'x' })
  assert(r.report.okBlocks === 1, `应有 1 个成功块，实为 ${r.report.okBlocks}`)
  assert(r.report.failedBlocks === 1, `应有 1 个失败块，实为 ${r.report.failedBlocks}`)
  assert(r.report.failedSessionIds.length === 2, `失败块应记 2 个 sid，实为 ${r.report.failedSessionIds.length}`)
  assert(r.report.failedSessionIds.includes('b1') && r.report.failedSessionIds.includes('b2'), 'sid 记错了')
  assert(r.proposals.length === 1, '成功块的产出应保留')
  return `失败块 ${r.report.failedSessionIds.join(',')} 记入重试队列`
})

await check('distillSessions：给 proposal 补 provenance 但不覆盖模型字段', async () => {
  const llm = mockLlm(okJson([GOOD_ENTRY]))
  const r = await distillSessions([{ sid: 'sX', title: 't' }], { llm, maxSessionsPerCall: 1, digest: 'x' })
  const p = r.proposals[0]
  assert(p.provenance, '缺 provenance')
  assert(p.provenance.kind === 'llm-distilled', 'provenance.kind 不对')
  assert(p.provenance.session_ids.includes('sX'), 'sid 没记进去')
  assert(p.title === GOOD_ENTRY.title, '模型字段被覆盖了')
  assert(p.confidence === 'high', '模型字段被覆盖了')
  return 'provenance 追加，原有字段不变'
})

await check('distillBatch：严格 UTF-8 无 BOM 参与链路（digest 不含 \\uFEFF）', () => {
  const digest = renderSessionDigest(realSessions[0], {})
  assert(!digest.includes('\uFEFF'), 'digest 里出现 BOM 字符')
  return '无 BOM'
})

// ───────────────────────── 收尾 ─────────────────────────
for (const d of cleanups) {
  try { rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log('\n' + '═'.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail > 0) {
  console.log('\n失败用例：')
  for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.error.message}`)
  process.exit(1)
}
