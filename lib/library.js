/**
 * 建库：把分诊后的会话编译成"有目录的书库"。
 *
 * 核心设计（第一性判断，不可动摇）：
 *   **canonical（真相层）与 index（索引层）分离**。
 *   真相层 = volumes 下的 .md + entries 下的 .json + library.json（人可读、可 git、可搬走）
 *   索引层 = .index/（SQLite FTS5，可整个删掉重建，零知识损失）
 *
 * 归册规则（T0 轨，零 LLM）：靠**信号加权**，不靠模型拍脑袋。
 *   信号：cwd / 项目名（强）> 工具指纹（强）> 技能使用（强）> 会话内已有条目（中）> 关键词（弱）
 *   判定：最高分领先次高 >= 2 分 → 直接归册；否则进 VOL.05 收件箱并标 needs_review。
 *   **宁可进收件箱，不要归错册** —— 归错册的条目永远不会被翻到，等于白提炼。
 *
 * 本模块只做"结构性"的事：归册、生成目录、写 md/json。
 * 它**不调用任何 LLM**，这是"没有 key 也能用"的全部内容。
 */

import { mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
// 写入安全：单文件原子写 + 暂存区一次性提交 + 建库锁。
// 改造原因见 atomic.js 头部注释：裸 writeFileSync 在崩溃时会留下半写状态，
// 而幂等逻辑是「已存在就跳过」，半写状态会被永久固化。
import { Staging, createRunId, writeRunReport, STAGING_PREFIX, COMMIT_MARKER } from './atomic.js'
import { withBuildLock } from './lock.js'
import { deviceId } from './identity.js'
import { isSkeletonClaim } from './skeleton.js'
import { resolveLibraryRoot } from './library-root.js'

/**
 * 默认书库根目录。
 *
 * 【2026-11-12 改】原来写死 `~/.dsh/dsh-manuscript`，现在委托给
 * `lib/library-root.js`：环境变量 > 面板配置 > 默认路径。
 * 所有既有调用点（commit/health/tools/vectors）无需改动即可获得可配置能力。
 */
export function defaultLibraryRoot() {
  return resolveLibraryRoot()
}

/**
 * 册的初始集合。**可增不可自动删** —— 删册会让所有条目失去归属。
 * VOL.05 收件箱永远存在，且永远是最后一册。
 */
export const VOLUME_DEFS = [
  {
    id: 'vol-01',
    no: 'VOL.01',
    name: '硬件设计与器件选型',
    desc: '原理图审查、电源拓扑、器件选型与替代、嘉立创 / EasyEDA 实操',
    // cwd / 项目名信号
    projectHints: ['hwplatform', '硬件', 'hardis', 'hard-is', 'l1', '器件库', '立创'],
    // 工具指纹信号
    toolHints: [/^mcp__kicad__/i, /^mcp__easyeda/i],
    // 关键词（弱信号）
    keywords: ['原理图', '选型', 'datasheet', '电源', '隔离', 'DC-DC', '封装', '阻容', '芯片', '器件'],
  },
  {
    id: 'vol-02',
    no: 'VOL.02',
    name: '嵌入式固件',
    desc: 'MCU（GD32 / AT32 / STM32）、外设驱动、状态机、HardFault 排查',
    projectHints: ['pn协议栈', '嵌入式', 'plc', 'firmware'],
    toolHints: [],
    keywords: ['固件', 'MCU', '外设', 'ISR', '中断', '寄存器', 'HardFault', 'I2C', 'SPI', 'UART', 'GD32', 'AT32', 'STM32', 'DMA', '时钟'],
  },
  {
    id: 'vol-03',
    no: 'VOL.03',
    name: 'DSH 插件开发',
    desc: '插件清单、client 面板槽位、会话事件、工具注册、宿主 API',
    projectHints: ['dsh', '技能手册', '插件'],
    toolHints: [/subagent/i, /spawn_teammate/i, /wait_agent/i],
    keywords: ['插件', 'preset', '槽位', 'slot', 'agent', '系统提示', 'systemPrompt', 'defineTool', 'cordis', 'bundle', 'DSH'],
  },
  {
    id: 'vol-04',
    no: 'VOL.04',
    name: 'EDA 与 PCB',
    desc: 'KiCad / EasyEDA Pro API、封装符号库、布线规则、DRC / DFM',
    projectHints: ['eda', 'pcb', 'kicad'],
    toolHints: [/^mcp__kicad__/i, /^mcp__easyeda/i],
    keywords: ['PCB', '布线', 'DRC', 'DFM', '封装', '符号库', 'Gerber', 'KiCad', 'EasyEDA', '铺铜'],
  },
  {
    id: 'vol-06',
    no: 'VOL.06',
    name: 'AI 协作方法与踩坑',
    desc: '跟 AI 一起干活时踩过的坑、有效的协作方法、子 agent 用法',
    projectHints: [],
    // 故意留空：vol-06 的内容来自预加工离线统计（data/vol-06-ai-collab.json），
    // 不是从单会话「用了哪些工具」能推出来的。早先把 subagent/job 当信号，
    // 结果 52 个只是用过子 agent 的普通会话被误归进来。
    // 教训：工具指纹说明「用了什么能力」，不说明「产出了什么经验」。
    toolHints: [],
    keywords: [],
  },
  {
    id: 'vol-07',
    no: 'VOL.07',
    name: '本地模型与推理环境',
    desc: '本地部署 / 量化 / 显存与算力、推理服务与客户端接入、模型评测',
    // 【2026-11-07 新增】收件箱里实测约半数条目是这类会话：本地跑 Qwen /
    // Granite / DeepSeek，调 ROCm 与显存，接 DSH 或各种客户端。
    // 此前六个册（硬件/固件/DSH/EDA/收件箱/AI 协作）覆盖不到它们，
    // 只能全部落收件箱 —— 这不是"归册判不准"，是**册表缺一类**。
    // 信号刻意只取"推理环境"的词，不取泛化的"模型"：后者会把
    // "用某个模型写文案"也吸进来，那不是这一册要记的事。
    projectHints: ['模型', 'llm', 'ollama', 'llama.cpp', 'vllm', 'rocm', 'cuda'],
    toolHints: [],
    // 【2026-11-09 扩】实测收件箱里还有大量模型类会话没被这些词覆盖：
    // "Workbuddy 模型无法使用排查""查询本地ROCm版本号""询问模型是否为多模态"
    // "检查视觉服务并识别图片""本地27b模型经常出现：重试延…"。补进去。
    keywords: ['本地部署', '量化', '显存', '推理', 'gguf', 'qwen', 'granite', 'deepseek', 'moe',
      '上下文长度', 'token/s', '模型评测', '模型', 'rocm', '多模态', '视觉服务', 'vision',
      '27b', 'llama.cpp', '重试延迟', '显存占用'],
  },
  // 【2026-11-09 新增 vol-08/09】收件箱里 62 个会话**没有任何信号命中** —— 不是
  // "分数接近判不准"，是册表缺两类。真实语料里量很大且信号清晰：
  //   · 网页抓取：立创商城 / 京东工业 / 淘宝 / 领英 / Boss直聘 / DuckDuckGo
  //   · 系统与运维：升级主机软件包 / 公网 IP / 固定 IP 无法联网 / ROCm 版本
  // 两类都用"确定性信号"（项目名、工具指纹、标题关键词）就能判，不需要猜。
  {
    id: 'vol-08',
    no: 'VOL.08',
    name: '网页抓取与检索',
    desc: '抓站、解析页面、反爬与限速、搜索引擎与 API 检索、批量采集与整理',
    // 工具指纹是最强的信号：这些工具只在抓取类会话里出现。
    projectHints: ['抓取', '爬', 'crawl', 'scrape'],
    toolHints: [/web_fetch/i, /web_search/i, /browser/i, /fetch/i],
    keywords: ['抓取', '爬虫', '采集', '检索', '立创', '京东', '淘宝', '领英', 'boss直聘',
      'duckduckgo', '搜索引擎', '反爬', '限流', '分页', '解析页面', '网页', 'html报告'],
  },
  {
    id: 'vol-09',
    no: 'VOL.09',
    name: '系统与运维',
    desc: '主机与软件包升级、网络与 IP 配置、服务启停与故障排查、硬件资源与驱动',
    projectHints: ['运维', 'ops', '系统'],
    // systemctl / apt / dnf 这类工具只在运维会话里出现。
    toolHints: [/systemctl/i, /journalctl/i, /apt|dnf|pacman|yum/i],
    keywords: ['升级主机', '软件包', 'systemd', 'journalctl', '公网', '固定ip', 'ipv4', 'ip地址',
      '无法联网', 'dns', '防火墙', '端口', '服务重启', '开机自启', '驱动', '磁盘', '内存占用',
      '主机', '重装', '系统盘', '日志'],
  },
  {
    id: 'vol-05',
    no: 'VOL.05',
    name: '未分类收件箱',
    desc: '待人工归册 —— 未匹配到任何册的候选条目',
    projectHints: [],
    toolHints: [],
    keywords: [],
    inbox: true,
  },
]

/** 归册阈值：领先次高多少分才算"有把握"。低于此进收件箱。 */
export const CONFIDENT_LEAD = 2

/**
 * 兜底册。与 `commit.js` 的 `INBOX_VOLUME`、`pipeline.js` 的 `'vol-05'` **同一口径**：
 * 宁可进收件箱（人还能翻到），也不要制造"在盘上但翻不到"的孤儿条目。
 */
const INBOX_VOLUME = 'vol-05'

/** 合法的册 id 集合（含收件箱）。用来判断一个 volume 是否真的指向某个存在的册。 */
const VALID_VOLUME_IDS = new Set(VOLUME_DEFS.map((d) => d.id))

/**
 * 给条目补上"归属册"。**幂等**：volume 合法就一个字不动，返回 `changed:false`。
 *
 * ## 【2026-11-06 实测事故 D-12】为什么需要这个函数
 *
 * 真实库 `~/.dsh/dsh-manuscript/entries/` 有 428 个文件，其中 **7 个根本没有
 * `volume` 字段**（字段集是 id/distilled/source/claim/authority/confidence/title/
 * status/provenance/committedAt，`provenance` 还是空对象）。它们写在 2026-11-02
 * 那次给 `commit.js` 加兜底**之前**，于是永久成了孤儿：
 *   · 归档循环 `allEntries.filter((e) => e.volume === def.id)` 不认它们 → 不进任何册
 *   · `manual_read` / `manual_toc` / `manual_recall` 全部翻不到
 *   · 只有 `manual_trace` 按 id 直读能中 —— 所以"抽查两条能查到"根本证明不了库是好的
 *   · **重建也救不回来**：幂等分支 `existing.has(cand.id)` 保留 `prev`，
 *     `prev` 那个坏掉的 volume 被原样留下来，差额永远是 7。
 *
 * ## 为什么必须放在 staging 写入**之前**，而不是归档循环里
 *
 * 归档循环里临时改 `e.volume` 只能骗过本次目录：下一次建库又从磁盘读回旧值，
 * 问题照旧。只有改在 `existing` 里的那份对象上，归一化结果才会随
 * `staging.write('entries/<id>.json')` **真正写回磁盘**，修复才是幂等的。
 *
 * 这也是它与幂等分支的关系：`existing.has(cand.id)` 保留 `prev` 是**对的**
 * （人工改过的条目不能被重建覆盖），但"保留 prev"必须连带"把 prev 修成合法形态"，
 * 否则保留 = 固化缺陷。所以归一化统一放在合并之后、写盘之前，
 * 而不是去动幂等分支本身 —— 那条分支的语义（不覆盖人工编辑）没有错。
 *
 * ## 红线（不可越）
 *   · 不改 `status`：expired 仍是 expired，退役是人工决定，本函数不管
 *   · 不改 `claim` / `title` / `provenance` 等任何内容字段
 *   · 不删条目（红线①）
 *
 * 唯一会改写**已存在非空字段**的情形是"volume 指向一个不存在的册"（如 `vol-99`）：
 * 那种值在归档循环里同样不被认，效果等价于没有归属。改写时**原值必须完整留在
 * `volumeFallbackFrom`**（原本没有这个字段则记 null —— "不知道"用 null，不用 '' 或 0），
 * 保证可追溯、可回滚。
 *
 * @param {object} e 条目（从磁盘读回，或本轮派生）
 * @param {string} now 归一化时间戳，落进 volumeFallbackAt
 * @returns {{entry: object, changed: boolean, from: (string|null), kind: 'ok'|'trim'|'fallback', reason?: string}}
 *   kind 区分三种情况：ok=没动 · trim=归属对但带空白（归位，不进收件箱）
 *   · fallback=真兜底进收件箱。
 */
function normalizeEntryVolume(e, now) {
  const from = e?.volume == null ? null : String(e.volume)
  const trimmed = from == null ? '' : from.trim()

  if (trimmed !== '' && VALID_VOLUME_IDS.has(trimmed)) {
    if (trimmed === from) {
      // 合法归属且写法规范：一个字都不动（也**不清理**历史的 volumeFallback 标记 ——
      // 它记录的是"这条曾经走过兜底"这个事实，事实不会因为后来被人工归册而消失）
      return { entry: e, changed: false, from, kind: 'ok' }
    }
    // 归属对、但两边带空白（' vol-01 '）。归档循环用的是严格相等
    // `e.volume === def.id`，所以这种值**同样翻不到**，是同一类静默丢失。
    // 归位到规范写法，原值留痕；这不算"兜底进收件箱"，不该打 volumeFallback。
    return {
      entry: { ...e, volume: trimmed, volumeNormalizedFrom: from, volumeNormalizedAt: now },
      changed: true,
      from,
      kind: 'trim',
    }
  }

  const reason = trimmed === '' ? 'volume 缺失/为空' : `volume 非法（${trimmed} 不在 VOLUME_DEFS 中）`
  const entry = {
    ...e,
    volume: INBOX_VOLUME,
    // 只有它还不是 true 时才写：needsReview 是人工态标记，已经是 true 就不重复覆盖
    ...(e?.needsReview === true ? {} : { needsReview: true }),
    // 可追溯标记：这批条目过去是**静默消失**的，必须留痕，让人能反查
    volumeFallback: true,
    volumeFallbackFrom: from,
    volumeFallbackAt: now,
    volumeFallbackReason: reason,
  }
  return { entry, changed: true, from, kind: 'fallback', reason }
}

/**
 * 用**信号加权**给一个会话打分，返回每册的得分明细。
 * 零 LLM，纯确定性 —— 同样的输入永远同样的输出。
 * @param {object} s 分诊后的会话
 * @returns {{scores: Record<string, number>, detail: object[]}}
 */
export function scoreVolumes(s) {
  const scores = {}
  const detail = []
  for (const v of VOLUME_DEFS) {
    if (v.inbox) continue
    let score = 0
    const hits = []

    // ① 项目名 / cwd（强，+3 每个命中）
    const projLower = (s.project || '').toLowerCase() + ' ' + (s.cwd || '').toLowerCase()
    for (const hint of v.projectHints) {
      if (projLower.includes(hint.toLowerCase())) {
        score += 3
        hits.push(`project:${hint}`)
      }
    }

    // ② 工具指纹（强，+3 每个不同类型的命中，同类只算一次）
    const toolNames = Object.keys(s.toolNameCount || {})
    for (const re of v.toolHints) {
      const matched = toolNames.filter((t) => re.test(t))
      if (matched.length > 0) {
        score += 3
        hits.push(`tool:${matched[0]}`)
      }
    }

    // ③ 关键词（弱，+0.25 每个命中，上限 2）
    //
    // 【2026-11-09 修】原来用 `text.includes(k)` 直接比 —— **大小写敏感**，于是
    // 关键词写 'rocm' 时匹配不到标题里的 'ROCm'。实测「查询本地ROCm版本号」
    // 因此完全没命中，白白落进收件箱。现在两边都转小写再比。
    // 迁移到小写只影响匹配，不改任何条目内容。
    let kw = 0
    const text = ((s.title || '') + ' ' + (s.project || '')).toLowerCase()
    for (const k of v.keywords) {
      if (text.includes(k.toLowerCase())) {
        kw += 0.25
        hits.push(`kw:${k}`)
      }
    }
    score += Math.min(2, kw)

    if (score > 0) {
      scores[v.id] = Math.round(score * 100) / 100
      detail.push({ id: v.id, score: Math.round(score * 100) / 100, hits })
    }
  }
  detail.sort((a, b) => b.score - a.score)
  return { scores, detail }
}

/**
 * 归册判定。返回 {volumeId, confident, reason}。
 * **宁可进收件箱，不要归错册。**
 * @param {object} s
 */
export function assignVolume(s) {
  const { detail } = scoreVolumes(s)
  if (detail.length === 0) {
    return { volumeId: 'vol-05', confident: false, reason: '无任何信号命中 → 收件箱' }
  }
  const top = detail[0]
  const second = detail[1]
  if (!second || top.score - second.score >= CONFIDENT_LEAD) {
    return { volumeId: top.id, confident: true, reason: `领先次高 ${second ? (top.score - second.score).toFixed(2) : '∞'} 分` }
  }
  return { volumeId: 'vol-05', confident: false, reason: `与 ${second.id} 仅差 ${(top.score - second.score).toFixed(2)} 分 → 收件箱` }
}

/** 内容派生 ID：同一内容在任何设备上都得到同一个 ID，天然幂等（云同步友好）。 */
export function entryId(parts) {
  const h = createHash('sha256').update(parts.join('\u0000')).digest('hex')
  return 'e-' + h.slice(0, 12)
}

/**
 * 从会话生成"待入册的候选条目"。
 * **零 LLM 版**：这里产出的不是提炼后的经验，而是**可归册的骨架**——
 * 标题 = 会话标题，claim = 一句结构性描述，正文等 LLM 轨补充。
 * 它的作用是让"目录、归册、进度漏斗、查阅"在没有 LLM 时也能跑起来。
 * @param {object} s
 * @param {{volumeId:string, confident:boolean, reason:string}} assign
 */
export function candidateEntryFromSession(s, assign) {
  const id = entryId([s.sid])
  const spec = chapterSpec(s)
  const nowIso = new Date().toISOString()
  return {
    id,
    volume: assign.volumeId,
    chapter: spec.slug,
    // 章的展示标题随条目一起走：目录渲染不必再靠 slug 反猜中文
    chapterTitle: spec.title,
    title: (s.title || '(无标题会话)').trim(),
    // 会话时间也要带到条目上：UI 的"最近活动"用它，不能只靠 provenance
    sessionAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
    claim: [
      `${s.turnEnds} 轮 · ${s.toolCalls} 次工具调用 · ${s.deliverables} 个交付物`,
      s.shape === 'one-shot' ? '（一次性模板任务）' : s.shape === 'multi-turn' ? '（多轮讨论）' : '',
    ].filter(Boolean).join(' · '),
    why: '',
    confidence: 'speculation',
    authority: 'L3',
    status: 'current',
    needsReview: !assign.confident,
    assignReason: assign.reason,
    qualityScore: s.qualityScore,
    provenance: {
      session_id: s.sid,
      turn: null,
      message_id: null,
      tool_call_id: null,
      timestamp: s.createdAt ? new Date(s.createdAt).toISOString() : null,
    },
    tags: [s.project].filter(Boolean),
    // 【2026-11-07】T0 骨架的唯一"证据"：这次用了哪些工具、写了哪些文件。
    // 没有 LLM 时，claim 只能给出统计量；工具与文件名是**确定性可核验**的补充，
    // 让人（和 Agent）能判断"这条记的到底是干什么的那次会话"。
    // 只放 basename，不放绝对路径 —— 后者属于个人环境信息。
    evidence:
      (s.topTools?.length || s.files?.length)
        ? {
            tools: (s.topTools || []).map((t) => t.name),
            files: s.files || [],
          }
        : null,
    // 这条是哪台设备产出的（多设备共用一个书库时用于区分来源）。
    // 只记设备标识，不记时间 —— 时间用 sessionAt（会话发生）/ updatedAt（条目变更）。
    origin: { device: deviceId() },
    createdAt: nowIso,
    updatedAt: nowIso,
    hits: 0,
    last_hit: null,
    slot: 0,
  }
}

/**
 * 章 = 主题，不是项目目录名。
 *
 * 【为什么改（2026-11-07 实测）】旧实现直接拿 cwd 的项目名当章：
 *   · 112 条条目里 64 条堆进「default workspace」一章，目录里全是
 *     default-workspace / 定时工作 / review-dsh-manuscript-4d 这种文件夹碎片
 *   · 5 个章名被 24 字符上限从中间切断（review-dsh-manuscript-4d 是个半词）
 * 而"目录即索引"的前提是**目录能说明这里记的是什么事**。项目名说明的是
 * "在哪个目录干的"，不是"干了什么事"——所以目录失去了索引价值。
 *
 * 【为什么用关键词而不是聚类】零依赖是硬约束（没有向量、没有分词、没有 LLM）。
 * 关键词表是**可读、可改、可测**的确定性映射；聚类的簇没有名字，还得再起名。
 *
 * 【为什么项目名仍是回退】一个项目里的会话多半同源；主题词一个都没命中时，
 * 说"这是 hwplatform 项目的事"仍比"未分类"有用。但 `default workspace`
 * 这类工作区兜底名不是主题，必须排除。
 */
export const TOPIC_DEFS = [
  { id: 'plugin', title: '插件安装与升级', keywords: ['插件', 'bundle', 'cordis', 'workbuddy', '挂载', 'unmount', 'mount'] },
  { id: 'llm-env', title: '本地模型与推理环境', keywords: ['模型', '部署', '量化', '显存', 'llama', 'qwen', 'deepseek', 'rocm', 'moe', '推理'] },
  { id: 'vision', title: '图像与视觉', keywords: ['图片', '视觉', '识别', 'vision', '截图', 'ocr', '多模态'] },
  { id: 'scrape', title: '网页抓取与检索', keywords: ['抓取', '采集', '爬', '检索', '领英', 'boss直聘', '招聘', '淘宝', '京东', '立创', '网页'] },
  { id: 'schedule', title: '定时任务与巡检', keywords: ['定时', '巡检', '昨晚', '未产出', 'cron', '每天'] },
  { id: 'eda', title: 'EDA 与 PCB', keywords: ['kicad', 'easyeda', 'pcb', '布线', 'drc', 'gerber', '铺铜'] },
  { id: 'hw', title: '硬件与器件', keywords: ['选型', '原理图', '电源', '连接器', '排针', '芯片', '器件', '封装', '嘉立创'] },
  { id: 'prompt', title: '提示词与技能', keywords: ['提示词', '技能', 'preset', 'system prompt', 'subagent', 'agent'] },
  { id: 'sys', title: '系统与环境', keywords: ['安装', '升级', '环境', '版本', '驱动', '显卡', '网络', 'bios', '远程桌面', '软件包', '配置'] },
]

/** 这些"项目名"不是主题，不能拿来当章。 */
const MEANINGLESS_PROJECTS = new Set([
  'default workspace', 'default', 'workspace', 'untitled', 'tmp', 'temp', 'unknown', 'npx', '未命名', '未分类',
])

/** 目录名本身就是一串哈希（npx 缓存、临时工作区）时不是主题。 */
const HASHY_PROJECT = /^[0-9a-f]{8,}$/

/** 章 slug 的长度上限（字符）。超了在词边界截断并附短哈希，避免不同长名撞成一章。 */
const CHAPTER_SLUG_MAX = 28

/** 把任意文本转成 slug；过长时截断 + 附哈希保唯一。 */
function slugifyChapter(text) {
  const full = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '')
  if (!full) return ''
  if (full.length <= CHAPTER_SLUG_MAX) return full
  // 尽量在 `-` 边界断，别把英文词从中间切开（旧实现就切出了 `…-4d`）
  const head = full.slice(0, CHAPTER_SLUG_MAX)
  const cut = head.lastIndexOf('-')
  const base = cut > CHAPTER_SLUG_MAX / 2 ? head.slice(0, cut) : head
  const h = createHash('sha256').update(full).digest('hex').slice(0, 4)
  return `${base}-${h}`
}

