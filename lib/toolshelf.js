/**
 * 工具架 · 把所有工具与工具包汇成一份对**用户**可见的清单。
 *
 * 【为什么单独建这个文件】
 * 2026-11-03 用户指出：REA 这类 MCP 工具包只出现在了系统提示词里（给模型看），
 * 书阁的 UI 里完全没有 —— 用户根本不知道本机有哪些能力。
 * 这是"模型可见 ≠ 用户可见"的典型设计缺口：我在做工具包发现层时，
 * 只想着让模型别绕开工具，忘了让用户知道这东西存在。
 *
 * 本模块只做**数据整形**，不碰 IO、不碰 context —— 全部是纯函数，
 * 这样它能被单测覆盖，也能被 HTTP 路由和 systemPrompt 两个消费者共用。
 */

/** 一个工具来自哪个来源。顺序即展示顺序：本地核心 → 书阁自身 → MCP 包。 */
export const TOOL_SOURCES = [
  { id: 'core', label: '本地核心工具', desc: 'DSH 内置：文件读写、命令执行、子 agent、任务管理等' },
  { id: 'manual', label: '书阁工具', desc: '书阁自己注册的查阅与网关工具' },
  { id: 'mcp', label: 'MCP 工具包', desc: '外接 MCP server 提供的工具，按需挂载' },
]

/**
 * 判断一个工具名属于哪个来源。
 *
 * MCP 工具的命名契约是 `mcp__<serverName>__<rawName>`，
 * 所以取第一段 `__` 之前的 serverName 就能把工具归到对应的包。
 * @param {string} name
 * @returns {{source: string, serverName: string|null}}
 */
export function classifyTool(name) {
  if (typeof name !== 'string' || name === '') return { source: 'unknown', serverName: null }
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length)
    const i = rest.indexOf('__')
    return { source: 'mcp', serverName: i > 0 ? rest.slice(0, i) : null }
  }
  if (name.startsWith('manual_')) return { source: 'manual', serverName: null }
  return { source: 'core', serverName: null }
}

/**
 * 静态兜底的工具描述。
 *
 * 为什么要手写一份：`ctx.tools.schemas()` 给的是模型的 schema，
 * 它的 description 是写给模型看的（"Use this when..."），
 * 对用户来说可读性一般。而这份是**给用户看的**一句话说明。
 * 未收录的工具会回落到 schema 里的 description 截断。
 */
const CORE_TOOL_HINTS = {
  pwsh: '执行 PowerShell 命令',
  read: '读文件',
  write: '写文件',
  edit: '精确替换文件内容',
  glob: '按路径模式找文件',
  grep: '按内容正则搜索',
  skill: '加载技能指令',
  subagent: '派一个独立子 agent 干活',
  subagent_fork: '派一个继承当前上下文的子 agent',
  spawn_teammate: '创建长期协作的队友',
  send_message: '给队友发消息',
  wait_agent: '等待队友完成',
  list_agents: '列出当前队友',
  interrupt_agent: '打断队友',
  todo_write: '维护任务清单',
  present: '声明交付物',
  web_search: '联网搜索',
  web_fetch: '抓取网页正文',
  job_list: '列出后台任务',
  job_output: '读后台任务输出',
  job_kill: '终止后台任务',
  ask_user_question: '向用户提问',
  working_directory: '查看/切换工作目录',
  read_image: '读图片',
  manual_toc: '翻书阁手册目录',
  manual_read: '读手册正文',
  manual_recall: '按关键词检索手册',
  manual_trace: '查条目溯源',
  manual_distill: '从会话中提炼经验',
  manual_mount: '挂载工具包',
  manual_unmount: '卸载工具包',
  pptwise_preview: '预览 PPT',
}

/**
 * 把原始工具名 + schema 列表整形为工具架数据。
 *
 * @param {object} p
 * @param {Array<{name: string, description?: string}>} p.tools - 当前可见工具（含 schema description）
 * @param {object[]} [p.packs] - 工具包定义（TOOL_PACKS）
 * @param {string[]} [p.mounted] - 已挂载的 packId
 * @param {object} [p.hints] - 覆盖内置的说明表，便于测试
 * @returns {object} 工具架数据
 */
