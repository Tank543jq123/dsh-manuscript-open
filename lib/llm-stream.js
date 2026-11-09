/**
 * LLM 流式输出的统一收集器 —— 单一实现。
 *
 * 【为什么单独一个模块（2026-11-08）】`distill.js` 与 `dupjudge.js` 各自写了一份
 * `collectStream`，对 chunk 形状的支持**不一致**：
 *   · distill 版认 `{type:'text-delta'}` 与 `{type:'text-chunks', texts:[]}`
 *   · dupjudge 版只认 `c.text`（所以 text-chunks 拿不到内容）
 *
 * 后果是静默的：宿主若用 text-chunks 流式返回，dupjudge 拿到空串 →
 * 返回 `{same:null}`（"问不出结论"）→ 调用方按未知处理 → **查重永远不生效**，
 * 而日志与接口都不会报错。实测确认：
 *
 *   text-delta      → same=true
 *   text-chunks     → same=null / 输出不含 JSON   ← bug
 *
 * 两份实现迟早会再次漂移，所以收敛到这里，谁新增调用方都直接复用。
 */

/**
 * 把异步 chunk 流拼成完整文本。
 *
 * 支持的 chunk 形状（按已观测到的宿主输出）：
 *   · 字符串                      —— 直接拼
 *   · `{ type: 'text-delta', text }`
 *   · `{ type: 'text-chunks', texts: string[] }`
 *   · `{ text }`（无 type 或其它 type，但有 text）
 * 其余（reasoning / tool-call 等）一律跳过 —— 对提炼与判重无用。
 *
 * @param {AsyncIterable<unknown>|Iterable<unknown>} chunks
 * @returns {Promise<string>}
 */
export async function collectTextStream(chunks) {
  let out = ''
  for await (const c of chunks) {
    if (typeof c === 'string') {
      out += c
      continue
    }
    if (!c || typeof c !== 'object') continue
    if (c.type === 'text-delta' && typeof c.text === 'string') out += c.text
    else if (c.type === 'text-chunks' && Array.isArray(c.texts)) out += c.texts.join('')
    else if (typeof c.text === 'string') out += c.text
  }
  return out
}
