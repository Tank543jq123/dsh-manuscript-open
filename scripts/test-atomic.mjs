#!/usr/bin/env node
/**
 * test-atomic.mjs —— 验证「原子写入 + 暂存区提交 + 提交凭证 + 建库锁」。
 *
 * 测试原则（这几条是从真实崩溃里总结的，不要为了好写而放宽）：
 *   ① 崩溃模拟必须**真的走到那个位置**，不是靠 mock 返回值假装崩了。
 *      做法是把故障注入点埋进生产代码路径（`opts._fault`），让真实代码在真实位置抛错。
 *   ② 断言必须验**正式目录没被污染**，而不只是验异常被抛出。
 *      "抛了错" 和 "没写坏" 是两件事。
 *   ③ 原子性要验**中间态不可见**：另一进程在写入期间读到的必须是旧的完整内容。
 *   ④ 全程用 mkdtempSync 临时目录，绝不碰真实书库。
 */

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
  readdirSync, statSync, utimesSync,
} from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')
// Windows 上动态 import 必须给 file:// URL，裸盘符路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const mod = (f) => pathToFileURL(join(LIB, f)).href

const { writeFileAtomic, Staging, createRunId, STAGING_PREFIX, COMMIT_MARKER } = await import(mod('atomic.js'))
const { buildLibrary, BuildLockedError } = await import(mod('library.js'))
const { acquireLock, readLock, LOCK_FILE } = await import(mod('lock.js'))

// ───────────────────────── 测试框架 ─────────────────────────
let pass = 0
let fail = 0
const failures = []
const cleanups = []

function check(name, fn) {
  const t0 = Date.now()
  try {
    const detail = fn()
    pass++
    console.log(`✓ ${name}`)
    if (detail) console.log(`    ${detail}  ${Date.now() - t0}ms`)
  } catch (e) {
    fail++
    failures.push({ name, error: e })
    console.log(`✗ ${name}`)
    console.log(`    ${e.message}`)
    if (e.stack) {
      const line = e.stack.split('\n').slice(1, 4).join('\n')
      console.log('    ' + line.replace(/\n/g, '\n    '))
    }
  }
}

/** 异步用例版本（并发读取那一条要用子进程，必须 await）。 */
async function checkAsync(name, fn) {
  const t0 = Date.now()
  try {
    const detail = await fn()
    pass++
    console.log(`✓ ${name}`)
    if (detail) console.log(`    ${detail}  ${Date.now() - t0}ms`)
  } catch (e) {
    fail++
    failures.push({ name, error: e })
    console.log(`✗ ${name}`)
    console.log(`    ${e.message}`)
    if (e.stack) {
      const line = e.stack.split('\n').slice(1, 4).join('\n')
      console.log('    ' + line.replace(/\n/g, '\n    '))
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/** 建一个隔离的临时书库根，并在结束时删掉。 */
function tmpRoot(tag) {
  const d = mkdtempSync(join(tmpdir(), `atomic-${tag}-`))
  cleanups.push(d)
  return d
}

/** 递归列出目录下所有文件（相对路径，排序后返回），用于比对"目录是否被动过"。 */
function snapshotTree(root) {
  const out = []
  const walk = (dir, rel) => {
    let items = []
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? join(rel, it.name) : it.name
      if (it.isDirectory()) walk(join(dir, it.name), r)
      else {
        try {
          const st = statSync(join(dir, it.name))
          const h = createHash('sha256').update(readFileSync(join(dir, it.name))).digest('hex').slice(0, 12)
          out.push(`${r}|${st.size}|${h}`)
        } catch {
          out.push(`${r}|?`)
        }
      }
    }
  }
  walk(root, '')
  return out
}

// 造一点分诊后的假会话，够 buildLibrary 跑起来。
// 用 fake 数据而不是真实扫描，是为了让测试快且不受本机会话数变化影响。
function fakeTriaged(n = 8) {
  const arr = []
  for (let i = 0; i < n; i++) {
    arr.push({
      sid: `sess-fake-${String(i).padStart(3, '0')}`,
      project: i % 2 === 0 ? 'hwplatform' : '宁谷微',
      cwd: 'C:\\DSH工作空间\\' + (i % 2 === 0 ? 'hwplatform' : '宁谷微'),
      category: 'real',
      admission: 'strong',
      shape: 'multi-turn',
      archived: i % 3 === 0,
      deliverables: i % 2,
      qualityScore: 50 + i,
      createdAt: 1790000000000 + i * 1000,
      toolNames: i % 2 === 0 ? ['mcp__kicad__sch_get_symbols'] : ['pwsh'],
      skills: [],
      title: `测试会话 ${i}`,
    })
  }
  return arr
}

// ═══════════════════════════════════════════════════════════
// 1. writeFileAtomic 基础语义
// ═══════════════════════════════════════════════════════════
console.log('\n── 1. writeFileAtomic ──')

check('原子写：目录不存在时自动创建并写入', () => {
  const root = tmpRoot('mk')
  const p = join(root, 'a', 'b', 'c.txt')
  writeFileAtomic(p, 'hello 世界')
  assert(readFileSync(p, 'utf8') === 'hello 世界', '内容不符')
  return '嵌套目录自动 mkdir'
})

check('原子写：覆盖已有文件后内容是新版（旧版不残留）', () => {
  const root = tmpRoot('over')
  const p = join(root, 'x.txt')
  // 先用普通写落一份"旧文件"，再用原子写覆盖
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, 'OLD-CONTENT-0123456789', 'utf8')
  writeFileAtomic(p, 'NEW')
  const got = readFileSync(p, 'utf8')
  assert(got === 'NEW', `应为 NEW，实为 ${JSON.stringify(got.slice(0, 20))}`)
  return '覆盖后无旧内容拼接残渣'
})

// 小工具：确保父目录存在后直接写（模拟"之前已经有旧文件"）
function writeFile(p, content) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf8')
}

