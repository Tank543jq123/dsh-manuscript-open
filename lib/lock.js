/**
 * 建库锁：防止两个 `buildLibrary()` 同时跑导致互相覆盖。
 *
 * 为什么需要：用户手快连点两次"立即重扫"，或者定时任务与手动重扫撞上，
 * 就会有两个进程同时写 `entries/` 和 `library.json`。
 * 后写的会覆盖先写的，结果是**总账数字与实际文件对不上**。
 *
 * 做法（POSIX 风格的文件锁）：
 *   `fs.openSync(lockPath, 'wx')` —— `wx` 是「独占创建 + 已存在则失败」，
 *   这个语义在本地文件系统上是原子的，不需要额外依赖。
 *
 * 三条必须处理的情况：
 *   ① 正常释放 —— `finally` 里 unlink
 *   ② 进程被 kill —— 锁文件残留，靠 **stale 检测**（超过 TTL 就视为失效）回收
 *   ③ 持锁进程还活着但卡死 —— 同样靠 TTL，但 TTL 要留够余量
 *
 * 设计取舍：宁可**误判为失效**（两个进程都跑，可能覆盖）也不要**永久卡死**
 * （用户从此无法建库）。所以 TTL 取 10 分钟，而正常建库实测 < 1 秒。
 */

import { openSync, writeSync, closeSync, unlinkSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'

/** 锁的有效期。超过这个年龄视为持锁进程已死。正常建库 < 1 秒，10 分钟足够安全。 */
export const LOCK_TTL_MS = 10 * 60 * 1000

/** 锁文件名。放在书库根下，与 library.json 同级便于发现。 */
export const LOCK_FILE = '.build.lock'

/**
 * 判断持锁的进程是否还活着。
 *
 * ⚠️ 这是 P1 压测发现的 D-1 缺陷的修法（2026-11-02）：
 *   原来 stale 只判 TTL（10 分钟）。如果持锁进程被 SIGKILL，
 *   锁文件残留但 ageMs 远小于 TTL —— 于是**崩溃后的 10 分钟内无法重新建库**，
 *   而且错误文案说"另一个进程正在运行（0s 前获取）"，那进程其实早死了。
 *
 * 判据：`process.kill(pid, 0)` 是"发信号 0"——不真发信号，只做权限与存在性检查。
 *   · 抛 `ESRCH` → 进程不存在 → 锁失效
 *   · 抛 `EPERM` → 进程存在但不是我们的 → 锁仍有效（不要误判为失效）
 *   · 正常返回   → 进程存在 → 锁有效
 *
 * 边界：只在本机能判定。持锁 host 与当前 host 不同时无法查证，退回只判 TTL
 *   （跨机器共用书库是少数场景，且误判为失效最多导致两个进程并发写，
 *     而误判为有效会让用户永久卡住 —— 两害相权取其轻）。
 *
 * @param {{pid:number, host:string}} holder
 * @returns {boolean} true = 进程还在（锁有效）；false = 已死（可回收）
 */
function isHolderAlive(holder) {
  if (!holder || holder.pid <= 0) return false
  // 跨机器：没法查，保守认为还活着，交给 TTL 兜底
  if (holder.host && holder.host !== hostname()) return true
  try {
    process.kill(holder.pid, 0)
    return true
  } catch (e) {
    // ESRCH = 无此进程 → 死了
    // EPERM = 有你没权限 → 活着
    return e.code !== 'ESRCH'
  }
}

/**
 * 读锁文件内容。锁文件本身可能被截断（写到一半被 kill），所以解析要容错。
 * @param {string} root
 * @returns {{pid:number, host:string, at:number, ageMs:number, stale:boolean, alive:boolean} | null}
 */
export function readLock(root) {
  const p = join(root, LOCK_FILE)
  if (!existsSync(p)) return null
  let raw = ''
  let ageMs = 0
  try {
    ageMs = Date.now() - statSync(p).mtimeMs
    raw = readFileSync(p, 'utf8')
  } catch {
    // 读都读不到：当成失效锁处理，但不抛错
    return { pid: -1, host: '', at: 0, ageMs: LOCK_TTL_MS, stale: true, alive: false }
  }
  let info = {}
  try {
    info = JSON.parse(raw)
  } catch {
    // 截断的锁文件：视为失效
    return { pid: -1, host: '', at: 0, ageMs, stale: true, alive: false }
  }
  const holder = {
    pid: typeof info.pid === 'number' ? info.pid : -1,
    host: typeof info.host === 'string' ? info.host : '',
    at: typeof info.at === 'number' ? info.at : 0,
  }
  const alive = isHolderAlive(holder)
  return {
    ...holder,
    ageMs,
    // 失效 = 超时，或持锁进程已死
    stale: ageMs > LOCK_TTL_MS || !alive,
    alive,
  }
}

/**
 * 尝试拿锁。
 *
 * @param {string} root 书库根
 * @param {{ttlMs?: number, now?: number}} [opts]
 * @returns {{ok:true, release:()=>void} | {ok:false, holder:object, reason:string}}
 */
export function acquireLock(root, opts = {}) {
  const ttl = opts.ttlMs ?? LOCK_TTL_MS
  const lockPath = join(root, LOCK_FILE)
  const payload = JSON.stringify({ pid: process.pid, host: hostname(), at: opts.now ?? Date.now() })

  const tryCreate = () => {
    // 'wx' = O_CREAT | O_EXCL | O_WRONLY：文件已存在就抛 EEXIST，原子
    const fd = openSync(lockPath, 'wx')
    try {
      writeSync(fd, payload)
    } finally {
      closeSync(fd)
    }
  }

  try {
    tryCreate()
  } catch (e) {
    if (e.code !== 'EEXIST') throw e

    // 锁已存在：判断是否失效
    const holder = readLock(root)
    if (holder && holder.stale) {
      // 失效锁：回收后重试一次。
      // 注意这里存在极小的竞态（两个进程同时判定失效同时删），
      // 但重试路径里 `wx` 仍然只有一个能成功，所以结果安全。
      try {
        unlinkSync(lockPath)
      } catch {
        /* 别人已经删了，继续重试 */
      }
      try {
        tryCreate()
      } catch (e2) {
        const h2 = readLock(root)
        return {
          ok: false,
          holder: h2,
          reason: `回收失效锁后仍被抢占（${h2?.pid ?? '?'}，${Math.round((h2?.ageMs ?? 0) / 1000)}s 前）`,
        }
      }
    } else {
      // 文案要区分两种真实情况：
      //   · 持锁进程还活着 → "另一个进程正在运行"（用户应该等）
      //   · 持锁进程已死但没超 TTL → 理论上不该走到这里（readLock 已把它判 stale），
      //     但跨主机场景会走这里，文案要说清"无法确认"
      const who = holder?.alive === false ? '无法确认持锁进程状态' : '另一个建库进程正在运行'
      const host = holder?.host && holder.host !== '' ? ` @${holder.host}` : ''
      return {
        ok: false,
        holder,
        reason: `${who}（pid ${holder?.pid ?? '?'}${host}，${Math.round((holder?.ageMs ?? 0) / 1000)}s 前获取）`,
      }
    }
  }

  let released = false
  return {
    ok: true,
    release() {
      if (released) return
      released = true
      try {
        // 只删自己持有的锁：防止误删别人刚抢到的锁
        const cur = readLock(root)
        if (cur && cur.pid === process.pid) unlinkSync(lockPath)
      } catch {
        /* 释放失败不影响主流程 */
      }
    },
  }
}

/**
 * 在锁保护下执行。拿不到锁就返回 `{skipped:true}` 而不是抛错 ——
 * 因为"另一个进程正在建库"是正常情况，不是错误。
 *
 * @template T
 * @param {string} root
 * @param {() => T} fn
 * @param {{ttlMs?: number}} [opts]
 * @returns {{skipped:true, holder:object, reason:string} | {skipped:false, value:T}}
 */
export function withBuildLock(root, fn, opts = {}) {
  const got = acquireLock(root, opts)
  if (!got.ok) return { skipped: true, holder: got.holder, reason: got.reason }
  try {
    return { skipped: false, value: fn() }
  } finally {
    got.release()
  }
}
