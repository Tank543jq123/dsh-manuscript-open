#!/usr/bin/env node
/**
 * 会话扫描器 + 合成夹具 的自检测试（2026-11-07 新增）。
 *
 * 覆盖三件"只在真实日志上才出错、而真实日志又搬不进仓库"的事：
 *   ① **多帧 zstd**：一个文件里拼接多个独立 zstd frame，zlib.zstdDecompressSync
 *      只解第一帧 —— 必须按魔数切帧逐帧解。
 *   ② **无版本号的老格式**（`session.jsonl.zstd`）：只匹配 `session.v*` 会漏掉它们。
 *   ③ **Windows 路径取 basename**：源机器的路径是 `D:\proj\x.md`，
 *      用 node:path 的 basename() 在 Linux 上会整条返回 —— 实测漏过一次，
 *      evidence.files 里出现了完整绝对路径（个人环境信息不该进手册）。
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanSessions, decompressMultiFrame } from '../lib/scan.js'
import { buildLibrary } from '../lib/library.js'
import { triageAll } from '../lib/triage.js'
import { writeSessionFixture } from './lib/session-fixture.mjs'

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

const root = mkdtempSync(join(tmpdir(), 'ms-scan-fixture-'))
try {
  console.log('\n── 1. 基本解析 ──')
  writeSessionFixture(root, { sid: 'session-a', title: '嘉立创2.0双排针选型' })
  let scanned = scanSessions({ sessionsRoot: root })
  check('扫到 1 个会话且无解析错误', scanned.sessions.length === 1 && scanned.errors.length === 0,
    `sessions=${scanned.sessions.length} errors=${JSON.stringify(scanned.errors)}`)
  const a = scanned.sessions[0]
  check('标题来自 session/title 事件', a.title === '嘉立创2.0双排针选型', a.title)
  check('项目名来自 header.cwd（不是目录名解码）', a.project === 'hwplatform', a.project)
  check('工具调用与交付物计数正确', a.toolCalls === 1 && a.deliverables === 1,
    `toolCalls=${a.toolCalls} deliverables=${a.deliverables}`)
  check('turn 结束原因被记录', a.lastEndReason === 'completed', a.lastEndReason)

  console.log('\n── 2. 证据：Windows 路径只留文件名 ──')
  check('evidence.files 是 basename', JSON.stringify(a.files) === JSON.stringify(['选型.md']), JSON.stringify(a.files))
  check('basename 不含盘符/目录分隔符', !a.files.some((f) => /[\\/:]/.test(f)), JSON.stringify(a.files))
  check('topTools 记录了工具名', a.topTools?.[0]?.name === 'write', JSON.stringify(a.topTools))

  console.log('\n── 3. 多帧 zstd ──')
  const multiRoot = mkdtempSync(join(tmpdir(), 'ms-scan-multi-'))
  writeSessionFixture(multiRoot, { sid: 'session-multi', title: '多帧会话', frames: 4 })
  const multiScanned = scanSessions({ sessionsRoot: multiRoot })
  check('多帧文件被完整解出（4 段拼回）', multiScanned.sessions.length === 1 && multiScanned.sessions[0].events > 4,
    `events=${multiScanned.sessions[0]?.events}`)
  check('decompressMultiFrame 报告帧数 > 1', multiScanned.sessions[0].frames > 1, `frames=${multiScanned.sessions[0]?.frames}`)
  rmSync(multiRoot, { recursive: true, force: true })

  console.log('\n── 4. 无版本号的老格式 ──')
  const oldRoot = mkdtempSync(join(tmpdir(), 'ms-scan-old-'))
  writeSessionFixture(oldRoot, { sid: 'session-old', title: '老格式会话', version: 0 })
  const oldScanned = scanSessions({ sessionsRoot: oldRoot })
  check('session.jsonl.zstd 也能被扫到', oldScanned.sessions.length === 1 && oldScanned.sessions[0].title === '老格式会话',
    `sessions=${oldScanned.sessions.length}`)
  check('formatVersion 记为 0', oldScanned.sessions[0].formatVersion === 0, String(oldScanned.sessions[0].formatVersion))
  rmSync(oldRoot, { recursive: true, force: true })

  console.log('\n── 5. 分诊口径 ──')
  const t = triageAll(scanned.sessions)
  check('有交付物的会话算 real', t.counts.real === 1, JSON.stringify(t.counts))

  writeSessionFixture(root, { sid: 'session-b', title: '模型测试', tools: [], deliverables: 0, turns: 2 })
  const scanned2 = scanSessions({ sessionsRoot: root })
  const t2 = triageAll(scanned2.sessions)
  check('零交付物的「模型测试」算 noise 侧', t2.counts.smoke === 1, JSON.stringify(t2.counts))

  console.log('\n── 5-b. 损坏的会话文件必须被报出来，不能静默消失 ──')
  {
    // 【2026-11-08 修复】原来 `if (rec) sessions.push(rec)`：
    // 解析不出事件的文件被静默跳过，errors 仍是 0 —— 用户看到"解析错误 0"，
    // 却少了几个会话。对"记忆"产品来说，"这个会话消失了"和"它本来没内容"必须能分开。
    const badRoot = mkdtempSync(join(tmpdir(), 'ms-scan-bad-'))
    try {
      // ① 0 字节文件
      const d0 = join(badRoot, '-D-proj-x', 'zero-bytes')
      mkdirSync(d0, { recursive: true })
      writeFileSync(join(d0, 'session.v1.jsonl.zstd'), Buffer.alloc(0))
      // ② 半截 zstd 帧
      writeSessionFixture(badRoot, { sid: 'will-truncate', title: '会被截断的会话', projectDir: '-D-proj-y' })
      const f = join(badRoot, '-D-proj-y', 'will-truncate')
      const p = join(f, 'session.v1.jsonl.zstd')
      const buf = readFileSync(p)
      writeFileSync(p, buf.subarray(0, Math.floor(buf.length * 0.5)))
      // ③ 一个正常会话
      writeSessionFixture(badRoot, { sid: 'healthy', title: '正常会话', projectDir: '-D-proj-z' })

      // 【2026-11-08 修】原来是 check(..., true, ...) —— 恒真，等于没测。
      // 现在真的把 scanSessions 包起来：抛错就是 FAIL，不抛才是通过。
      let r = null
      let threw = null
      try {
        r = scanSessions({ sessionsRoot: badRoot })
      } catch (e) {
        threw = e
      }
      check('损坏文件不让扫描崩掉', threw === null && !!r, threw ? threw.message : `sessions=${r?.sessions.length}`)
      check('0 字节文件被记为错误', r.errors.some((e) => e.includes('zero-bytes')), JSON.stringify(r.errors.slice(0, 2)))
      check('被截断的会话被记为错误', r.errors.some((e) => e.includes('will-truncate')), JSON.stringify(r.errors.slice(0, 2)))
      check('健康会话不受影响', r.sessions.some((x) => x.sid === 'healthy'), `sessions=${r.sessions.map((x) => x.sid).join(',')}`)
    } finally {
      rmSync(badRoot, { recursive: true, force: true })
    }
  }

  console.log('\n── 5-c. 标题里的 HTML 不能原样进 Markdown ──')
  {
    // 【2026-11-08】标题来自会话首条消息，是用户完全可控的文本。
    // 实测：`<img src=x onerror=alert(1)> …` 这样的标题会原样落进 MANUAL.md / TOC.md
    // —— 谁在 web 里渲染这些 md，谁就吃到 XSS。
    const xssRoot = mkdtempSync(join(tmpdir(), 'ms-md-escape-'))
    const sessRoot = join(xssRoot, 'sessions')
    mkdirSync(sessRoot, { recursive: true })
    writeSessionFixture(sessRoot, {
      sid: 's-xss',
      title: '<img src=x onerror=alert(1)> 恶意标题',
      cwd: 'D:\\proj\\hwplatform',
    })
    try {
      const scannedX = scanSessions({ sessionsRoot: sessRoot })
      const built = buildLibrary(triageAll(scannedX.sessions).enriched, { root: join(xssRoot, 'lib') })
      const volId = built.library.volumes.find((v) => v.entries > 0).id
      const manual = readFileSync(join(xssRoot, 'lib', 'volumes', volId, 'MANUAL.md'), 'utf8')
      const toc = readFileSync(join(xssRoot, 'lib', 'volumes', volId, 'TOC.md'), 'utf8')
      check('MANUAL.md 不含可执行 HTML', !/<img/i.test(manual), '找到 <img')
      check('MANUAL.md 里是转义后的文本', /&lt;img/.test(manual), '没找到 &lt;img')
      check('TOC.md 同样转义', !/<img/i.test(toc) && /&lt;img/.test(toc), toc.split('\n').slice(3, 5).join(' | '))
    } finally {
      rmSync(xssRoot, { recursive: true, force: true })
    }
  }

  console.log('\n── 6. 空目录 ──')
  const emptyRoot = mkdtempSync(join(tmpdir(), 'ms-scan-empty-'))
  const emptyScanned = scanSessions({ sessionsRoot: emptyRoot })
  check('空会话根：0 会话、0 错误', emptyScanned.sessions.length === 0 && emptyScanned.errors.length === 0)
  rmSync(emptyRoot, { recursive: true, force: true })

  console.log('\n── 7. 不存在的根 ──')
  const missing = scanSessions({ sessionsRoot: join(root, 'no-such-dir') })
  check('根不存在：返回错误说明而不是抛异常', missing.sessions.length === 0 && missing.errors.length === 1, missing.errors[0])
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('\n' + '═'.repeat(74))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail) {
  console.log('失败用例：')
  for (const f of failures) console.log('  ✗ ' + f)
}
console.log('═'.repeat(74))
process.exit(fail ? 1 : 0)