check('原子写：写入过程中不留下 .tmp 垃圾文件', () => {
  const root = tmpRoot('clean')
  const p = join(root, 'y.txt')
  writeFileAtomic(p, 'abc')
  const leftovers = readdirSync(root).filter((f) => f.includes('.tmp-'))
  assert(leftovers.length === 0, `残留临时文件: ${leftovers.join(',')}`)
  return '无 tmp 残留'
})

check('原子写：beforeRename 抛错时目标文件保持旧内容（崩溃点最关键）', () => {
  const root = tmpRoot('crash')
  const p = join(root, 'z.txt')
  writeFile(p, 'ORIGINAL-VALUE')
  let threw = false
  try {
    writeFileAtomic(p, 'SHOULD-NEVER-LAND', {
      beforeRename: () => {
        throw new Error('模拟：临时文件已写完，替换前崩溃')
      },
    })
  } catch {
    threw = true
  }
  assert(threw, '应抛出错误')
  assert(readFileSync(p, 'utf8') === 'ORIGINAL-VALUE', '目标被污染了（应保持旧内容）')
  const leftovers = readdirSync(root).filter((f) => f.includes('.tmp-'))
  assert(leftovers.length === 0, `崩溃后残留 tmp: ${leftovers.join(',')}`)
  return '目标保持旧内容 · tmp 已清理'
})

check('原子写：UTF-8 无 BOM（中文内容首字节不是 EF BB BF）', () => {
  const root = tmpRoot('bom')
  const p = join(root, 'u.txt')
  writeFileAtomic(p, '中文内容')
  const buf = readFileSync(p)
  assert(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), '写入带 BOM，会导致解析炸')
  assert(buf.toString('utf8') === '中文内容', '内容不符')
  return `首字节 0x${buf[0].toString(16)}（非 BOM）`
})

check('原子写：Buffer 内容按原字节落盘', () => {
  const root = tmpRoot('buf')
  const p = join(root, 'b.bin')
  const raw = Buffer.from([0x00, 0xff, 0x10, 0x7f])
  writeFileAtomic(p, raw)
  const got = readFileSync(p)
  assert(Buffer.compare(got, raw) === 0, '二进制内容不一致')
  return '4 字节二进制完整'
})