/**
 * 章的唯一真相：slug + 展示标题。
 *
 * 判据顺序（先主题、后项目、最后未分类）：
 *   1. 标题/项目名里命中的主题词最多者（并列取表里靠前的）
 *   2. 项目名（排除 default workspace 这类工作区兜底名）
 *   3. 未分类
 *
 * @param {object} s 会话记录
 * @returns {{slug:string, title:string}}
 */
export function chapterSpec(s) {
  const text = `${s?.title || ''} ${s?.project || ''}`.toLowerCase()
  let best = null
  for (const t of TOPIC_DEFS) {
    let score = 0
    for (const k of t.keywords) if (text.includes(k.toLowerCase())) score += 1
    if (score > 0 && (!best || score > best.score)) best = { id: t.id, title: t.title, score }
  }
  if (best) return { slug: 'ch-' + best.id, title: best.title }

  const p = String(s?.project || '').replace(/^.*[\\/]/, '').trim()
  const norm = p.toLowerCase().replace(/[-_\s]+/g, ' ').trim()
  if (p && !MEANINGLESS_PROJECTS.has(norm) && !HASHY_PROJECT.test(p.toLowerCase())) {
    const slug = slugifyChapter(p)
    if (slug) return { slug: 'ch-' + slug, title: p }
  }
  return { slug: 'ch-未分类', title: '未分类' }
}

