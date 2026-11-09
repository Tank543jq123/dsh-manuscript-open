/**
 * 原子写入 + 暂存区提交。
 *
 * 解决的问题：建库是「写 N 个文件」的多步操作。如果中途崩溃（或第二次建库来踩），
 * 会留下「entries 写了一部分、library.json 没写」的半写状态。
 * 而幂等逻辑是「文件已存在就跳过」，**半写状态会被永久固化**，之后再也修不回来。
 *
 * 三层防御：
 *   ① `writeFileAtomic` —— 单个文件要么是旧的完整版，要么是新的完整版，不存在半个。
 *   ② 暂存区（staging）—— 所有产物先写到 `<root>/.staging-<runId>/`，
 *      全部写成功后才一次性搬进正式位置。**写过半时正式目录完全没被碰过。**
 *   ③ 提交标记 —— `library.json` 最后提交，它是「这一批产物已经完整」的唯一信号。
 *
 * 为什么暂存区必须在 root 下面（不能放 os.tmpdir()）：
 *   **跨分区的 rename 不是原子操作**，退化成 copy+delete，崩在中间就是半个文件。
 *   暂存区与正式位置同分区，才能保证 `renameSync` 是原子的。
 */

import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 暂存区目录名前缀。`.<前缀>-<runId>`，点开头以免被当成内容目录。 */
export const STAGING_PREFIX = '.staging-'

/** 提交标记文件：只有它落位，才代表这一批产物完整。 */
export const COMMIT_MARKER = 'library.json'

/**
 * 生成 runId，形如 `run-20261102-103000-abc123`。
 *
 * 带上秒级时间戳是为了让人一眼看出这是哪一次建库；
 * 后缀 6 位随机是为了**同一秒内并发两次也不会撞名**（撞名会让两次建库共用一个暂存区）。
 *
 * @param {Date} [d]
 * @returns {string}
 */
export function createRunId(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `run-${stamp}-${randomBytes(3).toString('hex')}`
}

/**
 * 尽力 fsync 一个目录，让「rename 已落盘」这件事也持久化。
 *
 * 为什么要容错：Windows 上 `openSync(dir)` 会抛 EPERM/EISDIR（不能把目录当文件打开），
 * 而 Linux/macOS 上可以。所以这属于「能做就做，不能做不报错」的增强，
 * 不能让一个平台差异把建库搞挂。
 * @param {string} dir
 */
function fsyncDirBestEffort(dir) {
  let fd = null
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    /* 平台不支持目录 fsync：忽略 */
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 忽略 */
      }
    }
  }
}

/**
 * 原子写文件：写同目录临时文件 → fsync → rename 覆盖目标。
 *
 * 为什么临时文件必须与目标**同目录**：
 *   `rename` 只在同一分区/卷内是原子的。跨分区会退化成「复制 + 删源」，
 *   复制到一半崩溃就留下半个文件，正是我们要消灭的东西。
 *
 * @param {string} filePath 目标路径
 * @param {string|Buffer} content 内容（字符串按 UTF-8 编码，不加 BOM）
 * @param {{fsync?: boolean, beforeRename?: (tmpPath: string) => void}} [opts]
 *   - `fsync` 默认 true。设 false 可提速，但断电后可能丢内容。
 *   - `beforeRename` **仅供测试注入**：在 rename 之前调用，可在此抛错/杀进程
 *     以模拟「临时文件已写完、尚未替换目标」这个最危险的时刻。
 * @returns {string} 目标路径
 */