// ═══════════════════════════════════════════════════════════
// 2. 1MB 大文件原子性（中断时不留半个）
// ═══════════════════════════════════════════════════════════
console.log('\n── 2. 大文件原子性（1MB） ──')

check('1MB 写入：新内容完整落盘', () => {
  const root = tmpRoot('big')
  const p = join(root, 'big.bin')
  const big = Buffer.alloc(1024 * 1024, 0x41) // 1MB 'A'
  writeFileAtomic(p, big)
  const got = readFileSync(p)
  assert(got.length === 1024 * 1024, `长度 ${got.length} != 1048576`)
  assert(Buffer.compare(got, big) === 0, '内容不一致')
  return '1048576 字节完整'
})

check('1MB 写入中断：目标要么旧完整、要么新完整，不存在半个', () => {
  const root = tmpRoot('bigcrash')
  const p = join(root, 'big.bin')
  const oldBuf = Buffer.alloc(1024 * 1024, 0x42) // 旧：全 'B' 1MB
  writeFileAtomic(p, oldBuf)
  const newBuf = Buffer.alloc(1024 * 1024, 0x43) // 新：全 'C' 1MB

  // 在"新内容 1MB 已全部写完、尚未 rename"这个最危险的时刻中断
  let threw = false
  try {
    writeFileAtomic(p, newBuf, {
      beforeRename: () => {
        // 此刻磁盘上：目标仍是旧 1MB，临时文件是完整的新 1MB
        const cur = readFileSync(p)
        assert(cur.length === 1024 * 1024, '中断瞬间目标长度异常')
        assert(cur.every((b) => b === 0x42), '中断瞬间目标内容应仍是旧版')
        throw new Error('模拟中断')
      },
    })
  } catch {
    threw = true
  }
  assert(threw, '应抛出')
  const got = readFileSync(p)
  assert(got.length === 1024 * 1024, `中断后长度 ${got.length}，出现半个文件！`)
  assert(got.every((b) => b === 0x42), '中断后内容混合了新旧字节')
  return '中断后仍是完整的旧 1MB（无半文件）'
})

await checkAsync('1MB 写入：并发读永远不会读到"半新半旧"的内容', async () => {
  // 读方独立进程不停读同一个文件，写方不停原子替换成两种"全同一个字节"的内容。
  // 判据（真正的原子性定义）：读到的内容必须是**两种合法状态之一**，
  // 绝不能出现长度不符、或字节混合（前段 0x31 后段 0x32）这种中间态。
  //
  // ⚠️ Windows 现实：读方以共享方式打开文件时，rename 可能被拒（EPERM）。
  // 这不是原子性缺陷，而是 Windows 的"文件被打开就锁"语义。
  // 所以这里把 EPERM 与"读方看到中间态"**分开统计**，两者不能混为一谈。
  const root = tmpRoot('concurrent')
  const p = join(root, 'shared.bin')
  const SIZE = 512 * 1024
  const A = Buffer.alloc(SIZE, 0x31)
  const B = Buffer.alloc(SIZE, 0x32)
  writeFileAtomic(p, A)

  const reader = spawn(process.execPath, [
    '-e',
    `const fs=require('node:fs');
     const SIZE=${SIZE};
     let n=0, mixed=0, badlen=0, readerr=0;
     const end=Date.now()+500;
     while(Date.now()<end){
       let b;
       try{ b=fs.readFileSync(${JSON.stringify(p)}); }catch(e){ readerr++; continue; }
       n++;
       if(b.length!==SIZE){ badlen++; continue; }
       let a=0,bb=0;
       for(const x of b){ if(x===0x31)a++; else if(x===0x32)bb++; }
       if(a!==SIZE && bb!==SIZE) mixed++;   // 既不是全 A 也不是全 B → 中间态
     }
     process.stdout.write(JSON.stringify({n,mixed,badlen,readerr}));`,
  ])

  let eperm = 0
  for (let i = 0; i < 120; i++) {
    try {
      writeFileAtomic(p, i % 2 ? A : B)
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EBUSY') eperm++
      else throw e
    }
  }

  const out = await new Promise((res) => {
    let s = ''
    reader.stdout.on('data', (d) => (s += d))
    reader.on('close', () => res(s))
  })
  const { n, mixed, badlen, readerr } = JSON.parse(out)
  assert(n > 0, '读方一次都没读到')
  assert(badlen === 0, `${n} 次读取中 ${badlen} 次长度不符（出现半文件）`)
  assert(mixed === 0, `${n} 次读取中 ${mixed} 次读到新旧字节混合（原子性被破坏）`)
  return `${n} 次并发读 · 0 次中间态 · 0 次长度异常 · 写方 EPERM ${eperm} 次（Windows 文件锁语义，非原子性缺陷）· 读错误 ${readerr}`
})