/** 章 slug（保留旧的字符串返回形态，供外部按 slug 用）。 */
export function chapterOf(s) {
  return chapterSpec(s).slug
}

/** 确保目录存在。 */
function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}

/**
 * 载入预加工的手册数据（如 vol-06「AI 协作方法与踩坑」）。
 *
 * 为什么不把它塞进 T0 规则轨：这一册的内容是**跨会话统计结论**
 * （"web_fetch 每 6 次就有 1 次失败"），不是从单个会话能推出来的。
 * 它的原料是全部会话的失败统计，属于"离线分析产物"，所以以 JSON 随包分发。
 *
 * 诚实性要求：这类条目的 provenance 用 `kind:'aggregate'`，而不是编造一个 session_id。
 * 渲染时显式标「跨会话统计」+ 样本数，让人一眼区分它和单条经验。
 *
 * @param {string} dataDir
 * @returns {{volumes: object[], errors: string[]}}
 */
export function loadPrebuiltVolumes(dataDir) {
  const out = { volumes: [], errors: [] }
  if (!dataDir || !existsSync(dataDir)) return out
  let files = []
  try {
    files = readdirSync(dataDir).filter((f) => f.endsWith('.json'))
  } catch (e) {
    out.errors.push(`读 data/ 失败: ${e.message}`)
    return out
  }
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(dataDir, f), 'utf8'))
      if (!j?.id || !Array.isArray(j.chapters)) {
        out.errors.push(`${f}: 缺 id 或 chapters，跳过`)
        continue
      }
      out.volumes.push(j)
    } catch (e) {
      out.errors.push(`${f}: ${e.message}`)
    }
  }
  return out
}

