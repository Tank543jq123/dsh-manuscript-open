/**
 * 本机身份 —— 给"多设备共用一个书库"用的最小标识。
 *
 * 【为什么需要（2026-11-08）】条目的主键是 `sha256(session_id)[:12]`，
 * 跨设备天然不撞；实测另一台设备的条目也不会被本机重建删掉（按并集保留）。
 * 但条目里**没有任何字段说明它来自哪台设备** —— 想做一个管理多设备书库的
 * "图书馆"，只能靠同步目录名或 session_id 去反推。
 *
 * 这个模块只做一件事：给出一个稳定、可读、可覆盖的设备标识。
 *
 * 【为什么默认用主机名】零配置、人能看懂、同一台机器重启不变。
 * 主机名不唯一（两台机器可能都叫 `MacBook-Pro`）是已知代价；
 * 真要唯一就显式设 `DSH_MANUSCRIPT_DEVICE`。
 *
 * 【为什么不用 uuid 落盘】那会引入一个需要同步/备份的状态文件，
 * 与"真相层只有 entries/"的设计冲突。
 */

import { hostname } from 'node:os'

/** 环境变量里允许的最大长度（防止有人把整段 JSON 塞进来）。 */
const MAX_LEN = 64

/**
 * 取本机设备标识。
 *
 * 优先级：`DSH_MANUSCRIPT_DEVICE` > 主机名 > `unknown-device`。
 * 结果会被裁剪到 64 字符并去掉首尾空白，保证落盘字段可预期。
 *
 * @returns {string}
 */
export function deviceId() {
  const raw = process.env.DSH_MANUSCRIPT_DEVICE
  const fromEnv = typeof raw === 'string' ? raw.trim() : ''
  if (fromEnv) return fromEnv.slice(0, MAX_LEN)
  let host = ''
  try {
    host = String(hostname() || '').trim()
  } catch {
    host = ''
  }
  return (host || 'unknown-device').slice(0, MAX_LEN)
}