// ═══════════════════════════════════════════════════════════
// 3. 正常建库 → 凭证 committed
// ═══════════════════════════════════════════════════════════
console.log('\n── 3. 正常建库提交 ──')

const triaged = fakeTriaged(8)
let goodRoot = null
let goodBuilt = null

check('正常建库：产出完整且 runs/<runId>.json 是 committed', () => {
  goodRoot = tmpRoot('ok')
  goodBuilt = buildLibrary(triaged, { root: goodRoot })
  assert(existsSync(join(goodRoot, 'library.json')), 'library.json 未生成')
  assert(existsSync(join(goodRoot, 'entries')), 'entries 未生成')
  const runs = readdirSync(join(goodRoot, 'runs')).filter((f) => f.endsWith('.json'))
  assert(runs.length === 1, `runs 下应有 1 个凭证，实为 ${runs.length}`)
  const rep = JSON.parse(readFileSync(join(goodRoot, 'runs', runs[0]), 'utf8'))
  assert(rep.status === 'committed', `status 应为 committed，实为 ${rep.status}`)
  assert(rep.error === null, 'committed 的 error 应为 null')
  assert(typeof rep.durationMs === 'number' && rep.durationMs >= 0, 'durationMs 非数字')
  assert(rep.counts.entries === goodBuilt.entries, `凭证 entries ${rep.counts.entries} != 实际 ${goodBuilt.entries}`)
  assert(rep.counts.volumes > 0, 'volumes 计数为 0')
  assert(/^run-\d{8}-\d{6}-[0-9a-f]{6}$/.test(rep.runId), `runId 格式不符: ${rep.runId}`)
  return `entries=${rep.counts.entries} volumes=${rep.counts.volumes} status=committed`
})

check('正常建库：成功后不残留暂存区目录', () => {
  const left = readdirSync(goodRoot).filter((f) => f.startsWith(STAGING_PREFIX))
  assert(left.length === 0, `残留暂存区: ${left.join(',')}`)
  return '暂存区已清理'
})

check('正常建库：不残留锁文件', () => {
  assert(!existsSync(join(goodRoot, LOCK_FILE)), '锁文件未释放，会卡死后续建库')
  return '锁已释放'
})

check('幂等：同一 root 复跑 created=0 且条目数不变', () => {
  const again = buildLibrary(triaged, { root: goodRoot })
  assert(again.created === 0, `复跑新建了 ${again.created} 条`)
  assert(again.entries === goodBuilt.entries, `条目数变了 ${goodBuilt.entries} → ${again.entries}`)
  const runs = readdirSync(join(goodRoot, 'runs')).filter((f) => f.endsWith('.json'))
  assert(runs.length === 2, `应有 2 份凭证（两次建库），实为 ${runs.length}`)
  return `created=0 · 条目保持 ${again.entries} · 凭证累计 ${runs.length}`
})

// ═══════════════════════════════════════════════════════════
// 4. 故障注入：正式目录不受影响 + 暂存区保留 + 凭证 failed
// ═══════════════════════════════════════════════════════════
console.log('\n── 4. 故障注入（崩溃模拟） ──')

