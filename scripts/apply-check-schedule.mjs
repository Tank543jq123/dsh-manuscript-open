#!/usr/bin/env node
/**
 * apply-check-schedule.mjs —— 把「巡检设置」翻译成真实的 systemd 调度（2026-11-12）。
 *
 * ## 它存在的理由
 *
 * 面板里存的是 `~/.dsh/dsh-manuscript/check-settings.json`，但真正决定"几点跑"的是
 * `manuscript-daily-check.timer` 的 `OnCalendar=`。两个地方都能改 = 迟早不一致。
 * 所以只留一条通路：**面板写文件 → systemd path unit 触发本脚本 → 脚本改 timer**。
 * 服务端不调 systemctl，本脚本也不碰 HTTP —— 各自只做一件事。
 *
 * ## 为什么同时写「仓库源文件」和「用户目录里的副本」（2026-11-12 实测修正）
 *
 * 最初以为 `~/.config/systemd/user/manuscript-daily-check.timer` 是指向仓库的软链，
 * 于是"写仓库文件就够了"。实测（systemd 259）推翻了这个前提：
 *
 *   `systemctl --user disable` 对 **linked unit**（搜索路径里的软链）不是只删
 *   `timers.target.wants`，而是**连软链本身一起删掉**（日志原文：
 *   `Removed '~/.config/systemd/user/manuscript-daily-check.timer'`）。
 *   删完 `is-enabled` 变 `not-found`，`systemctl cat` 也读不到 —— 再 enable 会失败，
 *   面板上"关掉再打开"这条路直接断掉。
 *   更根本的是：linked unit 的 `is-enabled` 只会回 `linked`，永远不会回 `disabled`，
 *   「已停用」这个状态在 systemd 自己的词汇里根本无法表达。
 *
 * 所以 timer 改成**用户目录里的实文件**（仓库文件是模板/源）：
 *   · 脚本先重写仓库源（仓库仍是为什么是 07:00 的真相），
 *   · 再原子复制到 `~/.config/systemd/user/manuscript-daily-check.timer`，
 *   · 之后 enable/disable 才是 systemd 语义里的 enabled / disabled。
 * 首次跑会把老的软链一次性换成实文件，并在 journal 里说明。
 * （service 单元保持软链不动 —— 它从不需要 disable。）
 *
 * ## 它做什么（顺序不能换）
 *
 *   ① 读设置（缺失/损坏 → 默认 07:00 启用，并打印警告，不静默）
 *   ② 改写仓库 timer 的 OnCalendar 行，并落到 ~/.config/systemd/user（实文件）
 *   ③ `systemctl --user daemon-reload`（不 reload，systemd 还拿旧 unit 跑）
 *   ④ enabled ? `enable --now` : `disable --now`
 *   ⑤ 打印实际状态（is-enabled + list-timers + cat 里读回来的 OnCalendar）
 *
 * 每一步失败都走 stderr + 非零退出码：path unit 会把失败记进 journal，
 * 而不是让"设置看起来生效了"。
 *
 * 用法：
 *   node scripts/apply-check-schedule.mjs            # 正常路径（path unit 调它）
 *   node scripts/apply-check-schedule.mjs --dry-run  # 只打印将要做什么
 */

import { readFileSync, writeFileSync, renameSync, existsSync, lstatSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const TIMER_FILE = join(REPO, 'systemd', 'manuscript-daily-check.timer')
/** systemd 真正加载的那个文件（用户目录）。测试可用 DSH_MANUSCRIPT_UNIT_DIR 隔离。 */
const UNIT_DIR = process.env.DSH_MANUSCRIPT_UNIT_DIR || join(homedir(), '.config', 'systemd', 'user')
const TIMER_LIVE = join(UNIT_DIR, 'manuscript-daily-check.timer')
const LIB_ROOT = process.env.DSH_MANUSCRIPT_ROOT || join(homedir(), '.dsh', 'dsh-manuscript')
const SETTINGS_FILE = join(LIB_ROOT, 'check-settings.json')
const SYSTEMCTL = process.env.DSH_MANUSCRIPT_SYSTEMCTL || 'systemctl'
const DRY_RUN = process.argv.includes('--dry-run')

const DEFAULT_SETTINGS = { enabled: true, time: '07:00' }
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function log(msg) {
  console.log(`[apply-check-schedule] ${msg}`)
}

function warn(msg) {
  console.warn(`[apply-check-schedule] 警告：${msg}`)
}

function die(msg, code = 1) {
  console.error(`[apply-check-schedule] 失败：${msg}`)
  process.exit(code)
}

// ── ① 读设置 ────────────────────────────────────────────────────────────────
function readSettings() {
  const settings = { ...DEFAULT_SETTINGS }
  if (!existsSync(SETTINGS_FILE)) {
    log(`设置文件不存在（${SETTINGS_FILE}），按默认值 ${DEFAULT_SETTINGS.time} / 启用`)
    return settings
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
  } catch (e) {
    warn(`设置文件无法解析（${e?.message || e}），按默认值 ${DEFAULT_SETTINGS.time} / 启用`)
    return settings
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`设置文件内容不是对象，按默认值 ${DEFAULT_SETTINGS.time} / 启用`)
    return settings
  }
  if (typeof raw.enabled === 'boolean') settings.enabled = raw.enabled
  else if (raw.enabled !== undefined) warn(`enabled 不是布尔值，回落为 ${DEFAULT_SETTINGS.enabled}`)
  if (typeof raw.time === 'string' && TIME_RE.test(raw.time)) settings.time = raw.time
  else if (raw.time !== undefined) warn(`time 不是合法 HH:MM，回落为 ${DEFAULT_SETTINGS.time}`)
  return settings
}

