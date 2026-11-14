#!/usr/bin/env node
/**
 * test-host-model.mjs —— 提炼模型来源与错误透传的回归测试（2026-11-10）
 *
 * 覆盖 issue dsh-manuscript-open#4 的两条根因：
 *   ① 宿主默认模型必须能从 `agentDefaultModel` 服务取到（而不是只读 profile 文件）；
 *   ② 宿主流里的 `{type:'error'}` 必须抛出，不能被吞成「LLM 返回空文本」。
 *
 * 这些是纯函数/纯服务桩测试：不连真实 LLM，也不依赖宿主机。
 */
import { resolveFromHost, resolveDshDefaultModel } from '../lib/model-config.js'
import { collectTextStream } from '../lib/llm-stream.js'

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`✓ ${name}${detail ? '  ' + detail : ''}`) }
  else { fail += 1; console.log(`✗ ${name}${detail ? '  ' + detail : ''}`) }
}

/* ── 1. resolveFromHost：ctx.get(服务) 能取到 ───────────────────── */
{
  const service = { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
  const ctx = { get: (name) => (name === 'agentDefaultModel' ? service : undefined) }
  const found = resolveFromHost(ctx)
  ok('ctx.get(agentDefaultModel) 取到 provider', found?.provider === 'deepseek-account', String(found?.provider))
  ok('ctx.get(agentDefaultModel) 取到 model', found?.model === 'deepseek-flash', String(found?.model))
}

/* ── 2. resolveFromHost：属性挂载的形态也能取到 ─────────────────── */
{
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'p2', model: 'm2' }) } }
  const found = resolveFromHost(ctx)
  ok('ctx.agentDefaultModel 属性形态可用', found?.provider === 'p2' && found?.model === 'm2')
}

/* ── 3. 取不到时返回 null（调用方回落 YAML / 旧默认） ───────────── */
{
  ok('无服务时返回 null', resolveFromHost({}) === null)
  ok('currentSelection 抛错时返回 null', resolveFromHost({ get: () => ({ currentSelection() { throw new Error('boom') } }) }) === null)
  ok('provider/model 缺一不可', resolveFromHost({ get: () => ({ currentSelection: () => ({ provider: 'p' }) }) }) === null)
}

/* ── 4. profile 解析仍是兜底路径 ───────────────────────────────── */
{
  const fromFile = resolveDshDefaultModel()
  ok('resolveDshDefaultModel 不抛错（有/无 profile 都允许）', fromFile === null || typeof fromFile === 'object')
}

/* ── 5. collectTextStream：正常文本仍然拼接 ────────────────────── */
{
  const text = await collectTextStream([
    { type: 'text-delta', text: 'hello ' },
    { type: 'text-chunks', texts: ['wor', 'ld'] },
    { text: '!' },
  ])
  ok('文本块拼接正确', text === 'hello world!', JSON.stringify(text))
}

/* ── 6. collectTextStream：error 块必须抛出，不能静默 ─────────── */
{
  let thrown = null
  try {
    await collectTextStream([
      { type: 'text-delta', text: 'partial' },
      { type: 'error', error: { message: 'provider "workbuddy" not found' } },
    ])
  } catch (e) { thrown = e }
  ok('error 块被抛出', thrown !== null)
  ok('错误信息保留宿主原文', /provider "workbuddy" not found/.test(thrown?.message || ''), String(thrown?.message))
}

console.log('\n============================================================')
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