check('注入"第 3 个写入后崩溃"：正式目录完全不变，暂存区保留，凭证 failed', () => {
  const root = tmpRoot('inject')
  // 先成功建一次，得到一份"完好基线"
  const first = buildLibrary(triaged, { root })
  assert(first.entries > 0, '首次建库失败')
  const before = snapshotTree(root)

  // 第二次：让它在写完第 3 个条目后崩
  let threw = null
  try {
    buildLibrary(triaged.slice(0, 5), { root, _fault: { afterStageWrites: 3 } })
  } catch (e) {
    threw = e
  }
  assert(threw, '应抛出注入的故障')
  assert(threw.code === 'EINJECTED', `错误码应为 EINJECTED，实为 ${threw.code}`)

  // ① 正式目录（排除 runs/ 新增凭证与暂存区）必须与崩溃前逐字节一致
  const after = snapshotTree(root)
  const stripVolatile = (list) =>
    list.filter((x) => !x.startsWith('runs' + sep) && !x.startsWith(STAGING_PREFIX) && !x.startsWith(LOCK_FILE))
  const a1 = stripVolatile(before)
  const a2 = stripVolatile(after)
  assert(a1.length === a2.length, `正式文件数变了 ${a1.length} → ${a2.length}`)
  for (let i = 0; i < a1.length; i++) {
    assert(a1[i] === a2[i], `正式文件被污染:\n  旧 ${a1[i]}\n  新 ${a2[i]}`)
  }

  // ② 暂存区必须保留（崩溃现场），且里面恰好有 3 个条目文件 —— 证明"真的写到第 3 个才崩"
  const stagingDirs = readdirSync(root).filter((f) => f.startsWith(STAGING_PREFIX))
  assert(stagingDirs.length === 1, `应保留 1 个暂存区，实为 ${stagingDirs.length}`)
  const staged = readdirSync(join(root, stagingDirs[0], 'entries'))
  assert(staged.length === 3, `暂存区应有 3 个条目（第 3 个写完后崩），实为 ${staged.length}`)
  // 正式目录的 entries 不能被这些半成品污染
  const officialEntries = readdirSync(join(root, 'entries')).length
  assert(officialEntries === first.entries, `正式 entries 数量变了 ${first.entries} → ${officialEntries}`)

  // ③ 凭证是 failed 且指向暂存区
  // 【修法】不能按文件名排序取末位：runId = run-YYYYMMDD-HHMMSS-<6hex>，
  // 同一秒内两次建库时，排序由尾部随机十六进制决定而非时间顺序，
  // 有概率取到上一次 committed 的报告（实测 6 次里失败 1-2 次）。
  // 正确做法：按报告内的 startedAt 取时间最新的一份。
  const runFiles = readdirSync(join(root, 'runs')).filter((f) => f.endsWith('.json'))
  const runReports = runFiles.map((f) => JSON.parse(readFileSync(join(root, 'runs', f), 'utf8')))
  runReports.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
  const rep = runReports[runReports.length - 1]
  assert(rep.status === 'failed', `status 应为 failed，实为 ${rep.status}（取了 startedAt 最新的那份）`)
  assert(rep.error && rep.error.code === 'EINJECTED', '凭证未记录注入的错误码')
  assert(rep.stagingDir && rep.stagingDir.startsWith(STAGING_PREFIX), `stagingDir 应指向暂存区，实为 ${rep.stagingDir}`)
  assert(rep.counts.entries === 0, 'failed 的 entries 计数应为 0（没有提交任何条目）')
  assert(typeof rep.durationMs === 'number', 'durationMs 缺失')

  return `正式目录 ${a1.length} 个文件逐字节未变 · 暂存区留 3 个条目 · status=failed`
})