// ── ② 改写 timer（仓库源 + 用户目录实文件）─────────────────────────────────
function assertCalendar(text, line, where) {
  if (!new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(text)) {
    die(`回读校验失败：${where} 里没有 ${line}`)
  }
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

function rewriteTimer(time) {
  if (!existsSync(TIMER_FILE)) die(`找不到 timer 源文件 ${TIMER_FILE}`)
  const before = readFileSync(TIMER_FILE, 'utf8')
  const line = `OnCalendar=*-*-* ${time}:00`
  if (!/^OnCalendar=.*$/m.test(before)) die(`${TIMER_FILE} 里没有 OnCalendar= 行，不猜、不插`)
  const after = before.replace(/^OnCalendar=.*$/m, line)
  const oldLine = /^OnCalendar=.*$/m.exec(before)?.[0] || '(无)'

  if (DRY_RUN) {
    log(`[dry-run] ${TIMER_FILE}: ${oldLine} → ${line}（不写盘）`)
    log(`[dry-run] ${TIMER_LIVE}：写实文件（若仍是软链则替换）`)
    return { oldLine, newLine: line }
  }

  if (after !== before) {
    // 与设置文件同一套原子写法：崩在中间不会留下半个 unit 文件。
    atomicWrite(TIMER_FILE, after)
    assertCalendar(readFileSync(TIMER_FILE, 'utf8'), line, TIMER_FILE)
    log(`仓库源 ${oldLine} → ${line}`)
  } else {
    log(`仓库源 OnCalendar 已是 ${line}，无需改写`)
  }

  // 用户目录：linked unit 的 disable 会把软链删掉（见文件头），所以这里是实文件。
  // 老安装是软链 —— 第一次跑就原地换成实文件，让系统状态自愈而不是靠人记得。
  let liveIsLink = false
  try {
    liveIsLink = lstatSync(TIMER_LIVE).isSymbolicLink()
  } catch {
    liveIsLink = false
  }
  if (liveIsLink) {
    rmSync(TIMER_LIVE, { force: true })
    log(`${TIMER_LIVE} 原本是软链，已替换为实文件（linked unit 无法表达 disabled）`)
  }
  atomicWrite(TIMER_LIVE, readFileSync(TIMER_FILE, 'utf8'))
  assertCalendar(readFileSync(TIMER_LIVE, 'utf8'), line, TIMER_LIVE)
  log(`用户目录 ${TIMER_LIVE} 已同步为 ${line}`)
  return { oldLine, newLine: line }
}

// ── ③④ systemctl ───────────────────────────────────────────────────────────
function systemctl(args, label) {
  if (DRY_RUN) {
    log(`[dry-run] ${SYSTEMCTL} --user ${args.join(' ')}`)
    return ''
  }
  try {
    return execFileSync(SYSTEMCTL, ['--user', ...args], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (e) {
    const detail = String(e?.stderr || '').trim() || e?.message || String(e)
    die(`${label}（${SYSTEMCTL} --user ${args.join(' ')}）：${detail}`)
    return ''
  }
}

/**
 * 只查询、不判死。
 *
 * `is-enabled` 在 disabled 时退出码是 1、`is-active` 在 inactive 时是 3 ——
 * 用上面那个「非零就 die」的版本查状态，会把"已停用"这件**正常结果**报成失败。
 */
function systemctlQuery(args) {
  if (DRY_RUN) return ''
  try {
    return execFileSync(SYSTEMCTL, ['--user', ...args], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (e) {
    // 非零退出时 stdout 仍可能带着状态词（如 "disabled"），优先用它。
    const out = String(e?.stdout || '').trim()
    if (out) return out
    return `(查询失败：${String(e?.stderr || e?.message || e).trim()})`
  }
}

// ── ⑤ 打印实际状态 ─────────────────────────────────────────────────────────
function reportStatus() {
  const enabled = systemctlQuery(['is-enabled', 'manuscript-daily-check.timer'])
  const active = systemctlQuery(['is-active', 'manuscript-daily-check.timer'])
  log(`is-enabled=${enabled || '(空)'} is-active=${active || '(空)'}`)
  const cat = systemctlQuery(['cat', 'manuscript-daily-check.timer'])
  const calendar = /^OnCalendar=.*$/m.exec(cat)?.[0] || '(读不到 OnCalendar)'
  log(`systemctl cat 实际生效的：${calendar}`)
  if (!DRY_RUN) {
    const timers = systemctlQuery(['list-timers', 'manuscript-daily-check.timer', '--all', '--no-pager'])
    log(`list-timers：\n${timers}`)
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const settings = readSettings()
log(`设置：enabled=${settings.enabled} time=${settings.time}（${SETTINGS_FILE}）`)
const changed = rewriteTimer(settings.time)
if (!DRY_RUN) {
  systemctl(['daemon-reload'], 'daemon-reload 失败')
  if (settings.enabled) {
    systemctl(['enable', '--now', 'manuscript-daily-check.timer'], '启用 timer 失败')
  } else {
    systemctl(['disable', '--now', 'manuscript-daily-check.timer'], '停用 timer 失败')
    // stop 之后残留的 failed 是上一次异常的历史痕迹，不是这次的结果；
    // 不清掉的话，面板/脚本会把「已停用」读成「失败」，排查时方向全错。
    systemctlQuery(['reset-failed', 'manuscript-daily-check.timer'])
  }
}
reportStatus()
log(`完成：${settings.enabled ? `已启用，每天 ${settings.time}` : '已停用'}（${changed.oldLine} → ${changed.newLine}）`)
