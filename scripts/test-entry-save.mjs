#!/usr/bin/env node
/**
 * test-entry-save.mjs —— 书阁体验改造 P1 的服务端契约（2026-11-12）。
 *
 * 锁住四个新入口：
 *   GET  /dsh-manuscript/api/search         扩展筛选 / matched 片段 / 0 结果建议
 *   GET  /dsh-manuscript/api/timeline       按 updatedAt（无则 mtime）分日
 *   POST /dsh-manuscript/api/entry-save     新建 / 编辑（保留未传字段）
 *   tool library_save                       对话侧入库
 *
 * ## 为什么用夹具库而不是真实库
 *
 * 负控（Docker 137 / Vulkan / Nuxt）必须是 0 条 —— 真实库里已经有条目在
 * **讨论**这些负控（「…误命中…」），用真实库断言 0 条会变成一条假红。
 * 夹具还让「今天 / 3 天前 / 40 天前」的时间线窗口可复现，不随运行时间漂移。
 *
 * 全程 os.tmpdir()，不碰 ~/.dsh/library。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-ms-save-'))
const LIB_ROOT = join(TMP, 'library')
const SESSIONS_ROOT = join(TMP, 'sessions')
mkdirSync(SESSIONS_ROOT, { recursive: true })
mkdirSync(LIB_ROOT, { recursive: true })

process.env.DSH_MANUSCRIPT_ROOT = LIB_ROOT
process.env.DSH_SESSIONS_ROOT = SESSIONS_ROOT
process.env.DSH_WORKSPACE_JSON = join(TMP, 'no-such-workspace.json')
// 让 defineTool 走宿主包解析（与 test-ui-endpoints 同一招），否则 library_save 注册不上。
process.argv[1] = 'C:/Users/<user>/AppData/Local/OpenClaw/deps/portable-node/node_modules/@deepseek-ai/dsh/lib/bin.js'

const { writeMarkdownEntry, scanMarkdownLibrary } = await import('../lib/markdown-library.js')
const { apply } = await import('../lib/index.js')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`✓ ${name}${extra ? '  ' + extra : ''}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`✗ ${name}${extra ? '  ' + extra : ''}`)
  }
}

const daysAgo = (n) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString()
}

// ── 夹具：4 条，跨 2 册 / 3 章 / 3 种 confidence ──
const SEED = [
  {
    id: 'e-test-plugin',
    title: '插件热加载要重启宿主服务',
    claim: '改完 client.js 必须重启宿主，热更新不会重新注册工具面。',
    why: '实测：只刷新页面不会重新注册工具。重启后新工具才出现在工具架。',
    volume: 'vol-03', chapter: 'ch-prompt', chapterTitle: '提示词与技能',
    confidence: 'high', authority: 'L2', tags: ['seed'],
    provenance: { session_id: 'session-test-1', timestamp: daysAgo(0) },
    updatedAt: daysAgo(0),
  },
  {
    id: 'e-test-pin',
    title: '双排针选型先看载流',
    claim: '2.54mm 排针每针载流约 3A，2.0mm 更低。',
    why: '选型时先按电流算针数，再看间距与高度。',
    volume: 'vol-01', chapter: 'ch-hw', chapterTitle: '硬件与器件',
    confidence: 'medium', authority: 'L2',
    updatedAt: daysAgo(3),
  },
  {
    id: 'e-test-vram',
    title: '本地模型显存不足时先量化',
    claim: '7B q4 约占 4.5GB 显存。',
    why: '显存不够先降量化，再考虑换小模型。',
    volume: 'vol-05', chapter: 'ch-未分类', chapterTitle: '未分类',
    confidence: 'speculation', authority: 'L3',
    updatedAt: daysAgo(40),
  },
  {
    id: 'e-test-stat',
    title: '统计骨架条目不是结论',
    claim: '12 轮 · 40 次工具调用 · 2 个交付物',
    why: '',
    volume: 'vol-05', chapter: 'ch-未分类', chapterTitle: '未分类',
    confidence: 'statistic', authority: 'L3',
    updatedAt: daysAgo(1),
  },
]
for (const e of SEED) writeMarkdownEntry(LIB_ROOT, e)

const routes = []
const tools = []
const mockCtx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  tools: { register(def) { tools.push(def); return () => {} }, schemas() { return [] } },
  systemPrompt: { getSectionOrder() { return 3100 }, section() { return () => {} } },
  webServer: { register(r) { routes.push(r); return () => {} } },
  llm: {},
  effect(fn) { const d = fn && fn(); return typeof d === 'function' ? d : () => {} },
  on() { return () => {} },
  inject(deps, cb) { cb(mockCtx); return {} },
  get() { return undefined },
}

function mkRes() {
  const out = { status: 0, body: null, raw: '', headers: {} }
  out.res = {
    writeHead(code, headers) { out.status = code; out.headers = headers || {} },
    end(body) {
      out.raw = body == null ? '' : String(body)
      try { out.body = JSON.parse(out.raw) } catch { out.body = null }
    },
  }
  return out
}

function mkReq({ url = '/', method = 'GET', headers = {}, body = null } = {}) {
  const listeners = new Map()
  const req = {
    url,
    method,
    headers,
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, [])
      listeners.get(evt).push(fn)
      return req
    },
    destroy() {},
  }
  if (body !== null) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
    setImmediate(() => {
      for (const fn of listeners.get('data') || []) fn(buf)
      for (const fn of listeners.get('end') || []) fn()
    })
  }
  return req
}

async function call(path, opts = {}) {
  const route = routes.find((r) => r.kind === 'exact' && r.path === path)
  if (!route) throw new Error('没有注册路由：' + path)
  const out = mkRes()
  await route.handler(mkReq({ url: opts.url || path, ...opts }), out.res)
  return out
}

const GUARD = { 'x-dsh-manuscript': '1' }
const postJson = (obj) => ({ method: 'POST', headers: GUARD, body: JSON.stringify(obj) })
const searchUrl = (params) =>
  '/dsh-manuscript/api/search?' + new URLSearchParams(params).toString()

console.log('\n── 0. 装配 ──')
await apply(mockCtx)
check('注册了 /api/timeline', routes.some((r) => r.path === '/dsh-manuscript/api/timeline'))
check('注册了 /api/entry-save', routes.some((r) => r.path === '/dsh-manuscript/api/entry-save'))
check('注册了工具 library_save', tools.some((t) => t.name === 'library_save'))

// 等首次后台扫描完成
let booted = false
const deadline = Date.now() + 30000
while (Date.now() < deadline) {
  const r = await call('/dsh-manuscript/api/summary')
  if (r.status === 200 && r.body?.ok === true) { booted = true; break }
  await new Promise((resolve) => setTimeout(resolve, 200))
}
check('首次扫描完成（夹具 4 条）', booted && (await call('/dsh-manuscript/api/summary')).body?.entries === 4)

console.log('\n── 1. /api/search：筛选 ──')
{
  const r = await call('/dsh-manuscript/api/search', { url: searchUrl({ q: '插件' }) })
  check('q=插件 → 命中 e-test-plugin', r.status === 200 && r.body?.hits?.some((h) => h.id === 'e-test-plugin'))

  const vol = await call('/dsh-manuscript/api/search', { url: searchUrl({ q: '插件', volume: 'vol-01' }) })
  check('volume=vol-01 → 0 条（筛选发生在检索语料层）', vol.status === 200 && vol.body?.hits?.length === 0,
    `hits=${vol.body?.hits?.length}`)
  check('volume 筛选生效后 warnings 为空', Array.isArray(vol.body?.warnings) && vol.body.warnings.length === 0)

  const badVol = await call('/dsh-manuscript/api/search', { url: searchUrl({ q: '插件', volume: 'vol-99' }) })
  check('非法 volume → 200（忽略筛选）且 warnings 说明', badVol.status === 200
    && badVol.body?.warnings?.some((w) => w.includes('volume')),
    JSON.stringify(badVol.body?.warnings))
  check('非法 volume 没有把结果筛空', badVol.body?.hits?.some((h) => h.id === 'e-test-plugin'))

  const chapter = await call('/dsh-manuscript/api/search', {
    url: searchUrl({ q: '插件', chapter: '提示词与技能' }),
  })
  check('chapter 用标题也能筛中', chapter.body?.hits?.length === 1 && chapter.body.hits[0].id === 'e-test-plugin',
    JSON.stringify(chapter.body?.hits?.map((h) => h.id)))

  const badChapter = await call('/dsh-manuscript/api/search', {
    url: searchUrl({ q: '插件', chapter: '不存在的章' }),
  })
  check('非法 chapter → warnings 且忽略', badChapter.body?.warnings?.some((w) => w.includes('chapter')))

  const high = await call('/dsh-manuscript/api/search', { url: searchUrl({ q: '插件', confidence: 'high' }) })
  check('confidence=high → 命中 high 条目', high.body?.hits?.length === 1 && high.body.hits[0].id === 'e-test-plugin')

  // L2 是 authority 的取值：筛选必须同时匹配两套口径（否则“按 L2 筛”会 0 条）。
  const l2 = await call('/dsh-manuscript/api/search', { url: searchUrl({ q: '插件', confidence: 'L2' }) })
  check('confidence=L2 匹配 authority（两套口径都认）', l2.body?.hits?.some((h) => h.id === 'e-test-plugin'))

  const badConf = await call('/dsh-manuscript/api/search', { url: searchUrl({ q: '插件', confidence: 'bogus' }) })
  check('非法 confidence → warnings 且忽略', badConf.body?.warnings?.some((w) => w.includes('confidence')))
}

console.log('\n── 2. /api/search：matched 片段 ──')
{
  const r = await call('/dsh-manuscript/api/search', { url: searchUrl({ q: '插件热加载' }) })
  const hit = r.body?.hits?.[0] || {}
  check('每个 hit 都有 matched 数组', Array.isArray(hit.matched))
  check('matched 最多 2 处', hit.matched.length <= 2, `len=${hit.matched.length}`)
  check('片段字段来自 title/claim/why',
    hit.matched.every((m) => ['title', 'claim', 'why'].includes(m.field)),
    JSON.stringify(hit.matched))
  check('片段里原样保留命中词（不转义、不改写）',
    hit.matched.some((m) => m.text.includes('插件')),
    JSON.stringify(hit.matched))
  check('片段被截断时带省略号或完整包裹', hit.matched.every((m) => typeof m.text === 'string' && m.text.length > 0))

  // 语义命中可能一个查询词都没原样出现 —— 此时 matched 为空数组，不许伪造高亮。
  const semantic = await call('/dsh-manuscript/api/search', {
    url: searchUrl({ q: '改完插件前端要不要重启服务' }),
  })
  check('语义命中（无原词）不伪造 matched', Array.isArray(semantic.body?.hits)
    && semantic.body.hits.every((h) => Array.isArray(h.matched)),
    `hits=${semantic.body?.hits?.length}`)
}

console.log('\n── 3. /api/search：0 结果建议 + 负控 ──')
{
  for (const q of ['Docker exit code 137', 'Vulkan 投机解码参数', 'Nuxt 3 SSR 缓存']) {
    const r = await call('/dsh-manuscript/api/search', { url: searchUrl({ q }) })
    check(`负控「${q}」→ 0 条`, r.status === 200 && r.body?.hits?.length === 0, `hits=${r.body?.hits?.length}`)
    check(`负控「${q}」→ 3 个 suggestions`, Array.isArray(r.body?.suggestions) && r.body.suggestions.length === 3,
      JSON.stringify(r.body?.suggestions))
    check(`负控「${q}」→ suggestions 去重且非空`,
      new Set(r.body?.suggestions || []).size === (r.body?.suggestions || []).length
      && (r.body?.suggestions || []).every((s) => typeof s === 'string' && s.length >= 2),
      JSON.stringify(r.body?.suggestions))
  }
  const empty = await call('/dsh-manuscript/api/search', { url: searchUrl({ q: 'zzzqqq' }) })
  check('无结果时 suggestions 仍给 3 个', empty.body?.suggestions?.length === 3)
  check('有结果时不带 suggestions（不塞噪音）',
    (await call('/dsh-manuscript/api/search', { url: searchUrl({ q: '插件' }) })).body?.suggestions === undefined)
}

console.log('\n── 4. /api/timeline ──')
{
  const r = await call('/dsh-manuscript/api/timeline', { url: '/dsh-manuscript/api/timeline?days=30' })
  check('默认 30 天 → 200', r.status === 200 && r.body?.ok === true)
  check('窗口内 3 条（今天 / 3 天前 / 1 天前），40 天前那条被排除',
    r.body?.entryCount === 3 && r.body?.days?.reduce((n, d) => n + d.entries.length, 0) === 3,
    `entryCount=${r.body?.entryCount}`)
  check('日期分组是 YYYY-MM-DD 且倒序',
    r.body?.days?.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    && r.body.days.every((d, i) => i === 0 || r.body.days[i - 1].date > d.date),
    JSON.stringify(r.body?.days?.map((d) => d.date)))
  const e = r.body?.days?.find((d) => d.date === new Date().toISOString().slice(0, 10))?.entries?.[0]
  check('分组条目含 id/title/claim/volumeName/chapter',
    e && ['id', 'title', 'claim', 'volumeName', 'chapter'].every((k) => k in e),
    JSON.stringify(e))

  check('days=abc → 400（不静默当 0）',
    (await call('/dsh-manuscript/api/timeline', { url: '/dsh-manuscript/api/timeline?days=abc' })).status === 400)
  const clamp = await call('/dsh-manuscript/api/timeline', { url: '/dsh-manuscript/api/timeline?days=9999' })
  check('days=9999 → 夹到 365 且 clamped:true',
    clamp.status === 200 && clamp.body?.windowDays === 365 && clamp.body?.clamped === true,
    `windowDays=${clamp.body?.windowDays}`)
  check('POST /timeline → 405（只读端点）',
    (await call('/dsh-manuscript/api/timeline', { method: 'POST' })).status === 405)

  // 没有 updatedAt 的条目（人手写进来的普通 Markdown）必须用文件 mtime 兜底，
  // 而不是被时间线静默丢掉。测完立刻删掉，避免影响后面的目录计数断言。
  const rawPath = join(LIB_ROOT, '手写笔记.md')
  writeFileSync(rawPath, '# 手写笔记\n\n没有 front-matter，也没有 updatedAt。\n', 'utf8')
  const withRaw = await call('/dsh-manuscript/api/timeline', { url: '/dsh-manuscript/api/timeline?days=1' })
  check('无 updatedAt → 文件 mtime 兜底进今天的时间线',
    withRaw.body?.days?.[0]?.entries?.some((e) => e.title === '手写笔记'),
    JSON.stringify(withRaw.body?.days?.[0]?.entries?.map((e) => e.title)))
  rmSync(rawPath, { force: true })
}

console.log('\n── 5. /api/entry-save：新建 / 编辑 ──')
let newId = null
{
  check('无守门头 POST → 403',
    (await call('/dsh-manuscript/api/entry-save', { method: 'POST', body: JSON.stringify({ title: 'x', claim: 'y' }) })).status === 403)
  check('GET → 405',
    (await call('/dsh-manuscript/api/entry-save', { method: 'GET' })).status === 405)
  const notJson = await call('/dsh-manuscript/api/entry-save', { method: 'POST', headers: GUARD, body: 'not-json' })
  check('body 非 JSON → 400', notJson.status === 400)
  check('缺 title → 400 且说明原因',
    (await call('/dsh-manuscript/api/entry-save', postJson({ claim: 'y' }))).status === 400)
  check('空 claim → 400',
    (await call('/dsh-manuscript/api/entry-save', postJson({ title: 'x', claim: '   ' }))).status === 400)
  check('非法 id → 400',
    (await call('/dsh-manuscript/api/entry-save', postJson({ id: '../etc/passwd', title: 'x', claim: 'y' }))).status === 400)
  check('有 id 但不存在 → 404（不静默新建）',
    (await call('/dsh-manuscript/api/entry-save', postJson({ id: 'e-no-such', title: 'x', claim: 'y' }))).status === 404)

  const created = await call('/dsh-manuscript/api/entry-save', postJson({
    title: '手写一条：保存后立刻能搜到',
    claim: '保存后只重扫 Markdown，不重扫会话。',
    why: '写入在 .build.lock 内完成，索引重建后立即刷新内存快照。',
  }))
  newId = created.body?.entry?.id || null
  check('新建 → 200 且 created:true', created.status === 200 && created.body?.created === true, `status=${created.status}`)
  check('新建 id 形如 md-<hash>', /^md-[0-9a-f]{12}/.test(String(newId)), String(newId))
  check('返回 entry 含 id/title/claim/why/volumeName/chapter',
    created.body?.entry && ['id', 'title', 'claim', 'why', 'volumeName', 'chapter'].every((k) => k in created.body.entry),
    JSON.stringify(created.body?.entry))
  check('新建落收件箱 vol-05', /未分类收件箱/.test(String(created.body?.entry?.volumeName)), String(created.body?.entry?.volumeName))
  check('文件真的写到了 relativePath', existsSync(join(LIB_ROOT, created.body?.relativePath || '')),
    created.body?.relativePath)
  const mdText = readFileSync(join(LIB_ROOT, created.body?.relativePath || ''), 'utf8')
  check('写出的 Markdown 有 front-matter 与正文', mdText.startsWith('---\n') && mdText.includes('手写一条'))

  const found = await call('/dsh-manuscript/api/search', { url: searchUrl({ q: '保存后立刻能搜到' }) })
  check('保存后无需重启即可被搜索到（快照已增量刷新）',
    found.body?.hits?.some((h) => h.id === newId), JSON.stringify(found.body?.hits?.map((h) => h.id)))

  const timeline = await call('/dsh-manuscript/api/timeline', { url: '/dsh-manuscript/api/timeline?days=1' })
  check('新建条目出现在今天的时间线里',
    timeline.body?.days?.[0]?.entries?.some((e) => e.id === newId))

  const edited = await call('/dsh-manuscript/api/entry-save', postJson({
    id: newId,
    title: '手写一条：改过标题',
    claim: '改过的摘要',
    why: '改过的正文',
  }))
  check('编辑 → 200 且 created:false', edited.status === 200 && edited.body?.created === false)
  check('编辑回显新值', edited.body?.entry?.title === '手写一条：改过标题'
    && edited.body?.entry?.claim === '改过的摘要', JSON.stringify(edited.body?.entry))
  const editedFile = readFileSync(join(LIB_ROOT, edited.body?.relativePath || ''), 'utf8')
  check('编辑写回同一文件（没有产生第二份）',
    !edited.body?.relativePath?.includes('\n') && editedFile.includes('改过的正文'), edited.body?.relativePath)
  check('编辑后只有一条同 id 的 Markdown', scanMarkdownLibrary(LIB_ROOT).entries.filter((e) => e.id === newId).length === 1)
}

console.log('\n── 6. /api/entry-save：保留未传字段 + 并发 ──')
{
  const before = readFileSync(join(LIB_ROOT, 'vol-03', 'ch-prompt', 'e-test-plugin.md'), 'utf8')
  check('夹具条目带 provenance/confidence', before.includes('session-test-1') && before.includes('"high"'))
  const r = await call('/dsh-manuscript/api/entry-save', postJson({
    id: 'e-test-plugin',
    title: '插件热加载要重启宿主服务（修订）',
    claim: '改客户端代码后必须重启宿主。',
    why: '补充：工具 schema 在启动时注册一次。',
  }))
  check('编辑既有条目 → 200', r.status === 200 && r.body?.entry?.id === 'e-test-plugin')
  check('册/章/置信度未被改动（未传字段保留）',
    r.body?.entry?.volumeName === 'VOL.03 DSH 插件开发' && r.body?.entry?.chapter === '提示词与技能',
    `${r.body?.entry?.volumeName} / ${r.body?.entry?.chapter}`)
  const after = readFileSync(join(LIB_ROOT, 'vol-03', 'ch-prompt', 'e-test-plugin.md'), 'utf8')
  check('provenance 原样保留在文件里', after.includes('session-test-1'))
  check('confidence/authority 原样保留', after.includes('"high"') && after.includes('"L2"'))
  check('tags 原样保留', after.includes('seed'))
  check('正文已被替换', after.includes('工具 schema 在启动时注册一次'))

  // 并发写同一 id：序列化后最终文件必须是合法、可解析、id 唯一的一份。
  const [a, b] = await Promise.all([
    call('/dsh-manuscript/api/entry-save', postJson({ id: 'e-test-plugin', title: '并发 A', claim: '甲摘要', why: '甲正文' })),
    call('/dsh-manuscript/api/entry-save', postJson({ id: 'e-test-plugin', title: '并发 B', claim: '乙摘要', why: '乙正文' })),
  ])
  check('并发写同一 id → 两个请求都成功（不互相报错）', a.status === 200 && b.status === 200,
    `status=${a.status}/${b.status}`)
  const scan = scanMarkdownLibrary(LIB_ROOT)
  const copies = scan.entries.filter((e) => e.id === 'e-test-plugin')
  check('并发后同 id 只有一份', copies.length === 1, `count=${copies.length}`)
  check('并发后无解析错误', scan.errors.length === 0, JSON.stringify(scan.errors))
  check('最终标题是其中一次写入的完整值', ['并发 A', '并发 B'].includes(copies[0]?.title), String(copies[0]?.title))
  check('最终文件 front-matter 未被撕裂', readFileSync(join(LIB_ROOT, 'vol-03', 'ch-prompt', 'e-test-plugin.md'), 'utf8').startsWith('---\n'))
}

console.log('\n── 7. 工具 library_save ──')
{
  const tool = tools.find((t) => t.name === 'library_save')
  check('工具描述里有「只存明确结论」的提醒',
    /明确/.test(tool.description) && /整段对话|日志/.test(tool.description), tool.description.slice(0, 80))
  check('参数含 title/content/tags', ['title', 'content', 'tags'].every((k) => k in (tool.parameters?.properties || {})))

  const before = (await call('/dsh-manuscript/api/summary')).body?.entries
  const out = await tool.execute({ title: '工具保存的结论', content: '第一句摘要。\n第二句补充证据。', tags: 'test, 冒烟' })
  check('工具返回包含 id 与路径', /id：md-[0-9a-f]{12}/.test(out) && /路径：vol-05\//.test(out), String(out).slice(0, 120))
  const toolId = (out.match(/id：(md-[0-9a-f]{12})/) || [])[1]
  check('工具保存的条目可被手动读取', !!toolId && existsSync(join(LIB_ROOT, 'vol-05', 'ch-未分类', toolId + '.md')))
  const txt = readFileSync(join(LIB_ROOT, 'vol-05', 'ch-未分类', toolId + '.md'), 'utf8')
  check('工具保存的 claim 取自正文首句', txt.includes('第一句摘要'))
  check('tags 写进 front-matter', txt.includes('冒烟'))
  check('工具保存后目录计数 +1（快照已刷新）',
    (await call('/dsh-manuscript/api/summary')).body?.entries === before + 1,
    `${before} → ${(await call('/dsh-manuscript/api/summary')).body?.entries}`)

  check('空 title 不写库', String(await tool.execute({ title: '   ', content: '正文' })).startsWith('未保存'))
  check('空 content 不写库', String(await tool.execute({ title: '标题', content: '  ' })).startsWith('未保存'))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
rmSync(TMP, { recursive: true, force: true })
if (fail > 0) {
  console.log('失败用例：', failures.join('；'))
  process.exit(1)
}