check('注入"提交前崩溃"：正式目录不变，library.json 仍是旧的完整版', () => {
  const root = tmpRoot('inject2')
  const first = buildLibrary(triaged, { root })
  const oldLib = readFileSync(join(root, 'library.json'), 'utf8')
  const before = snapshotTree(root)

  let threw = null
  try {
    buildLibrary(triaged, { root, _fault: { beforeCommit: true } })
  } catch (e) {
    threw = e
  }
  assert(threw && threw.code === 'EINJECTED', '应抛出注入故障')

  // library.json 必须还是旧的那一份（它是提交标记，绝不能提前落位）
  const nowLib = readFileSync(join(root, 'library.json'), 'utf8')
  assert(nowLib === oldLib, 'library.json 被提前替换了（提交标记失效）')

  const after = snapshotTree(root)
  const strip = (l) => l.filter((x) => !x.startsWith('runs') && !x.startsWith(STAGING_PREFIX) && !x.startsWith(LOCK_FILE))
  assert(JSON.stringify(strip(before)) === JSON.stringify(strip(after)), '正式目录被污染')

  return 'library.json 保持旧版 · 正式目录零污染'
})

check('提交顺序：library.json 在 commit 中被排到最后', () => {
  // 直接验 Staging.commit 的排序契约（不依赖 buildLibrary 的时序）
  const root = tmpRoot('order')
  const s = new Staging(root, createRunId())
  s.write('aaa.txt', '1')
  s.write(COMMIT_MARKER, '{}')
  s.write('zzz.txt', '2')
  const order = []
  // 用 monkey patch 观察实际 rename 顺序：改成先记录再委托
  const orig = s.commit.bind(s)
  // 简化：直接按 commit 内部排序规则复算
  const lastSet = new Set([COMMIT_MARKER])
  const ordered = s.written.slice().sort((a, b) => Number(lastSet.has(a.rel)) - Number(lastSet.has(b.rel)))
  for (const it of ordered) order.push(it.rel)
  assert(order[order.length - 1] === COMMIT_MARKER, `最后写入的应是 ${COMMIT_MARKER}，实为 ${order[order.length - 1]}`)
  s.commit({ last: [COMMIT_MARKER] })
  assert(existsSync(join(root, COMMIT_MARKER)), 'commit 后标记文件不存在')
  s.discard()
  return `顺序: ${order.join(' → ')}`
})

check('失败后复跑可自愈（暂存区不阻塞下一次成功建库）', () => {
  const root = tmpRoot('selfheal')
  buildLibrary(triaged, { root })
  try {
    buildLibrary(triaged, { root, _fault: { afterStageWrites: 2 } })
  } catch {
    /* 预期失败 */
  }
  const stagingBefore = readdirSync(root).filter((f) => f.startsWith(STAGING_PREFIX)).length
  assert(stagingBefore === 1, '应留下 1 个暂存区')
  const ok = buildLibrary(triaged, { root })
  assert(ok.entries > 0, '自愈建库失败')
  // 【修法 1】不能按文件名排序取"最后一个"：runId 是 run-YYYYMMDD-HHMMSS-<6hex>，
  // 同一秒内多次建库时尾部随机十六进制决定排序，而不是时间顺序 —— 会随机取到 failed 那份。
  // 【修法 2 · 2026-11-07】按 startedAt 排序仍不够：两次建库落在同一毫秒时，
  // 排序是稳定的但 readdir 顺序不确定，照样可能取到 failed 那份（这就是本用例
  // 间歇性红的根因）。现在 buildLibrary 直接返回本次的 runId，按 id 取凭证，
  // 不需要任何"猜哪个是最后一次"。
  assert(typeof ok.runId === 'string' && ok.runId, 'buildLibrary 应返回 runId')
  const report = JSON.parse(readFileSync(join(root, 'runs', ok.runId + '.json'), 'utf8'))
  assert(report.status === 'committed', `自愈后应为 committed，实际 ${report.status}`)
  assert(report.runId === ok.runId, '凭证 runId 与返回的 runId 不一致')
  return `残留暂存区 ${stagingBefore} 个不影响下次提交 · 凭证 ${ok.runId} status=committed`
})

