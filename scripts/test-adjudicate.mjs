#!/usr/bin/env node
/**
 * lib/adjudicate.js 的测试。
 *
 * 这个模块决定了"哪些提案 AI 直接放行、哪些要人看"。
 * 它错判的后果不对称：
 *   · 放行太多 → 垃圾进书库，污染未来的上下文
 *   · 放行太少 → 人工队列变长，人会无脑点"全过"，人工确认变成假动作
 *
 * 所以测试要同时压这两头。
 */

import { adjudicate, inspectProposal, fingerprint, similarity, summarizeAdjudication, DECISION, MIN_CLAIM_CHARS, looksSameTopic, keyTokens } from '../lib/adjudicate.js'

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

// 一条"内容合格"的提案（机械检查能全过）
const good = (over = {}) => ({
  title: '重试三次失败后应该退避而不是继续重试下去',
  claim:
    '实测在 5 次调用中有 3 次失败，正确做法是退避 2 秒后重试，而不是立即连续重试导致雪崩。具体的退避序列是 2s → 4s → 8s。',
  claim_conf: undefined,
  why: '连续重试会放大下游压力。',
  confidence: 'high',
  tags: ['重试'],
  ...over,
})

console.log('\n── 1. 指纹与相似度 ──')

check('相同文本相似度为 1', similarity(fingerprint('停用旧 Gitea 后要封堵入口'), fingerprint('停用旧 Gitea 后要封堵入口')) === 1)

const s1 = similarity(
  fingerprint('停用旧 Gitea 后要封堵启动入口否则会复发'),
  fingerprint('停用旧 Gitea 后要封堵启动入口否则会再次复发')
)
// 中文改一个字会拆出 2-3 个 bigram，实测这条是 0.79 —— 已经属于高度相似。
// 阈值定 0.8 会把"改一个字"判成不相似，太严。
check('近似文本相似度 > 0.75', s1 > 0.75, s1.toFixed(3))

const s2 = similarity(
  fingerprint('I2C 从机中断里不能调阻塞日志'),
  fingerprint('GitHub 仓库要定期清理 stale branch')
)
check('不相关文本相似度 < 0.2', s2 < 0.2, s2.toFixed(3))

check('空文本指纹为空集', fingerprint('').size === 0)
check('空文本相似度为 0', similarity(fingerprint(''), fingerprint('abc')) === 0)

console.log('\n── 2. 单条检查 ──')

let ins = inspectProposal(good())
check('合格条目 ok=true', ins.ok === true, `reasons=${ins.reasons.length} warnings=${ins.warnings.length}`)

ins = inspectProposal({ title: '好', claim: '短', confidence: 'high' })
check('超短标题被拒', ins.ok === false, ins.reasons[0] || '')

ins = inspectProposal({ title: '关于性能优化的思考', claim: '这'.repeat(60), confidence: 'high' })
check('名词堆标题被拒', ins.ok === false, ins.reasons[0] || '')

ins = inspectProposal({ title: '某个足够长的陈述句标题在这里', claim: '太短', confidence: 'high' })
check(`结论短于 ${MIN_CLAIM_CHARS} 字被拒`, ins.ok === false, ins.reasons[0] || '')

ins = inspectProposal({
  title: '做事情之前应该先想清楚目标然后再动手去做',
  claim: '这是一段足够长的可独立读懂的结论文本，说明了做事情之前要先明确目标，但通篇没有任何数字、路径、专名或命令出现。',
  confidence: 'high',
})
check('无锚点的泛泛而谈产生警告', ins.ok === true && ins.warnings.some((w) => w.includes('泛泛而谈')), ins.warnings.join('|'))

ins = inspectProposal(good({ confidence: 'speculation' }))
check('speculation 产生警告', ins.warnings.some((w) => w.includes('推测')))

// 用整段 claim 当标题 —— 这才是真正的"没提炼"（模型把结论原样当标题）
ins = inspectProposal({ ...good(), title: good().claim })
check('标题与结论雷同被拒', ins.ok === false, ins.reasons[0] || '')

console.log('\n── 3. 自动接受（不该麻烦人的不麻烦人）──')

let adj = adjudicate([good()], {})
check('high + 无警告 → 自动接受', adj.accept.length === 1 && adj.human.length === 0)
check('high 入册不打抽查标记', adj.accept[0]?._spotCheck === false)

