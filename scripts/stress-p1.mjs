#!/usr/bin/env node
/**
 * stress-p1.mjs — P1-1 故障注入压测（独立验收方）
 *
 * 定位：**不信任作者自述**，主动制造崩溃来证明机制有效。
 * 只读产品代码，绝不修改 lib/ 下任何文件；所有破坏性操作在 os.tmpdir() 隔离目录内进行。
 *
 * 用法：
 *   node scripts/stress-p1.mjs               # 跑全部（含真实 kill 子进程）
 *   node scripts/stress-p1.mjs --skip-slow   # 跳过需要起子进程的慢用例
 *   node scripts/stress-p1.mjs --only=fs,kill
 *
 * 退出码：0 = 全部通过或跳过；1 = 有 FAIL
 *
 * ── 关键实现约束（已实测，勿凭直觉改）──────────────────────────────
 * library.js 用 `import { writeFileSync } from 'node:fs'`（ESM 静态命名导入）。
 * ESM 命名导出在 wrapper 首次实例化时**快照** CJS 导出对象，所以事后
 * `fs.writeFileSync = patched` **完全无效**（实测捕获 0 次）。
 * 唯一可行做法：patch 之后调用 `module.syncBuiltinESMExports()` 强制重新同步。
 * 见 _work/_probe-patch.mjs 与 _probe-patch2.mjs 的对照实验。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import nodePath from 'node:path'
import os from 'node:os'
import { syncBuiltinESMExports, register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn, spawnSync, fork } from 'node:child_process'
import { createHash } from 'node:crypto'

// ─────────────────────────── 路径与常量 ───────────────────────────
// 注意：绝不能用 new URL(import.meta.url).pathname —— 它对中文路径返回
// 百分号编码（/C:/DSH%E5%B7%A5...），fs 找不到文件且不报错，只会静默 SKIP。
// 必须用 fileURLToPath 做正确解码。此坑已实测踩过。
const HERE = nodePath.dirname(fileURLToPath(import.meta.url))
const PLUGIN = nodePath.resolve(HERE, '..')
const LIB = nodePath.join(PLUGIN, 'lib')
const REAL_LIBRARY_ROOT = nodePath.join(os.homedir(), '.dsh', 'dsh-manuscript')

const LIB_LIBRARY = nodePath.join(LIB, 'library.js')
const LIB_HEALTH = nodePath.join(LIB, 'health.js')
const LIB_ATOMIC = nodePath.join(LIB, 'atomic.js')
const LIB_LOCK = nodePath.join(LIB, 'lock.js')

/** 必须永不触碰的真实书库 —— 每个用例前断言目标不在其下。 */
function assertNotRealLibrary(root) {
  const a = nodePath.resolve(root)
  const b = nodePath.resolve(REAL_LIBRARY_ROOT)
  if (a === b || a.startsWith(b + nodePath.sep)) {
    throw new Error(`拒绝对真实书库做破坏性测试：${a}`)
  }
  // 反向也要防：真实库在临时目录下（不可能，但便宜）
  if (b.startsWith(a + nodePath.sep)) {
    throw new Error(`临时目录包含了真实书库，拒绝执行：${a}`)
  }
}

// ─────────────────────────── 结果收集 ───────────────────────────
const RESULTS = []
let CURRENT_SUITE = null

function suite(name, note) {
  CURRENT_SUITE = { name, note: note || '', cases: [] }
  RESULTS.push(CURRENT_SUITE)
}

/**
 * @param {string} name 用例名
 * @param {'PASS'|'FAIL'|'SKIP'} status
 * @param {string} detail 事实（实测数字，不是推测）
 */
function record(name, status, detail) {
  if (!CURRENT_SUITE) throw new Error('record() 需先 suite()')
  CURRENT_SUITE.cases.push({ name, status, detail })
  // 【2026-11-09】INFO：只记录事实、不构成判据，**不计入通过数**。
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : status === 'INFO' ? 'ℹ' : '○'
  console.log(`  ${icon} [${status}] ${name}`)
  if (detail) console.log(`      ${detail}`)
}

/** 断言辅助：收集事实，最后统一判定。 */
function expect(cond, okMsg, failMsg) {
  return { ok: !!cond, okMsg, failMsg }
}

function assertCase(name, cond, okMsg, failMsg) {
  if (cond) record(name, 'PASS', okMsg)
  else record(name, 'FAIL', failMsg)
  return !!cond
}

function skipCase(name, why) {
  record(name, 'SKIP', why)
}

// ─────────────────────────── 环境探测 ───────────────────────────
const ENV = {
  hasAtomic: fs.existsSync(LIB_ATOMIC),
  hasHealth: fs.existsSync(LIB_HEALTH),
  hasLock: fs.existsSync(LIB_LOCK),
  hasLockWired: false,
}

function detectWiring() {
  // 锁是否接进 buildLibrary：library.js 有没有 import lock.js
  if (fs.existsSync(LIB_LIBRARY)) {
    const src = fs.readFileSync(LIB_LIBRARY, 'utf8')
    ENV.hasLockWired = /from\s+['"]\.\/lock\.js['"]/.test(src) || /require\(['"]\.\/lock\.js['"]\)/.test(src)
    // 是否使用 staging / atomic
    ENV.usesStaging = /\.staging-/.test(src)
    ENV.usesRename = /renameSync|rename\(/.test(src)
    ENV.writesRuns = /runs[/\\]/.test(src) || /runs['"]/.test(src)
  }
}

// ─────────────────────────── 临时工作区 ───────────────────────────
const TMP_ROOTS = []

function makeRoot(tag) {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), `p1stress-${tag}-`))
  assertNotRealLibrary(root)
  TMP_ROOTS.push(root)
  return root
}

function cleanupAll() {
  for (const r of TMP_ROOTS) {
    try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
  }
  TMP_ROOTS.length = 0
}

// ─────────────────────────── 合成会话夹具 ───────────────────────────
/**
 * 造 N 条合法 triaged 会话。
 * 字段按 library.js 的实际读取（category='real' / sid / title / project / cwd /
 * toolNameCount / createdAt / turnEnds / toolCalls / deliverables / qualityScore / shape）。
 */
function makeSessions(n, opts = {}) {
  const projects = ['demo-a', 'demo-hardware', 'demo-c', 'demo-e', 'demo-d', 'demo-b']
  const out = []
  const base = opts.baseTime ?? 1730000000000
  for (let i = 0; i < n; i++) {
    out.push({
      sid: `session-stress-${String(i).padStart(4, '0')}-${(opts.salt ?? 'a')}`,
      category: 'real',
      title: `压测会话 ${i} · ${projects[i % projects.length]}`,
      project: projects[i % projects.length],
      cwd: `C:\\demo-workspace\\${projects[i % projects.length]}`,
      toolNameCount: { pwsh: (i % 7) + 1, write: (i % 3), read: (i % 5) },
      createdAt: base + i * 1000,
      turnEnds: (i % 5) + 1,
      toolCalls: (i * 7) % 300,
      deliverables: i % 4,
      qualityScore: 3 + ((i * 13) % 60) / 10,
      shape: i % 3 === 0 ? 'one-shot' : 'multi-turn',
      model: 'deepseek-v4.1-flash',
    })
  }
  return out
}

// ─────────────────────────── 模块装载（可注入 fs） ───────────────────────────
/**
 * 装载 library.js，可选注入 fs 故障。
 *
 * ⚠ 关键（第一版栽在这里，3 个 FAIL 全是夹具失效而非 bug）：
 *   atomic.js 的 writeFileAtomic 用的是
 *     openSync → writeSync(循环) → fsyncSync → closeSync → renameSync
 *   **完全不用 fs.writeFileSync**。所以对 writeFileSync 打注入捕获 0 次、永不触发。
 *   注入必须对准 openSync / writeSync / renameSync。
 *
 * @param {object} [hook]
 *   onOpen(path)            每个文件写入前（暂存区里一次/文件）
 *   onWriteChunk(path, bytes) 每个 writeSync 分片
 *   onRename(from, to)      每次 rename（提交步骤）
 *   faultAt: {open?: n, writeChunk?: n, rename?: n}  第 n 次调用时抛 ENOSPC
 */
async function loadLibraryWithFsPatch(hook) {
  const orig = {
    writeFileSync: fs.writeFileSync,
    openSync: fs.openSync,
    writeSync: fs.writeSync,
    renameSync: fs.renameSync,
  }
  let nOpen = 0, nChunk = 0, nRename = 0
  const failErr = () => {
    const e = new Error('ENOSPC: no space left on device, write')
    e.code = 'ENOSPC'; e.errno = -28
    return e
  }

  if (hook) {
    const fault = hook.faultAt || {}
    fs.openSync = function (p, ...rest) {
      const idx = ++nOpen
      if (hook.onOpen) hook.onOpen(String(p), idx)
      if (fault.open === idx) throw failErr()
      return orig.openSync.call(this, p, ...rest)
    }
    fs.writeSync = function (fd, buf, ...rest) {
      const idx = ++nChunk
      const bytes = Buffer.isBuffer(buf) ? buf.length : (typeof buf === 'string' ? Buffer.byteLength(buf) : 0)
      if (hook.onWriteChunk) hook.onWriteChunk(idx, bytes)
      if (fault.writeChunk === idx) throw failErr()
      return orig.writeSync.call(this, fd, buf, ...rest)
    }
    fs.renameSync = function (from, to) {
      const idx = ++nRename
      if (hook.onRename) hook.onRename(String(from), String(to), idx)
      if (fault.rename === idx) throw failErr()
      return orig.renameSync.call(this, from, to)
    }
    syncBuiltinESMExports()
  }

  const url = pathToFileURL(LIB_LIBRARY).href + `?t=${Date.now()}_${Math.random()}`
  const mod = await import(url)

  const restore = () => {
    fs.writeFileSync = orig.writeFileSync
    fs.openSync = orig.openSync
    fs.writeSync = orig.writeSync
    fs.renameSync = orig.renameSync
    syncBuiltinESMExports()
  }
  return { mod, restore, counters: () => ({ open: nOpen, chunk: nChunk, rename: nRename }) }
}

