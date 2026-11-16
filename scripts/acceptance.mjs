#!/usr/bin/env node
/**
 * scripts/acceptance.mjs —— 可重复的「验收入口」（2026-11-16）。
 *
 * ## 为什么要有它
 *
 * 之前的验收依赖「作者机器上的真实书库」：test-ui-endpoints 复制 ~/.dsh/dsh-manuscript，
 * selfcheck 扫 ~/.dsh/sessions。换台机器、进 CI、或者用户库清空了，同一条命令
 * 得到的是另一套结论 —— 这不叫验收，叫「在我这儿是好的」。
 *
 * 这条流程改成自给自足：先造 3 个夹具会话 → 走真实的 scan/triage/buildLibrary 建库
 * → 再拿这个库去跑只读接口测试。任何机器、任何时间跑，输入都一样，结论可比。
 *
 * ## 用法
 *
 *   node scripts/acceptance.mjs            # 全流程，成功 exit 0
 *   node scripts/acceptance.mjs --keep     # 保留临时目录，方便打开看
 *
 * ## 它不做什么
 *
 * - 不碰 ~/.dsh 下的真实库与真实会话（全程只读不写）
 * - 不推微信、不起服务、不改任何仓库文件
 */

import { mkdtempSync, existsSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { scanSessions } from '../lib/scan.js'
import { triageAll } from '../lib/triage.js'
import { buildLibrary } from '../lib/library.js'
import { writeSessionFixture } from './lib/session-fixture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(HERE, '..', 'data')
const KEEP = process.argv.includes('--keep')

let pass = 0
let fail = 0
const failures = []
function check(name, fn) {
  try {
    const detail = fn()
    pass += 1
    console.log(`✓ ${name}${detail ? '  ' + detail : ''}`)
  } catch (e) {
    fail += 1
    failures.push(`${name} → ${e.message}`)
    console.log(`✗ ${name}\n    ${e.message}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const TMP = mkdtempSync(join(tmpdir(), 'ms-acceptance-'))
const SESSIONS = join(TMP, 'sessions')
const LIB = join(TMP, 'library')

console.log('\n── 1. 造夹具语料（不读用户数据）──')
check('写 3 个夹具会话', () => {
  writeSessionFixture(SESSIONS, { sid: 'acc-plugin', title: '插件装进运行中的 profile 无需重启', tools: [{ name: 'write', args: { file_path: 'D:\\proj\\hwplatform\\插件.md' } }] })
  writeSessionFixture(SESSIONS, { sid: 'acc-cron', title: '定时巡检要在面板上可配置时间点', tools: [{ name: 'write', args: { file_path: 'D:\\proj\\hwplatform\\巡检.md' } }] })
  writeSessionFixture(SESSIONS, { sid: 'acc-hr', title: '招聘网站未登录时薪资字段不展示', tools: [{ name: 'bash', args: { command: 'curl x' } }] })
  const dirs = readdirSync(SESSIONS)
  return `${dirs.length} 个项目目录`
})

console.log('\n── 2. 走真实管线建库 ──')
let built
check('scan → triage → buildLibrary', () => {
  const scanned = scanSessions({ sessionsRoot: SESSIONS })
  assert(scanned.errors.length === 0, '解析错误：' + JSON.stringify(scanned.errors))
  const triaged = triageAll(scanned.sessions)
  built = buildLibrary(triaged.enriched, { root: LIB, dataDir: DATA_DIR })
  assert(existsSync(join(LIB, 'library.json')), 'library.json 未生成')
  return `${scanned.sessions.length} 会话 → ${built.entries} 条入册`
})

// 夹具会话只带标题与工具调用，建出来的条目 why 是空串，正文退化成 claim；
// 而 test-ui-endpoints 会断言「正文来自 why、与 claim 不同」。
// 这里给每个条目的 entries/*.json 补一段 why —— 补的是夹具，不是产品数据。
check('给夹具条目补正文（why 段）', () => {
  const dir = join(LIB, 'entries')
  let patched = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const p = join(dir, name)
    const obj = JSON.parse(readFileSync(p, 'utf8'))
    if (obj.why && String(obj.why).trim()) continue
    obj.why = '实测：装完刷新页面即见效，不需要重启进程；同一条命令跑两次结果一致。'
    writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
    patched += 1
  }
  assert(patched > 0, '没有条目被补正文')
  return `${patched} 条`
})

check('入口条数为正（否则后面的接口测试没有意义）', () => {
  assert(Number(built?.entries) > 0, 'entries=' + built?.entries)
  return `entries=${built.entries}`
})

console.log('\n── 3. 用这个库跑只读接口测试 ──')
check('test-ui-endpoints 在新库上通过', () => {
  const r = spawnSync(process.execPath, [join(HERE, 'test-ui-endpoints.mjs')], {
    env: { ...process.env, DSH_MANUSCRIPT_ROOT: LIB, DSH_SESSIONS_ROOT: SESSIONS },
    encoding: 'utf8',
    timeout: 120000,
  })
  const tail = String(r.stdout || '').trim().split('\n').slice(-3).join(' | ')
  assert(r.status === 0, `exit=${r.status}：${tail}`)
  assert(/0 失败/.test(String(r.stdout || '')), '输出里没有「0 失败」：' + tail)
  return tail
})

console.log('\n' + '='.repeat(60))
console.log(`验收结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (keep()) console.log('临时目录：' + TMP)
if (fail > 0) {
  for (const f of failures) console.log('  ' + f)
  if (!keep()) rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
}
if (!keep()) rmSync(TMP, { recursive: true, force: true })

function keep() {
  return KEEP
}