/**
 * 拿不到建库锁时抛出。**刻意抛错而不是返回 {skipped:true}**：
 *   - 返回 `{skipped:true}` 会让调用方在 `toSummary(built.library)` 处炸（library 是 undefined），
 *     报错位置完全不指向真正原因。
 *   - 抛错会被 index.js 的 `refresh()` 捕获，记进 `lastError` 并返回上一份快照，
 *     用户能看到"另一次建库正在跑"，而不会静默以为建成了。
 * 携带 holder 信息便于诊断是谁占着锁。
 */
export class BuildLockedError extends Error {
  constructor(reason, holder) {
    super(`建库被跳过：${reason}`)
    this.name = 'BuildLockedError'
    this.code = 'EBUILDLOCKED'
    this.holder = holder || null
    this.reason = reason
  }
}

/**
 * 建库。**幂等**：同样的输入跑两次，条目数不变。
 *
 * 写入策略（P1-1 起）：
 *   全部产物先写进 `<root>/.staging-<runId>/`，全写成功后再一次性搬到正式位置。
 *   崩在任何一步，正式目录都保持上一批的完整状态；`library.json` 永远最后提交，
 *   它是"这批产物已完整"的唯一标记。
 *
 * @param {object[]} triaged triageAll().enriched
 * @param {{root?: string, now?: string, dataDir?: string, logger?: object,
 *          _fault?: {afterStageWrites?: number, beforeCommit?: boolean}} [opts]}
 *   `logger` 可选，有 `warn()` 就用它报"兜底了几条"（index.js 传 ctx.logger）。
 *   `_fault` 仅供测试注入故障，生产调用方不要传。
 * @returns {{root: string, library: object, created: number, kept: number, entries: number,
 *            volumeFallback: number, volumeFallbacks: {id:string, from:string|null, reason:string}[],
 *            volumeNormalized: number}}
 *   `volumeFallback` 是本次构建修正了多少条缺/非法 volume 的条目（第一次跑真实库应为 7，
 *   之后为 0）；`volumeNormalized` 是 volume 归属对但写法带空白、已归位的条数。
 *   两个数都是"不静默"要求的出口，别丢掉。
 */
export function buildLibrary(triaged, opts = {}) {
  const root = opts.root || defaultLibraryRoot()
  const now = opts.now || new Date().toISOString()
  const runId = createRunId()
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  // 锁文件放在 root 下，所以 root 必须先存在
  ensureDir(root)

  const locked = withBuildLock(root, () => doBuild(triaged, opts, { root, now, runId, startedAt, t0 }))
  if (locked.skipped) {
    throw new BuildLockedError(locked.reason, locked.holder)
  }
  return locked.value
}

/**
 * 真正的建库逻辑，在锁内执行。
 * 从 buildLibrary 拆出来是为了让锁的 finally 与业务逻辑分离，避免提前 return 漏释放。
 *
 * 本函数是**故障兜底壳**：`doBuildInner` 里的任何未捕获异常（比如磁盘满导致
 * 暂存区写失败，此时根本走不到我们埋的注入点）都会在这里补写一份 failed 凭证，
 * 保证「每次建库都有凭证」这条承诺在异常路径上也成立。
 */
function doBuild(triaged, opts, ctx) {
  const state = { reported: false, report: null }
  try {
    return doBuildInner(triaged, opts, ctx, state)
  } catch (err) {
    if (!state.reported) {
      const { root, runId, startedAt, t0 } = ctx
      try {
        writeRunReport(root, {
          runId,
          startedAt,
          finishedAt: new Date().toISOString(),
          status: 'failed',
          counts: { entries: 0, volumes: 0 },
          stagingDir: STAGING_PREFIX + runId,
          error: { name: err?.name || 'Error', message: err?.message || String(err), code: err?.code || null },
          durationMs: Date.now() - t0,
        })
      } catch {
        /* 凭证都写不进去时只能放弃，但原始错误必须照常抛 */
      }
    }
    throw err
  }
}