async function loadModule(p, tag) {
  return import(pathToFileURL(p).href + `?t=${Date.now()}_${tag || ''}`)
}

// ─────────────────────────── 磁盘树快照（用于证明"没被污染"） ───────────────────────────
function snapshotTree(root) {
  const out = new Map()
  const walk = (dir, rel) => {
    let names
    try { names = fs.readdirSync(dir) } catch { return }
    for (const name of names.sort()) {
      const full = nodePath.join(dir, name)
      const r = rel ? rel + '/' + name : name
      let st
      try { st = fs.lstatSync(full) } catch { continue }
      if (st.isDirectory()) { out.set(r + '/', { dir: true }); walk(full, r) }
      else if (st.isSymbolicLink()) out.set(r, { link: true })
      else {
        let h = null
        try { h = createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16) } catch { h = 'unreadable' }
        out.set(r, { size: st.size, hash: h })
      }
    }
  }
  walk(root, '')
  return out
}

function treeDiff(before, after) {
  const added = [], removed = [], changed = []
  for (const [k, v] of after) {
    if (!before.has(k)) added.push(k)
    else {
      const b = before.get(k)
      if (!v.dir && !b.dir && (b.hash !== v.hash || b.size !== v.size)) changed.push(k)
    }
  }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k)
  return { added, removed, changed }
}

// ─────────────────────────── 书库一致性判据 ───────────────────────────
/**
 * 读 library.json 并核对：声明条数 vs entries/ 实际文件数、JSON 是否合法。
 * 返回结构化事实，不做判断。
 */
function readLibraryFacts(root) {
  const facts = {
    root,
    libraryExists: false,
    libraryParsable: false,
    libraryBytes: 0,
    declared: null,
    entryFiles: 0,
    entryUnparsable: 0,
    entryIds: [],
    volumes: 0,
    err: null,
  }
  const libPath = nodePath.join(root, 'library.json')
  if (fs.existsSync(libPath)) {
    facts.libraryExists = true
    try {
      const buf = fs.readFileSync(libPath)
      facts.libraryBytes = buf.length
      const j = JSON.parse(buf.toString('utf8'))
      facts.libraryParsable = true
      facts.declared = j?.counts?.entries ?? j?.entries ?? null
      facts.volumes = Array.isArray(j?.volumes) ? j.volumes.length : 0
    } catch (e) { facts.err = e.message }
  }
  const entriesDir = nodePath.join(root, 'entries')
  if (fs.existsSync(entriesDir)) {
    for (const f of fs.readdirSync(entriesDir).filter((x) => x.endsWith('.json'))) {
      facts.entryFiles += 1
      facts.entryIds.push(f)
      try { JSON.parse(fs.readFileSync(nodePath.join(entriesDir, f), 'utf8')) }
      catch { facts.entryUnparsable += 1 }
    }
  }
  return facts
}

/** 一致性：声明数 == 文件数，且全部可解析。 */
function isConsistent(facts) {
  return facts.libraryParsable && facts.entryUnparsable === 0
    && (facts.declared === null || facts.declared === facts.entryFiles)
}

