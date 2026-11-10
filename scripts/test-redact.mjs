// P0-1 隐私防线单测：确定性脱敏 + 敏感性扫描。
import assert from 'node:assert/strict'
import { redactText, scanSensitive, redactEntry, redactionEnabled } from '../lib/redact.js'
import { distillBatch } from '../lib/distill.js'

let pass = 0
const check = (name, fn) => {
  try { fn(); pass++; console.log(`✓ ${name}`) }
  catch (e) { console.error(`✗ ${name}: ${e.message}`); process.exitCode = 1 }
}

check('GitHub token 被脱敏', () => {
  const out = redactText('see ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  assert.match(out, /\[REDACTED:github-token\]/)
  assert.ok(!out.includes('ghp_'))
})
check('OpenAI/AWS/token 被脱敏', () => {
  assert.match(redactText('sk-abcdefghijklmnopqrstuvwxyz123456'), /\[REDACTED:openai-token\]/)
  assert.match(redactText('AKIAABCDEFGHIJKLMNOP'), /\[REDACTED:aws-key\]/)
})
check('Bearer / password 被脱敏', () => {
  assert.match(redactText('Authorization: Bearer abcdefghijklmnop'), /\[REDACTED:(bearer|generic-secret)\]/)
  assert.match(redactText('password=hunter2'), /\[REDACTED:generic-secret\]/)
})
check('私有 IP / 邮箱 / home 路径 / SSH 被脱敏', () => {
  const out = redactText('host 192.168.1.9 mail a@b.com /home/alice/x C:\\Users\\alice\\y ssh root@10.0.0.2')
  assert.match(out, /\[REDACTED:private-ip\]/)
  assert.match(out, /\[REDACTED:email\]/)
  assert.match(out, /\[REDACTED:home-path\]/)
  assert.match(out, /\[REDACTED:ssh-target\]/)
})
check('私钥块整体被脱敏', () => {
  const out = redactText('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')
  assert.match(out, /\[REDACTED:private-key\]/)
  assert.ok(!out.includes('abc'))
})
check('普通中文/数字不被误伤', () => {
  const s = '今天修了 3 个 bug，端口 3082，版本 1.1.0。'
  assert.equal(redactText(s), s)
})
check('scanSensitive 返回类型且不返回原文', () => {
  const t = scanSensitive('ghp_abcdefghijklmnopqrstuvwxyz0123456789 10.1.2.3')
  assert.ok(t.includes('github-token'))
  assert.ok(t.includes('private-ip'))
  assert.ok(!JSON.stringify(t).includes('ghp_'))
})
check('redactEntry 递归脱敏', () => {
  const e = { title: 'a@b.com', evidence: { files: ['C:\\Users\\alice\\x'] }, n: 3 }
  const o = redactEntry(e)
  assert.match(o.title, /REDACTED:email/)
  assert.match(o.evidence.files[0], /REDACTED:home-path/)
  assert.equal(o.n, 3)
})
check('显式关闭才关闭脱敏', () => {
  const old = process.env.DSH_MANUSCRIPT_REDACT
  process.env.DSH_MANUSCRIPT_REDACT = '0'
  try { assert.equal(redactionEnabled(), false); assert.equal(redactText('a@b.com'), 'a@b.com') }
  finally { if (old === undefined) delete process.env.DSH_MANUSCRIPT_REDACT; else process.env.DSH_MANUSCRIPT_REDACT = old }
})

const oldT1 = process.env.DSH_MANUSCRIPT_T1
process.env.DSH_MANUSCRIPT_T1 = '0'
try {
  const r = await distillBatch([{ sid: 's1' }], { llm: { stream() { throw new Error('should not call') } } })
  check('T1 可显式禁用', () => { assert.match(String(r.error), /T1 已禁用/) })
} finally {
  if (oldT1 === undefined) delete process.env.DSH_MANUSCRIPT_T1
  else process.env.DSH_MANUSCRIPT_T1 = oldT1
}

console.log(`\n结果：${pass} 通过 / 0 失败 / 共 ${pass}`)
