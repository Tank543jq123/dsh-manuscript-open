/**
 * P0-1 隐私防线：在**送模型**与**入册落盘**之前做确定性脱敏。
 *
 * 这不是"识别所有敏感信息"的银弹；它覆盖最容易泄漏且可稳定识别的几类：
 *   · 私钥 / GitHub / OpenAI / AWS token / Bearer / 密码赋值
 *   · 私有 IPv4、邮箱、本机 home 路径、SSH 目标
 *
 * 设计原则：
 *   1. 确定性替换，不依赖模型；
 *   2. 可测试、可解释（返回命中类型）；
 *   3. 默认开启；只有显式 `DSH_MANUSCRIPT_REDACT=0` 才关闭。
 *   4. 只做"减少泄漏面"，不承诺把自然语言里的个人姓名等全部抹掉。
 */

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g
const OPENAI_TOKEN = /\bsk-[A-Za-z0-9_-]{20,}\b/g
const AWS_KEY = /\bAKIA[0-9A-Z]{16}\b/g
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/gi
const GENERIC_SECRET = /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"`]?[^\s'"`]{6,}/gi
const PRIVATE_IP = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const HOME_POSIX = /(?:\/home|\/Users)\/[A-Za-z0-9._-]+/g
const HOME_WIN = /\b[A-Za-z]:\\Users\\[^\\\s]+/g
const SSH_TARGET = /\bssh\s+[A-Za-z0-9._-]+@[A-Za-z0-9._-]+/gi

const RULES = [
  ['private-key', PRIVATE_KEY],
  ['github-token', GITHUB_TOKEN],
  ['openai-token', OPENAI_TOKEN],
  ['aws-key', AWS_KEY],
  ['bearer', BEARER],
  ['generic-secret', GENERIC_SECRET],
  ['ssh-target', SSH_TARGET],
  ['private-ip', PRIVATE_IP],
  ['email', EMAIL],
  ['home-path', HOME_POSIX],
  ['home-path', HOME_WIN],
]

/** 是否关闭脱敏。默认开启；只有显式 0/false 才关闭。 */
export function redactionEnabled() {
  return !/^(0|false|no)$/i.test(String(process.env.DSH_MANUSCRIPT_REDACT ?? ''))
}

/**
 * 返回命中的敏感类型（去重）。用于日志/审计；不返回原文。
 * @param {string} text
 * @returns {string[]}
 */
export function scanSensitive(text) {
  const s = String(text ?? '')
  const hit = new Set()
  for (const [name, re] of RULES) {
    re.lastIndex = 0
    if (re.test(s)) hit.add(name)
  }
  return [...hit]
}

/**
 * 确定性脱敏。关闭时原样返回；命中类型可由 `scanSensitive` 单独查。
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  let s = String(text ?? '')
  if (!redactionEnabled() || !s) return s
  for (const [name, re] of RULES) {
    s = s.replace(re, `[REDACTED:${name}]`)
  }
  return s
}

/** 递归脱敏条目里的字符串字段（id/时间戳等短字段也会走，但无命中不改）。 */
export function redactEntry(value) {
  if (!redactionEnabled()) return value
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redactEntry)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactEntry(v)
    return out
  }
  return value
}