adj = adjudicate([good({ confidence: 'medium' })], {})
check('medium + 无警告 → 也自动接受（模型保守不该拖累人）', adj.accept.length === 1, `accept=${adj.accept.length} human=${adj.human.length}`)
check('medium 入册打抽查标记', adj.accept[0]?._spotCheck === true)

console.log('\n── 4. 自动拒绝（垃圾不进书库）──')

adj = adjudicate([
  { title: '好', claim: '短', confidence: 'high' },
  { title: '关于某些问题的思考', claim: '这'.repeat(60), confidence: 'high' },
  { title: '标题够长但是结论太短所以不行', claim: '短', confidence: 'high' },
])
check('三条差条目全部自动拒绝', adj.reject.length === 3 && adj.accept.length === 0, `reject=${adj.reject.length}`)
check('拒绝都带原因', adj.reject.every((r) => r._reasons && r._reasons.length > 0))

console.log('\n── 5. 去重（同一结论不重复入册）──')

const existing = [
  { id: 'e-1', title: '飞牛 NAS 上停用旧 Gitea 后仍要封堵其启动入口，否则会复发', claim: '在飞牛 NAS 上把服务切换成新部署的 Gitea 后，仅仅停掉旧实例不够，还需禁用启动入口并封死复发路径。' },
]
adj = adjudicate(
  [{ ...good(), title: '飞牛 NAS 停用旧 Gitea 后要封堵启动入口否则会复发', claim: '在飞牛 NAS 上把服务切换成新部署的 Gitea 后，仅仅停掉旧实例不够，还需禁用启动入口并封死复发路径才行。' }],
  { existing }
)
check('与库内已有条目重复 → 拒绝', adj.reject.length === 1 && String(adj.reject[0]?._reasons?.[0] || '').includes('重复'), adj.reject[0]?._reasons?.[0] || '')

adj = adjudicate(
  [
    good({ title: '重试三次失败后应该退避而不是继续重试下去' }),
    good({ title: '重试三次失败后应该退避而不是立即继续重试' }),
  ],
  {}
)
check('批内自身重复 → 只留一条', adj.accept.length === 1 && adj.reject.length === 1, `accept=${adj.accept.length} reject=${adj.reject.length}`)

// ── 批内「主题级」重复（2026-11-04 修复的漏洞）──────────────────────────
// 背景：bigram 指纹只有 0.26，第一层拦不住；主题层原来只对比历史库，
// 库里没有同主题条目时，同一批的两条同主题提案会双双进 accept。
// 这里用 existing 为空来隔离「批内」这一条路径。
const batchTopicA = good({
  title: '非视觉模型调用 read_image 会直接报错应换模型而不是重试',
  claim: '模型不支持图像输入时 read_image 立即失败，报错 model does not declare image input，重试同一读取没有意义，应切换到支持图像的模型。',
  confidence: 'high',
})
const batchTopicB = good({
  title: '当前模型不支持图像输入read_image读取物料图片直接失败',
  claim: '用 read_image 读物料图片直接报错 model does not declare image input，需切换到支持图像输入的模型，或改用参数表判定。',
  confidence: 'high',
})
adj = adjudicate([batchTopicA, batchTopicB], { existing: [] })
check(
  '批内同主题（bigram 拦不住）→ 不再双双入册',
  adj.accept.length === 1 && adj.human.length === 1,
  `accept=${adj.accept.length} human=${adj.human.length} reject=${adj.reject.length}`
)
check(
  '批内同主题的警告说明了是本批候选',
  String(adj.human[0]?._warnings?.join(' ') || '').includes('本批'),
  adj.human[0]?._warnings?.join(' ') || ''
)

// ── 长 claim 不得稀释判重（2026-11-04 修复的缺陷 2）────────────────────
// 背景：一条 claim 写了具体文件名/模型号 → token 从 4 涨到 11，
// jaccard 被稀释到 0.154 < 0.20，同一件事被判成"不重复"。
// 也就是说 claim 越详细反而越容易漏判，方向与提炼质量相反。
const longClaimExisting = {
  title: '当前模型不支持图像输入，read_image 工具必然失败',
  claim: '在本次会话中，模型 deepseek-v4.1-flash 调用 read_image 读取 PNG 图片（svgcheck.png、n3_report.png）时全部失败，报错为 model does not declare image input。',
  confidence: 'high',
}
const longClaimCandidate = {
  title: '当前模型不支持图像输入，read_image 读物料图片直接失败',
  claim: '用 read_image 读物料图片直接报错 model does not declare image input，凡是靠看图判断的选型环节都走不通，需换支持图像输入的模型。',
  confidence: 'high',
}
const diluted = looksSameTopic(longClaimCandidate, longClaimExisting)
check(
  '长 claim 不稀释判重（标题几乎逐字相同 → 仍判重）',
  diluted.dup === true,
  `jaccard=${diluted.jaccard.toFixed(3)} prefix=${diluted.prefixRatio.toFixed(2)} byTitle=${diluted.byTitle}`
)

