/**
 * 合成会话夹具（2026-11-07 新增）。
 *
 * ## 为什么需要
 *
 * 两套 HTTP 验收（`test-http-guards` / `test-http-hardening`）都把
 * `DSH_SESSIONS_ROOT` 指到一个空的临时目录，于是它们测的是一个**空书库**：
 * 没有册、没有章、没有条目。结果 `/volume/<册>/<章>` 这类路由实际从没被验证过，
 * `test-http-hardening` 里"找一个含章节的册"只能跳过（长期恒为 73/74）。
 *
 * 这里按 DSH 真实的落盘格式造最小会话：`<root>/<projectDir>/<sid>/session.v< N>.jsonl.zstd`，
 * 内容是 zstd 压缩的 JSONL 事件流。字段名与 `lib/scan.js` 消费的一致。
 *
 * 只造"扫描器认得出"的最小集合，不追求覆盖全部事件类型 —— 夹具要能一眼看懂，
 * 不是再造一个 DSH。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

/**
 * 写一个可被 scan.js 识别的会话。
 *
 * @param {string} root 会话根目录（相当于 ~/.dsh/sessions）
 * @param {object} spec
 * @param {string} spec.sid 会话 id（目录名）
 * @param {string} [spec.projectDir] 项目目录名（默认由 sid 派生）
 * @param {string} [spec.cwd] 写入 header.cwd —— scan 用它推项目名
 * @param {string} [spec.title] 会话标题
 * @param {number} [spec.createdAt] 毫秒时间戳
 * @param {Array<{name:string, args?:string|object}>} [spec.tools] 工具调用
 * @param {number} [spec.deliverables] deliverables/presented 的次数
 * @param {number} [spec.turns] turn 数
 * @param {number} [spec.version] 文件名版本号；传 0 表示用无版本号的老格式
 * @param {number} [spec.frames] 切成几段 zstd 帧（默认 1；>1 用于验证多帧解压）
 * @returns {{file: string, dir: string}} 落盘位置
 */
export function writeSessionFixture(root, spec = {}) {
  const {
    sid = 'session-fixture-0001',
    projectDir = '-D-proj-demo-hardware',
    cwd = 'D:\\proj\\demo-hardware',
    title = '嘉立创2.0双排针选型',
    createdAt = Date.parse('2026-11-01T10:00:00.000Z'),
    tools = [{ name: 'write', args: { file_path: 'D:\\proj\\demo-hardware\\选型.md' } }],
    deliverables = 1,
    turns = 1,
    version = 1,
    frames = 1,
  } = spec

  const dir = join(root, projectDir, sid)
  mkdirSync(dir, { recursive: true })

  const events = [{ type: 'session', version: 1, cwd, createdAt }]
  if (title) events.push({ type: 'session/title', data: { title } })
  events.push({
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: `请处理：${title}` }] },
  })
  for (let i = 0; i < turns; i += 1) {
    events.push({ type: 'turn/start', data: {} })
    for (const t of tools) {
      const args = typeof t.args === 'string' ? t.args : JSON.stringify(t.args ?? {})
      events.push({ type: 'tool/call', data: { name: t.name, arguments: args } })
      events.push({ type: 'tool/result', data: {} })
    }
    for (let d = 0; d < deliverables; d += 1) events.push({ type: 'deliverables/presented', data: {} })
    events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }

  const lines = events.map((e) => JSON.stringify({ time: createdAt, ...e }))
  const file = version > 0 ? `session.v${version}.jsonl.zstd` : 'session.jsonl.zstd'

  // frames > 1：把事件流切成几段分别压缩再拼起来 —— 真实日志就是多帧的，
  // zstdDecompressSync 只解第一帧，scan.js 必须按魔数切帧。
  const per = Math.ceil(lines.length / Math.max(1, frames))
  const chunks = []
  for (let i = 0; i < lines.length; i += per) {
    chunks.push(zstdCompressSync(Buffer.from(lines.slice(i, i + per).join('\n') + '\n', 'utf8')))
  }
  writeFileSync(join(dir, file), Buffer.concat(chunks))
  return { file: join(dir, file), dir }
}