function doBuildInner(triaged, opts, ctx, state) {
  const { root, now, runId, startedAt, t0 } = ctx

  ensureDir(root)
  ensureDir(join(root, 'volumes'))
  ensureDir(join(root, 'entries'))
  ensureDir(join(root, 'archive'))
  ensureDir(join(root, 'runs'))
  ensureDir(join(root, 'snapshots'))

  // ── 暂存区：本次所有产物先落这里，全成功后才搬进正式位置 ──
  const staging = new Staging(root, runId)
  /** 报告写入用的闭包，避免多处重复拼装 */
  const finishReport = (status, extra = {}) => {
    const report = {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status,
      counts: { entries: extra.entries ?? 0, volumes: extra.volumes ?? 0 },
      stagingDir: extra.stagingDir ?? null,
      error: extra.error ?? null,
      durationMs: Date.now() - t0,
      ...(extra.extra || {}),
    }
    // 凭证写入绝不能反过来把主流程搞挂：它只是诊断信息
    try {
      writeRunReport(root, report)
      state.reported = true
      state.report = report
    } catch {
      /* 报告写不进去不影响建库本身的正确性 */
    }
    return report
  }

  /**
   * 失败路径统一出口：写 failed 凭证 → 保留暂存区 → 抛出原始错误。
   *
   * 为什么**不删暂存区**：崩在半路时暂存区是唯一的现场，
   * 里面能看出"写到了第几个文件才崩"。删了就永远查不到原因。
   * @param {Function} finishReport
   * @param {Staging} staging
   * @param {Error} err
   */
  function finishReportThrow(finishReport, staging, err) {
    finishReport('failed', {
      stagingDir: STAGING_PREFIX + runId,
      error: { name: err?.name || 'Error', message: err?.message || String(err), code: err?.code || null },
    })
    return err
  }

  // 只对 real 层建条目；噪声连分母都不进
  const real = triaged.filter((s) => s.category === 'real')

  // 已有条目要读进来做幂等合并（不是覆盖）
  const entriesDir = join(root, 'entries')
  const existing = new Map()
  /**
   * 读不出来的条目文件名。
   *
   * 【2026-11-08】原来只有一个空 catch，注释写"不隐瞒（调用方会看到条目数对不上）"——
   * 但调用方要自己去比对磁盘才能发现。多设备同步时最容易出现半写文件，
   * 这类条目会**永久停在盘上、永远不进目录**，而界面上没有任何提示。
   * 现在显式计数并透出（counts.invalidEntries / summary.invalidEntries）。
   */
  const invalidEntryFiles = []
  if (existsSync(entriesDir)) {
    for (const f of readdirSync(entriesDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const e = JSON.parse(readFileSync(join(entriesDir, f), 'utf8'))
        if (e && e.id) existing.set(e.id, e)
        else invalidEntryFiles.push(f)
      } catch {
        invalidEntryFiles.push(f)
      }
    }
  }

  let created = 0
  let kept = 0
  const byVolume = {}
  let slot = 0

  for (const s of real) {
    const assign = assignVolume(s)
    const cand = candidateEntryFromSession(s, assign)
    slot += 1
    cand.slot = slot

    if (existing.has(cand.id)) {
      // 幂等：保留已有条目（可能已被人工编辑过），只刷新它的统计口径
      const prev = existing.get(cand.id)
      prev.qualityScore = cand.qualityScore
      prev.hits = prev.hits ?? 0
      existing.set(cand.id, prev)
      kept += 1
      byVolume[prev.volume] = (byVolume[prev.volume] || 0) + 1
      continue
    }

    existing.set(cand.id, cand)
    created += 1
    byVolume[cand.volume] = (byVolume[cand.volume] || 0) + 1
  }

  // 载入预加工册（vol-06 等）。这些条目的 id 已稳定，天然幂等。
  const prebuilt = loadPrebuiltVolumes(opts.dataDir ?? join(root, 'data'))
  for (const pv of prebuilt.volumes) {
    for (const ch of pv.chapters || []) {
      for (const e of ch.entries || []) {
        const entry = {
          id: e.id,
          volume: pv.id,
          chapter: 'ch-' + String(ch.no || '00'),
          prebuiltChapter: ch.title || null,
          // 预加工册没有会话时间，用生成时间当'最近活动'
          sessionAt: pv.generatedAt || null,
          title: e.title,
          claim: e.claim || '',
          why: e.why || '',
          confidence: e.confidence || 'medium',
          authority: 'L2',
          status: 'current',
          needsReview: false,
          provenance: e.provenance || {},
          tags: e.tags || [],
          hits: 0,
          last_hit: null,
          slot: ++slot,
          prebuilt: true,
          // 保留统计证据，渲染时展示样本量
          evidence: e.evidence || null,
        }
        if (existing.has(entry.id)) {
          kept += 1
        } else {
          existing.set(entry.id, entry)
          created += 1
        }
        byVolume[entry.volume] = (byVolume[entry.volume] || 0) + 1
      }
    }
  }

  // ── 骨架自动退役（2026-11-12）────────────────────────────────────────
  //
  // 【为什么要自动化，而不是靠人一条条点】
  //   T0 轨给每个 real 会话都生成一条骨架条目（claim 只有「N 轮 · M 次工具调用」）。
  //   T1 提炼成功后会入册一条**真结论**，但两者 id 不同、互不覆盖 —— 骨架从此
  //   永远留在目录里，既被 manual_recall 召回，又把「会话有多长」混进
  //   「会话教会了什么」。实测：321 条里 156 条（48.6%）是骨架，其中 110 个
  //   会话**早就有真结论**了，只是没人把骨架标成退役。
  //
  // 【判据（两条同时满足，宁可少退役不可误退役）】
  //   ① 本条 claim 是 T0 骨架（isSkeletonClaim 的窄判据，不误杀正文提「轮」的真结论）
  //   ② 同一 provenance.session_id 下存在 distilled === true 且 claim 不是骨架的条目
  //
  // 【为什么放在这里，而不是从磁盘上手动改 status】
  //   这是建库的**派生规则**：每次重建都会重新判一次，跨设备同步后也一致；
  //   而手改 entries/*.json 会留下"这台机器改了、那台没改"的两套真相。
  //
  // 【红线】只改 status 与退役留痕，**绝不改 claim/title，绝不删文件**。
  //   已退役条目的文件原样保留（manual_read / manual_trace 仍能查到），
  //   只是不再进目录（见下面的 `status !== 'expired'` 过滤）与召回语料。
  const realBySid = new Map()
  for (const e of existing.values()) {
    if (!e || e.distilled !== true || e.prebuilt === true || e.status === 'expired') continue
    const sid = e.provenance?.session_id
    if (!sid) continue
    // 提炼也可能产出"仍像骨架"的 claim（旧版本/异常路径），那种不算真结论
    if (isSkeletonClaim(e.claim)) continue
    if (!realBySid.has(sid)) realBySid.set(sid, e.id)
  }
  let skeletonRetired = 0
  for (const [id, e] of existing) {
    if (!e || e.status === 'expired') continue
    if (!isSkeletonClaim(e.claim)) continue
    const sid = e.provenance?.session_id
    const realId = sid ? realBySid.get(sid) : null
    if (!realId || realId === id) continue
    existing.set(id, {
      ...e,
      status: 'expired',
      retiredAt: now,
      retiredReason: 'superseded-by-distilled-entry',
      // 留一条可追溯的替换关系：以后想知道骨架被哪条真结论取代，不用再反查
      replacedBy: realId,
    })
    skeletonRetired += 1
  }

  // ── 归属册归一化（2026-11-06 D-12 修正）────────────────────────────────
  //
  // 位置很关键：**必须在 staging 写入之前、所有条目合并之后**。
  // 早先的问题正是这里缺了一步 —— 从磁盘读回来的 `existing` 里混着没有
  // `volume` 的条目，归档循环 `filter(e => e.volume === def.id)` 直接把它们筛掉，
  // 于是 7 条 current 条目在盘上、在 counts 里、却不在任何一册的目录里。
  //
  // 为什么改在这里而不是归档循环里临时改：
  //   只改内存 → 下次建库从磁盘读回旧值，问题复发。归一化对象随下面的
  //   `staging.write(entries/<id>.json)` 落回磁盘，第二次建库读到的就是合法值，
  //   这才是"重建能治好这个病"的前提（幂等分支 existing.has(cand.id) 保留 prev
  //   本身没错，错的是 prev 没被修正）。
  const normalized = []
  for (const [id, e] of existing) {
    const r = normalizeEntryVolume(e, now)
    if (r.changed) {
      existing.set(id, r.entry)
      normalized.push({ id, from: r.from, kind: r.kind, reason: r.reason })
    }
  }
  // 只有"真兜底进收件箱"的那些才算 volumeFallback；带空白归位的单独计数，
  // 别把两件事混成一个数字（混了以后就看不出"是归错册还是写法不规范"）。
  const fallbacks = normalized.filter((n) => n.kind === 'fallback')
  const trimmedVols = normalized.filter((n) => n.kind === 'trim')
  // 不静默：兜底了多少条、分别是哪些，必须能被看见。
  // 这 7 条之所以能"沉默地"丢了四天，就是因为之前没有任何一处报出来。
  //
  // 三条出口，一条都不用猜：
  //   ① library.json 的 counts.volumeFallback / volumeFallbacks —— 持久证据，可 git 追溯
  //   ② runs/<runId>.json 的 volumeFallback —— 每次建库的凭证
  //   ③ 这里：宿主给了 logger 就用它（与 index.js 其它日志同一通道），
  //      没给就退到 console.warn（stderr，不会污染 selfcheck --json 的 stdout）
  const announce = (msg) => {
    if (opts.logger?.warn) opts.logger.warn(msg)
    else console.warn(msg)
  }
  if (fallbacks.length > 0) {
    announce(
      `[library] 归属册兜底 ${fallbacks.length} 条 → ${INBOX_VOLUME}：` +
        fallbacks.map((n) => `${n.id}（${n.reason}）`).join(' · ')
    )
  }
  if (trimmedVols.length > 0) {
    announce(
      `[library] volume 带空白已归位 ${trimmedVols.length} 条：` +
        trimmedVols.map((n) => `${n.id}（${JSON.stringify(n.from)}）`).join(' · ')
    )
  }

  // 写条目（真相层）—— 先写进暂存区，不碰正式目录
  const allEntries = [...existing.values()]
  const faultAt = opts._fault && typeof opts._fault.afterStageWrites === 'number'
    ? opts._fault.afterStageWrites
    : -1
  let writtenCount = 0
  for (const e of allEntries) {
    staging.write(join('entries', e.id + '.json'), JSON.stringify(e, null, 2))
    writtenCount++
    // 测试注入点：第 N 个条目**真的写进暂存区之后**再崩，
    // 这样"正式目录不受影响 + 暂存区留着 N 个文件"才是真实可复现的
    if (faultAt >= 0 && writtenCount >= faultAt) {
      const err = new Error('injected fault: 模拟第 ' + faultAt + ' 个条目写完后崩溃')
      err.code = 'EINJECTED'
      throw finishReportThrow(finishReport, staging, err)
    }
  }

  // 写册 + 目录（真相层）
  const volumes = []
  for (const def of VOLUME_DEFS) {
    const list = allEntries.filter((e) => e.volume === def.id)
    if (list.length === 0 && !def.inbox) {
      // 空册仍写元数据，但书架不展示（见 toSummary）
      volumes.push({ ...def, chapters: 0, chapterList: [], entries: 0 })
      continue
    }
    // 【骨架退役 2026-11-03】已标记 expired 的条目不进目录。
    //
    // 为什么要有这一步：T0 轨给每个会话都生成一条骨架（claim 只是
    // 「N 轮 · M 次工具调用」的结构描述）。当同一会话被 LLM 提炼出真结论后，
    // 骨架就成了纯噪音——它还会被 manual_recall 召回，把「这个会话很长」
    // 混进「这个会话教会了什么」里。
    //
    // 【2026-11-12 起自动退役】入口见上面「骨架自动退役」：同会话已有真结论时
    // 建库会把骨架标成 expired。人工仍可把 status 改回 current 覆盖该派生结果。
    //
    // 注意：**只从目录剔除，entries/*.json 文件原样保留**（红线①：永不自动删除）。
    // 想恢复只需把 status 改回 current，再重建一次。
    const visible = list.filter((e) => e.status !== 'expired')
    const chapterMap = new Map()
    for (const e of visible) {
      const k = e.chapter || 'ch-inbox'
      if (!chapterMap.has(k)) chapterMap.set(k, [])
      chapterMap.get(k).push(e)
    }
    const chapters = [...chapterMap.entries()]
      .map(([slug, items]) => {
        const pre = items.find((e) => e.prebuilt)
        const origTitle = items.find((e) => e.title && (e.prebuilt || e.tags?.length))
        return {
          slug,
          // 标题的三种来源，优先级：
          //   ① 预加工册自带章名（ch-01 → 「工具失败的集中区」）
          //   ② 条目自己带的 chapterTitle（主题章，如 ch-plugin → 「插件安装与升级」）
          //   ③ 从 slug 反推（老库/夹具兼容）
          title: pre
            ? prebuiltChapterTitle(allEntries, slug) || chapterTitle(slug)
            : (items.find((e) => e.chapterTitle)?.chapterTitle || chapterTitle(slug)),
          prebuilt: !!pre,
          entries: items
            .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0))
            .map((e) => ({
              id: e.id,
              title: e.title,
              claim: e.claim,
              confidence: e.confidence,
              authority: e.authority,
              hits: e.hits || 0,
              needsReview: !!e.needsReview,
              prebuilt: !!e.prebuilt,
              sessionAt: e.sessionAt || null,
              evidence: e.evidence || null,
              provenance: e.provenance || null,
              // 【N-04 2026-11-06】兜底标记必须透到目录投影里。
              //
              // 为什么：`matchEntries()` 的语料**只**来自 chapterList 投影，
              // 不是磁盘上的条目全字段。此前这个投影把 volumeFallback 剪掉了，
              // 于是检索层根本看不见「这条是兜底塞进收件箱的」，
              // N-04 的双条件过滤（兜底 && 损坏）在检索层无从下手。
              //
              // 只透一个布尔值：volumeFallbackFrom/At/Reason 是溯源细节，
              // 属于 manual_trace 的职责，不该塞进每轮都可能被序列化的检索语料。
              // 用 `=== true` 而不是真值判断：历史数据里出现过字符串 'true'
              // 和 1，那些不是 normalizeEntryVolume 写的标记。
              volumeFallback: e.volumeFallback === true,
            })),
        }
      })
      // 预加工章按 slug 升序排在前，其余按条目数降序在后
      .sort((a, b) => {
        if (a.prebuilt && b.prebuilt) return a.slug.localeCompare(b.slug)
        if (a.prebuilt) return -1
        if (b.prebuilt) return 1
        return b.entries.length - a.entries.length
      })

    // 写入暂存区（相对路径与正式位置一致），正式目录此刻仍未被动过
    staging.write(join('volumes', def.id, 'MANUAL.md'), renderManual(def, chapters, now))
    staging.write(join('volumes', def.id, 'TOC.md'), renderToc(def, chapters, now))

    // 最近活动：取该册下所有条目的最大时间戳（预加工册退回其 generatedAt）
    const recent = list.reduce((acc, e) => {
      const t = e.sessionAt || e.provenance?.timestamp
      if (!t) return acc
      return !acc || t > acc ? t : acc
    }, null)
    volumes.push({
      ...def,
      chapters: chapters.length,
      chapterList: chapters,
      // 必须用 visible.length：已退役条目不该计入册的条目数，
      // 否则「XX 册 15 条」会和实际能翻到的条数对不上。
      entries: visible.length,
      recent: recent ? recent.slice(0, 10) : null,
    })
  }


  const library = {
    version: 1,
    generatedAt: now,
    counts: {
      total: triaged.length,
      empty: triaged.filter((s) => s.category === 'empty').length,
      smoke: triaged.filter((s) => s.category === 'smoke').length,
      real: real.length,
      strong: triaged.filter((s) => s.admission === 'strong').length,
      weak: triaged.filter((s) => s.admission === 'weak').length,
      archived: triaged.filter((s) => s.archived).length,
      oneShot: triaged.filter((s) => s.shape === 'one-shot').length,
      multiTurn: triaged.filter((s) => s.shape === 'multi-turn').length,
      entries: allEntries.length,
      // 已主动退役的条目数（骨架退役）。必须单独记：
      // 否则 catalogLoss() 只能算出 "declared - 可见数"，
      // 会把退役量误算成丢失量（实测：7 条真丢失被算成 21 条）。
      retired: allEntries.filter((e) => e.status === 'expired').length,
      // 本次构建**新退役**了多少条骨架（幂等：第二次构建应为 0）。
      // 与 retired 分开：前者是本次动作，后者是盘上存量。
      skeletonRetired,
      created,
      kept,
      // 归属册兜底（2026-11-06 D-12）。两个口径分开记，别混：
      //   volumeFallback     本次构建**新兜底**了多少条（第一次跑真实库 7，之后 0）
      //   volumeFallbackTotal 盘上当前**总共**有多少条带兜底标记（含历史修正）
      // 只记一个数会分不清"这次刚好没触发"和"从来没有过兜底条目"。
      volumeFallback: fallbacks.length,
      volumeFallbackTotal: allEntries.filter((e) => e.volumeFallback === true).length,
      // 写法不规范（' vol-01 '）单独计：它不是归错册，别混进兜底里
      volumeNormalized: trimmedVols.length,
    },
    // 有序判定表的分布（互斥且完备，见 sessionStage）
    // 有序判定表的分布（互斥且完备，见 sessionStage）
    // distilledSids 只收"有实质内容"的条目 —— 排除 T0 骨架（confidence=speculation 且非 prebuilt）
    stages: stageDistribution(
      triaged,
      new Set(allEntries.map((e) => e.provenance?.session_id).filter(Boolean)),
      new Set(
        allEntries
          .filter((e) => e.prebuilt || (e.confidence && e.confidence !== 'speculation'))
          .map((e) => e.provenance?.session_id)
          .filter(Boolean)
      )
    ),
    byVolume,
    // 兜底明细（id + 原因）随总账一起落盘：事后要能回答"哪几条是被兜底进来的"，
    // 而不是只知道个数。同样是"不静默"这条要求的落地。
    volumeFallbacks: fallbacks.map((n) => ({ id: n.id, from: n.from, to: INBOX_VOLUME, reason: n.reason })),
    // 带空白归位的明细（不进收件箱，只修正写法）
    volumeNormalized: trimmedVols.map((n) => ({ id: n.id, from: n.from, to: String(n.from || '').trim() })),
    // 注意：buildLibrary 产出的 library.json 里 chapters 用数字（给卡片用），
    // 但 chapterList 必须一并保留 —— toSummary() 渲染目录时要数组。
    volumes: volumes.map((v) => ({
      id: v.id,
      no: v.no,
      name: v.name,
      desc: v.desc,
      entries: v.entries,
      chapters: v.chapters,
      chapterList: v.chapterList,
      inbox: !!v.inbox,
      // recent 必须一起落盘：否则 toSummary 从 library.json 读回来永远是 null
      recent: v.recent || null,
    })),
  }
  // library.json 是**提交标记**：它必须最后落位。
  // 只要它还是上一批的，就说明这一批没交付完整 —— 这正是我们想要的信号。
  staging.write(COMMIT_MARKER, JSON.stringify(library, null, 2))

  // 测试注入点：模拟"全部写完、提交前一刻崩溃"
  if (opts._fault && opts._fault.beforeCommit) {
    const err = new Error('injected fault: 模拟提交前崩溃（正式目录应保持原样）')
    err.code = 'EINJECTED'
    throw finishReportThrow(finishReport, staging, err)
  }

  // ── 一次性提交：library.json 由 commit() 排在最后 ──
  try {
    staging.commit({ last: [COMMIT_MARKER] })
  } catch (e) {
    throw finishReportThrow(finishReport, staging, e)
  }

  const volumeCount = VOLUME_DEFS.filter((d) => d.inbox || allEntries.some((x) => x.volume === d.id)).length
  finishReport('committed', {
    entries: allEntries.length,
    volumes: volumeCount,
    stagingDir: null,
    // 兜底数量写进建库凭证：以后翻 runs/ 就能看到"这次修了几条孤儿"，
    // 不需要人去比 entries 与目录的差额才猜出来。
    extra: {
      written: staging.written.length,
      cleanup: 'ok',
      volumeFallback: fallbacks.length,
      volumeNormalized: trimmedVols.length,
      invalidEntries: invalidEntryFiles.length,
    },
  })
  // 提交成功才清掉空壳暂存区
  staging.discard()

  // 记账：坏条目文件数（读不出来的 .json）。它是"看不见的损失"，必须显式。
  library.counts = {
    ...(library.counts || {}),
    invalidEntries: invalidEntryFiles.length,
  }
  if (invalidEntryFiles.length > 0) {
    library.invalidEntries = invalidEntryFiles.slice(0, 50)
  }

  return {
    root,
    library,
    invalidEntryFiles,
    // 本次建库的凭证 id（`runs/<runId>.json`）。
    // 【2026-11-07】原先不返回它，于是"读最后一次建库的凭证"只能靠
    // `runs/` 目录名或 startedAt 排序去猜 —— 同一毫秒内两次建库时猜错就是
    // 随机失败（test-atomic 的"自愈"用例就是这么间歇性红的）。
    // 建库自己报告它的凭证 id，比让调用方反推可靠。
    runId,
    created,
    kept,
    entries: allEntries.length,
    // 本次构建新退役的骨架数（幂等时为 0）。调用方（批量重提炼脚本）用它
    // 判断"这一轮重扫有没有真的把骨架清掉"，不需要自己去比两版 library.json。
    skeletonRetired,
    volumeFallback: fallbacks.length,
    volumeFallbacks: fallbacks,
    volumeNormalized: trimmedVols.length,
    volumeNormalizedList: trimmedVols,
  }
}