export function buildToolShelf({ tools = [], packs = [], mounted = [], hints = CORE_TOOL_HINTS } = {}) {
  const mountedSet = new Set(mounted)
  const list = Array.isArray(tools) ? tools.filter((t) => t && typeof t.name === 'string') : []

  // ── 按来源分组 ──
  const groups = new Map()
  for (const t of list) {
    const { source, serverName } = classifyTool(t.name)
    const key = source === 'mcp' ? `mcp:${serverName ?? 'unknown'}` : source
    let g = groups.get(key)
    if (!g) {
      g = { key, source, serverName, tools: [] }
      groups.set(key, g)
    }
    // 用户向说明：优先手写、其次 schema description、最后留空
    const human = hints[t.name]
      ?? (typeof t.description === 'string' && t.description.trim() !== ''
        ? t.description.split(/[。.\n]/)[0].trim().slice(0, 80)
        : '')
    g.tools.push({ name: t.name, human })
  }

  // ── 组装分组视图 ──
  const outGroups = []
  for (const src of TOOL_SOURCES) {
    if (src.id === 'mcp') {
      // MCP：按 serverName 归到工具包；没有对应 pack 定义的也要露出来（不能藏）
      const mcpKeys = [...groups.keys()].filter((k) => k.startsWith('mcp:'))
      const seen = new Set()
      for (const p of packs) {
        const key = `mcp:${p.serverName}`
        const g = groups.get(key)
        seen.add(key)
        outGroups.push({
          key,
          source: 'mcp',
          packId: p.id,
          label: p.label,
          desc: p.what,
          mounted: mountedSet.has(p.id),
          toolCount: g ? g.tools.length : 0,
          schemaKb: p.schemaKb,
          tools: g ? g.tools : [],
          // 该包定义了但当前没挂载 —— 用户最需要知道的正是这个
          available: true,
          how: p.how,
          cost: p.cost,
        })
      }
      // 有 MCP 工具但没有 pack 定义（用户手工在 cordis.patch.yml 挂的）—— 也要展示
      for (const key of mcpKeys) {
        if (seen.has(key)) continue
        const g = groups.get(key)
        outGroups.push({
          key,
          source: 'mcp',
          packId: null,
          label: `MCP 服务：${g.serverName ?? '未命名'}`,
          desc: '在 cordis.patch.yml 中静态挂载，书阁没有它的工具包定义',
          mounted: true,
          toolCount: g.tools.length,
          schemaKb: null,
          tools: g.tools,
          available: true,
          how: '由 profile 配置静态挂载，改配置后重启 DSH 生效',
          cost: '常驻，无法通过 manual_unmount 释放',
        })
      }
      continue
    }
    const g = groups.get(src.id)
    if (!g || g.tools.length === 0) continue
    outGroups.push({
      key: src.id,
      source: src.id,
      packId: null,
      label: src.label,
      desc: src.desc,
      mounted: true,
      toolCount: g.tools.length,
      schemaKb: null,
      tools: g.tools.sort((a, b) => a.name.localeCompare(b.name)),
      available: true,
    })
  }

  // ── 汇总 ──
  const mountedPacks = outGroups.filter((g) => g.source === 'mcp' && g.mounted)
  const unmountedPacks = outGroups.filter((g) => g.source === 'mcp' && !g.mounted)
  // 静态挂载 = 已挂载但书阁没有它的工具包定义（用户手工写在 cordis.patch.yml 里）。
  // 必须与"可卸载的包"分开计数：否则用户会以为 kicad 也能 manual_unmount。
  const staticPacks = mountedPacks.filter((g) => g.packId === null)
  const visibleToolCount = list.length
  const schemaBytes = list.reduce((s, t) => s + JSON.stringify(t).length, 0)

  return {
    groups: outGroups,
    summary: {
      visibleToolCount,
      schemaBytes,
      schemaKb: Math.round(schemaBytes / 1024),
      mountedPackCount: mountedPacks.length,
      unmountedPackCount: unmountedPacks.length,
      // 已挂载且**可以**通过 manual_unmount 释放的（有包定义的那些）
      unmountableCount: mountedPacks.filter((g) => g.packId !== null).length,
      staticPackCount: staticPacks.length,
      // 「省下了多少」：未挂载包按定义里的 schemaKb 累加
      savedKbByUnmounted: unmountedPacks.reduce((s, g) => s + (g.schemaKb ?? 0), 0),
    },
  }
}

/**
 * 渲染成一段适合**用户**读的纯文本（不是给模型的那种命令式措辞）。
 *
 * 刻意与 renderToolPacks（给模型看）分开：
 * 模型需要"什么时候该调用什么、禁忌是什么"；
 * 用户需要"我这台机器上有什么、占多少、开没开"。
 * 同一份数据，两种受众，不该共用一套文案。
 * @param {object} shelf - buildToolShelf 的输出
 * @returns {string}
 */
export function renderToolShelfText(shelf) {
  if (!shelf || !Array.isArray(shelf.groups)) return '（工具架为空）'
  const s = shelf.summary
  const lines = []
  lines.push('## 书阁 · 工具架')
  lines.push('')
  lines.push(`当前可见 ${s.visibleToolCount} 个工具，合计 ${s.schemaKb} KB schema。`)
  if (s.unmountedPackCount > 0) {
    lines.push(`另有 ${s.unmountedPackCount} 个工具包未挂载（合计约 ${s.savedKbByUnmounted} KB 未占用）。`)
  }
  lines.push('')
  for (const g of shelf.groups) {
    const tag = g.source === 'mcp'
      ? (g.mounted ? '已挂载' : '未挂载')
      : '常驻'
    lines.push(`### ${g.label}（${g.toolCount} 个 · ${tag}）`)
    if (g.desc) lines.push(g.desc)
    if (g.schemaKb) lines.push(`体积：约 ${g.schemaKb} KB`)
    if (g.tools.length > 0) {
      const preview = g.tools.slice(0, 8).map((t) => t.name).join('、')
      lines.push(`工具：${preview}${g.tools.length > 8 ? ` … 另 ${g.tools.length - 8} 个` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
