// test-dupjudge.mjs —— LLM 语义判重的单元测试
//
// 不调真实 LLM：用 mock 的 llm.stream 覆盖各条分支。
// 真实判准率由人工标注集单独验证（见 _work/llm-judge-probe.mjs）。
import { worthAsking, judgeSameTopic, JUDGE_SYSTEM } from '../lib/dupjudge.js'

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log('✓ ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail += 1
    failures.push(name)
    console.log('✗ ' + name + (detail ? '  ' + detail : ''))
  }
}

/** 构造一个按剧本返回的假 llm。 */
function fakeLLM(reply) {
  return {
    stream() {
      return (async function* () {
        yield reply
      })()
    },
  }
}

console.log('── 1. 粗筛（成本控制，宁可多问不可漏问）──')

check(
  '标题有长公共子串 → 值得问',
  worthAsking(
    { title: '标准编号里的新年份常是区域采纳版，不代表技术修订' },
    { title: '标准编号出现新年份多为区域采纳版，不等于新版国际标准' }
  )
)
check(
  '共享英文标识符 → 值得问',
  worthAsking(
    { title: 'read_image 因模型无图像能力失败' },
    { title: 'read_image 只能读位图' }
  )
)
check(
  '完全无关 → 不值得问',
  worthAsking(
    { title: '飞牛 NAS 上装 Gitea' },
    { title: 'KiCad 原理图文件报错排查' }
  ) === false
)
check('空标题不崩', worthAsking({}, {}) === false)

// 2026-11-04 真实漏判案例：公共子串只有 4 字、共享英文只有 2 字母，
// 原判据（≥6 字子串 / 共享 ≥3 字符英文词）全部够不上，于是 LLM 没被问到，
// 这条重复直接进库（库里已有 2 条同主题）。补了中文 2-gram 比例判据。
check(
  '中文字面重合（旧判据漏判的真实案例）→ 值得问',
  worthAsking(
    { title: '区域采纳版编号里的年份会被误当成 ISO 标准修订版' },
    { title: '标准编号里的新年份常是区域采纳版，不代表技术修订' }
  ),
  '公共子串仅 4 字、共享英文仅 ISO（2 字符）'
)
check(
  '中文字面重合（ISO Survey 案例）→ 值得问',
  worthAsking(
    { title: 'ISO/IEC 42001 全球认证证书数没有官方统计数字' },
    { title: 'ISO Survey 未收录时，ISO 认证证书数不存在官方全球数字' }
  )
)

console.log('\n── 2. 无 llm 时必须返回未知，不能当成"不重复"──')

const noLLM = await judgeSameTopic(null, { title: 'a' }, { title: 'b' })
check('无 llm → same=null', noLLM.same === null, `same=${noLLM.same}`)
check('无 llm → 带 error 原因', noLLM.error === 'no-llm')

console.log('\n── 3. 正常判定 ──')

const yes = await judgeSameTopic(fakeLLM('{"same": true}'), { title: 'a' }, { title: 'b' })
check('LLM 说同一件事 → same=true', yes.same === true)

const no = await judgeSameTopic(fakeLLM('{"same": false}'), { title: 'a' }, { title: 'b' })
check('LLM 说不同 → same=false', no.same === false)

console.log('\n── 4. 输出不可解析时必须返回未知（不能瞎猜）──')

const garbage = await judgeSameTopic(fakeLLM('我觉得它们差不多'), { title: 'a' }, { title: 'b' })
check('无 JSON → same=null', garbage.same === null, `error=${garbage.error}`)

const badJson = await judgeSameTopic(fakeLLM('{same: yes}'), { title: 'a' }, { title: 'b' })
check('坏 JSON → same=null', badJson.same === null)

const noField = await judgeSameTopic(fakeLLM('{"verdict": "same"}'), { title: 'a' }, { title: 'b' })
check('缺 same 字段 → same=null', noField.same === null, `error=${noField.error}`)

const wrapped = await judgeSameTopic(
  fakeLLM('好的，结论如下：\n{"same": true}\n以上。'),
  { title: 'a' },
  { title: 'b' }
)
check('JSON 被包裹在解释里也能取出', wrapped.same === true)

console.log('\n── 5. 调用抛错不能把主流程带崩 ──')

const throwing = {
  stream() {
    throw new Error('network down')
  },
}
const err = await judgeSameTopic(throwing, { title: 'a' }, { title: 'b' })
check('调用抛错 → same=null 且带原因', err.same === null && String(err.error).includes('network down'))

console.log('\n── 6. 提示词要求只输出 JSON ──')

check('系统提示词含输出格式约束', JUDGE_SYSTEM.includes('{"same": true}'))
check('系统提示词写明了"不同成因不算同一件事"', JUDGE_SYSTEM.includes('成因不同'))

// ── 5. 流式 chunk 形状：宿主可能用 text-chunks，不能静默失效 ──
{
  // 【2026-11-08 修复】dupjudge 原来自己写了一份 collectStream，只认 c.text；
  // 宿主若用 {type:'text-chunks', texts:[]} 返回，它拿到空串 → same:null（未知）
  // → 查重永远不生效，而日志与接口都不报错。现在与 distill 共用 llm-stream.js。
  const A = { title: '双排针选型要按载流降额', claim: '先按额定电流八成降额' }
  const B = { title: '双排针选型按载流降额', claim: '额定电流八成降额' }
  const mk = (chunks) => ({ stream: async function* () { for (const c of chunks) yield c } })
  const shapes = [
    ['text-delta', [{ type: 'text-delta', text: '{"same":true}' }]],
    ['text-chunks', [{ type: 'text-chunks', texts: ['{"same":', 'true}'] }]],
    ['裸字符串', ['{"same":true}']],
    ['只有 text 字段', [{ text: '{"same":true}' }]],
    ['分段 delta', [{ type: 'text-delta', text: '{"sa' }, { type: 'text-delta', text: 'me":true}' }]],
  ]
  for (const [name, chunks] of shapes) {
    const r = await judgeSameTopic(mk(chunks), A, B)
    check(`chunk 形状「${name}」能解析出 same=true`, r.same === true, `same=${r.same} err=${r.error || ''}`)
  }
  const junk = await judgeSameTopic(mk([{ type: 'text-delta', text: '不知道' }]), A, B)
  check('非 JSON 输出 → same=null（按未知处理，不当成不重复）', junk.same === null, `same=${junk.same}`)
}

console.log('\n' + '═'.repeat(74))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail) {
  console.log('失败用例：')
  for (const f of failures) console.log('  ✗ ' + f)
}
console.log('═'.repeat(74))
process.exit(fail ? 1 : 0)