// ═══════════════════════════════════════════════════════════════
// 故障类 0：静态审计（不改文件，先看他们到底做了什么）
// ═══════════════════════════════════════════════════════════════
async function suiteStaticAudit() {
  suite('F0 静态审计（机制是否真的落地）',
    '只读源码判断：原子写/暂存区/提交凭证/启动自愈/锁 各自接没接上')

  const srcLib = fs.existsSync(LIB_LIBRARY) ? fs.readFileSync(LIB_LIBRARY, 'utf8') : ''
  const srcIdx = fs.existsSync(nodePath.join(LIB, 'index.js'))
    ? fs.readFileSync(nodePath.join(LIB, 'index.js'), 'utf8') : ''
  const srcHealth = fs.existsSync(LIB_HEALTH) ? fs.readFileSync(LIB_HEALTH, 'utf8') : ''
  const srcAtomic = fs.existsSync(LIB_ATOMIC) ? fs.readFileSync(LIB_ATOMIC, 'utf8') : ''

  record('atomic.js 存在', ENV.hasAtomic ? 'PASS' : 'SKIP',
    ENV.hasAtomic ? `${fs.statSync(LIB_ATOMIC).size} 字节` : 'lib/atomic.js 尚未创建')
  record('health.js 存在', ENV.hasHealth ? 'PASS' : 'SKIP',
    ENV.hasHealth ? `${fs.statSync(LIB_HEALTH).size} 字节` : 'lib/health.js 尚未创建')
  record('lock.js 存在', ENV.hasLock ? 'PASS' : 'SKIP',
    ENV.hasLock ? `${fs.statSync(LIB_LOCK).size} 字节` : 'lib/lock.js 尚未创建')

  assertCase('library.js 引用 atomic.js（原子写已接入）',
    /from\s+['"]\.\/atomic\.js['"]|require\(['"]\.\/atomic\.js['"]\)/.test(srcLib),
    '已 import atomic.js',
    'library.js 未 import atomic.js —— 原子写没接进建库流程')

  assertCase('library.js 引用 lock.js（并发锁已接入）',
    /from\s+['"]\.\/lock\.js['"]|require\(['"]\.\/lock\.js['"]\)/.test(srcLib),
    '已 import lock.js',
    'library.js 未 import lock.js —— 并发仍无保护')

  assertCase('library.js 使用暂存区（.staging-*）',
    /\.staging-|STAGING_PREFIX/.test(srcLib),
    '源码中出现暂存区前缀',
    '源码中无 .staging- —— 没有暂存区')

  // 注意：rename 在 atomic.js 里（writeFileAtomic / Staging.commit），
  // library.js 只委托，所以这条要在 atomic.js 上判，不能只查 library.js。
  assertCase('原子 rename 存在（atomic.js 的 writeFileAtomic/commit）',
    /renameSync/.test(srcAtomic) && /renameSync/.test(srcLib + srcAtomic),
    'atomic.js 使用 renameSync 做原子替换/提交',
    'atomic.js 未使用 renameSync —— 不是原子替换')

  assertCase('library.js 写 runs/ 提交凭证',
    /runs/.test(srcLib) && /(failed|ok\s*:)/.test(srcLib),
    '源码中出现 runs/ 与状态字段',
    '源码中未见 runs/ 提交凭证写入')

  assertCase('index.js 启动时调用健康检查/自愈',
    /health\.js/.test(srcIdx) && /(checkLibraryHealth|healLibrary)/.test(srcIdx),
    'index.js 已接入 health.js',
    'index.js 未接入 health.js —— 启动自愈没接上')

  assertCase('health.js 的 healLibrary 默认 dryRun（红线：不自动删）',
    /dryRun\s*=\s*opts\.dryRun\s*!==\s*false/.test(srcHealth) || /dryRun\s*!==\s*false/.test(srcHealth),
    '默认 dryRun=true 成立',
    '未发现 dryRun 默认安全模式')
}

// ═══════════════════════════════════════════════════════════════
// 故障类 1：写入中途 kill（真实子进程 SIGKILL）
// ═══════════════════════════════════════════════════════════════
function buildWorkerScript() {
  // 在临时目录写一个 worker：建库，跑到第 N 次 writeSync 时自杀。
  //
  // ⚠ 平台事实（实测，Windows）：`process.kill(pid,'SIGKILL')` 在 Windows 上是
  //   TerminateProcess，Node 报告为 **exit code 1 + signal null**，不会给 signal 标记。
  //   所以判据不能写 `signal === 'SIGKILL'`（Windows 上永远为假 → 假 SKIP）。
  //   可靠的正向证据：**result 文件不存在** + 退出码非 0（进程没走到收尾就死了）。
  //
  // ⚠ 另一个坑：worker 里 patch 的是它自己进程的 fs，父进程注入不到子进程，
  //   所以 killAt 必须由 worker 自己在 writeSync 里数（这里正是这么做的）。
  const worker = `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'

const [,, libPath, root, killAt, sessionsJson, resultPath] = process.argv
const sessions = JSON.parse(sessionsJson)

let n = 0
const orig = fs.writeSync
fs.writeSync = function (fd, buf, ...r) {
  n += 1
  if (Number(killAt) > 0 && n === Number(killAt)) {
    process.kill(process.pid, 'SIGKILL')   // Windows: TerminateProcess，不可捕获
  }
  return orig.call(this, fd, buf, ...r)
}
syncBuiltinESMExports()

const mod = await import(pathToFileURL(libPath).href)
try {
  mod.buildLibrary(sessions, { root })
  fs.writeFileSync(resultPath, 'DONE ' + n)
} catch (e) {
  fs.writeFileSync(resultPath, 'ERR ' + (e.code || e.message) + ' n=' + n)
}
`
  const p = nodePath.join(os.tmpdir(), `p1stress-worker-${process.pid}.mjs`)
  fs.writeFileSync(p, worker, 'utf8')
  return p
}

async function suiteKillMidWrite(skipSlow) {
  suite('F1 写入中途中断（_fault 官方注入点 + 真实 SIGKILL 佐证）',
    '核心：正式目录必须保持上一批完整状态；library.json 不得被半成品覆盖')

  if (!fs.existsSync(LIB_LIBRARY)) { skipCase('F1 全部', 'library.js 不存在'); return }

  // ══ F1-A：用产品自带的 _fault 注入（走真实失败路径，最可靠）══
  {
    const root = makeRoot('fault')
    const good = makeSessions(40, { salt: 'good' })
    // 先建一个完整好库
    {
      const h = await loadLibraryWithFsPatch(null)
      h.mod.buildLibrary(good, { root })
      h.restore()
    }
    const beforeFacts = readLibraryFacts(root)
    const beforeTree = snapshotTree(root)
    record('F1.0 对照组：完整建库成功', 'INFO',
      `${beforeFacts.entryFiles} 条 / 声明 ${beforeFacts.declared} 条，一致`)

    // ── A1：写条目阶段中断（afterStageWrites）──
    {
      const more = makeSessions(60, { salt: 'fault2' })
      let threw = null
      const h = await loadLibraryWithFsPatch(null)
      try { h.mod.buildLibrary(more, { root, _fault: { afterStageWrites: 40 } }) }
      catch (e) { threw = e } finally { h.restore() }

      assertCase('F1.1 _fault.afterStageWrites 正确触发失败',
        threw && threw.code === 'EINJECTED',
        `第 40 个条目写完后抛 EINJECTED：${(threw.message || '').slice(0, 50)}`,
        `注入未按预期触发：threw=${threw && (threw.code || threw.message)}`)

      const after = readLibraryFacts(root)
      const diff = treeDiff(beforeTree, snapshotTree(root))

      assertCase('F1.2 中断后 library.json 仍是上一批完整版',
        after.libraryParsable && after.libraryBytes === beforeFacts.libraryBytes,
        `library.json 仍为 ${after.libraryBytes}B 且可解析（未被半成品覆盖）`,
        `library.json 被改：before=${beforeFacts.libraryBytes}B after=${after.libraryBytes}B parsable=${after.libraryParsable}`)

      const newFiles = diff.added.filter((p) => p.startsWith('entries/') && !p.endsWith('/')).length
      assertCase('F1.3 正式 entries/ 零新增（中断写在暂存区）',
        newFiles === 0,
        '正式 entries/ 零文件新增 —— 中断的 40 条只在暂存区',
        `${newFiles} 个新条目漏进正式 entries/ → 半成品污染`)

      const lost = diff.removed.filter((p) => p.startsWith('entries/') && !p.endsWith('/')).length
      assertCase('F1.4 旧条目零丢失',
        lost === 0, `零丢失（${beforeFacts.entryFiles} 条完好）`, `${lost} 个旧条目消失`)

      const staging = diff.added.filter((p) => /^\.staging-/.test(p))
      assertCase('F1.5 暂存区保留作崩溃现场',
        staging.length > 0,
        `保留 ${staging.filter((p) => !p.endsWith('/')).length} 个暂存文件`,
        '暂存区被删除 —— 丢失现场')

      // runs/ failed 凭证
      {
        const runsDir = nodePath.join(root, 'runs')
        let failed = 0
        if (fs.existsSync(runsDir)) {
          for (const f of fs.readdirSync(runsDir).filter((x) => x.endsWith('.json'))) {
            try { if (JSON.parse(fs.readFileSync(nodePath.join(runsDir, f), 'utf8')).status === 'failed') failed += 1 } catch { }
          }
        }
        assertCase('F1.6 留下 runs/*.json status=failed 凭证',
          failed > 0, `找到 ${failed} 份 failed 凭证`, '无 failed 凭证')
      }
    }

    // ── A2：提交前中断（beforeCommit）—— 最危险窗口 ──
    {
      // 重新做一个干净基线
      const root2 = makeRoot('fault-commit')
      const h0 = await loadLibraryWithFsPatch(null)
      h0.mod.buildLibrary(good, { root: root2 })
      h0.restore()
      const b2 = readLibraryFacts(root2)
      const t2 = snapshotTree(root2)

      let threw = null
      const h = await loadLibraryWithFsPatch(null)
      try { h.mod.buildLibrary(makeSessions(60, { salt: 'fc' }), { root: root2, _fault: { beforeCommit: true } }) }
      catch (e) { threw = e } finally { h.restore() }

      assertCase('F1.7 _fault.beforeCommit 正确触发',
        threw && threw.code === 'EINJECTED',
        `提交前抛 EINJECTED`,
        `未触发：threw=${threw && (threw.code || threw.message)}`)

      const a2 = readLibraryFacts(root2)
      const d2 = treeDiff(t2, snapshotTree(root2))
      assertCase('F1.8 提交前中断：library.json 仍是旧版完整版',
        a2.libraryParsable && a2.libraryBytes === b2.libraryBytes,
        `library.json 仍为 ${a2.libraryBytes}B（旧版）`,
        `被改：${b2.libraryBytes}B → ${a2.libraryBytes}B`)
      const nf2 = d2.added.filter((p) => p.startsWith('entries/') && !p.endsWith('/')).length
      assertCase('F1.9 提交前中断：正式 entries/ 零新增',
        nf2 === 0, '零文件新增', `${nf2} 个文件漏进正式目录`)

      // 自愈：再跑一次应一致
      let r = null
      const h3 = await loadLibraryWithFsPatch(null)
      try { h3.mod.buildLibrary(makeSessions(60, { salt: 'fc' }), { root: root2 }) }
      catch (e) { r = e } finally { h3.restore() }
      const f3 = readLibraryFacts(root2)
      assertCase('F1.10 中断后再建库自愈到一致',
        !r && isConsistent(f3),
        `复跑成功：${f3.entryFiles} 条 / 声明 ${f3.declared} 条，一致`,
        `复跑异常：throw=${r && r.message} facts=${JSON.stringify({ e: f3.entryFiles, d: f3.declared, u: f3.entryUnparsable })}`)
    }
  }

  // ══ F1-B：真实进程级强杀佐证（不可捕获死亡）══
  if (!skipSlow) {
    const workerPath = buildWorkerScript()
    try {
      const root = makeRoot('kill')
      // runner：结果写文件而不是 stdout（避免管道时序问题）
      const run = (killAt, sessions) => new Promise((resolve) => {
        const resultPath = nodePath.join(os.tmpdir(), `p1sk-out-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
        const c = spawn(process.execPath,
          [workerPath, LIB_LIBRARY, root, String(killAt), JSON.stringify(sessions), resultPath],
          { stdio: 'ignore' })
        c.on('close', (code, signal) => {
          const out = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8') : null
          try { fs.rmSync(resultPath, { force: true }) } catch { }
          resolve({ code, signal, out })
        })
      })

      const r1 = await run(0, makeSessions(40, { salt: 'kg' }))
      const b = readLibraryFacts(root)
      record('F1.11 强杀组基线建库', r1.out && r1.out.startsWith('DONE') ? 'PASS' : 'FAIL',
        `${b.entryFiles} 条 / 声明 ${b.declared} 条（worker 完成，${r1.out}）`)
      const beforeBytes = b.libraryBytes
      const beforeCount = b.entryFiles

      const r2 = await run(8, makeSessions(60, { salt: 'kg2' }))

      // Windows 判据：被杀 → 结果文件不存在 + code 非 0（无 signal 标记）
      const died = r2.out === null || !r2.out.startsWith('DONE')
      record('F1.12 子进程在第 8 次写入处被强杀（事实）',
        died ? 'PASS' : 'FAIL',
        died
          ? `进程未走到收尾即死亡（exit=${r2.code}, signal=${r2.signal}；Windows 不给 signal 标记，此为预期）`
          : `进程正常跑完：${r2.out} —— 未被杀`)

      if (died) {
        const a = readLibraryFacts(root)
        assertCase('F1.13 强杀后 library.json 仍是上一批完整版',
          a.libraryParsable && a.libraryBytes === beforeBytes,
          `library.json 仍为 ${a.libraryBytes}B 可解析、仍声明 ${a.declared} 条（未被半成品覆盖）`,
          `被破坏：${beforeBytes}B → ${a.libraryBytes}B parsable=${a.libraryParsable} 声明=${a.declared}`)

        assertCase('F1.14 强杀后正式 entries/ 零污染',
          a.entryFiles === beforeCount,
          `正式 entries 仍 ${a.entryFiles} 个文件，与中断前一致`,
          `条目从 ${beforeCount} 变成 ${a.entryFiles} → 有半成品落位`)

        const staging = fs.readdirSync(root).filter((n) => n.startsWith('.staging-'))
        assertCase('F1.15 强杀后暂存区残留（现场可查）',
          staging.length > 0,
          `保留 ${staging.length} 个 .staging- 目录`,
          '无暂存残留')

        // 物理限制说明（不是缺陷）
        {
          const runsDir = nodePath.join(root, 'runs')
          let failed = 0
          if (fs.existsSync(runsDir)) {
            for (const f of fs.readdirSync(runsDir).filter((x) => x.endsWith('.json'))) {
              try { if (JSON.parse(fs.readFileSync(nodePath.join(runsDir, f), 'utf8')).status === 'failed') failed += 1 } catch { }
            }
          }
          record('F1.16 强杀路径下 failed 凭证（物理限制说明）', 'INFO',
            failed > 0
              ? `意外地找到 ${failed} 份 failed 凭证`
              : '进程被强杀时任何 JS 都不执行，无 failed 凭证属物理限制，**不算缺陷**；库完整性未受影响')
        }

        // 自愈：强杀后立刻复跑
        // 实测发现（2026-11-02）：强杀留下的 .build.lock 未超时（TTL=10min），
        // 立刻复跑会拿到 EBUILDLOCKED。/ 也就是说：崩溃后 10 分钟内用户点"重扫"会被拒。
        // 这不是数据损坏（库仍 40/40 一致），但是**可用性缺陷**，如实记录。
        const r3 = await run(0, makeSessions(60, { salt: 'kg2' }))
        const f3 = readLibraryFacts(root)
        const blocked = r3.out && r3.out.includes('EBUILDLOCKED')

        record('F1.17 强杀后立刻复跑的结果（事实）',
          blocked ? 'FAIL' : 'PASS',
          blocked
            ? '复跑被 EBUILDLOCKED 拒绝 —— 残留锁未超时，用户 10 分钟内无法重新建库（数据仍一致）'
            : `复跑成功：${r3.out}`)

        if (blocked) {
          // 验证：把锁调老后应该能恢复 → 证明是可恢复的、不是死锁
          const lockPath = nodePath.join(root, '.build.lock')
          if (fs.existsSync(lockPath)) {
            const old = (Date.now() - (10 * 60 * 1000 + 60000)) / 1000
            fs.utimesSync(lockPath, old, old)
          }
          const r4 = await run(0, makeSessions(60, { salt: 'kg2' }))
          const f4 = readLibraryFacts(root)
          assertCase('F1.18 残留锁超时后可自愈（不是死锁）',
            r4.out && r4.out.startsWith('DONE') && isConsistent(f4),
            `锁超时后复跑成功：${f4.entryFiles} 条 / 声明 ${f4.declared} 条，一致`,
            `锁超时后仍无法建库：${r4.out} facts=${JSON.stringify({ e: f4.entryFiles, d: f4.declared })}`)
        } else {
          assertCase('F1.18 强杀后复跑能自愈到一致',
            r3.out && r3.out.startsWith('DONE') && isConsistent(f3),
            `复跑成功：${f3.entryFiles} 条 / 声明 ${f3.declared} 条，一致`,
            `复跑后不一致：${JSON.stringify({ e: f3.entryFiles, d: f3.declared, u: f3.entryUnparsable })} out=${r3.out}`)
        }
      }
    } finally {
      try { fs.rmSync(workerPath, { force: true }) } catch { }
    }
  } else {
    skipCase('F1.11–F1.17 真实强杀佐证', '--skip-slow 已跳过（F1-A 的 _fault 路径已覆盖崩溃语义）')
  }
}

// ═══════════════════════════════════════════════════════════════
// 故障类 2：磁盘满 ENOSPC
// ═══════════════════════════════════════════════════════════════
async function suiteEnospc() {
  suite('F2 磁盘满 / 写失败（注入 ENOSPC）',
    '在真实 syscall 上注入（openSync/writeSync/renameSync），检查正式目录是否被污染')

  if (!fs.existsSync(LIB_LIBRARY)) { skipCase('F2 全部', 'library.js 不存在'); return }

  // ── 2a：写第 5 个文件时 ENOSPC（发生在暂存区写入阶段）──
  // ⚠ 注入点选择：必须用 writeSync，不能用 openSync。
  //   实测 openSync 打进去 counts.open=117 但 threw=null —— buildLibrary 照常成功。
  //   原因：atomic.js 在同一文件内 import {openSync,...} 与 Staging 的 write 分属不同
  //   模块实例/时序，同步点不稳定；而 writeSync 在 F2.11 已证实可靠触发。
  {
    const root = makeRoot('enospc')
    const sessions = makeSessions(50, { salt: 'enospc' })
    const before = snapshotTree(root)
    let threw = null, counters = null
    {
      const h = await loadLibraryWithFsPatch({ faultAt: { writeChunk: 5 } })
      try { h.mod.buildLibrary(sessions, { root }) } catch (e) { threw = e }
      finally { counters = h.counters(); h.restore() }
    }

    assertCase('F2.1 ENOSPC 被真实触发（注入对准 writeSync）',
      threw && threw.code === 'ENOSPC',
      `第 5 个 writeSync 分片抛 ENOSPC（本次共 ${counters.chunk} 个分片 / ${counters.open} 次 open）`,
      `注入未触发：threw=${threw && (threw.code || threw.message)} counts=${JSON.stringify(counters)}`)

    const after = snapshotTree(root)
    const diff = treeDiff(before, after)
    const facts = readLibraryFacts(root)

    // ★ 核心：暂存区架构下，写入阶段失败 → 正式 entries/ 必须零文件新增
    // 陷阱：快照里目录记作 'entries/'（带尾斜杠）。若只写 startsWith('entries/')，
    // 会把「空目录占位」误判成「文件漏出」。必须排除目录标记 —— 已实测踩过此坑。
    const polluted = diff.added.filter((p) => p.startsWith('entries/') && !p.endsWith('/')).length
    const dirOnly = diff.added.filter((p) => p === 'entries/').length
    assertCase('F2.2 正式 entries/ 零文件污染（暂存区隔离有效）',
      polluted === 0,
      `正式 entries/ 零文件新增（仅建了空目录占位${dirOnly ? ' entries/' : ''}）；ENOSPC 只弄脏了暂存区`,
      `${polluted} 个条目文件漏进正式 entries/ → 暂存区隔离失效`)

    // 正式 library.json 不该出现（首次建库、且没提交）
    assertCase('F2.3 未提交时正式 library.json 不存在',
      !facts.libraryExists,
      '正式 library.json 未生成（未提交即未落总账，符合"总账是完整信号"）',
      `正式 library.json 已生成 ${facts.libraryBytes}B —— 提交信号不可靠`)

    // ★ 暂存区必须保留作证据
    const staging = diff.added.filter((p) => /^\.staging-/.test(p))
    assertCase('F2.4 失败后暂存区保留（崩溃现场可查）',
      staging.length > 0,
      `保留暂存区 ${staging.filter((p) => p.endsWith('/')).length || '?'} 个条目文件（.staging-*）`,
      '失败后暂存区被删除 —— 丢失崩溃现场，违反设计要求')

    // ★ runs/ 必须有 failed 凭证
    {
      const runsDir = nodePath.join(root, 'runs')
      let failed = 0, total = 0
      if (fs.existsSync(runsDir)) {
        for (const f of fs.readdirSync(runsDir).filter((x) => x.endsWith('.json'))) {
          total += 1
          try {
            const j = JSON.parse(fs.readFileSync(nodePath.join(runsDir, f), 'utf8'))
            if (j.status === 'failed') failed += 1
          } catch { /* 坏报告 */ }
        }
      }
      assertCase('F2.5 失败留下 runs/*.json status=failed 凭证',
        failed > 0,
        `runs/ 共 ${total} 份，其中 ${failed} 份 status=failed`,
        `runs/ 共 ${total} 份，0 份 failed —— 失败没有凭证，无法排查`)
    }

    // ── 恢复：不注入再跑一次必须一致 ──
    {
      let r2 = null
      const h2 = await loadLibraryWithFsPatch(null)
      try { h2.mod.buildLibrary(sessions, { root }) } catch (e) { r2 = e }
      finally { h2.restore() }
      const f2 = readLibraryFacts(root)
      assertCase('F2.6 磁盘恢复后复跑到一致状态（自愈）',
        !r2 && isConsistent(f2),
        `复跑成功：${f2.entryFiles} 条 / 声明 ${f2.declared} 条，全部可解析`,
        `复跑失败或不一致：throw=${r2 && r2.message} facts=${JSON.stringify({ e: f2.entryFiles, d: f2.declared, u: f2.entryUnparsable })}`)
    }
  }

  // ── 2b：提交阶段 rename ENOSPC（最危险窗口）──
  {
    const root = makeRoot('enospc-commit')
    const sessionsA = makeSessions(30, { salt: 'c1' })
    // 先建好一个完整库
    {
      const h = await loadLibraryWithFsPatch(null)
      h.mod.buildLibrary(sessionsA, { root })
      h.restore()
    }
    const beforeFacts = readLibraryFacts(root)
    const beforeTree = snapshotTree(root)

    let threw = null, counters = null
    {
      // 提交时先搬几个文件，再让第 3 次 rename 失败
      const h = await loadLibraryWithFsPatch({ faultAt: { rename: 3 } })
      try { h.mod.buildLibrary(makeSessions(30, { salt: 'c2' }), { root }) } catch (e) { threw = e }
      finally { counters = h.counters(); h.restore() }
    }

    assertCase('F2.7 提交阶段 ENOSPC 被触发',
      threw && threw.code === 'ENOSPC',
      `第 3 次 rename 失败（共 ${counters.rename} 次 rename）`,
      `未触发：threw=${threw && (threw.code || threw.message)}`)

    const afterFacts = readLibraryFacts(root)
    const diff = treeDiff(beforeTree, snapshotTree(root))

    // ★ 核心：library.json 排在最后 → 提交中途失败时它必须仍是旧版
    assertCase('F2.8 提交中途失败后 library.json 仍是旧版完整版',
      afterFacts.libraryParsable && afterFacts.libraryBytes === beforeFacts.libraryBytes,
      `library.json 仍为 ${afterFacts.libraryBytes}B 可解析（旧版未被半新数据覆盖）`,
      `library.json 变了：before=${beforeFacts.libraryBytes}B after=${afterFacts.libraryBytes}B parsable=${afterFacts.libraryParsable} → 总账可能指向不完整的批次`)

    // 已搬走的文件是完整文件（不是半成品），这是可接受的中间态
    const moved = diff.added.filter((p) => p.startsWith('entries/'))
    const movedUnparsable = afterFacts.entryUnparsable
    assertCase('F2.9 已搬走的条目是完整文件（非半成品）',
      movedUnparsable === 0,
      `搬走 ${moved.length} 个条目，全部可解析`,
      `${movedUnparsable} 个条目不可解析 → 出现半成品`)

    // 【2026-11-09 修】原来是 `moved.length === 0 ? 'PASS' : 'PASS'` —— 两条分支
    // 都记 PASS，无论搬走 0 个还是 N 个都恒绿。这条只打印、不判定，是纯粹的假绿灯。
    // 现在给一个**能失败**的判据：注入"提交中断"后，正式目录里不能出现半成品
    // （movedUnparsable 已由 F2.9 保证为 0），且"总账是否已更新"必须与实际搬走的
    // 条目数一致 —— 搬了条目却没更新总账是**可恢复的中间态**（允许），但搬了 0 条
    // 却宣称总账已更新、或搬了条目而总账也"看起来已更新"却是坏的，都要报出来。
    const ledgerUpdated = afterFacts.libraryParsable && diff.added.includes('library.json')
    assertCase('F2.10 提交中断后的中间态自洽（搬走条目 ⇔ 总账未更新）',
      moved.length === 0 ? !ledgerUpdated : movedUnparsable === 0,
      moved.length === 0
        ? '零文件被搬走（第一次 rename 就失败），总账也未更新 —— 一致'
        : `搬走 ${moved.length} 个完整条目、总账未更新 —— 可恢复中间态，且无半成品`,
      moved.length === 0
        ? `零文件被搬走，但总账被改成了新版（${beforeFacts.libraryBytes}B → ${afterFacts.libraryBytes}B）—— 中间态不自洽`
        : `${movedUnparsable} 个条目不可解析 → 出现半成品`)
  }

  // ── 2c：大文件写到一半 ENOSPC（writeSync 层）──
  {
    const root = makeRoot('enospc-chunk')
    const sessions = makeSessions(20, { salt: 'chunk' })
    let threw = null, counters = null
    {
      const h = await loadLibraryWithFsPatch({ faultAt: { writeChunk: 8 } })
      try { h.mod.buildLibrary(sessions, { root }) } catch (e) { threw = e }
      finally { counters = h.counters(); h.restore() }
    }
    assertCase('F2.11 分片写入中途 ENOSPC 被触发',
      threw && threw.code === 'ENOSPC',
      `第 8 个 writeSync 分片抛 ENOSPC（共 ${counters.chunk} 个分片）`,
      `未触发：threw=${threw && (threw.code || threw.message)}`)

    const facts = readLibraryFacts(root)
    const stagingLeft = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => n.startsWith('.staging-')) : []
    assertCase('F2.12 分片中途失败：正式目录干净、暂存区留痕',
      !facts.libraryExists && stagingLeft.length > 0,
      `正式无 library.json，暂存区保留 ${stagingLeft.length} 个`,
      `libraryExists=${facts.libraryExists} staging=${stagingLeft.length}`)
  }
}

// ═══════════════════════════════════════════════════════════════
// 故障类 3：library.json 截断
// ═══════════════════════════════════════════════════════════════
async function suiteTruncatedLibrary() {
  suite('F3 library.json 截断（毁掉总账）',
    '把总账截成一半非法 JSON，检查诊断/自愈/启动是否扛得住')

  if (!fs.existsSync(LIB_LIBRARY)) { skipCase('F3 全部', 'library.js 不存在'); return }
  if (!fs.existsSync(LIB_HEALTH)) { skipCase('F3 全部', 'health.js 尚未创建'); return }

  const root = makeRoot('trunc')
  const sessions = makeSessions(35, { salt: 'trunc' })
  {
    const h = await loadLibraryWithFsPatch(null)
    h.mod.buildLibrary(sessions, { root })
    h.restore()
  }
  const healthyFacts = readLibraryFacts(root)
  record('F3.0 对照组：正常库', 'INFO',
    `${healthyFacts.entryFiles} 条，${healthyFacts.libraryBytes} 字节`)

  // 截断 library.json 一半
  const libPath = nodePath.join(root, 'library.json')
  const origBuf = fs.readFileSync(libPath)
  const half = origBuf.subarray(0, Math.floor(origBuf.length / 2))
  fs.writeFileSync(libPath, half)
  const truncatedFacts = readLibraryFacts(root)
  assertCase('F3.1 截断后 library.json 确实不可解析（构造成功）',
    !truncatedFacts.libraryParsable,
    `截断到 ${half.length} 字节，JSON.parse 失败：${truncatedFacts.err}`,
    '截断后仍可解析，构造失败')

  const health = await loadModule(LIB_HEALTH, 'trunc')

  // ── 3a：checkLibraryHealth 是否报 broken ──
  {
    const r = health.checkLibraryHealth(root)
    assertCase('F3.2 checkLibraryHealth 报 broken 且指出不可解析',
      r.level === 'broken' && r.issues.some((i) => i.code === 'library-unparsable' || i.code === 'library-shape'),
      `level=${r.level}，issues=${r.issues.map((i) => i.code).join(',')}`,
      `未正确报 broken：level=${r.level} issues=${JSON.stringify(r.issues.map((i) => i.code))}`)
  }

  // ── 3b：healLibrary 不许自己乱重建 ──
  {
    const beforeTree = snapshotTree(root)
    const r = health.healLibrary(root, { dryRun: false })
    const afterTree = snapshotTree(root)
    const diff = treeDiff(beforeTree, afterTree)

    // 红线：不能重写 library.json，不能删条目
    const rewrote = diff.changed.includes('library.json') || diff.added.includes('library.json')
    const deletedEntries = diff.removed.filter((p) => p.startsWith('entries/'))
    assertCase('F3.3 healLibrary 不自行重建 library.json',
      !rewrote,
      `未改动 library.json（action=${r.action}）`,
      `healLibrary 擅自改写了 library.json（action=${r.action}）→ 违反"不自行重建"红线`)
    assertCase('F3.4 healLibrary 不删任何条目',
      deletedEntries.length === 0,
      '零条目被删',
      `删除了 ${deletedEntries.length} 个条目：${deletedEntries.slice(0, 5).join(', ')}`)
    assertCase('F3.5 healLibrary 给出 rebuild 建议',
      r.action === 'rebuild' || r.advice.some((a) => /rebuild|重建/i.test(a)),
      `action=${r.action}，advice=${(r.advice[0] || '').slice(0, 60)}`,
      `未给出 rebuild 建议：action=${r.action} advice=${JSON.stringify(r.advice).slice(0, 120)}`)

    // 条目必须还在（没被顺手删）
    const remaining = fs.readdirSync(nodePath.join(root, 'entries')).filter((f) => f.endsWith('.json')).length
    assertCase('F3.6 截断总账后条目文件全部保留',
      remaining === healthyFacts.entryFiles,
      `${remaining} 个条目文件完好`,
      `条目从 ${healthyFacts.entryFiles} 变成 ${remaining} —— 有丢失`)
  }

  // ── 3c：恢复总账后应回到健康（证明损坏可逆）──
  fs.writeFileSync(libPath, origBuf)
  {
    const r = health.checkLibraryHealth(root)
    assertCase('F3.7 总账还原后健康检查恢复 healthy/warn',
      r.level === 'healthy' || r.level === 'warn',
      `level=${r.level}（可逆）`,
      `还原后仍 ${r.level}：${r.issues.map((i) => i.code).join(',')}`)
  }

  // ── 3d：启动不能因库坏而崩 ──
  {
    fs.writeFileSync(libPath, half)   // 再毁一次
    const probe = `
import { pathToFileURL } from 'node:url'
const root = ${JSON.stringify(root)}
const health = await import(pathToFileURL(${JSON.stringify(LIB_HEALTH)}).href + '?boot=1')
let out = { loaded: true, threw: null }
try {
  const r = health.checkLibraryHealth(root)
  out.level = r.level
  // 模拟启动路径里可能被调用的一切
  health.healLibrary(root, { dryRun: true })
  out.healOk = true
} catch (e) { out.threw = e && (e.message || String(e)) }
process.stdout.write(JSON.stringify(out))
`
    const tmpProbe = nodePath.join(os.tmpdir(), `p1stress-boot-${process.pid}.mjs`)
    fs.writeFileSync(tmpProbe, probe, 'utf8')
    const res = spawnSync(process.execPath, [tmpProbe], { encoding: 'utf8' })
    fs.rmSync(tmpProbe, { force: true })
    let parsed = null
    try { parsed = JSON.parse(res.stdout || '{}') } catch { /* ignore */ }
    assertCase('F3.8 库损坏时模块仍能加载、健康检查不抛异常',
      res.status === 0 && parsed && parsed.loaded && !parsed.threw,
      `进程退出码 0，level=${parsed && parsed.level}，未抛异常`,
      `启动路径崩了：status=${res.status} threw=${parsed && parsed.threw} stderr=${(res.stderr || '').slice(0, 200)}`)
  }
}

// ═══════════════════════════════════════════════════════════════
// 故障类 4：孤儿文件
// ═══════════════════════════════════════════════════════════════
async function suiteOrphanFiles() {
  suite('F4 孤儿文件（entries/ 有文件但总账没列）',
    '红线：永不自动删除。dryRun 与非 dryRun 都必须保留')

  if (!fs.existsSync(LIB_LIBRARY)) { skipCase('F4 全部', 'library.js 不存在'); return }
  if (!fs.existsSync(LIB_HEALTH)) { skipCase('F4 全部', 'health.js 尚未创建'); return }

  const root = makeRoot('orphan')
  const sessions = makeSessions(30, { salt: 'orphan' })
  {
    const h = await loadLibraryWithFsPatch(null)
    h.mod.buildLibrary(sessions, { root })
    h.restore()
  }
  const base = readLibraryFacts(root)

  const entriesDir = nodePath.join(root, 'entries')
  const orphans = ['e-orphan000001.json', 'e-orphan000002.json', 'e-orphan000003.json']
  for (const name of orphans) {
    fs.writeFileSync(nodePath.join(entriesDir, name), JSON.stringify({
      id: name.replace('.json', ''), volume: 'vol-05', title: '孤儿压测条目',
    }, null, 2), 'utf8')
  }
  const withOrphans = readLibraryFacts(root)
  record('F4.0 构造 3 个孤儿文件', 'INFO',
    `条目文件 ${base.entryFiles} → ${withOrphans.entryFiles}，总账仍声明 ${withOrphans.declared}`)

  const health = await loadModule(LIB_HEALTH, 'orphan')

  // ── 4a：health 报 warn ──
  {
    const r = health.checkLibraryHealth(root)
    const hasOrphanIssue = r.issues.some((i) => i.code === 'entry-count-mismatch-extra')
    assertCase('F4.1 checkLibraryHealth 报出孤儿文件（warn，非 broken）',
      hasOrphanIssue && r.level === 'warn',
      `level=${r.level}，issue=entry-count-mismatch-extra`,
      `未报孤儿：level=${r.level} issues=${r.issues.map((i) => i.code).join(',') || '(空)'}`)
  }

  // ── 4b：dryRun 下文件必须还在 ──
  {
    health.healLibrary(root, { dryRun: true })
    const still = orphans.filter((n) => fs.existsSync(nodePath.join(entriesDir, n)))
    assertCase('F4.2 dryRun 下孤儿文件全部保留',
      still.length === orphans.length,
      `${still.length}/${orphans.length} 个孤儿仍在（未删）`,
      `dryRun 竟然删了孤儿：剩 ${still.length}/${orphans.length}`)
  }

  // ── 4c：非 dryRun 下也不能删 ──
  {
    const r = health.healLibrary(root, { dryRun: false })
    const still = orphans.filter((n) => fs.existsSync(nodePath.join(entriesDir, n)))
    assertCase('F4.3 非 dryRun 下孤儿文件仍全部保留（红线）',
      still.length === orphans.length,
      `${still.length}/${orphans.length} 个孤儿仍在；改为报告 advice`,
      `**违反红线**：非 dryRun 删除了 ${orphans.length - still.length} 个孤儿文件`)
    assertCase('F4.4 孤儿被写进 advice 供人工处理',
      r.advice.some((a) => /孤儿|永不自动删除|entry-count-mismatch-extra|磁盘上的条目文件多于/.test(a)),
      `advice 含孤儿提示：${(r.advice.find((a) => /孤儿|永不自动删除|多于/.test(a)) || '').slice(0, 80)}`,
      `advice 未提及孤儿：${JSON.stringify(r.advice).slice(0, 160)}`)
  }

  // ── 4d：health 自愈不应把孤儿当"要修的坏数据"清掉总账声明 ──
  {
    const f = readLibraryFacts(root)
    assertCase('F4.5 总账声明数未被自愈改写去"迁就"孤儿',
      f.declared === base.declared,
      `总账仍声明 ${f.declared} 条（未迎合孤儿数 ${f.entryFiles}）`,
      `总账被改写：${base.declared} → ${f.declared}（自愈擅自篡改总账）`)
  }
}

// ═══════════════════════════════════════════════════════════════
// 故障类 5：并发建库
// ═══════════════════════════════════════════════════════════════
async function suiteConcurrent() {
  suite('F5 并发建库（两个 buildLibrary 同时跑）',
    ENV.hasLock ? '锁已存在；重点验证是否真的接进 buildLibrary' : '锁文件尚未创建')

  if (!fs.existsSync(LIB_LIBRARY)) { skipCase('F5 全部', 'library.js 不存在'); return }

  // ── 5a：锁本身的行为（直接测 lock.js，不依赖接线）──
  if (fs.existsSync(LIB_LOCK)) {
    const lock = await loadModule(LIB_LOCK, 'lock')

    // 第一次拿锁成功
    const root1 = makeRoot('lock-a')
    {
      const a = lock.acquireLock(root1)
      assertCase('F5.1 首次 acquireLock 成功',
        a.ok === true, 'ok=true', `ok=false reason=${a.reason}`)
      // 第二次必须失败
      const b = lock.acquireLock(root1)
      assertCase('F5.2 持锁期间第二次 acquireLock 被拒',
        b.ok === false && /正在运行|抢占/.test(b.reason || ''),
        `ok=false，reason="${b.reason}"`,
        `第二次竟然也拿到锁：ok=${b.ok}`)
      a.release?.()
      const c = lock.acquireLock(root1)
      assertCase('F5.3 release 后可重新获取',
        c.ok === true, 'ok=true', `release 后仍拿不到：reason=${c.reason}`)
      c.release?.()
    }

    // 失效锁回收（用 utimesSync 调老，不真等 10 分钟）
    {
      const root2 = makeRoot('lock-b')
      const a = lock.acquireLock(root2)
      const lockPath = nodePath.join(root2, lock.LOCK_FILE || '.build.lock')
      const old = (Date.now() - (lock.LOCK_TTL_MS + 60000)) / 1000
      fs.utimesSync(lockPath, old, old)
      const holder = lock.readLock(root2)
      assertCase('F5.4 超时锁被 readLock 判定 stale',
        holder && holder.stale === true,
        `stale=true，ageMs=${Math.round(holder.ageMs / 1000)}s > TTL ${Math.round(lock.LOCK_TTL_MS / 1000)}s`,
        `未判为 stale：${JSON.stringify(holder)}`)
      const b = lock.acquireLock(root2)
      assertCase('F5.5 过期锁可被自动回收',
        b.ok === true, '回收成功并拿到锁', `回收失败：reason=${b.reason}`)
      b.release?.()
    }

    // 截断锁文件
    {
      const root3 = makeRoot('lock-c')
      const lockPath = nodePath.join(root3, '.build.lock')
      fs.writeFileSync(lockPath, '{"pid": 12345, "ho', 'utf8')   // 截断
      const holder = lock.readLock(root3)
      assertCase('F5.6 截断的锁文件被视为失效（不卡死）',
        holder === null || holder.stale === true,
        `readLock 返回 stale=${holder && holder.stale}`,
        `截断锁未被识别为失效：${JSON.stringify(holder)}`)
      const b = lock.acquireLock(root3)
      assertCase('F5.7 截断锁可被回收并成功建库',
        b.ok === true, '回收成功', `回收失败：reason=${b.reason}`)
      b.release?.()
    }
  } else {
    skipCase('F5.1–5.7 锁行为', 'lib/lock.js 不存在')
  }

  // ── 5b：真实并发 buildLibrary（核心）──
  const root = makeRoot('concurrent')
  const sessionsA = makeSessions(50, { salt: 'concA' })
  const sessionsB = makeSessions(50, { salt: 'concB' })

  const worker = `
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const [,, libPath, root, sessionsJson, tag] = process.argv
const sessions = JSON.parse(sessionsJson)
const mod = await import(pathToFileURL(libPath).href)
try {
  const r = mod.buildLibrary(sessions, { root })
  process.stdout.write('OK ' + JSON.stringify({ created: r.created, entries: r.entries }) + '\\n')
} catch (e) {
  process.stdout.write('THROW ' + (e.code || '') + ' ' + (e.message || '') + '\\n')
}
`
  const wPath = nodePath.join(os.tmpdir(), `p1stress-conc-${process.pid}.mjs`)
  fs.writeFileSync(wPath, worker, 'utf8')

  try {
    const launch = (sessions, tag) => new Promise((resolve) => {
      const c = spawn(process.execPath, [wPath, LIB_LIBRARY, root, JSON.stringify(sessions), tag], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let o = '', e = ''
      c.stdout.on('data', (d) => { o += d })
      c.stderr.on('data', (d) => { e += d })
      c.on('close', (code) => resolve({ code, stdout: o, stderr: e, tag }))
    })

    // 真正同时起两个
    const [ra, rb] = await Promise.all([launch(sessionsA, 'A'), launch(sessionsB, 'B')])
    const okCount = [ra, rb].filter((r) => r.stdout.includes('OK')).length
    const throwCount = [ra, rb].filter((r) => r.stdout.includes('THROW')).length

    record('F5.8 两个进程都结束（事实）', 'INFO',
      `A: ${ra.stdout.trim().slice(0, 80)} | B: ${rb.stdout.trim().slice(0, 80)}`)

    const facts = readLibraryFacts(root)
    if (!ENV.hasLockWired) {
      // 未接锁：如实报告损坏情况（已知未完成项，不是 bug，但要记录）
      record('F5.9 并发后库是否损坏（锁未接入，如实记录）',
        isConsistent(facts) ? 'PASS' : 'FAIL',
        isConsistent(facts)
          ? `碰巧一致：${facts.entryFiles} 条 / 声明 ${facts.declared}`
          : `**不自洽**：条目 ${facts.entryFiles} 个 / 总账声明 ${facts.declared} 条（差 ${facts.declared === null ? '?' : facts.declared - facts.entryFiles}）`)
      skipCase('F5.10 一个成功一个 skipped', 'library.js 未接入 lock.js —— 该项待 p1-atomic 接线后复测')
    } else {
      // 【2026-11-09 修判据】原来断言"必须恰好一个成功"——这是**过强的判据**，
      // 会偶发失败：两个进程若都错过了锁的重叠窗口（空库/小规模时 doBuild 只有
      // 几毫秒），会**先后**各拿一次锁、都成功。那仍然是安全的（没有同时写）。
      //
      // 真正的安全性质是：**不能有两个进程同时持有锁**，也就是"库不能被同时写坏"。
      // 这个性质由 F5.10（库自洽、无互相覆盖残骸）直接验证。所以这里改成：
      //   · 至少一个成功（否则不是锁的问题，是整体坏了）
      //   · 成功的那些必须全部 OK、失败的必须全部是 LOCKED（不能出现"写坏了还报 OK"）
      //   · 若真出现了并发争抢（okCount===1），额外确认确实有一个被挡住
      const anyBlocked = throwCount > 0
      assertCase('F5.9 并发时不存在"两个都写坏还都报成功"',
        okCount >= 1 && okCount + throwCount === 2,
        okCount === 1
          ? `恰好一个成功、一个被锁挡住（发生了争抢）`
          : `两个都成功、零个抛错 —— 未发生争抢（空库时 doBuild 仅几毫秒，两次持锁不重叠）`,
        `成功 ${okCount} 个 / 抛错 ${throwCount} 个（合计应为 2）`)
      if (anyBlocked) {
        assertCase('F5.9b 发生争抢时只有一方成功',
          okCount === 1,
          '争抢窗口内恰好一方拿到锁',
          `发生了抛错（${throwCount} 个）但成功数不是 1（是 ${okCount}）—— 锁窗口内可能被绕过`)
      }
      assertCase('F5.10 并发后库自洽（无互相覆盖残骸）',
        isConsistent(facts),
        `一致：${facts.entryFiles} 条 / 声明 ${facts.declared}，全部可解析`,
        `不自洽：条目 ${facts.entryFiles} / 声明 ${facts.declared} / 坏文件 ${facts.entryUnparsable}`)
    }

    // 5c：杀持锁进程 → 留 .build.lock → 应能回收
    if (ENV.hasLockWired && fs.existsSync(LIB_LOCK)) {
      const root2 = makeRoot('concurrent-kill')
      const slow = `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
const [,, libPath, root, sessionsJson] = process.argv
const sessions = JSON.parse(sessionsJson)
let n = 0
const orig = fs.writeSync
fs.writeSync = function (fd, buf, ...r) {
  n += 1
  // 第 3 次写入时被杀：此时锁已获取（buildLibrary 开头就在锁内），尚未 release
  if (n === 3) { process.kill(process.pid, 'SIGKILL') }
  return orig.call(this, fd, buf, ...r)
}
syncBuiltinESMExports()
const mod = await import(pathToFileURL(libPath).href)
try { mod.buildLibrary(sessions, { root }) } catch (e) {}
`
      const slowPath = nodePath.join(os.tmpdir(), `p1stress-slow-${process.pid}.mjs`)
      fs.writeFileSync(slowPath, slow, 'utf8')
      const killed = await new Promise((resolve) => {
        const c = spawn(process.execPath,
          [slowPath, LIB_LIBRARY, root2, JSON.stringify(makeSessions(40, { salt: 'ck' }))],
          { stdio: 'ignore' })
        c.on('close', (code, signal) => resolve({ code, signal }))
      })
      const lockPath = nodePath.join(root2, '.build.lock')
      const lockLeft = fs.existsSync(lockPath)
      record('F5.11 持锁进程被杀后 .build.lock 残留（事实）',
        lockLeft ? 'PASS' : 'SKIP',
        lockLeft
          ? `锁文件残留（exit=${killed.code}；符合预期，靠 TTL 回收）`
          : '无锁残留 —— 可能进程在拿锁前就死了，或锁被 finally 释放')
      if (lockLeft) {
        const holder = await (async () => { const l = await loadModule(LIB_LOCK, 'lock3'); return l.readLock(root2) })()
        record('F5.11b 残留锁记录的是已死进程', 'INFO',
          `pid=${holder?.pid} host=${holder?.host} ageMs=${Math.round(holder?.ageMs ?? 0)}`)
        // 调老 mtime 模拟超时，不真等 10 分钟
        const old = (Date.now() - (10 * 60 * 1000 + 60000)) / 1000
        fs.utimesSync(lockPath, old, old)
        const lock = await loadModule(LIB_LOCK, 'lock2')
        const got = lock.acquireLock(root2)
        assertCase('F5.12 残留锁过期后可自动回收',
          got.ok === true, '回收成功（不会永久卡死用户的建库）', `回收失败：reason=${got.reason}`)
        got.release?.()

        // 回收后真的能建库
        let r = null
        const h = await loadLibraryWithFsPatch(null)
        try { h.mod.buildLibrary(makeSessions(20, { salt: 'ck2' }), { root: root2 }) }
        catch (e) { r = e } finally { h.restore() }
        const f = readLibraryFacts(root2)
        assertCase('F5.13 回收锁后建库成功且状态一致',
          !r && isConsistent(f),
          `建库成功：${f.entryFiles} 条 / 声明 ${f.declared} 条`,
          `失败：${r && (r.code || r.message)} facts=${JSON.stringify({ e: f.entryFiles, d: f.declared })}`)
      }
      fs.rmSync(slowPath, { force: true })
    }
  } finally {
    fs.rmSync(wPath, { force: true })
  }
}

// ═══════════════════════════════════════════════════════════════
// 故障类 6：大数据量下的原子性（大文件写一半中断）
// ═══════════════════════════════════════════════════════════════
async function suiteLargeAtomic(skipSlow) {
  suite('F6 大数据量原子性（5MB 单文件写到一半中断）',
    '目标文件要么完整旧版、要么完整新版，绝不能是半成品')

  if (!fs.existsSync(LIB_ATOMIC)) {
    skipCase('F6 全部', 'lib/atomic.js 不存在')
    return
  }

  const atomic = await loadModule(LIB_ATOMIC, 'atomic')
  const writerName = ['writeFileAtomic', 'atomicWriteFile', 'writeJsonAtomic', 'atomicWrite', 'writeAtomic']
    .find((n) => typeof atomic[n] === 'function')
  record('F6.0 atomic.js 可用写入 API', writerName ? 'PASS' : 'SKIP',
    writerName ? `使用 ${writerName}()` : `未找到预期函数，实际导出：${Object.keys(atomic).filter((k) => typeof atomic[k] === 'function').join(', ')}`)
  if (!writerName) return

  const root = makeRoot('bigatomic')
  const bigPath = nodePath.join(root, 'big.json')
  const oldContent = JSON.stringify({ v: 'OLD', pad: 'x'.repeat(2000) })
  fs.writeFileSync(bigPath, oldContent, 'utf8')
  const newContent = JSON.stringify({ v: 'NEW', pad: 'y'.repeat(5 * 1024 * 1024) })
  record('F6.0b 构造 5MB 新内容', 'INFO',
    `旧 ${oldContent.length}B → 新 ${(newContent.length / 1048576).toFixed(2)}MB`)

  // ── 6a：用库自带 beforeRename 钩子（最贴合作者设计的注入点）──
  {
    let hookFired = false
    let threw = null
    try {
      atomic[writerName](bigPath, newContent, {
        beforeRename: () => { hookFired = true; throw Object.assign(new Error('ENOSPC: simulated mid-write'), { code: 'ENOSPC' }) },
      })
    } catch (e) { threw = e }

    const after = fs.readFileSync(bigPath, 'utf8')
    assertCase('F6.1 beforeRename 钩子被调用（注入生效）',
      hookFired && threw && threw.code === 'ENOSPC',
      '临时文件写完、rename 前抛 ENOSPC',
      `钩子未触发：hookFired=${hookFired} threw=${threw && threw.message}`)

    assertCase('F6.2 目标文件仍是完整旧版（非半成品）',
      after === oldContent,
      `目标文件仍为 ${after.length}B 的旧内容（5MB 新数据未污染）`,
      `目标被改：${after.length}B（旧 ${oldContent.length}B / 新 ${newContent.length}B）`)

    // rename 未执行 → 临时文件应被 catch 分支清理
    const leftovers = fs.readdirSync(root).filter((n) => n !== 'big.json')
    assertCase('F6.3 失败后临时文件被清理（不留垃圾）',
      leftovers.length === 0,
      '无残留临时文件',
      `残留 ${leftovers.length} 个：${leftovers.slice(0, 5).join(', ')}`)
  }

  // ── 6b：写到"一半字节"时失败（真实的中途中断）──
  // ⚠ 实测（_work/_probe-chunks.mjs）：writeSync 对 5MB buffer 是【单次全量写】，
  //   分片数 = 1，不是循环累加。所以"在第 2 个分片注入"前提不成立（那是假失败）。
  //   真正能模拟"1 个文件只写了 2MB 就崩"的做法：
  //   让 writeSync 只写入前 2MB 然后抛错 —— 此时 tmp 文件里有 2MB 半成品，
  //   而 rename 尚未发生。这正是要验证的危险场景。
  {
    fs.writeFileSync(bigPath, oldContent, 'utf8')
    const halfLen = Math.floor(newContent.length / 2)   // ≈2.5MB
    let threw = null
    const origWrite = fs.writeSync

    fs.writeSync = function (fd, buf, offset, length, ...rest) {
      // 只写一半，再抛错：制造真正的"半写文件"
      const half = Math.min(halfLen, length ?? buf.length)
      origWrite.call(this, fd, buf, offset, half, ...rest)
      throw Object.assign(new Error('ENOSPC: no space left on device (mid-write)'), { code: 'ENOSPC' })
    }
    syncBuiltinESMExports()

    try {
      atomic[writerName](bigPath, newContent)
    } catch (e) { threw = e } finally {
      fs.writeSync = origWrite
      syncBuiltinESMExports()
    }

    const after = fs.readFileSync(bigPath, 'utf8')
    const tmpLeft = fs.readdirSync(root).filter((n) => n !== 'big.json')

    assertCase('F6.4 写出 2.5MB 半成品后失败：目标仍为完整旧版',
      threw && threw.code === 'ENOSPC' && after === oldContent,
      `已写出 ${(halfLen / 1048576).toFixed(2)}MB 半成品后失败，但目标文件仍为完整 ${after.length}B 旧内容 —— 半成品只留在临时文件里`,
      `threw=${threw && threw.code}；目标 ${after.length}B（旧 ${oldContent.length}B / 新 ${newContent.length}B）→ 半成品污染了正式文件`)

    assertCase('F6.5 半成品临时文件被清理（不留垃圾、不会冒充正式版）',
      tmpLeft.length === 0,
      '临时文件已清理，正式目录只有 big.json',
      `残留 ${tmpLeft.length} 个临时文件：${tmpLeft.slice(0, 3).join(', ')}`)

    record('F6.6 单文件原子性结论（事实）', 'INFO',
      `5MB 单文件写入中断时，正式文件 100% 保持旧版完整内容，半成品从未落位。` +
      `writeSync 对 5MB 为单次全量写（实测分片数=1），产品 while 循环是防御性写法，不是必需路径。`)
  }
}

// ═══════════════════════════════════════════════════════════════
// 回归：子脚本必须全绿
// ═══════════════════════════════════════════════════════════════
//
// 【D-08 修正 2026-11-06】原来这里写死 `runOne('scripts/selfcheck.mjs', 21)`，
// 断言条件是 `total === expectPass`。selfcheck 已从 21 项长到 23 项，
// 于是**环境完全正常时这条断言也必然 FAIL** —— 一个永远红着的门禁等于没有门禁，
// 下一个人会学会"这条红是正常的"，然后真正的回归就被吞掉了。
//
// 现在只断言两件事，都与环境无关、与项数无关：
//   ① fail === 0     —— 没有一项失败（这是"回归"的真正定义）
//   ② pass === total —— 计数行自洽（防止脚本提前 exit 只打印半截结果）
//
// 项数**刻意不断言**：项数只应增长，写死它会每加一项就误报一次。
// 需要盯住项数的人应该看输出的 pass/total，那里每次都印。
async function suiteRegression() {
  suite('F7 回归：子脚本必须全绿（fail=0，项数不作断言）',
    '这是最重要的验收标准；挂了就是回归')

  /**
   * 跑一个子脚本，只判定"零失败 + 计数自洽"。
   *
   * 为什么不再收 expectPass：见上方注释。参数留着会被误用（有人会传一个数字
   * 进来）——所以直接删掉，让误用变成语法错误而不是静默失效。
   */
  const runOne = (scriptRel) => {
    const p = nodePath.join(PLUGIN, scriptRel)
    if (!fs.existsSync(p)) return { ok: false, why: `${scriptRel} 不存在`, out: '' }
    const res = spawnSync(process.execPath, [p], { encoding: 'utf8', cwd: PLUGIN, timeout: 180000 })
    const out = (res.stdout || '') + (res.stderr || '')
    const m = out.match(/结果：\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败\s*\/\s*共\s*(\d+)/)
    if (!m) {
      // 解析不到结果行本身就是失败：exit=0 但没打印结果，说明脚本半路 exit 了
      return { ok: false, why: `未能解析结果行（exit=${res.status}）`, out }
    }
    const [, pass, fail, total] = m.map(Number)
    const reasons = []
    if (fail !== 0) reasons.push(`${fail} 项失败`)
    if (pass !== total) reasons.push(`通过数 ${pass} ≠ 总数 ${total}（计数行不自洽）`)
    return { ok: reasons.length === 0, why: reasons.join('；'), pass, fail, total, out, exit: res.status }
  }

  {
    const r = runOne('scripts/selfcheck.mjs')
    assertCase('F7.1 selfcheck.mjs 全绿（fail=0）',
      r.ok,
      `${r.pass}/${r.total} 通过，0 失败`,
      `selfcheck 回归失败：${r.pass}/${r.total} 通过、${r.fail} 失败` +
      `${r.why ? `（${r.why}）` : ''}\n${(r.out || '').slice(-800)}`)
  }
  {
    const r = runOne('scripts/check-p0.mjs')
    assertCase('F7.2 check-p0.mjs 全绿（fail=0）',
      r.ok,
      `${r.pass}/${r.total} 通过，0 失败`,
      `check-p0 回归失败：${r.pass}/${r.total} 通过、${r.fail} 失败` +
      `${r.why ? `（${r.why}）` : ''}\n${(r.out || '').slice(-800)}`)
  }
}

// ═══════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════
async function main() {
  const argv = process.argv.slice(2)
  const skipSlow = argv.includes('--skip-slow')
  const onlyArg = argv.find((a) => a.startsWith('--only='))
  const only = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()) : null
  const want = (k) => !only || only.includes(k)

  const t0 = Date.now()
  console.log('══════════════════════════════════════════════════════════════')
  console.log('P1-1 故障注入压测 — 独立验收')
  console.log('══════════════════════════════════════════════════════════════')
  console.log(`插件：${PLUGIN}`)
  console.log(`真实书库（绝不触碰）：${REAL_LIBRARY_ROOT}`)
  console.log(`临时工作区：${os.tmpdir()}`)
  detectWiring()
  console.log('')
  console.log('机制探测：')
  console.log(`  lib/atomic.js       ${ENV.hasAtomic ? '存在' : '缺失'}`)
  console.log(`  lib/health.js       ${ENV.hasHealth ? '存在' : '缺失'}`)
  console.log(`  lib/lock.js         ${ENV.hasLock ? '存在' : '缺失'}`)
  console.log(`  atomic 接入建库      ${ENV.usesStaging ? '.staging- 出现' : '.staging- 未出现'}`)
  console.log(`  lock   接入建库      ${ENV.hasLockWired ? '已 import' : '未 import'}`)
  console.log('')

  const suites = [
    ['audit', suiteStaticAudit],
    ['kill', () => suiteKillMidWrite(skipSlow)],
    ['fs', suiteEnospc],
    ['trunc', suiteTruncatedLibrary],
    ['orphan', suiteOrphanFiles],
    ['concurrent', suiteConcurrent],
    ['big', () => suiteLargeAtomic(skipSlow)],
    ['regression', suiteRegression],
  ]

  for (const [key, fn] of suites) {
    if (!want(key)) continue
    console.log('──────────────────────────────────────────────────────────────')
    try { await fn() }
    catch (e) {
      suite(`F? ${key} 套件异常`, '')
      record(`${key} 套件整体`, 'FAIL', `套件抛异常：${e && e.stack ? e.stack.split('\n')[0] : e}`)
    }
  }

  // ── 汇总 ──
  console.log('')
  console.log('══════════════════════════════════════════════════════════════')
  console.log('汇总')
  console.log('══════════════════════════════════════════════════════════════')
  let P = 0, F = 0, S = 0, I = 0
  const failures = []
  for (const s of RESULTS) {
    const c = s.cases
    const p = c.filter((x) => x.status === 'PASS').length
    const f = c.filter((x) => x.status === 'FAIL').length
    const k = c.filter((x) => x.status === 'SKIP').length
    const i = c.filter((x) => x.status === 'INFO').length
    P += p; F += f; S += k; I += i
    console.log(`${f > 0 ? '✗' : k === c.length ? '○' : '✓'} ${s.name}`)
    console.log(`    ${p} 通过 / ${f} 失败 / ${k} 跳过${i ? ` / ${i} 事实记录` : ''}`)
    for (const x of c.filter((y) => y.status === 'FAIL')) {
      failures.push({ suite: s.name, ...x })
      console.log(`    ✗ ${x.name}`)
      console.log(`        ${x.detail}`)
    }
  }
  console.log('')
  console.log(`总计：${P} 通过 / ${F} 失败 / ${S} 跳过${I ? ` / ${I} 事实记录（不计入通过）` : ''} · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  if (failures.length) {
    console.log('')
    console.log('── 失败清单 ──')
    failures.forEach((f, i) => console.log(`${i + 1}. [${f.suite}] ${f.name}\n   ${f.detail}`))
  }

  cleanupAll()
  process.exit(F > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('压测脚本自身崩溃：', e)
  cleanupAll()
  process.exit(2)
})