// 同时反向验证：标题开头就分叉的两条不同成因，不能被前缀判据误伤
const prefixDiffA = {
  title: '编辑文件前必须先 read，否则 edit/write 会以 file has not been read 拒绝',
  claim: '顺序契约：没先 read 就 write/edit，工具直接拒绝，提示 read the file then retry',
  confidence: 'high',
}
const prefixDiffB = {
  title: 'edit 工具修改文件前必须先 read，否则报 file has not been read',
  claim: '在本工作区用 edit 工具修改 HTML 文件时连续多次被拒绝，报错为 cannot modify file has not been read',
  confidence: 'high',
}
const pd = looksSameTopic(prefixDiffA, prefixDiffB)
check(
  '标题前缀判据不误伤不同成因的条目',
  pd.dup === false,
  `prefix=${pd.prefixRatio.toFixed(2)} shared=${pd.shared.length}`
)

console.log('\n── 6. 人工队列（只把真正需要的推给人）──')

const vague = {
  title: '做事情之前应该先想清楚目标然后再动手去做',
  claim: '这是一段足够长的可独立读懂的结论文本，说明了做事情之前要先明确目标，但通篇没有任何数字、路径、专名或命令出现。',
  confidence: 'high',
}
adj = adjudicate([vague], {})
check('有警告 → 进人工队列', adj.human.length === 1 && adj.accept.length === 0)
check('人工条目带警告说明', adj.human[0]?._warnings?.length > 0, adj.human[0]?._warnings?.[0] || '')

adj = adjudicate([good({ confidence: 'speculation' })], {})
check('speculation → 进人工队列', adj.human.length === 1, `human=${adj.human.length}`)

const many = Array.from({ length: 15 }, (_, i) => ({
  title: `第 ${i} 条泛泛而谈的结论需要人来判断对错`,
  claim: '这是一段足够长的可独立读懂的结论文本描述了一些事情但没有具体锚点所以需要人工确认。',
  confidence: 'high',
}))
adj = adjudicate(many, { maxHuman: 5 })
check('人工队列上限生效', adj.human.length === 5 && adj.deferred.length === 10, `human=${adj.human.length} deferred=${adj.deferred.length}`)
check('延后不是拒绝', adj.deferred.every((d) => d._decision === 'deferred'))

console.log('\n── 7. 边界与安全 ──')

adj = adjudicate([], {})
check('空数组安全', adj.stats.total === 0 && adj.stats.autoHandledRate === 0)

adj = adjudicate(null, {})
check('null 安全', adj.stats.total === 0)

adj = adjudicate([null, undefined, 42, 'x', {}], {})
check('混合垃圾输入不崩', typeof adj.stats.total === 'number', `total=${adj.stats.total}`)

adj = adjudicate([good()], { existing: null })
check('existing 为 null 安全', adj.accept.length === 1)

// 不改动输入
const origin = [good()]
const snapshot = JSON.stringify(origin)
adjudicate(origin, {})
check('不修改调用方传入的数组', JSON.stringify(origin) === snapshot)

console.log('\n── 8. 摘要文字 ──')

adj = adjudicate([good(), good({ title: '另一条完全不同的结论需要足够长的标题', claim: '这是另一段完全不同的结论文本，含 42 这个数字和一些 code，用来验证摘要文字。' })], {})
const summary = summarizeAdjudication(adj)
check('摘要包含产出条数', summary.includes('2'), summary)
check('摘要包含自动处理占比', summary.includes('%'), summary)

check('空结果摘要是人话', summarizeAdjudication(adjudicate([], {})).includes('没有产出'))

console.log('\n── 9. 核心指标 ──')