/** 章标题：slug → 可读名（T0 只能做去横线，真正的章名要 LLM 轨）。 */
/**
 * 取预加工章的真实标题。
 * 预加工条目在生成时把章标题写进了 `prebuiltChapter` 字段（见 loadPrebuiltVolumes 的注入）。
 * 找不到就返回 null，由调用方退化为 slug 去横线。
 */
function prebuiltChapterTitle(allEntries, slug) {
  const hit = allEntries.find((e) => e.chapter === slug && e.prebuiltChapter)
  return hit ? hit.prebuiltChapter : null
}
function chapterTitle(slug) {
  if (slug === 'ch-inbox') return '未归章'
  return slug.replace(/^ch-/, '').replace(/-/g, ' ')
}

/**
 * Markdown 文本转义（标题 / claim / 章名）。
 *
 * 【为什么必须有（2026-11-08）】标题来自**会话首条消息**，是用户完全可控的文本。
 * 实测：一个标题为 `<img src=x onerror=alert(1)> …` 的会话，会在 `MANUAL.md` 与
 * `TOC.md` 里原样落盘 —— 生成的 Markdown 直接带可执行 HTML。
 *
 * 两个后果：
 *   ① 任何人（尤其是要接管这些 md 的"图书馆"）在 web 里渲染它，就是 XSS；
 *   ② 即使不渲染，标题里的 `#`、`]`、换行也会破坏手册结构（章被截断、链接断开）。
 *
 * 只做**最小必要**转义：`& < >` 与换行。反引号/星号之类留给 Markdown 语义。
 *
 * @param {unknown} s
 * @returns {string}
 */
