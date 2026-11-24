// DeepSeek 直连 shim 单测（2026-11-24）
// 锁三件事：①无 key 必须抛错且不回落到宿主；②SSE 正确映射为 text-delta；③HTTP 错误要带状态码。
import { createDeepSeekLLM, resolveDeepSeekKey } from '../lib/deepseek-llm.js'

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass += 1 } else { fail += 1; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

// ① 无 key：stream() 必须同步抛错
{
  const llm = createDeepSeekLLM({ env: {}, apiKey: null, allowFile: false, fetchImpl: async () => { throw new Error('不该被调用') } })
  let err = null
  try { llm.stream({ messages: [{ role: 'user', content: 'x' }] }) } catch (e) { err = e }
  check('无 key 时抛错', !!err)
  check('错误提示写明 key 与环境变量', /DEEPSEEK_API_KEY/.test(String(err?.message || '')))
  check('错误提示写明不回落', /不回落|不会回落/.test(String(err?.message || '')))
}

// ② SSE → text-delta
{
  const sse = 'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n'
  const fetchImpl = async () => ({ ok: true, body: (async function* () { yield sse })() })
  const llm = createDeepSeekLLM({ env: {}, apiKey: 'sk-test', fetchImpl })
  const texts = []
  for await (const c of llm.stream({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
    check('chunk 形态是 text-delta', c.type === 'text-delta')
    texts.push(c.text)
  }
  check('拼接结果正确', texts.join('') === '你好', texts.join(''))
}

// ③ HTTP 错误
{
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => '{"error":"bad key"}' })
  const llm = createDeepSeekLLM({ env: {}, apiKey: 'sk-bad', fetchImpl })
  let err = null
  try { for await (const _ of llm.stream({ messages: [] })) { /* drain */ } } catch (e) { err = e }
  check('HTTP 错误抛错', !!err)
  check('错误带状态码', /401/.test(String(err?.message || '')))
}

// ④ key 解析优先级：显式 apiKey > 环境变量
{
  check('env key 可解析', resolveDeepSeekKey({ DEEPSEEK_API_KEY: 'sk-env' }) === 'sk-env')
  check('无 key 返回 null', resolveDeepSeekKey({}, { allowFile: false }) === null)
}

console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
process.exitCode = fail === 0 ? 0 : 1