export function writeFileAtomic(filePath, content, opts = {}) {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })

  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
  // 临时文件名带 pid + 随机后缀：并发写同一目标时互不踩踏
  const tmp = join(dir, `.${basename(filePath)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)

  let fd = null
  try {
    fd = openSync(tmp, 'w')
    // 自己循环写，避免 writeSync 短写（大文件时 write 可能只写一部分）
    let off = 0
    while (off < buf.length) {
      off += writeSync(fd, buf, off, buf.length - off)
    }
    if (opts.fsync !== false) fsyncSync(fd)
    closeSync(fd)
    fd = null

    if (typeof opts.beforeRename === 'function') opts.beforeRename(tmp)

    // 同分区 rename：原子替换。目标已存在也会被覆盖（Node 在 Windows 用 MOVEFILE_REPLACE_EXISTING）
    renameSync(tmp, filePath)
    fsyncDirBestEffort(dir)
    return filePath
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 忽略 */
      }
    }
    // 失败清理临时文件，绝不留垃圾（但进程被 SIGKILL 时这里不会执行，残留文件是崩溃证据）
    try {
      unlinkSync(tmp)
    } catch {
      /* 文件可能已经被 rename 走了，或本来就没建起来 */
    }
    throw e
  }
}

/**
 * 暂存区：所有产物先写到这里，最后一次性搬到正式位置。
 *
 * 崩在写入阶段时：正式目录**完全没被碰过**，暂存区保留下来供排查。
 * 崩在提交阶段时：已搬走的文件是新版、没搬的还是旧版，但 `library.json`
 *   因为排在最后，所以**只要它还指着上一批，就说明这批没交付完整**。
 */
export class Staging {
  /**
   * @param {string} root 书库根（暂存区建在它下面，保证与正式位置同分区）
   * @param {string} runId
   */
  constructor(root, runId) {
    this.root = root
    this.runId = runId
    this.dir = join(root, STAGING_PREFIX + runId)
    /** @type {{rel: string, bytes: number}[]} 按写入顺序 */
    this.written = []
    /** @type {string[]} 已成功搬到正式位置的相对路径 */
    this.committed = []
    mkdirSync(this.dir, { recursive: true })
  }

  /** 暂存区内的绝对路径。 */
  pathOf(rel) {
    return join(this.dir, rel)
  }

  /**
   * 写一个文件到暂存区（相对路径）。暂存区内也用原子写，
   * 免得暂存区自己出现写一半的文件被后续误判。
   * @param {string} rel 相对路径，如 `entries/e-xxx.json`
   * @param {string} content
   */
  write(rel, content) {
    const p = writeFileAtomic(this.pathOf(rel), content)
    this.written.push({ rel, bytes: Buffer.byteLength(String(content), 'utf8') })
    return p
  }

  /**
   * 一次性把暂存区内容搬到正式位置。
   *
   * 排序规则：普通文件按写入顺序先搬；`COMMIT_MARKER`（library.json）**永远最后**。
   * 这样「library.json 已就位」就等价于「这一批全部搬完了」。
   *
   * @param {{last?: string[]}} [opts] 额外指定要排在最后的相对路径
   * @returns {{committed: string[], failedAt: string|null, moved: number}}
   */
  commit(opts = {}) {
    const lastSet = new Set([COMMIT_MARKER, ...(opts.last || [])])
    // 数组 sort 是稳定的：同一优先级内保持原写入顺序
    const ordered = this.written
      .slice()
      .sort((a, b) => Number(lastSet.has(a.rel)) - Number(lastSet.has(b.rel)))

    for (const item of ordered) {
      const target = join(this.root, item.rel)
      mkdirSync(dirname(target), { recursive: true })
      try {
        renameSync(this.pathOf(item.rel), target)
        this.committed.push(item.rel)
      } catch (e) {
        // 搬运失败：已搬的保留（它们本身是完整文件），未搬的留在暂存区
        e.failedAt = item.rel
        e.moved = this.committed.length
        throw e
      }
    }
    fsyncDirBestEffort(this.root)
    return { committed: this.committed.slice(), failedAt: null, moved: this.committed.length }
  }

  /** 提交成功后删掉空壳暂存区；失败时**不要调用**，留着当证据。 */
  discard() {
    try {
      rmSync(this.dir, { recursive: true, force: true })
    } catch {
      /* 删不掉不影响正确性，下次可以人工清理 */
    }
  }

  /** 暂存区里还剩什么（失败时用于报告）。 */
  leftovers() {
    const out = []
    for (const item of this.written) {
      if (this.committed.includes(item.rel)) continue
      try {
        statSync(this.pathOf(item.rel))
        out.push(item.rel)
      } catch {
        /* 已被搬走 */
      }
    }
    return out
  }
}

/**
 * 写提交凭证 `runs/<runId>.json`。
 *
 * 它本身也在 crateed 之外——**无论成功失败都要写**，
 * 因为「上一次建库是怎么失败的」正是排查时最需要的信息。
 *
 * @param {string} root 书库根
 * @param {object} report
 */
export function writeRunReport(root, report) {
  const rel = join('runs', report.runId + '.json')
  return writeFileAtomic(join(root, rel), JSON.stringify(report, null, 2), { fsync: true })
}

/** 检查某路径存在（避免调用方各自 import fs）。 */
export function pathExists(p) {
  return existsSync(p)
}