function escapeMdInline(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 链接标签里的 `[` `]` 会把链接断开，单独转义。 */
function escapeMdLinkLabel(s) {
  return escapeMdInline(s).replace(/\[|\]/g, (m) => (m === '[' ? '&#91;' : '&#93;'))
}

/** 渲染人可读全文（真相层）。 */
function renderManual(def, chapters, now) {
  const lines = []
  lines.push(`# ${def.no} ${def.name}`)
  lines.push('')
  lines.push(`> ${def.desc}`)
  lines.push('')
  lines.push(`生成时间：${now}`)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 目录')
  lines.push('')
  for (const c of chapters) {
    lines.push(`- [${escapeMdLinkLabel(c.title)}](#${c.slug}) — ${c.entries.length} 条`)
  }
  lines.push('')
  for (const c of chapters) {
    lines.push(`<a id="${c.slug}"></a>`)
    lines.push('')
    lines.push(`## ${escapeMdInline(c.title)}`)
    lines.push('')
    for (const e of c.entries) {
      lines.push(`### ${escapeMdInline(e.title)}`)
      lines.push('')
      if (e.claim) lines.push(escapeMdInline(e.claim))
      lines.push('')
      // 【2026-11-08】把 evidence 也渲染进 Markdown。
      // 此前它只出现在 manual_read 的工具输出里，导出的 md 看不到
      // "这次用了什么工具、写了哪些文件" —— 而 T0 骨架的 claim 只有统计量，
      // evidence 是唯一确定性的"干了什么"。
      const ev = e.evidence || {}
      const evBits = []
      if (Array.isArray(ev.tools) && ev.tools.length) evBits.push(`工具 ${ev.tools.join('/')}`)
      if (Array.isArray(ev.files) && ev.files.length) evBits.push(`文件 ${ev.files.join('、')}`)
      // 【2026-11-08】跨会话统计条目必须自报口径：它不是从某一次会话推出来的，
      // 编一个 session_id 会让人误以为可以点开追溯。这里显式写样本量与计算日期。
      if (e.provenance && e.provenance.kind === 'aggregate') {
        const sample = Number(e.provenance.sample)
        const at = String(e.provenance.computedAt || '').slice(0, 10)
        lines.push(
          `来源：跨会话统计${Number.isFinite(sample) ? `（样本 ${sample} 个会话` : '（'}${at ? `，${at} 计算）` : Number.isFinite(sample) ? '）' : ''}`
        )
      }
      if (evBits.length) {
        lines.push(`证据：${escapeMdInline(evBits.join(' · '))}`)
        lines.push('')
      }
      lines.push(
        `<sub>置信度 ${e.confidence} · 权威等级 ${e.authority} · 命中 ${e.hits}${
          e.needsReview ? ' · ⚠ 待归册复核' : ''
        }</sub>`
      )
      lines.push('')
    }
  }
  return lines.join('\n')
}

/** 渲染目录页（这一页就是被注入的那 200 行）。 */
function renderToc(def, chapters, now) {
  const lines = []
  lines.push(`# ${def.no} ${def.name} — 目录`)
  lines.push('')
  for (const c of chapters) {
    lines.push(`${escapeMdInline(c.title)}（${c.entries.length} 条）`)
    for (const e of c.entries.slice(0, 5)) {
      lines.push(`  - ${escapeMdInline(e.title)}`)
    }
    if (c.entries.length > 5) lines.push(`  … 另有 ${c.entries.length - 5} 条`)
  }
  lines.push('')
  lines.push(`<sub>${now}</sub>`)
  return lines.join('\n')
}

/**
 * 统计"目录层面"的损失：有多少条条目虽然在 counts 里，却翻不到。
 *
 * 为什么放在 summary 而不是让每个调用方自己算：
 * 损失统计是**库的固有属性**，不是一个视图的选择。任何一个消费方
 * （目录注入 / 面板 / 体检 / 未来的导出）自己反推，迟早算出不一致的数字，
 * 而"数字不自洽"正是这轮事故的根源。
 *
 * 口径：
 *   catalogEntries   目录里实际可见的条目数（五册 chapterList 去重计数）
 *   uncatalogedEntries  entries 有多少、目录里就有多少的差额 —— 即"看不见的损失"
 *
 * 当库没有 chapterList 结构时（老库/测试夹具），返回 catalogEntries=null，
 * 表示**无法判断**，绝不返回一个假的"0 损失"。
 *
 * @param {object} library
 * @returns {{catalogEntries:number|null, uncatalogedEntries:number|null}}
 */
export function catalogLoss(library) {
  const volumes = Array.isArray(library?.volumes) ? library.volumes : []
  let sawCatalog = false
  const ids = new Set()
  for (const v of volumes) {
    if (!v || !Array.isArray(v.chapterList)) continue
    sawCatalog = true
    for (const c of v.chapterList) {
      for (const e of Array.isArray(c?.entries) ? c.entries : []) {
        if (e && e.id != null) ids.add(String(e.id))
      }
    }
  }
  if (!sawCatalog) return { catalogEntries: null, uncatalogedEntries: null, retiredEntries: null }
  const declared = Number(library?.counts?.entries)
  const retired = Number(library?.counts?.retired) || 0
  // 差额 = 声明总数 - 可见数。这个差额里混着两种东西：
  //   · retiredEntries：主动退役，**不算损失**
  //   · 剩下那些才是真的「看不见的损失」
  const gap = Number.isFinite(declared) ? Math.max(0, declared - ids.size) : null
  const uncataloged = gap == null ? null : Math.max(0, gap - retired)
  return { catalogEntries: ids.size, uncatalogedEntries: uncataloged, retiredEntries: retired }
}

/**
 * 生成给 UI 的摘要（左栏卡片 + 书房漏斗）。
 *
 * 注意 chapters 的两种形态容易被搞混：
 *   - `chapterCount` 是数字（给卡片显示"12 章"用）
 *   - `chapters` 是数组（给目录页渲染用）
 * 早先版本把 chapters 直接写成数字，导致目录渲染时 .slice 报错 —— 这里两种都给，名字区分开。
 * @param {object} library buildLibrary 的 library
 * @param {{withChapters?: boolean}} [opts] UI 全量视图需要章节数组；左栏只要计数
 */
export function toSummary(library, opts = {}) {
  const c = library.counts
  const withChapters = opts.withChapters !== false
  const loss = catalogLoss(library)
  return {
    total: c.total,
    real: c.real,
    smoke: c.smoke,
    empty: c.empty,
    archived: c.archived,
    strong: c.strong,
    weak: c.weak,
    oneShot: c.oneShot,
    multiTurn: c.multiTurn,
    entries: c.entries,
    // ── 提炼进度（2026-11-05 新增，用户痛点：「我不知道一共提炼了多少」）──
    //
    // 为什么必须单独给，而不是让前端拿 entries 顶：
    //   entries 是**条目数**（389），distilled 是**会话数**（130）。两者量纲不同，
    //   早先前端取不到 distilled 就 fallback 到 entries，漏斗显示「全部 278 / 已提炼 389」——
    //   比数字错更糟：已提炼比全部还多，用户直接不信这个面板。
    //
    // 取不到时必须给 **null**，绝不能给 0：
    //   0 的意思是"一条都没提炼"，而 null 的意思是"不知道"。
    //   把「不知道」画成「0 条」是本项目的红线级错误（见 VOL.06 诚实标注约定）。
    distilledSessions:
      Number.isFinite(library?.stages?.counts?.distilled) ? library.stages.counts.distilled : null,
    // 阶段分布全量透出：前端要画漏斗就得知道每一段的真实值，
    // 不能只给它一个 distilled 再让它反推（反推 = 编数字）。
    stages: library?.stages?.counts ? { ...library.stages.counts } : null,
    // 损失口径：entries 是"盘上有多少"，catalogEntries 是"翻得到多少"。
    // 两者不等时必须显式暴露，不允许用 entries 一个数字掩盖差额。
    catalogEntries: loss.catalogEntries,
    uncatalogedEntries: loss.uncatalogedEntries,
    // 已主动退役（骨架退役）：不算损失，但要让消费方能区分
    retiredEntries: loss.retiredEntries,
    // 读不出来的条目文件数（多设备同步时最容易出现的半写文件）。
    // 它们**永久停在盘上、永远不进目录**，所以必须显式告诉消费方 ——
    // 否则用户看到"104 条"不会知道旁边还有 1 个坏文件。
    invalidEntries: Number.isFinite(library?.counts?.invalidEntries) ? library.counts.invalidEntries : 0,
    volumes: library.volumes
      .filter((v) => v.entries > 0 || v.inbox)
      .map((v) => ({
        id: v.id,
        no: v.no,
        name: v.name,
        desc: v.desc,
        chapterCount: v.chapters,
        entries: v.entries,
        inbox: v.inbox,
        // 最近活动时间（UI 卡片显示"最近 10-30"）。预加工册无会话时间则为 null。
        recent: v.recent || null,
        ...(withChapters ? { chapters: v.chapterList || [] } : {}),
      })),
  }
}

/**
 * 会话所处的「沉淀阶段」—— 有序判定表，首个匹配行胜出。
 *
 * 为什么要这个：之前的进度漏斗是"全部 → 已归档 → 已提炼 → 已入册"四段，
 * 但一个会话可能同时满足多个条件（既已归档又有交付物又已入册），
 * 没有优先级定义 → 各段之和会大于总数，漏斗看起来永远不自洽。
 *
 * 改法照抄 superagent 的 `ticketStage`（003-execution.md）：
 *   "Read the table from top to bottom; the first matching row wins."
 * 好处：**互斥且完备** —— 任何会话必属于且仅属于一个阶段，可以直接写测试断言。
 *
 * ⚠️ 一个第一版就踩到的坑：
 *   T0 轨会给**每个 real 会话**都生成一条骨架条目，所以"有条目"≠"已入册"。
 *   真正的"已提炼"必须是指条目有实质内容（非骨架）。
 *   否则漏斗会显示"180/180 全部已入册"，恰好掩盖掉"其实一条都没提炼"这个事实。
 *
 * 阶段（从深到浅，先匹配到的赢）：
 *   distilled     已提炼（条目有实质内容）
 *   in-book       仅骨架（有占位条目，等 LLM 轨补）
 *   distillable   够格提炼但还没条目（strong）
 *   weak-source   能提炼但产出弱（weak）
 *   archived-only 真实会话但不满足任何提炼条件
 *   noise         空壳 / 冒烟测试，不进任何分母
 *
 * @param {object} s
 * @param {{entrySids?: Set<string>, distilledSids?: Set<string>}} [ctx]
 * @returns {'distilled'|'in-book'|'distillable'|'weak-source'|'archived-only'|'noise'}
 */
export function sessionStage(s, ctx = {}) {
  if (ctx.distilledSids && ctx.distilledSids.has(s.sid)) return 'distilled'
  if (ctx.entrySids && ctx.entrySids.has(s.sid)) return 'in-book'
  if (s.category !== 'real') return 'noise'
  if (s.admission === 'strong') return 'distillable'
  if (s.admission === 'weak') return 'weak-source'
  return 'archived-only'
}

/** 阶段的中文标签与语义色（给 UI 用）。 */
export const STAGE_LABELS = {
  distilled: { label: '已提炼', tone: 'success' },
  'in-book': { label: '仅骨架', tone: 'caption' },
  distillable: { label: '可提炼', tone: 'business' },
  'weak-source': { label: '弱来源', tone: 'warn' },
  'archived-only': { label: '仅归档', tone: 'dimmed' },
  noise: { label: '噪声', tone: 'dimmed' },
}

/**
 * 计算全语料的阶段分布，并**断言互斥完备**。
 * @param {object[]} triaged
 * @param {Set<string>} entrySids
 * @param {Set<string>} distilledSids
 */
export function stageDistribution(triaged, entrySids, distilledSids) {
  const counts = { distilled: 0, 'in-book': 0, distillable: 0, 'weak-source': 0, 'archived-only': 0, noise: 0 }
  const byStage = { distilled: [], 'in-book': [], distillable: [], 'weak-source': [], 'archived-only': [], noise: [] }
  for (const s of triaged) {
    const st = sessionStage(s, { entrySids, distilledSids })
    counts[st] += 1
    byStage[st].push(s.sid)
  }
  const sum = Object.values(counts).reduce((a, b) => a + b, 0)
  return { counts, byStage, total: triaged.length, sum, exhaustive: sum === triaged.length }
}