// 真实场景：3 条好的 + 2 条差的
adj = adjudicate([
  good(),
  good({ title: '另一条合格的结论需要足够长的陈述句标题', claim: '这段文本包含 42 和 code 这样的锚点，内容与第一条完全不同，用来凑够样本数量。' }),
  good({ title: '第三条合格结论同样需要足够长的标题才行', claim: '第三条内容包含 7 次调用和 path/to/file 这样的具体锚点，确保不被判为泛泛而谈。', confidence: 'medium' }),
  { title: '好', claim: '短', confidence: 'high' },
  { title: '关于某些问题的思考', claim: '这'.repeat(60), confidence: 'high' },
], {})
check('5 条里 AI 自动处理 5 条（人零负担）', adj.stats.autoHandledRate === 1, `rate=${adj.stats.autoHandledRate}`)
check('其中 3 条接受 2 条拒绝', adj.accept.length === 3 && adj.reject.length === 2, `accept=${adj.accept.length} reject=${adj.reject.length}`)

// ═══════════════════════════════════════════════════════════════════
// 10. 主题级查重（2026-11-03 新增）
//
// 事故背景：库里积累了 9 条讲「read_image 不支持图像输入」的重复条目。
// 原 bigram 指纹两两最高只有 0.722（阈值 0.82），一条都拦不住 ——
// 因为它测的是字面重合，而这些条目措辞差异极大。
// ═══════════════════════════════════════════════════════════════════

console.log('\n── 10. 主题级查重 ──')

// 10.1 换了说法但讲同一件事 → 应判重
const sameA = {
  title: 'deepseek-v4.1-flash 模型无法读取图片，read_image 必然失败',
  claim: '模型不支持图像输入时 read_image 报错 model does not declare image input',
  confidence: 'high',
}
const sameB = {
  title: '当前模型不支持图像输入，read_image 无法读取原理图截图',
  claim: '调用 read_image 读 PNG 时直接失败，原因是模型未声明图像输入能力',
  confidence: 'high',
}
check('换说法的同一件事 → looksSameTopic 判重', looksSameTopic(sameA, sameB).dup === true,
  `shared=${JSON.stringify(looksSameTopic(sameA, sameB).shared)}`)

// 10.2 不同主题 → 不应判重
// 注意：claim 必须 >= MIN_CLAIM_CHARS(40)，否则会先被机械检查拒掉，
// 测到的就不是"查重没命中"而是"claim 太短"。第一版就踩了这个坑。
const diffB = {
  title: '立创EDA bridge 无排队机制且存在不共享锁的第二条通道',
  claim: '并发调用 bridge 时会出现两条通道，其中一条不加锁，导致状态不一致；调用方需要自己串行化，否则结果不可预期。',
  confidence: 'high',
}
check('不同主题 → 不判重', looksSameTopic(sameA, diffB).dup === false)

// 10.3 通用词不能作为判重依据（这条是关键回归）
// 两条都含 file/read/edit/changed，但讲的是不同的事
const editA = {
  title: 'edit 报 file changed since it was read 需重新 read 后重试',
  claim: '文件被外部修改后，edit 会以 file changed since it was read 拒绝执行，需要重新 read 再改',
}
const editB = {
  title: '编辑文件前必须先 read，否则 edit/write 会以 file has not been read 拒绝',
  claim: '顺序契约：没先 read 就 write/edit，工具直接拒绝，提示 read the file then retry',
}
check('通用词不误伤（edit 两条不同成因）', looksSameTopic(editA, editB).dup === false,
  `shared=${JSON.stringify(looksSameTopic(editA, editB).shared)}`)

// 10.4 主题重复进 human 而非 reject —— 绝不静默丢弃
const dupProposals = [sameB]
const dupRes = adjudicate(dupProposals, { existing: [sameA], maxHuman: 10 })
check('主题重复 → 进 human 队列', dupRes.human.length === 1 && dupRes.reject.length === 0,
  `human=${dupRes.human.length} reject=${dupRes.reject.length}`)
check('主题重复的警告写明了共享了什么',
  dupRes.human.length > 0 &&
  (dupRes.human[0]._warnings || []).some((w) => w.includes('疑似与已有条目讲同一件事')))

// 10.5 基线为空时绝不误拦（首次提炼的场景）
const emptyBase = adjudicate([sameB, diffB], { existing: [], maxHuman: 10 })
check('基线为空时不误拦', emptyBase.accept.length === 2 && emptyBase.human.length === 0,
  `accept=${emptyBase.accept.length} human=${emptyBase.human.length}`)

console.log('\n' + '═'.repeat(74))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail) {
  console.log('失败用例：')
  for (const f of failures) console.log('  ✗ ' + f)
}
console.log('═'.repeat(74))
process.exit(fail ? 1 : 0)
