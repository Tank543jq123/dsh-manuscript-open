#!/usr/bin/env node
/**
 * 每天晚上看一次 GitHub 有没有新的 issue（bug 单），有就回一句「收到，跟进中」。
 *
 * 为什么单独一个脚本：issue 是别人提的，回应速度影响信任；但人不可能一直盯。
 * 这里做最小闭环——发现新开且没被我们回复过的 issue，用 gh 留一条 ack。
 *
 * 首次运行只登记基线（把当前已存在的 issue 记进状态文件），不对旧单乱回。
 * 状态文件：~/.dsh/state/superagent/issue-watch.json
 *
 * 用法：node scripts/watch-issues.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const REPOS = (process.env.ISSUE_WATCH_REPOS || 'Tank543jq123/dsh-manuscript,Tank543jq123/dsh-manuscript-open')
  .split(',').map((s) => s.trim()).filter(Boolean)
const STATE = join(homedir(), '.dsh', 'state', 'superagent', 'issue-watch.json')
const ACK = 'This is by an automated agent, not a human.\n\n收到，跟进中。'
const dryRun = process.argv.includes('--dry-run')

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: 60_000 }).trim()
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return { repos: {} } }
}
function saveState(s) {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify(s, null, 2))
}

const state = loadState()
state.repos ||= {}
let acks = 0
let seen = 0
let baseline = 0

for (const repo of REPOS) {
  let issues = []
  try {
    const out = gh(['issue', 'list', '-R', repo, '--state', 'open', '--limit', '50',
      '--json', 'number,title,createdAt,author,labels'])
    issues = JSON.parse(out || '[]')
  } catch (e) {
    console.error(`[${repo}] gh issue list 失败：${String(e.message).slice(0, 200)}`)
    continue
  }
  const known = new Set(state.repos[repo] || [])
  const firstRun = !state.repos[repo]
  for (const it of issues) {
    const n = it.number
    if (known.has(n)) continue
    if (firstRun) { known.add(n); baseline += 1; continue }
    seen += 1
    // 只回「新开、不是我们自己提的」的 issue；机器人的号由 gh 返回的 author.login 判断。
    const byUs = String(it.author?.login || '').toLowerCase() === 'tank543jq123' && process.env.ISSUE_WATCH_ALLOW_SELF !== '1'
    if (!byUs) {
      if (dryRun) {
        console.log(`[dry-run] 会回复 ${repo}#${n} ${it.title}`)
      } else {
        try {
          gh(['issue', 'comment', String(n), '-R', repo, '--body', ACK])
          console.log(`已回复 ${repo}#${n} ${it.title}`)
        } catch (e) {
          console.error(`[${repo}#${n}] 回复失败：${String(e.message).slice(0, 160)}`)
          continue
        }
      }
      acks += 1
    }
    known.add(n)
  }
  state.repos[repo] = [...known]
}
if (!dryRun) saveState(state)
console.log(`issue-watch: 新单 ${seen} · 已回复 ${acks} · 首次基线登记 ${baseline} · 仓库 ${REPOS.length}`)
