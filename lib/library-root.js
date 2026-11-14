/**
 * 书库根解析：面板配置 → 环境变量 → 默认路径。
 *
 * ## 为什么单独一个模块
 *
 * 旧实现把 `~/.dsh/dsh-manuscript` 写死在 `library.js` 的 `defaultLibraryRoot()` 里，
 * 全仓 20 多处调用都跟着它走 —— 这是「路径不可配」的根因。现在解析规则集中在这里，
 * `defaultLibraryRoot()` 只做一次转发，所有调用点自动获得新能力。
 *
 * ## 优先级（不可随意调换）
 *
 *   1. `DSH_MANUSCRIPT_ROOT` —— 显式硬覆盖。测试/CI/运维靠它隔离真实库；
 *      如果让面板配置压过它，任何测试都可能被本机配置文件带到真实库上。
 *   2. 面板配置 `~/.dsh/dsh-manuscript-config.json` 的 `root`
 *   3. `~/.dsh/dsh-manuscript`
 *
 * ## 失败策略
 *
 * 配置坏掉（JSON 截断、root 不是绝对路径、root 不存在）时**回退**并留下 warning，
 * 绝不抛错。书阁是常驻插件，一个坏配置文件不该让整个宿主装配失败。
 */

import { existsSync, statSync, readFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, isAbsolute, resolve } from 'node:path'
import { writeFileAtomic } from './atomic.js'

/** 默认配置文件路径（不在库根里：库根是配置的结果，放进去会形成循环依赖）。 */
export function defaultConfigFile(env = process.env) {
  const override = String(env?.DSH_MANUSCRIPT_CONFIG || '').trim()
  if (override) return isAbsolute(override) ? override : resolve(override)
  return join(homedir(), '.dsh', 'dsh-manuscript-config.json')
}

/** 默认库根。保持与改动前完全一致：`~/.dsh/dsh-manuscript`。 */
export function fallbackLibraryRoot() {
  return join(homedir(), '.dsh', 'dsh-manuscript')
}

/**
 * 判断一个路径能不能作为库根。只做**形状**校验，不创建目录。
 * @param {unknown} root
 * @returns {{ok:true, root:string} | {ok:false, reason:string}}
 */
export function normalizeLibraryRoot(root) {
  const raw = String(root ?? '').trim()
  if (!raw) return { ok: false, reason: '路径为空' }
  if (raw.includes('\0')) return { ok: false, reason: '路径含 NUL 字符' }
  if (!isAbsolute(raw)) return { ok: false, reason: `必须是绝对路径（收到 ${raw}）` }
  return { ok: true, root: resolve(raw) }
}

// ── 配置读取缓存 ──────────────────────────────────────────────────────────
//
// `defaultLibraryRoot()` 会被 HTTP 请求、工具调用、扫描反复调用。每次都 readFileSync
// 配置虽小，但没必要；用 mtime+size 做失效判据，改文件后下一次调用立刻生效。
const configCache = new Map() // configPath -> {mtimeMs, size, value}

function readConfigFile(file) {
  let st
  try {
    st = statSync(file)
  } catch {
    return null
  }
  const cached = configCache.get(file)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.value
  }
  let value
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    value = { parsed, error: null }
  } catch (e) {
    value = { parsed: null, error: `配置无法解析：${e?.message || String(e)}` }
  }
  configCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value })
  return value
}

/**
 * 读取当前生效的库根与来源。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{logger?: object}} [opts]
 * @returns {{
 *   root:string, source:'env'|'config'|'default', configFile:string,
 *   envOverride:boolean, configRoot:(string|null), warnings:string[]
 * }}
 */
export function readLibraryConfig(env = process.env, opts = {}) {
  const logger = opts.logger
  const warnings = []
  const configFile = defaultConfigFile(env)

  const envRootRaw = String(env?.DSH_MANUSCRIPT_ROOT || '').trim()
  if (envRootRaw) {
    const n = normalizeLibraryRoot(envRootRaw)
    if (n.ok) {
      return {
        root: n.root,
        source: 'env',
        configFile,
        envOverride: true,
        configRoot: null,
        warnings,
      }
    }
    warnings.push(`DSH_MANUSCRIPT_ROOT 非法（${n.reason}），忽略该环境变量`)
  }

  let configRoot = null
  const loaded = readConfigFile(configFile)
  if (loaded?.error) {
    warnings.push(`${configFile} ${loaded.error}`)
  } else if (loaded?.parsed) {
    const parsed = loaded.parsed
    if (parsed && typeof parsed === 'object' && parsed.root != null) {
      const n = normalizeLibraryRoot(parsed.root)
      if (!n.ok) {
        warnings.push(`配置文件 root 非法（${n.reason}），已回退默认路径`)
      } else if (!existsSync(n.root) || !statSync(n.root).isDirectory()) {
        // 路径不存在不阻断装配：库可能刚被移走/挂载未就绪。回退默认并显式告警。
        warnings.push(`配置的库根不存在或不是目录（${n.root}），已回退默认路径`)
      } else {
        configRoot = n.root
      }
    } else {
      warnings.push(`配置文件缺少字符串字段 root，已回退默认路径`)
    }
  } else if (loaded && !loaded.parsed && !loaded.error) {
    warnings.push(`配置文件为空，已回退默认路径`)
  }

  for (const w of warnings) {
    logger?.warn?.('[dsh-manuscript] 库路径配置：%s', w)
  }

  if (configRoot) {
    return {
      root: configRoot,
      source: 'config',
      configFile,
      envOverride: false,
      configRoot,
      warnings,
    }
  }
  return {
    root: fallbackLibraryRoot(),
    source: 'default',
    configFile,
    envOverride: false,
    configRoot,
    warnings,
  }
}

/**
 * 只取库根字符串。给 `defaultLibraryRoot()` 用。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveLibraryRoot(env = process.env) {
  return readLibraryConfig(env).root
}

/**
 * 写面板配置。只写配置文件，不建库、不搬数据。
 *
 * @param {string} root 绝对路径
 * @param {{env?: NodeJS.ProcessEnv, configFile?: string}} [opts]
 * @returns {{ok:true, configFile:string, root:string} | {ok:false, error:string}}
 */
export function writeLibraryConfig(root, opts = {}) {
  const n = normalizeLibraryRoot(root)
  if (!n.ok) return { ok: false, error: n.reason }
  const configFile = opts.configFile || defaultConfigFile(opts.env || process.env)
  try {
    mkdirSync(dirname(configFile), { recursive: true })
    writeFileAtomic(configFile, JSON.stringify({ version: 1, root: n.root }, null, 2) + '\n')
    configCache.delete(configFile)
    return { ok: true, configFile, root: n.root }
  } catch (e) {
    return { ok: false, error: `写配置失败：${e?.message || String(e)}` }
  }
}
