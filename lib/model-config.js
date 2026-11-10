/**
 * Resolve the host DSH profile's agent-default-model, so 书阁's distillation uses the
 * same provider/model the user picked in DSH instead of a hardcoded workbuddy model.
 * Read-only: it only parses the profile's cordis.patch.yml.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function profileFromArgv(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile' && argv[i + 1]) return argv[i + 1]
    if (argv[i].startsWith('--profile=')) return argv[i].slice('--profile='.length)
  }
  return 'web'
}

export function resolveDshDefaultModel() {
  const profile = process.env.DSH_PROFILE || profileFromArgv()
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const candidates = [
    process.env.DSH_PROFILE_DIR,
    join(dshHome, 'profiles', profile),
  ].filter(Boolean)
  for (const dir of candidates) {
    const file = join(dir, 'cordis.patch.yml')
    if (!existsSync(file)) continue
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const lines = text.split(/\r?\n/)
    let inBlock = false
    let provider = null
    let model = null
    for (const line of lines) {
      if (/^- id:\s*agent-default-model\s*$/.test(line)) { inBlock = true; continue }
      if (inBlock && /^- id:/.test(line)) break
      if (!inBlock) continue
      const p = /^\s+provider:\s*(\S+)/.exec(line)
      if (p) provider = p[1].replace(/^["']|["']$/g, '')
      const m = /^\s+model:\s*(\S+)/.exec(line)
      if (m) model = m[1].replace(/^["']|["']$/g, '')
    }
    if (provider || model) return { provider: provider || undefined, model: model || undefined, source: file, profile }
  }
  return null
}


/** Resolve provider/model from the host's agentDefaultModel service (DSH >=0.2.2). */
export function resolveFromHost(ctx) {
  const candidates = []
  const push = (label, svc) => {
    if (!svc || typeof svc.currentSelection !== 'function') return
    candidates.push([label, svc])
  }
  try { push('ctx.get', ctx?.get?.('agentDefaultModel')) } catch {}
  try { push('ctx.agentDefaultModel', ctx?.agentDefaultModel) } catch {}
  try { push('ctx.root.get', ctx?.root?.get?.('agentDefaultModel')) } catch {}
  for (const [label, svc] of candidates) {
    try {
      const sel = svc.currentSelection()
      if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model, source: `host:agentDefaultModel(${label})` }
    } catch {}
  }
  return null
}