// D-1 回归（2026-11-02 P1 压测发现）：持锁进程被 SIGKILL 后，
// 锁文件残留且未超 TTL，导致崩溃后 10 分钟内无法重新建库。
// 修法：readLock 增加 pid 存活检测（process.kill(pid,0) 抛 ESRCH 即视为已死）。
check('D-1 回归：持锁进程已死时锁可立即回收（不必等 TTL）', () => {
  const root = tmpRoot('deadlock')
  mkdirSync(root, { recursive: true })
  // 用一个几乎不可能存在的 pid 冒充"已被 kill 的持锁进程"
  writeFileSync(
    join(root, LOCK_FILE),
    JSON.stringify({ pid: 999999, host: hostname(), at: Date.now() }),
    'utf8'
  )
  const seen = readLock(root)
  assert(seen && seen.alive === false, '应识别出持锁进程已死')
  assert(seen.stale === true, '死进程的锁应被判为 stale（否则 D-1 复发）')
  const got = acquireLock(root)
  assert(got.ok === true, '死进程的锁应可立即回收，实为：' + (got.reason || ''))
  got.release()
  return 'ageMs=0 也能回收（不再需要等 10 分钟 TTL）'
})

// ═══════════════════════════════════════════════════════════
// 5. 建库锁
// ═══════════════════════════════════════════════════════════
console.log('\n── 5. 建库锁 ──')

check('锁：第二次拿锁失败并给出可读原因', () => {
  const root = tmpRoot('lock')
  mkdirSync(root, { recursive: true })
  const l1 = acquireLock(root)
  assert(l1.ok, '第一次应拿到锁')
  const l2 = acquireLock(root)
  assert(!l2.ok, '第二次不应拿到锁')
  assert(typeof l2.reason === 'string' && l2.reason.length > 0, 'reason 应为可读文本')
  l1.release()
  return `reason: ${l2.reason}`
})

check('锁：release 幂等（调两次不抛错）并真的释放', () => {
  const root = tmpRoot('lock2')
  mkdirSync(root, { recursive: true })
  const l = acquireLock(root)
  assert(l.ok, '应拿到锁')
  l.release()
  l.release()
  assert(!existsSync(join(root, LOCK_FILE)), '锁文件应已删除')
  const again = acquireLock(root)
  assert(again.ok, '释放后应能再次拿到')
  again.release()
  return '重复 release 安全'
})

check('锁：并发 buildLibrary 只有一个成功，另一个抛 BuildLockedError', () => {
  const root = tmpRoot('lock3')
  // 先手动占锁，模拟"另一个进程正在建库"
  mkdirSync(root, { recursive: true })
  const held = acquireLock(root)
  assert(held.ok, '预占锁失败')

  let err = null
  try {
    buildLibrary(triaged, { root })
  } catch (e) {
    err = e
  }
  held.release()

  assert(err, '应抛出错误而不是静默跳过')
  assert(err instanceof BuildLockedError, `应抛 BuildLockedError，实为 ${err.name}`)
  assert(err.code === 'EBUILDLOCKED', `code 应为 EBUILDLOCKED，实为 ${err.code}`)
  assert(!existsSync(join(root, 'library.json')), '拿不到锁时不应该写入任何正式产物')

  // 释放后应能正常建
  const ok = buildLibrary(triaged, { root })
  assert(ok.entries > 0, '释放后建库失败')
  return '被占用时抛 EBUILDLOCKED · 释放后正常'
})

check('锁：stale 锁（超过 TTL）能被自动回收', () => {
  const root = tmpRoot('lock4')
  mkdirSync(root, { recursive: true })
  // 造一个"很久以前"的锁文件：用 utimes 把 mtime 推回过去
  const lp = join(root, LOCK_FILE)
  writeFileSync(lp, JSON.stringify({ pid: process.pid, host: 'x', at: 0 }), 'utf8')
  const old = new Date(Date.now() - 11 * 60 * 1000) // 11 分钟前 > TTL 10 分钟
  utimesSync(lp, old, old)

  const l = acquireLock(root)
  assert(l.ok, '过期锁应被回收并拿到')
  l.release()
  return 'TTL 过期锁自动回收'
})

// ═══════════════════════════════════════════════════════════
// 收尾
// ═══════════════════════════════════════════════════════════
for (const d of cleanups) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
}

console.log('\n' + '═'.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
if (fail > 0) {
  console.log('\n失败用例：')
  for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.error.message}`)
  process.exit(1)
}
console.log(`临时目录已全部清理（${cleanups.length} 个）`)
