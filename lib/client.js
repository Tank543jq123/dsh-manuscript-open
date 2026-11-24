window.__ModuleLoader__.load({
  id: "dsh-manuscript",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const jsxRuntime = require("react/jsx-runtime");
    const react = require("react");
    const { jsx, jsxs } = jsxRuntime;

    // ── 常量 ────────────────────────────────────────────────────────────────
    const PANEL_ID = "manuscript";
    // 插件管理页里的行 id，必须与 cordis.patch.yml 的 insert id 一致
    const ENTRY_ID = "dsh-manuscript";
    const CSS_ID = "dsh-manuscript";
    const API_SUMMARY = "/dsh-manuscript/api/summary";
    const API_VOLUME = "/dsh-manuscript/api/volume/";
    // 2026-11-12：给人用的两条只读端点（服务端 lib/index.js 同一批新增）。
    // search 复用 matchEntries，entry 回读磁盘上的正文（why）。
    const API_SEARCH = "/dsh-manuscript/api/search";
    const API_ENTRY = "/dsh-manuscript/api/entry";
    // 2026-11-12（体验改造 P0/P2）：编辑保存与时间线。
    // 写操作同样走 postJson 的守门头；时间线是只读 GET。
    const API_ENTRY_SAVE = "/dsh-manuscript/api/entry-save";
    const API_TIMELINE = "/dsh-manuscript/api/timeline";
    const API_SESSIONS = "/dsh-manuscript/api/sessions?limit=50";
    const AI_VOLUME_ID = "ai-collab";
    const AI_VOLUME_HINT = "AI 协作";
    const API_DISTILL_PLAN = "/dsh-manuscript/api/distill/plan";
    const API_DISTILL_RUN = "/dsh-manuscript/api/distill/run";
    const API_DISTILL_COMMIT = "/dsh-manuscript/api/distill/commit";
    // 【2026-11-06 新增】切换模型原来是"用 GET /plan?model=xxx 顺手改后端状态"，
    // 一个 GET 能产生副作用意味着预取/重放都会改配置。现在单独立一条 POST 路由。
    const API_DISTILL_MODEL = "/dsh-manuscript/api/distill/model";
    const API_TOOLS = "/dsh-manuscript/api/tools";
    // 【2026-11-12 新增】巡检设置：GET 读、POST 写；改完由 systemd path unit 落到 timer，
    // 前端**不**负责改调度，只负责把"存了什么"和"下次什么时候跑"如实显示。
    const API_CHECK_SETTINGS = "/dsh-manuscript/api/check-settings";
    const API_CHECK_RUN = "/dsh-manuscript/api/check-run";
    // 2026-11-12：库路径配置（面板可改，环境变量兜底）。写操作同样走守门头。
    const API_LIBRARY_CONFIG = "/dsh-manuscript/api/library-config";
    // 写操作守门头：后端据此确认请求来自本插件前端，而不是任意页面发起的裸 POST。
    // 所有 POST 都必须带上，值与后端约定一致（1 = 本前端）。
    const GUARD_HEADER = "x-dsh-manuscript";
    const GUARD_VALUE = "1";

    // 【为什么需要模块级缓存 2026-11-02】
    // distillResult 原本只是 ManuscriptPage 的局部 state。
    // 但 main 槽是 keyed 的，用户切面板 / 切 tab 时组件会被卸载，
    // 状态随之丢失 —— 症状就是"点完提炼看到结果，过一阵又变回预演文案"。
    // 所以把最近一次结果和进行中标记提到模块级，卸载再挂载也能恢复。
    const DISTILL_MEMORY = {
      phase: "idle",      // idle | ready | planning | running | done | error
      result: null,
      error: null,
      startedAt: 0,
      // 用户选的模型也要跨卸载保留
      model: null,
    };

    /**
     * 提炼单次可能跑 20–180 秒（真调 LLM）。
     * 默认 fetch 没有超时，但某些环境会 30s 掐断 —— 这里显式放开到 5 分钟，
     * 并且**不用 AbortController 主动中断**，否则用户会看到"跑到一半失败"。
     */
    // 提炼超时。
    // 【2026-11-03 调整】原来 5 分钟，但那时每批只跑 5 个会话。
    // 现在一批 20 个，实测约 130 秒 + 提炼前强制刷新约 25 秒 ≈ 2.6 分钟；
    // 留足余量到 8 分钟，避免长会话批次（实测单个可达 17k 字符）被误杀。
    const DISTILL_TIMEOUT_MS = 480000;

    // ── 样式（主结构直角 · 圆角只给 chip/圆点）─────────────────────────────
    //
    // 【重要】本插件不定义自己的调色板，全部映射到 DSH 官方 design token。
    // 之前这里硬编码了 13 个色值，后果是：DSH 切换主题（深/浅/其他皮肤）时
    // 我们的面板不跟随，会变成一块突兀的深色区域。
    //
    // 做法：保留 `--ms-*` 中间层变量，但让它们指向官方的 `--dsw-alias-*`。
    // 好处是：① 主题自动跟随 ② 组件 CSS 不用改一个字 ③ 万一官方 token 缺失，
    // 后面的 fallback 值仍能保证可读（不是完全裸奔）。
    const CSS = [
      '.ms-root,.ms-card,.ms-rail,.ms-glyph{',
      // 背景层：base(页面) / layer-1(卡片) / layer-2(次级) / layer-3(凹陷)
      '  --bg:var(--dsw-alias-bg-base, #12151A);',
      '  --panel:var(--dsw-alias-bg-layer-1, #181C22);',
      '  --card:var(--dsw-alias-bg-layer-2, #1E232B);',
      '  --well:var(--dsw-alias-bg-layer-3, #232830);',
      '  --line:var(--dsw-alias-border-l3, #2C333D);',
      '  --line-soft:var(--dsw-alias-border-l2, #262D36);',
      // 文字四级
      '  --text:var(--dsw-alias-label-primary, #E6EAF0);',
      '  --text-2:var(--dsw-alias-label-secondary, #9AA4B2);',
      '  --text-3:var(--dsw-alias-label-tertiary, #6B7684);',
      '  --text-4:var(--dsw-alias-label-caption, #5A636E);',
      // 强调与状态（成对：图形用 primary，文字用对应 label 级别）
      '  --accent:var(--dsw-alias-brand-primary, #4C8DFF);',
      '  --t-green:var(--dsw-alias-state-success-primary, #57C08F);',
      '  --t-orange:var(--dsw-alias-state-warn-primary, #E0B455);',
      '  --t-red:var(--dsw-alias-state-error-primary, #E0705A);',
      '  --t-cyan:var(--dsw-alias-state-business-primary, #4FB3C4);',
      // 交互态
      '  --hover:var(--dsw-alias-interactive-bg-hover, #232830);',
      '  --elevation:var(--dsw-elevation-prominent, 0 4px 16px rgba(0,0,0,.4));',
      '  --font-mono:var(--ds-font-family-code, Menlo, monospace);',
      // 控制面板排版刻度：文字 4 档（11/12/13/16），间距 4/8/12/16/24。
      // 标题固定 16px/700；数字/路径/状态用等宽；不再散落 9.5/10.5/12.5/14.5。
      '  --ms-fs-1:11px; --ms-fs-2:12px; --ms-fs-3:13px; --ms-fs-4:16px;',
      '  --ms-lh-1:16px; --ms-lh-2:18px; --ms-lh-3:20px; --ms-lh-4:24px;',
      '  --ms-s1:4px; --ms-s2:8px; --ms-s3:12px; --ms-s4:16px; --ms-s5:24px;',
      '  font-family:-apple-system,"Microsoft YaHei",sans-serif;',
      '}',

      /* panellist 图标单独作用域（侧栏不提供我们的变量） */
      '.ms-glyph{--accent:var(--dsw-alias-brand-primary, #4C8DFF)}',

      /* ① 侧栏迷你卡 */
      '.ms-card{display:flex;flex-direction:column;gap:8px;width:100%;box-sizing:border-box;',
      '  padding:8px 12px;background:var(--card);border:0;border-radius:0;',
      '  box-shadow:0 0 0 1px var(--line);color:var(--text);cursor:pointer;outline:none}',
      '.ms-card:hover{background:var(--well)}',
      '.ms-card:focus-visible{box-shadow:0 0 0 1px var(--accent)}',
      '.ms-cardHead{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px;min-width:0}',
      '.ms-cardName{font-weight:600;letter-spacing:.02em;color:var(--text);white-space:nowrap}',
      '.ms-cardCount{margin-left:auto;color:var(--text-2);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.ms-meterRow{display:flex;align-items:center;gap:8px}',
      '.ms-meter{flex:1;min-width:0;height:3px;background:var(--well);position:relative;overflow:hidden}',
      '.ms-meterFill{position:absolute;left:0;top:0;bottom:0;background:var(--t-green)}',
      '.ms-meterLabel{font-size:11px;line-height:12px;color:var(--text-3);white-space:nowrap;font-variant-numeric:tabular-nums}',

      /* 56px rail 降级形态 */
      '.ms-rail{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;',
      '  background:transparent;border:0;border-radius:0;padding:4px;margin:0;cursor:pointer;outline:none;color:var(--text-2)}',
      '.ms-rail:focus-visible{box-shadow:0 0 0 1px var(--accent)}',
      '.ms-rail:hover .ms-railPct{color:var(--text)}',
      '.ms-railPct{font-size:11px;line-height:11px;color:var(--text-3);font-variant-numeric:tabular-nums}',

      /* ③ 主面板骨架 */
      '.ms-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font-size:var(--ms-fs-3);line-height:1.5}',
      '.ms-top{flex:none;display:flex;align-items:center;gap:16px;padding:12px 24px 12px;background:var(--bg);box-shadow:inset 0 -1px 0 0 var(--line)}',
      '.ms-title{font-size:13px;font-weight:600;letter-spacing:.03em;color:var(--text);white-space:nowrap}',
      // 窄屏（390px 实测）标签会逐字换行、把顶栏撑成两行，
      // 这里改成单行横向滚动：标签不换行，容器自己滚，顶栏高度恒定。
      '.ms-tabs{display:flex;align-items:center;gap:4px;overflow-x:auto;',
      '  scrollbar-width:none;-ms-overflow-style:none}',
      '.ms-tabs::-webkit-scrollbar{display:none}',
      '.ms-tab{flex:none;white-space:nowrap}',
      '.ms-tab{background:transparent;border:0;border-radius:0;padding:4px 12px;margin:0;font:inherit;font-size:12px;',
      '  line-height:20px;color:var(--text-2);cursor:pointer;outline:none;box-shadow:none}',
      '.ms-tab:hover{color:var(--text);background:var(--well)}',
      '.ms-tab[data-on="true"]{color:var(--text);background:var(--card);box-shadow:inset 0 -2px 0 0 var(--accent)}',
      '.ms-tab:focus-visible{box-shadow:inset 0 0 0 1px var(--accent)}',
      '.ms-meta{margin-left:auto;font-size:12px;color:var(--text-3);letter-spacing:.02em;white-space:nowrap;font-variant-numeric:tabular-nums}',
      /* 快照过期提示（D-05，2026-11-06）：与 .ms-meta 同为小字，但用告警色，
         否则它和"6 册"这种事实型数字长一样，用户眼睛扫过去不会停。 */
      '.ms-stale{font-size:12px;line-height:16px;color:var(--t-orange);white-space:nowrap;',
      '  font-variant-numeric:tabular-nums;padding:0 8px;box-shadow:inset 0 0 0 1px currentColor}',
      '.ms-body{flex:1;min-height:0;overflow:auto;padding:16px 24px 24px}',
      '.ms-body::-webkit-scrollbar{width:10px;height:10px}',
      '.ms-body::-webkit-scrollbar-thumb{background:var(--well);box-shadow:inset 0 0 0 1px var(--line)}',
      '.ms-body::-webkit-scrollbar-thumb:hover{background:var(--line)}',
      '.ms-body::-webkit-scrollbar-track{background:transparent}',

      /* 通用排版 */
      '.ms-view{display:flex;flex-direction:column}',
      /* ── 控制面板卡片（2026-11-24 v1.3.0）──────────────────────
         真实在用的 CardSection：标题栏 16px/700 + 分隔线 + 卡片边界。
         .ms-sec 降级为卡片内的小节标题（13px/700），不再承担整块标题。 */
      '.ms-sec{font-size:var(--ms-fs-3);line-height:var(--ms-lh-3);color:var(--text);letter-spacing:.02em;font-weight:700;' +
      '  margin:0 0 var(--ms-s3);display:flex;align-items:center;gap:var(--ms-s2)}',
      '.ms-sec::before{content:"";width:3px;height:12px;background:var(--t-cyan);flex:none}',
      '.ms-cardsec{background:var(--panel);box-shadow:0 0 0 1px var(--line);margin:0 0 var(--ms-s4);min-width:0}',
      '.ms-cardsec:last-child{margin-bottom:0}',
      '.ms-cardsecHead{display:flex;align-items:center;gap:var(--ms-s2);padding:var(--ms-s4) var(--ms-s4) var(--ms-s3);',
      '  border-bottom:1px solid var(--line-soft);min-width:0}',
      '.ms-cardsecTitle{font-size:var(--ms-fs-4);line-height:var(--ms-lh-4);font-weight:700;color:var(--text);',
      '  margin:0;display:flex;align-items:center;gap:var(--ms-s2);min-width:0}',
      '.ms-cardsecTitle::before{content:"";width:3px;height:16px;background:var(--t-cyan);flex:none}',
      '.ms-cardsecMeta{margin-left:auto;font-family:var(--font-mono);font-size:var(--ms-fs-1);line-height:var(--ms-lh-1);',
      '  color:var(--text-3);white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.ms-cardsecActions{margin-left:auto;display:flex;align-items:center;gap:var(--ms-s2)}',
      '.ms-cardsecHint{margin:0;padding:var(--ms-s3) var(--ms-s4) 0;font-size:var(--ms-fs-2);line-height:var(--ms-lh-2);color:var(--text-3)}',
      '.ms-cardsecBody{padding:var(--ms-s4);min-width:0}',
      '.ms-cardsecBody[data-flush="true"]{padding:0}',
      '.ms-readerCard{max-width:832px}',
      /* 数值 / 路径 / 日期 / 状态值统一等宽：中文仍回落到系统字体，不会变丑。 */
      '.ms-meta,.ms-stale,.ms-cardsecMeta,.ms-volMeta,.ms-volDate,.ms-updPath,.ms-tlPath,.ms-tlCount,',
      '.ms-seNum,.ms-seScore,.ms-entryMeta,.ms-entryConf,.ms-resultPath,.ms-dLineWhy,.ms-wdScore,',
      '.ms-tsumNum,.ms-fnNum,.ms-cNote,.ms-cWarn{font-family:var(--font-mono);font-variant-numeric:tabular-nums}',
      '.ms-cardsecBody .ms-distill,.ms-cardsecBody .ms-check{background:transparent;box-shadow:none}',
      '.ms-cardsecBody[data-flush="true"] > .ms-upd,.ms-cardsecBody[data-flush="true"] > .ms-sess{background:transparent;box-shadow:none}',
      '.ms-cardsecBody .ms-distill > .ms-dRow,.ms-cardsecBody .ms-check > .ms-dRow,',
      '.ms-cardsecBody .ms-check > .ms-cRow,.ms-cardsecBody .ms-distill > .ms-dHuman,',
      '.ms-cardsecBody .ms-distill > .ms-dMore{padding-left:0;padding-right:0}',
      '.ms-cardsecBody .ms-distill .ms-dList,.ms-cardsecBody .ms-distill .ms-wdHead,',
      '.ms-cardsecBody .ms-distill .ms-wdRow{padding-left:0;padding-right:0}',
      '.ms-cardsecBody .ms-dConfirm{margin-left:0;margin-right:0}',
      '.ms-subhead{font-size:var(--ms-fs-3);line-height:var(--ms-lh-3);font-weight:700;color:var(--text);',
      '  margin:0 0 var(--ms-s3);display:flex;align-items:center;gap:var(--ms-s2)}',
      '.ms-subfold{border-top:1px solid var(--line-soft);margin-top:var(--ms-s4);padding-top:var(--ms-s3)}',
      '.ms-subfold > summary{list-style:none;cursor:pointer;font-size:var(--ms-fs-3);line-height:var(--ms-lh-3);',
      '  font-weight:600;color:var(--text-2);padding:var(--ms-s2) 0;display:flex;align-items:center;gap:var(--ms-s2);outline:none}',
      '.ms-subfold > summary::-webkit-details-marker{display:none}',
      '.ms-subfold > summary::before{content:"▸";color:var(--text-3)}',
      '.ms-subfold[open] > summary::before{content:"▾"}',
      '.ms-subfoldBody{padding-top:var(--ms-s2)}',
      '.ms-searchEntry{display:flex;flex-direction:column;gap:var(--ms-s3)}',
      '.ms-searchEntryRow{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ms-s2)}',
      '.ms-searchEntryHint{font-size:var(--ms-fs-2);line-height:var(--ms-lh-2);color:var(--text-3);margin:0}',
      '.ms-toolSummary{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--ms-s2) var(--ms-s4);',
      '  font-size:var(--ms-fs-2);color:var(--text-2);margin-bottom:var(--ms-s4)}',
      '.ms-toolSummary b{font-family:var(--font-mono);font-size:var(--ms-fs-3);font-weight:700;color:var(--text)}',
      '.ms-btn{background:var(--card);border:0;border-radius:2px;padding:8px 12px;margin:0;font:inherit;',
      '  font-size:var(--ms-fs-2);line-height:var(--ms-lh-2);color:var(--text-2);cursor:pointer;outline:none;',
      '  box-shadow:0 0 0 1px var(--line);white-space:nowrap}',
      '.ms-btn:hover{background:var(--well);color:var(--text);box-shadow:0 0 0 1px var(--accent)}',
      '.ms-btn:focus-visible{box-shadow:0 0 0 1px var(--accent)}',
      '.ms-btn[data-tone="primary"]{background:var(--accent);color:var(--bg);box-shadow:none;font-weight:600}',
      '.ms-btn[data-tone="primary"]:hover{filter:brightness(.94);color:var(--bg);box-shadow:none}',
      '.ms-chip{display:inline-flex;align-items:center;height:16px;padding:0 4px;border-radius:2px;',
      '  font-size:11px;line-height:16px;color:var(--text-2);background:var(--well);box-shadow:0 0 0 1px var(--line);white-space:nowrap}',
      '.ms-empty{background:var(--panel);box-shadow:0 0 0 1px var(--line);padding:12px 16px;color:var(--text-3);font-size:12px;line-height:17px}',
      '.ms-retired{margin-top:16px;padding-top:12px;box-shadow:inset 0 1px 0 0 var(--line)}',
      '.ms-retiredHead{font-size:12px;color:var(--text-3);margin-bottom:8px}',
      '.ms-retiredItem{padding:8px 0;cursor:pointer;box-shadow:inset 0 -1px 0 0 var(--line-soft)}',
      '.ms-retiredTitle{font-size:13px;color:var(--text-2)}',
      '.ms-retiredClaim{font-size:12px;color:var(--text-3);margin-top:4px}',
      '.ms-empty b{display:block;margin-bottom:4px;font-size:12px;font-weight:600;color:var(--text-2)}',
      '.ms-empty span{display:block}',
      '.ms-callout{background:var(--panel);box-shadow:0 0 0 1px var(--line),inset 2px 0 0 0 var(--t-cyan);',
      '  padding:12px 16px;color:var(--text-2);font-size:12px;line-height:18px}',

      /* 漏斗 */
      '.ms-funnel{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;background:var(--line);box-shadow:0 0 0 1px var(--line)}',
      '.ms-fn{background:var(--panel);padding:12px 16px 12px;min-width:0}',
      '.ms-fnLabel{font-size:11px;line-height:13px;color:var(--text-3);letter-spacing:.04em}',
      '.ms-fnNum{margin-top:4px;font-size:22px;font-weight:600;line-height:1.1;letter-spacing:-.01em;font-variant-numeric:tabular-nums}',
      '.ms-fnBar{height:3px;margin-top:8px;background:var(--well)}',
      '.ms-fnFill{height:3px}',
      '.ms-shape{margin-top:8px;font-size:12px;color:var(--text-3);letter-spacing:.02em}',

      /* ── 书房首屏（2026-11-12）─────────────────────────────────
         原来的首屏是：提炼状态条 → 4 格漏斗 → 构成小字 → 分册 → 会话。
         对人来说这是一块监控面板：眼睛要先跳过 8 个数字才看到"有哪些册"。
         现在改成：一句人话 + 3 个安静的数字 + 分册，维护区折叠到底部。 */
      '.ms-hero{padding:4px 0 4px}',
      '.ms-heroTitle{font-size:22px;line-height:1.35;font-weight:700;letter-spacing:-.01em;color:var(--text)}',
      '.ms-heroSub{margin-top:8px;font-size:12px;line-height:20px;color:var(--text-2)}',
      '.ms-statline{display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px 24px;',
      '  margin:16px 0 24px;padding-top:16px;box-shadow:inset 0 1px 0 0 var(--line-soft)}',
      '.ms-stat{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0;flex:1 1 180px}',
      '.ms-statValue{display:flex;align-items:baseline;gap:8px;min-width:0}',
      '.ms-statNum{font-family:var(--font-mono);font-size:24px;font-weight:700;line-height:1;letter-spacing:-.02em;',
      '  font-variant-numeric:tabular-nums;color:var(--text)}',
      '.ms-statLabel{font-size:13px;color:var(--text-2);font-weight:600;white-space:nowrap}',
      '.ms-statHint{display:block;font-size:12px;line-height:18px;color:var(--text-3);margin-top:4px;',
      '  white-space:normal;overflow:visible}',
      /* 索引骨架说明（2026-11-24 整改 P0-1）：常驻、可读、不抢统计数字的层级 */
      '.ms-skelNote{margin:-4px 0 20px;padding:8px 12px;background:var(--well);box-shadow:inset 0 0 0 1px var(--line-soft);',
      '  font-size:12px;line-height:18px;color:var(--text-3)}',
      '.ms-skelNote b{color:var(--text-2);font-weight:600}',
      '@media (max-width:640px){',
      '  .ms-statline{flex-direction:column;gap:16px}',
      '  .ms-stat{flex:0 0 auto;width:100%}',
      '}',


      /* ── 搜索条（2026-11-12）──────────────────────────────────
         放在顶栏下方独占一行：搜索是"人打开手册的第一动作"，
         塞进顶栏右侧会被 tabs + 计数挤成一条细线。 */
      '.ms-searchbar{flex:none;display:flex;align-items:center;gap:12px;padding:0 24px 12px;background:var(--bg)}',
      '.ms-search{flex:1;max-width:620px;display:flex;align-items:center;gap:8px;height:34px;',
      '  padding:0 12px;box-sizing:border-box;background:var(--card);border-radius:4px;',
      '  box-shadow:inset 0 0 0 1px var(--line)}',
      '.ms-search:focus-within{box-shadow:inset 0 0 0 1px var(--accent)}',
      '.ms-searchIcon{flex:none;color:var(--text-3);display:flex}',
      '.ms-searchInput{flex:1;min-width:0;background:transparent;border:0;outline:none;color:var(--text);',
      '  font:inherit;font-size:13px;line-height:20px;padding:0}',
      '.ms-searchInput::placeholder{color:var(--text-4)}',
      '.ms-searchInput::-webkit-search-cancel-button,.ms-searchInput::-webkit-search-decoration{-webkit-appearance:none;display:none}',
      '.ms-searchClear{flex:none;border:0;background:transparent;color:var(--text-3);cursor:pointer;',
      '  font:inherit;font-size:16px;line-height:20px;padding:0 4px;border-radius:2px}',
      '.ms-searchClear:hover{color:var(--text);background:var(--well)}',
      '.ms-searchHint{font-size:12px;color:var(--text-4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',

      /* 搜索结果：一行一条，标题 / 一句 claim / 册·章小字 */
      '.ms-results{display:flex;flex-direction:column;max-width:860px}',
      '.ms-resHead{font-size:12px;line-height:19px;color:var(--text-3);margin:0 0 4px}',
      '.ms-resHead b{color:var(--text);font-weight:600}',
      '.ms-result{display:block;width:100%;box-sizing:border-box;text-align:left;background:transparent;',
      '  border:0;margin:0;padding:16px 4px 16px;cursor:pointer;outline:none;font:inherit;',
      '  box-shadow:inset 0 -1px 0 0 var(--line-soft)}',
      '.ms-result:hover{background:var(--well)}',
      '.ms-result:focus-visible{box-shadow:inset 0 0 0 1px var(--accent)}',
      '.ms-resultTitle{font-size:16px;line-height:21px;font-weight:600;color:var(--text);letter-spacing:.01em}',
      '.ms-resultClaim{margin-top:4px;font-size:13px;line-height:20px;color:var(--text-2);',
      '  overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.ms-resultPath{margin-top:8px;font-size:12px;line-height:16px;color:var(--text-3)}',
      // 命中词高亮：浅色底、只用一层内阴影压边，不抢标题的字重。
      // 颜色走 rgba 而不是主题 token —— 高亮需要在深/浅两套主题里都保持"底色"语义，
      // 直接拿 --accent 当背景会在大面积文字上变成刺眼的实心色块。
      '.ms-mark{background:rgba(76,141,255,.32);color:inherit;border-radius:2px;',
      '  padding:0 4px;box-shadow:inset 0 -2px 0 0 rgba(27,96,214,.55)}',
      // 深色主题下 22% 蓝几乎看不见：提高底色比例，并把文字钉在浅色，
      // 避免命中词落进强调色后反而更难读。
      'body[data-ds-dark-theme] .ms-mark{background:rgba(88,155,255,.40);color:var(--text);',
      '  box-shadow:inset 0 -2px 0 0 rgba(160,200,255,.75)}',
      // 命中片段：最多两条，和 claim 同字号但更淡，不参与两行截断，
      // 让"为什么命中"能自己长出来，而不是被裁掉。
      '.ms-resultMatch{margin-top:4px;font-size:12px;line-height:18px;color:var(--text-3);',
      '  overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.ms-resultField{display:inline-block;margin-right:8px;padding:0 4px;border-radius:2px;',
      '  font-size:11px;line-height:15px;color:var(--text-3);background:var(--well);vertical-align:1px}',
      // 搜索筛选：三个原生下拉，和目录里的"册"选择同一套扁平方角。
      '.ms-filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:4px 0 12px}',
      '.ms-filter{max-width:190px;background:var(--panel);color:var(--text-2);border:0;border-radius:2px;',
      '  padding:4px 8px;font:inherit;font-size:12px;line-height:18px;cursor:pointer;',
      '  box-shadow:0 0 0 1px var(--line);outline:none}',
      '.ms-filter:hover{color:var(--text);background:var(--well)}',
      '.ms-filter:focus-visible{box-shadow:0 0 0 1px var(--accent)}',
      '.ms-filterNote{font-size:12px;line-height:18px;color:var(--text-4)}',
      '.ms-filterReset{border:0;background:transparent;color:var(--text-3);font:inherit;font-size:12px;',
      '  line-height:18px;padding:4px 4px;margin:0;cursor:pointer;outline:none;',
      '  text-decoration:underline;text-underline-offset:2px}',
      '.ms-filterReset:hover{color:var(--text)}',
      '.ms-filterReset:focus-visible{box-shadow:0 0 0 1px var(--accent)}',
      // 0 结果引导：3 个相邻词，不铺大卡片，只做一行小按钮。
      '.ms-sug{margin-top:12px;display:flex;flex-wrap:wrap;align-items:center;gap:4px}',
      '.ms-sugLabel{font-size:12px;color:var(--text-3)}',
      '.ms-sugBtn{border:0;border-radius:2px;padding:4px 8px;margin:0;font:inherit;font-size:12px;',
      '  line-height:18px;color:var(--text-2);background:var(--card);cursor:pointer;outline:none;',
      '  box-shadow:0 0 0 1px var(--line)}',
      '.ms-sugBtn:hover{color:var(--text);background:var(--well);box-shadow:0 0 0 1px var(--accent)}',
      '.ms-sugBtn:focus-visible{box-shadow:0 0 0 1px var(--accent)}',

      /* 条目正文：行宽 760、15px/1.9，长文才读得下去 */
      '.ms-reader{max-width:760px;padding:0 0 24px}',
      '.ms-back{align-self:flex-start;border:0;background:transparent;margin:0 0 16px;padding:4px 0;font:inherit;font-size:12px;',
      '  line-height:20px;color:var(--text-3);cursor:pointer;outline:none;text-align:left;border-radius:2px}',
      '.ms-back:hover{color:var(--text)}',
      '.ms-back:focus-visible{box-shadow:inset 0 0 0 1px var(--accent)}',
      '.ms-crumb{font-size:12px;line-height:18px;color:var(--text-3);margin:0 0 12px}',
      '.ms-crumbSep{margin:0 8px;color:var(--text-4)}',
      '.ms-readerTitle{margin:0;font-size:22px;line-height:1.45;font-weight:600;letter-spacing:-.01em;color:var(--text)}',
      '.ms-readerClaim{margin-top:16px;font-size:16px;line-height:1.85;color:var(--text)}',
      '.ms-readerBody{margin-top:24px;font-size:16px;line-height:1.9;color:var(--text-2);white-space:pre-wrap}',
      '.ms-readerNote{margin-top:16px;font-size:12px;line-height:18px;color:var(--text-3)}',
      '.ms-readerMeta{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:24px;padding-top:16px;',
      '  box-shadow:inset 0 1px 0 0 var(--line-soft);font-size:12px;line-height:18px;color:var(--text-3)}',
      '.ms-fold{margin-top:24px;border-top:1px solid var(--line-soft)}',
      '.ms-fold > summary{list-style:none;cursor:pointer;padding:12px 0 12px;font-size:12px;line-height:18px;',
      '  color:var(--text-2);outline:none;user-select:none}',
      '.ms-fold > summary::-webkit-details-marker{display:none}',
      '.ms-fold > summary::before{content:"▸ ";font-size:11px;color:var(--text-4)}',
      '.ms-fold[open] > summary::before{content:"▾ "}',
      '.ms-fold > summary:hover{color:var(--text)}',
      '.ms-kv{display:grid;grid-template-columns:96px minmax(0,1fr);gap:4px 16px;font-size:12px;',
      '  line-height:19px;padding:0 0 16px}',
      '.ms-kvKey{color:var(--text-3)}',
      '.ms-kvVal{color:var(--text-2);word-break:break-all;font-family:var(--font-mono)}',
      '.ms-kvText{color:var(--text-2);word-break:break-word;font-family:inherit}',
      '.ms-tagRow{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}',
      '.ms-tag{font-size:12px;line-height:18px;padding:0 8px;border-radius:2px;background:var(--well);color:var(--text-2)}',

      /* 条目操作：复制 / 编辑。放在元信息下、正文上 —— 读完标题就能用，
         不用先滚到页尾找按钮。窄屏自动换行，两枚按钮不会互相挤压。 */
      '.ms-readerActions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:16px}',
      '.ms-rBtn{border:0;border-radius:2px;padding:4px 12px;margin:0;font:inherit;font-size:12px;',
      '  line-height:18px;color:var(--text-2);background:var(--card);cursor:pointer;outline:none;',
      '  box-shadow:0 0 0 1px var(--line);white-space:nowrap}',
      '.ms-rBtn:hover:not([disabled]){color:var(--text);background:var(--well);box-shadow:0 0 0 1px var(--accent)}',
      '.ms-rBtn:focus-visible{box-shadow:0 0 0 1px var(--accent)}',
      '.ms-rBtn[disabled]{color:var(--text-4);cursor:not-allowed;opacity:.65}',
      '.ms-rBtn[data-tone="primary"]{background:var(--accent);color:var(--bg);box-shadow:none;font-weight:600}',
      '.ms-rBtn[data-tone="primary"]:hover:not([disabled]){background:var(--accent);filter:brightness(.94);box-shadow:none}',
      // 保存/复制反馈固定贴在面板右下角：表单很长时，顶部提示会被滚出视野。
      '.ms-toast{position:fixed;right:24px;bottom:24px;z-index:20;max-width:min(360px,calc(100vw - 48px));',
      '  padding:8px 12px;font-size:12px;line-height:18px;color:var(--text);background:var(--card);',
      '  box-shadow:0 0 0 1px var(--line),var(--elevation);border-left:2px solid var(--t-green)}',
      '.ms-toast[data-tone="err"]{border-left-color:var(--t-red)}',

      /* 内联编辑：三块输入复用同一骨架，正文给大一点的高度但不做富文本。 */
      '.ms-edit{margin-top:16px;background:var(--panel);box-shadow:0 0 0 1px var(--line);padding:12px 16px 12px}',
      '.ms-editLabel{display:block;margin:0 0 4px;font-size:12px;line-height:16px;letter-spacing:.04em;color:var(--text-2);font-weight:600}',
      '.ms-editInput,.ms-editArea{display:block;width:100%;box-sizing:border-box;background:var(--card);',
      '  color:var(--text);border:0;border-radius:2px;padding:8px 8px;font:inherit;font-size:13px;',
      '  line-height:19px;box-shadow:0 0 0 1px var(--line);outline:none}',
      '.ms-editInput:focus,.ms-editArea:focus{box-shadow:0 0 0 1px var(--accent)}',
      '.ms-editArea{min-height:150px;line-height:1.85;resize:vertical;white-space:pre-wrap}',
      '.ms-editRow{margin-top:12px}',
      '.ms-editActions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}',
      '.ms-editErr{font-size:12px;line-height:18px;color:var(--t-red);margin:0 0 12px;padding:8px 12px;',
      '  background:rgba(224,112,90,.10);box-shadow:inset 2px 0 0 0 var(--t-red)}',
      'body[data-ds-dark-theme] .ms-editErr{background:rgba(224,112,90,.16)}',
      '.ms-editInput[data-invalid="true"],.ms-editArea[data-invalid="true"]{box-shadow:0 0 0 1px var(--t-red)}',
      '.ms-editHint{font-size:12px;line-height:16px;color:var(--text-4);margin-top:8px}',

      /* 首页 · 最近更新：沿用结果行的克制排版，只少一个命中片段。 */
      '.ms-upd{display:flex;flex-direction:column;background:var(--panel);box-shadow:0 0 0 1px var(--line)}',
      '.ms-updRow{display:block;width:100%;box-sizing:border-box;text-align:left;background:transparent;',
      '  border:0;margin:0;padding:12px 12px 12px;cursor:pointer;outline:none;font:inherit;',
      '  box-shadow:inset 0 -1px 0 0 var(--line)}',
      '.ms-updRow:last-child{box-shadow:none}',
      '.ms-updRow:hover{background:var(--well)}',
      '.ms-updRow:focus-visible{box-shadow:inset 0 0 0 1px var(--accent)}',
      '.ms-updTop{display:flex;align-items:baseline;gap:8px;min-width:0}',
      '.ms-updTitle{flex:1;min-width:0;font-size:13px;line-height:19px;font-weight:600;color:var(--text);',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ms-updClaim{margin-top:4px;font-size:12px;line-height:17px;color:var(--text-2);',
      '  overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}',
      '.ms-updPath{margin-top:4px;font-size:11px;line-height:15px;color:var(--text-4)}',
      '.ms-updNone{padding:12px 12px;font-size:12px;line-height:16px;color:var(--text-3)}',
      '.ms-updEmpty{padding:12px;display:flex;flex-direction:column;gap:4px}',
      '.ms-updEmptyTitle{font-size:13px;line-height:19px;font-weight:600;color:var(--text)}',
      '.ms-updEmptyText{font-size:12px;line-height:17px;color:var(--text-3)}',
      '.ms-updEmptyActions{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}',

      /* 时间线：按天分组，日期当组标题；条目仍是"标题 + claim + 册/章"。 */
      '.ms-tl{display:flex;flex-direction:column;gap:24px;max-width:860px}',
      '.ms-tlDay{display:flex;flex-direction:column}',
      // 日期拆成「相对日 / 具体日 + 星期」两级：今天、昨天优先，具体日期仍可读。
      '.ms-tlDate{display:flex;align-items:baseline;gap:8px;margin:0 0 8px;min-width:0}',
      '.ms-tlDayLabel{font-size:12px;line-height:16px;letter-spacing:.03em;font-weight:600;',
      '  color:var(--text-2);white-space:nowrap}',
      '.ms-tlDaySub{font-size:12px;line-height:15px;letter-spacing:.04em;color:var(--text-4);',
      '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ms-tlCount{margin-left:auto;font-size:11px;color:var(--text-4);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.ms-tlList{background:var(--panel);box-shadow:0 0 0 1px var(--line)}',
      '.ms-tlRowSkel{opacity:.55}',
      '.ms-tlSkelTag{font-size:11px;margin-left:8px;color:var(--text-4)}',
      '.ms-tlRow{display:block;width:100%;box-sizing:border-box;text-align:left;background:transparent;',
      '  border:0;margin:0;padding:12px 12px 12px;cursor:pointer;outline:none;font:inherit;',
      '  box-shadow:inset 0 -1px 0 0 var(--line)}',
      '.ms-tlRow:last-child{box-shadow:none}',
      '.ms-tlRow:hover{background:var(--well)}',
      '.ms-tlRow:focus-visible{box-shadow:inset 0 0 0 1px var(--accent)}',
      '.ms-tlTitle{font-size:13px;line-height:19px;color:var(--text);overflow:hidden;',
      '  text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.ms-tlClaim{margin-top:4px;font-size:12px;line-height:17px;color:var(--text-2);',
      '  overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.ms-tlPath{margin-top:4px;font-size:11px;line-height:15px;color:var(--text-4)}',
      // 窄屏保护：搜索条与筛选器是横向的，最多换行、不溢出；
      // 时间线日期和条目行缩一点，标题仍保留两行，不塌成一列小字。
      '@media (max-width:760px){',
      '  .ms-searchbar{padding:0 12px 12px}',
      '  .ms-filter{max-width:100%;flex:1 1 auto;min-width:96px}',
      '  .ms-readerActions{gap:4px}',
      '  .ms-edit{padding:12px 12px 12px}',
      '  .ms-tlRow,.ms-updRow{padding:8px 12px 12px}',
      '  .ms-tlDayLabel{font-size:12px}',
      '  .ms-toast{right:12px;bottom:12px;max-width:calc(100vw - 24px)}',
      '}',
      // 手机宽度下筛选器三列横排放不下：两列网格，第三个下拉占满整行。
      '@media (max-width:520px){',
      '  .ms-filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
      '  .ms-filter{width:100%;max-width:none;min-width:0}',
      '  .ms-filter:nth-of-type(3){grid-column:1/-1}',
      '  .ms-filterReset{grid-column:1/-1;justify-self:start}',
      '}',

      /* 分册网格 */
      '.ms-vols{display:grid;grid-template-columns:repeat(auto-fill,minmax(212px,1fr));gap:8px}',
      '.ms-vol{background:var(--card);box-shadow:0 0 0 1px var(--line);padding:12px 12px 12px;cursor:pointer;outline:none;min-width:0}',
      '.ms-vol:hover{background:var(--well)}',
      '.ms-vol:focus-visible{box-shadow:0 0 0 1px var(--accent)}',
      '.ms-volName{font-size:12px;line-height:17px;color:var(--text);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.ms-volMeta{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11px;color:var(--text-3);font-variant-numeric:tabular-nums}',
      '.ms-volKind{font-size:11px;line-height:15px;margin-top:4px;color:var(--text-3);font-variant-numeric:tabular-nums}',
      '.ms-volDate{margin-left:auto;color:var(--text-3)}',

      /* 目录 */
      '.ms-volPick{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:16px}',
      '.ms-pick{background:var(--panel);border:0;border-radius:2px;padding:4px 8px;margin:0;font:inherit;font-size:12px;',
      '  line-height:18px;color:var(--text-2);cursor:pointer;outline:none;box-shadow:0 0 0 1px var(--line);',
      '  display:flex;flex-direction:column;align-items:flex-start;gap:2px;white-space:normal;text-align:left}',
      '.ms-pickKind{font-size:11px;line-height:15px;color:var(--text-3);font-variant-numeric:tabular-nums}',
      '.ms-pick:hover{color:var(--text);background:var(--well)}',
      '.ms-pick[data-on="true"]{color:var(--text);background:var(--card);box-shadow:0 0 0 1px var(--accent)}',
      '.ms-chaps{display:flex;flex-direction:column;gap:4px;background:var(--line);box-shadow:0 0 0 1px var(--line)}',
      '.ms-idx{margin:6px 0 2px;border-top:1px solid var(--line-soft)}',
      '.ms-idxSum{cursor:pointer;list-style:none;font-size:11px;line-height:26px;color:var(--text-3);user-select:none;outline:none}',
      '.ms-idxSum::-webkit-details-marker{display:none}',
      '.ms-idxSum::before{content:"▸ ";color:var(--text-4)}',
      '.ms-idx[open] > .ms-idxSum::before{content:"▾ "}',
      '.ms-idxBody{padding:2px 0 4px}',
      '.ms-chap{background:var(--panel)}',
      '.ms-chapRow{display:grid;grid-template-columns:26px minmax(0,1fr) auto;align-items:center;gap:12px;',
      '  padding:8px 12px;cursor:pointer;outline:none}',
      '.ms-chapRow:hover{background:var(--well)}',
      '.ms-chapRow:focus-visible{box-shadow:inset 0 0 0 1px var(--accent)}',
      '.ms-chapNo{font-size:11px;color:var(--text-3);font-variant-numeric:tabular-nums;letter-spacing:.02em}',
      '.ms-chapTitle{font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ms-chapCount{font-size:11px;color:var(--text-3);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.ms-entries{background:var(--card);box-shadow:inset 0 1px 0 0 var(--line),inset 0 -1px 0 0 var(--line)}',
      '.ms-entry{padding:8px 12px 12px 24px;box-shadow:inset 0 -1px 0 0 var(--line);outline:none}',
      '.ms-entry[role="button"]{cursor:pointer}',
      '.ms-entry[role="button"]:hover{background:var(--well)}',
      '.ms-entry:focus-visible{box-shadow:inset 0 0 0 1px var(--accent)}',
      '.ms-entry:last-child{box-shadow:none}',
      '.ms-entryTop{display:flex;align-items:baseline;gap:8px;min-width:0}',
      '.ms-entryTitle{font-size:12px;line-height:16px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ms-entryConf{margin-left:auto;flex:none;font-size:11px;line-height:16px}',
      '.ms-entryClaim{margin-top:4px;font-size:12px;line-height:16px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.ms-entryMeta{display:flex;align-items:center;gap:4px;margin-top:8px;flex-wrap:wrap;font-size:11px;line-height:14px;color:var(--text-4);font-variant-numeric:tabular-nums}',
      '.ms-entryEmpty{padding:8px 12px 12px 24px;font-size:12px;color:var(--text-3)}',

      /* 最近会话 */
      '.ms-sess{background:var(--panel);box-shadow:0 0 0 1px var(--line)}',
      '.ms-serow{display:grid;grid-template-columns:minmax(0,1fr) 132px 40px;align-items:center;gap:12px;',
      '  padding:8px 12px;font-size:12px;color:var(--text-2);box-shadow:inset 0 -1px 0 0 var(--line)}',
      '.ms-serow:last-child{box-shadow:none}',
      '.ms-seTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}',
      // 【2026-11-08 实测修复】长工作区名（如 review-dsh-manuscript-4dbc409abece，35 字符）
      // 在 84px 列里被 nowrap 撑出边界、压到右侧的轮次/得分列上（浏览器实测截图）。
      // grid 列宽是固定的，所以这里必须自己截断。
      '.ms-seNum{color:var(--text-3);font-size:11px;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ms-seScore{font-size:12px;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}',
      '.ms-seNone{padding:8px 12px;font-size:12px;color:var(--text-3)}',

      /* ── 提炼区块 ──────────────────────────────────────────────
         三层密度：① 一行状态（92% 只看这个）② 只列需人看 ③ 折叠明细。
         刻意保持扁平方角，与分册/章列表同一套骨架。 */
      '.ms-distill{background:var(--panel);box-shadow:0 0 0 1px var(--line)}',

      /* 第 1 层：状态行 */
      '.ms-dRow{display:flex;align-items:center;gap:12px;padding:8px 12px;min-height:34px;box-sizing:border-box}',
      '.ms-dTag{flex:none;font-size:11px;line-height:14px;letter-spacing:.06em;color:var(--text-3)}',
      '.ms-dText{flex:1;min-width:0;font-size:12px;line-height:17px;color:var(--text);',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ms-dText[data-dim="true"]{color:var(--text-2)}',
      '.ms-dBtn{flex:none;background:var(--card);border:0;border-radius:2px;padding:4px 12px;margin:0;',
      '  font:inherit;font-size:12px;line-height:18px;color:var(--text);cursor:pointer;outline:none;',
      '  box-shadow:0 0 0 1px var(--line);white-space:nowrap}',
      '.ms-dBtn:hover:not([disabled]){background:var(--well);box-shadow:0 0 0 1px var(--accent)}',
      '.ms-dBtn:focus-visible{box-shadow:0 0 0 1px var(--accent)}',
      '.ms-dBtn[disabled]{color:var(--text-4);cursor:not-allowed;opacity:.65}',
      '.ms-dBtn[data-tone="primary"]{background:var(--accent);color:var(--bg);box-shadow:none;font-weight:600}',
      '.ms-dBtn[data-tone="primary"]:hover:not([disabled]){background:var(--accent);filter:brightness(.94);box-shadow:none}',
      '.ms-dBtn[data-tone="danger"]{color:var(--text-2);background:transparent;box-shadow:0 0 0 1px var(--line)}',
      '.ms-dBtn[data-tone="danger"]:hover:not([disabled]){color:var(--t-red);background:rgba(224,112,90,.10);box-shadow:0 0 0 1px var(--t-red)}',
      '.ms-dBtn[data-tone="dangerConfirm"]{color:var(--t-red);background:transparent;box-shadow:inset 0 0 0 1px var(--t-red);font-weight:600}',
      '.ms-dBtn[data-tone="dangerConfirm"]:hover:not([disabled]){background:rgba(224,112,90,.12)}',
      '.ms-dConfirmInline{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;',
      '  padding:8px 12px;background:var(--well);box-shadow:inset 2px 0 0 0 var(--t-red)}',
      '.ms-dConfirmText{font-size:12px;line-height:18px;color:var(--text-2);margin-right:auto}',
      // 模型下拉：宽度自适应，禁用时降透明度，与按钮同一视觉层级
      '.ms-dSel{flex:none;max-width:180px;background:var(--card);color:var(--text);border:0;border-radius:2px;padding:4px 8px;font-size:12px;font-family:inherit;box-shadow:0 0 0 1px var(--line);cursor:pointer}',
      '.ms-dSel:hover:not([disabled]){background:var(--well)}',
      '.ms-dSel:focus-visible{box-shadow:0 0 0 1px var(--accent);outline:none}',
      '.ms-dSel[disabled]{color:var(--text-4);cursor:not-allowed;opacity:.65}',

      /* ── 巡检设置（2026-11-12）─────────────────────────────────
         与提炼区共用骨架（扁平方角、行内控件）。时间用原生 <input type=time>：
         不引日期库，键盘可输入、浏览器自带校时器；非法值根本提交不出来。
         颜色全部走 --ms-* 中间层，主题切换时不会变成一块突兀的深色。 */
      '.ms-check{background:var(--panel);box-shadow:0 0 0 1px var(--line)}',
      '.ms-cRow{display:flex;align-items:center;gap:12px;padding:8px 12px;',
      '  box-shadow:inset 0 1px 0 0 var(--line-soft)}',
      '.ms-cToggle{display:flex;align-items:center;gap:8px;flex:none;font-size:12px;line-height:18px;',
      '  color:var(--text);cursor:pointer;user-select:none}',
      '.ms-cToggle input{width:13px;height:13px;margin:0;accent-color:var(--accent);cursor:pointer}',
      '.ms-cToggle input[disabled]{cursor:not-allowed}',
      '.ms-cTime{flex:none;width:88px;background:var(--card);color:var(--text);border:0;border-radius:2px;',
      '  padding:4px 8px;font:inherit;font-size:12px;font-family:var(--font-mono);',
      '  box-shadow:0 0 0 1px var(--line);color-scheme:dark}',
      '.ms-cTime:hover:not([disabled]){background:var(--well)}',
      '.ms-cTime:focus-visible{box-shadow:0 0 0 1px var(--accent);outline:none}',
      '.ms-cTime[disabled]{color:var(--text-4);cursor:not-allowed;opacity:.65}',
      '.ms-cSpacer{flex:1}',
      '.ms-cNote{padding:8px 12px 8px;font-size:12px;line-height:15px;color:var(--text-3)}',
      '.ms-cNote[data-tone="ok"]{color:var(--t-green)}',
      '.ms-cNote[data-tone="err"]{color:var(--t-red)}',
      '.ms-cWarn{padding:8px 12px 8px;font-size:12px;line-height:15px;color:var(--t-orange)}',
      /* 库路径输入：复用巡检区的行骨架，路径要能一眼看全，所以给 flex:1 */
      '.ms-cInput{flex:1;min-width:0;background:var(--card);color:var(--text);border:0;border-radius:2px;',
      '  padding:4px 8px;font:inherit;font-size:12px;font-family:var(--font-mono);',
      '  box-shadow:0 0 0 1px var(--line)}',
      '.ms-cInput:hover:not([disabled]){background:var(--well)}',
      '.ms-cInput:focus-visible{box-shadow:0 0 0 1px var(--accent);outline:none}',
      '.ms-cInput[disabled]{color:var(--text-4);cursor:not-allowed;opacity:.65}',

      /* 进行中：细进度条，避免"以为卡死" */
      '.ms-dBar{height:2px;background:var(--well);overflow:hidden}',
      '.ms-dBarFill{height:2px;background:var(--accent);transition:width .4s ease}',
      '.ms-dBusy{display:flex;align-items:center;gap:8px;padding:0 12px 8px;font-size:12px;color:var(--text-3)}',
      '.ms-dDot{width:5px;height:5px;border-radius:50%;background:var(--accent);flex:none}',

      /* 第 2 层：需人看 */
      '.ms-dHuman{border-top:1px solid var(--line);padding:12px 12px 12px}',
      '.ms-dHumanHead{font-size:11px;line-height:14px;letter-spacing:.06em;color:var(--t-orange);margin-bottom:8px}',
      '.ms-dItem{padding:8px 0;box-shadow:inset 0 -1px 0 0 var(--line-soft)}',
      '.ms-dItem:last-child{box-shadow:none;padding-bottom:0}',
      '.ms-dItemTitle{font-size:12px;line-height:16px;color:var(--text);overflow:hidden;',
      '  text-overflow:ellipsis;white-space:nowrap}',
      '.ms-dItemWhy{margin-top:4px;font-size:12px;line-height:15px;color:var(--text-2);',
      '  overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.ms-dItemActions{display:flex;gap:8px;margin-top:8px}',
      '.ms-dNone{padding:8px 12px;font-size:12px;color:var(--text-3);border-top:1px solid var(--line)}',

      /* 第 3 层：折叠明细 */
      '.ms-dMore{border-top:1px solid var(--line)}',
      '.ms-dSum{padding:8px 12px;font-size:12px;line-height:15px;color:var(--text-3);cursor:pointer;',
      '  outline:none;user-select:none;list-style:none;display:block}',
      '.ms-dSum::-webkit-details-marker{display:none}',
      '.ms-dSum:hover{color:var(--text-2)}',
      '.ms-dSum::before{content:"▸ ";font-size:11px;color:var(--text-4)}',
      '.ms-dMore[open] > .ms-dSum::before{content:"▾ "}',
      '.ms-dList{padding:0 12px 12px;max-height:260px;overflow:auto}',
      '.ms-dLine{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:baseline;',
      '  padding:4px 0;font-size:12px;line-height:15px;color:var(--text-2)}',
      '.ms-dLineTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ms-dLineWhy{color:var(--text-3);white-space:nowrap;font-size:11px}',
      '.ms-dSpot{color:var(--t-orange);font-size:11px;white-space:nowrap}',
      '.ms-dErr{padding:8px 12px;font-size:12px;line-height:16px;color:var(--t-red);',
      '  border-top:1px solid var(--line)}',

      /* ── 提炼二次确认区（D-03，2026-11-06）─────────────────────────
         为什么不是一个弹窗：window.confirm 无法排版、无法写测试、
         还会在 Electron / 某些宿主里被拦截成静默 no-op。
         做法：就地展开一块区域，代价数字用表格排，确认与取消两个按钮并排。
         视觉上用告警色左描边 —— 这一区是"花钱前的最后一道门"。 */
      '.ms-dConfirm{border-top:1px solid var(--line);padding:12px 12px 12px;background:var(--card);',
      '  box-shadow:inset 2px 0 0 0 var(--t-orange)}',
      '.ms-dConfHead{font-size:11px;line-height:14px;letter-spacing:.06em;color:var(--t-orange);margin-bottom:8px}',
      '.ms-dConfGrid{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;',
      '  font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}',
      '.ms-dConfKey{color:var(--text-3);white-space:nowrap}',
      '.ms-dConfVal{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ms-dConfWarn{margin-top:8px;font-size:12px;line-height:16px;color:var(--text-2)}',
      '.ms-dConfActions{display:flex;gap:8px;margin-top:8px}',

      /* 本轮将提炼的会话清单（2026-11-05）
         回答用户"这一轮到底在提炼哪几段对话"。行结构与 .ms-dLine 同族，
         但多一个分数列，且默认只露前 5 行 —— 20 行会把面板撑爆。 */
      '.ms-wd{border-top:1px solid var(--line)}',
      '.ms-wdHead{padding:8px 12px 8px;font-size:11px;line-height:14px;letter-spacing:.06em;',
      '  color:var(--text-3)}',
      '.ms-wdList{padding:0 0 4px}',
      '.ms-wdRow{display:grid;grid-template-columns:minmax(0,1fr) auto auto 34px;align-items:center;',
      '  gap:8px;padding:4px 12px;font-size:12px;line-height:16px;color:var(--text-2)}',
      '.ms-wdRow:hover{background:var(--well)}',
      '.ms-wdTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}',
      '.ms-wdTag{font-size:11px;line-height:14px;color:var(--text-3);white-space:nowrap}',
      '.ms-wdScore{font-size:11px;line-height:14px;text-align:right;',
      '  font-variant-numeric:tabular-nums;white-space:nowrap}',
      /* 漏斗每段的"分母"标签 —— 四段分母本来就不一样，必须写出来 */
      '.ms-fnBase{margin-top:4px;font-size:11px;line-height:13px;color:var(--text-3);',
      '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',

      /* ── 工具架 ──────────────────────────────────────────────
         与分册网格同一套骨架（扁平方角），但语义不同：
         分册讲"记过什么"，工具架讲"本机有什么能力、开没开、占多少"。 */
      '.ms-tshelf{display:flex;flex-direction:column;gap:8px}',
      '.ms-tpack{background:var(--card);box-shadow:0 0 0 1px var(--line);padding:12px 12px 12px}',
      '.ms-tpack[data-muted="true"]{background:var(--panel);box-shadow:0 0 0 1px var(--line)}',
      '.ms-tpackTop{display:flex;align-items:baseline;gap:8px;min-width:0}',
      '.ms-tpackName{font-size:12px;line-height:17px;color:var(--text);overflow:hidden;',
      '  text-overflow:ellipsis;white-space:nowrap}',
      '.ms-tpackTop .ms-tchip{margin-left:auto;flex:none}',
      '.ms-tchip{font-size:11px;line-height:14px;padding:4px 8px;border-radius:2px;white-space:nowrap;',
      '  box-shadow:inset 0 0 0 1px var(--line);color:var(--text-3)}',
      '.ms-tchip[data-on="true"]{color:var(--t-green,#4c9a6a);box-shadow:inset 0 0 0 1px currentColor}',
      '.ms-tchip[data-off="true"]{color:var(--text-3)}',
      '.ms-tchip[data-static="true"]{color:var(--t-orange)}',
      '.ms-tpackDesc{margin-top:4px;font-size:12px;line-height:16px;color:var(--text-2);',
      '  overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.ms-tpackMeta{display:flex;align-items:center;gap:12px;margin-top:8px;font-size:11px;',
      '  color:var(--text-3);font-variant-numeric:tabular-nums;flex-wrap:wrap}',
      '.ms-tnames{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px}',
      '.ms-tname{font-size:11px;line-height:16px;padding:0 8px;border-radius:2px;',
      '  background:var(--well);color:var(--text-3);font-family:var(--font-mono,ui-monospace,monospace)}',
      '.ms-thelp{margin-top:8px;font-size:11px;line-height:16px;color:var(--text-3);',
      '  padding-top:8px;box-shadow:inset 0 1px 0 0 var(--line)}',
      '.ms-tsum{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin-bottom:12px}',
      '.ms-tsumCell{background:var(--panel);box-shadow:0 0 0 1px var(--line);padding:8px 12px}',
      '.ms-tsumNum{font-size:16px;line-height:22px;color:var(--text);font-variant-numeric:tabular-nums}',
      '.ms-tsumLbl{margin-top:4px;font-size:11px;color:var(--text-3)}',

      /* ── 窄屏（<=640px）──────────────────────────────────────────
         必须放在所有组件规则之后：同一选择器的覆盖靠源码顺序。
         之前放在骨架区，会被后面的 .ms-cardsecHead/.ms-dText 覆盖。 */
      '@media (max-width:640px){',
      '  .ms-top{flex-wrap:wrap;gap:4px 8px;padding:8px 12px}',
      '  .ms-title{display:none}',
      '  .ms-tabs{order:2;width:100%;padding-bottom:4px}',
      '  .ms-meta{display:none}',
      '  .ms-stale{order:1;margin-left:0}',
      '  .ms-body{padding:12px}',
      '  .ms-searchbar{padding:0 12px 8px}',
      '  .ms-cardsec{margin:0 0 12px}',
      '  .ms-cardsecHead{padding:12px 12px 8px}',
      '  .ms-cardsecHint{padding:8px 12px 0}',
      '  .ms-cardsecBody{padding:12px}',
      '  .ms-cardsecBody[data-flush="true"]{padding:0}',
      '  .ms-readerCard{max-width:none}',
      '  .ms-statline{flex-direction:column;gap:16px}',
      '  .ms-stat{flex:0 0 auto;width:100%}',
      '  .ms-heroTitle{font-size:22px}',
      '  .ms-dRow{flex-wrap:wrap;align-items:flex-start}',
      '  .ms-dRow .ms-dText{flex:1 1 100%;min-width:0;white-space:normal;',
      '    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '  .ms-dSel{flex:1 1 140px;max-width:100%}',
      '  .ms-dBtn{flex:none}',
      '  .ms-cRow{flex-wrap:wrap;align-items:flex-start}',
      '  .ms-cToggle{flex:1 1 100%}',
      '  .ms-cInput{flex:1 1 100%}',
      '  .ms-cSpacer{display:none}',
      '}'
    ].join("\n");

    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) return;
      const tag = document.createElement("style");
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── 纯函数工具 ──────────────────────────────────────────────────────────
    function num(value) {
      const parsed = typeof value === "number" ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function fmtNum(value) {
      const parsed = num(value);
      try {
        return parsed.toLocaleString("en-US");
      } catch (error) {
        return String(parsed);
      }
    }

    /** 字符数 → 人读（93808 → 94k）。状态行要短，不能堆 6 位数字。 */
    function fmtCharK(value) {
      const parsed = num(value);
      if (parsed >= 10000) return Math.round(parsed / 1000) + "k";
      if (parsed >= 1000) return (parsed / 1000).toFixed(1) + "k";
      return String(parsed);
    }

    /**
     * 把后端给的本地 ISO（如 2026-11-13T07:00:00+08:00）折成「11-13 07:00」。
     *
     * 【为什么解析失败要原样返回】编一个"明天 07:00"比显示原始串更糟：
     * 前者是猜测、后者至少能让人自己看出来。后端 nextRun 为 null 时调用方
     * 根本不该走到这里（"没有下一次"和"解析不出来"是两件事）。
     */
    function fmtNextRun(iso) {
      const text = String(iso || "");
      if (!text) return "";
      const d = new Date(text);
      if (Number.isNaN(d.getTime())) return text;
      const p = (n) => String(n).padStart(2, "0");
      return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    function ratioOf(part, whole) {
      const total = num(whole);
      if (total <= 0) return 0;
      const ratio = num(part) / total;
      if (!Number.isFinite(ratio) || ratio < 0) return 0;
      return ratio > 1 ? 1 : ratio;
    }

    function chapterCount(volume) {
      if (!volume) return 0;
      if (volume.chapterCount != null) return num(volume.chapterCount);
      const value = volume.chapters;
      return Array.isArray(value) ? value.length : num(value);
    }

    function entryCount(volume) {
      const value = volume && volume.entries;
      return Array.isArray(value) ? value.length : num(value);
    }

    /** 可选数字：拿不到就返回 null（不是 0）。null 表示"不知道"，0 表示"确实是零"。 */
    function optNum(value) {
      if (value == null) return null;
      const parsed = typeof value === "number" ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    /**
     * 单册口径文案：真结论 N 条 · 索引骨架 M 条（仅统计，不含结论）。
     *
     * N/M 为 0 也照写 —— 0 是「确知这一册没有」，不是「没实现」；
     * 字段取不到（null）时整段省略，绝不拿 0 顶替。
     */
    function volumeKindText(volume) {
      const conclusions = optNum(volume && volume.conclusionEntries);
      const skeletons = optNum(volume && volume.skeletonEntries);
      const bits = [];
      if (conclusions != null) bits.push("真结论 " + fmtNum(conclusions) + " 条");
      if (skeletons != null) bits.push("索引骨架 " + fmtNum(skeletons) + " 条（仅统计，不含结论）");
      return bits.join(" · ");
    }

    // 【2026-11-05 修】"已提炼"原本取不到 summary.distilled 就退回 summary.entries
    // （= 已提炼**条目数** 389），而漏斗分母是**会话数** 278 ——
    // 于是面板出现「全部 278 / 已提炼 389」这种不可能画面；再叠加 ratioOf
    // 把 >1 的比例夹到 1，进度条照样画满，肉眼完全看不出矛盾。
    //
    // 根因是量纲混用：条目 ≠ 会话。两个量纲不能互相兜底。
    // 现在只认 distilledSessions（会话数）；取不到就返回 null，UI 渲染 "--"。
    function distilledOf(summary) {
      return optNum(summary && summary.distilledSessions);
    }

    // 【2026-11-05 复核后保留原样】"已入册"是**条目量纲**，不是会话量纲。
    //
    // 我一度把它改成 stages.counts.distilled + counts["in-book"]，被驳回 ——
    // 那两项的语义是"有条目覆盖的会话"，加起来约等于全部真实任务，
    // 会得出"218/218 已入册 100%"，是一句假话。
    //
    // 这个函数累加各册 entries（library.js:591 的可见条目数），回答的是
    // "书库里现在有多少条能翻的东西" —— 册子里装的就是条目，条目量纲本来就对。
    // 量纲不同的两段（已提炼=会话 / 已入册=条目）靠**标签写明单位 + 各自分母**区分。
    //
    // 唯一的加强：字段缺失时返回 null（→ 渲染 "--"），不返回 0。
    // 原来无脑返回 0，会把"后端没给 volumes"说成"一条都没入册"。
    function inBooksOf(summary) {
      if (summary && summary.inBooks != null) return optNum(summary.inBooks);
      const volumes = summary && Array.isArray(summary.volumes) ? summary.volumes : null;
      if (!volumes || volumes.length === 0) return null;
      let sum = 0;
      for (const volume of volumes) sum += entryCount(volume);
      return sum;
    }

    // 数值可能未知 → 统一渲染成 "--"。绝不能渲染成 0：
    // 0 在这里是"确实一个都没提炼"，和"后端还没给这个字段"是两件事。
    function fmtOrDash(value) {
      const parsed = optNum(value);
      return parsed == null ? "--" : fmtNum(parsed);
    }

    // ISO 时间 → "2026-11-09"。解析失败时原样返回（不编日期）。
    function fmtDate(value) {
      if (value == null || value === "") return "";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return String(value);
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return d.getFullYear() + "-" + m + "-" + day;
    }

    // ── 搜索高亮 / 时间线 的纯函数（2026-11-12 P0/P2）────────────────────
    //
    // 高亮只在**文本片段**上做，绝不拼 innerHTML：条目里常有 `<`、`&`、
    // 反引号片段，拼 HTML 会把正文吃成标签。这里 split 后由 React 渲染
    // <mark>，转义交给 React。
    function escapeRegExp(text) {
      return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    /** 查询词切成高亮用的词元：空白/常见中英标点都是分隔符。 */
    function searchTerms(query) {
      const raw = String(query || "").trim();
      if (!raw) return [];
      const seen = new Set();
      const out = [];
      const push = (word) => {
        const text = String(word || "").trim();
        if (!text) return;
        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(text);
      };

      // 整句优先；服务端 matchSnippetsFor 也会把整句当候选。
      if (raw.length >= 2 && raw.length <= 80) push(raw);
      for (const word of raw.match(/[A-Za-z][A-Za-z0-9_+#.-]{1,}/g) || []) push(word);
      for (const word of raw.match(/\d+(?:\.\d+)?/g) || []) {
        if (word.length >= 2) push(word);
      }
      // 中文按 bigram 切，与服务端 queryHighlightTerms 同一口径：
      // 长句整句在片段里可能被省略号截断，只高亮整句会一个 <mark> 都不出现。
      const cjk = raw.replace(/[^\u4e00-\u9fa5]/g, "");
      for (let i = 0; i + 2 <= cjk.length; i += 1) push(cjk.slice(i, i + 2));

      // 长词优先，避免 "web" 抢在 "web_fetch" 前把后者拆碎。
      out.sort((a, b) => b.length - a.length);
      return out;
    }

    /** 把命中词包成 <mark>；没有命中就原样返回字符串（零额外节点）。 */
    function highlightText(text, terms) {
      const source = text == null ? "" : String(text);
      if (!source) return source;
      const words = (Array.isArray(terms) ? terms : []).filter((word) => String(word || "").trim().length > 0);
      if (words.length === 0) return source;
      const pattern = new RegExp("(" + words.map(escapeRegExp).join("|") + ")", "gi");
      const parts = source.split(pattern);
      if (parts.length <= 1) return source;
      // split 带捕获组时，奇数下标一定是命中项。
      return parts.map((part, index) =>
        index % 2 === 1
          ? jsx("mark", { className: "ms-mark", children: part }, "hl-" + index)
          : part
      );
    }

    /** 服务端 suggestions 既可能是字符串，也可能是 {title|q|text|word}。 */
    function normalizeSuggestions(raw, limit) {
      const list = Array.isArray(raw) ? raw : [];
      const max = limit || 3;
      const out = [];
      const seen = new Set();
      for (const item of list) {
        const text = typeof item === "string"
          ? item
          : item && (item.title || item.q || item.text || item.word);
        const value = String(text == null ? "" : text).trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
        if (out.length >= max) break;
      }
      return out;
    }

    /**
     * 0 结果时的本地兜底词：从同册条目标题里抽英文标识符/短中文段，
     * 不够再拿章名顶上。它只是"让人有个下一步"，不冒充服务端建议。
     */
    function suggestionTerms(volumes, volumeId, limit) {
      const max = limit || 3;
      const list = Array.isArray(volumes) ? volumes : [];
      const out = [];
      const seen = new Set();
      const push = (raw) => {
        const value = String(raw == null ? "" : raw).trim();
        if (value.length < 2 || value.length > 16 || seen.has(value)) return;
        seen.add(value);
        out.push(value);
      };
      const scoped = list.filter((volume) => volume && (!volumeId || String(volume.id) === String(volumeId)));
      for (const volume of scoped) {
        const chapters = Array.isArray(volume.chapters) ? volume.chapters : [];
        for (const chapter of chapters) {
          const entries = chapter && Array.isArray(chapter.entries) ? chapter.entries : [];
          for (const entry of entries) {
            const title = entry && entry.title ? String(entry.title) : "";
            const ascii = title.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g);
            if (ascii) for (const token of ascii) push(token);
            const segments = title.split(/[\s,，。；;：:、/|（）()「」【】]+/);
            for (const segment of segments) {
              if (segment.length >= 3 && segment.length <= 12) push(segment);
              if (out.length >= max) return out;
            }
          }
        }
      }
      // 标题里抽不满，再用章名（同册时优先当前册的章）。
      for (const volume of scoped) {
        const chapters = Array.isArray(volume.chapters) ? volume.chapters : [];
        for (const chapter of chapters) {
          if (chapter && chapter.title) push(chapter.title);
          if (out.length >= max) return out;
        }
      }
      return out;
    }

    /**
     * 打灰条目判据（2026-11-17）。
     *
     * grayed 与 expired 是两种不同的「不在主视图」：
     *   · expired = 已有同会话真结论取代了这条骨架（有内容，只是旧）；
     *   · grayed  = 会话本身没有可提炼的结论（没内容）。
     * 服务端目录投影已剔除 grayed；这里再挡一层，防止旧快照/第三方数据源
     * 把灰条目带进目录与时间线（客户端是最后一道门）。
     */
    function isGrayedEntry(entry) {
      return !!(entry && (entry.status === "grayed" || entry.grayed === true));
    }

    /** 时间线/最近更新：把 days[] 拍平成 [{date, entries}]，并丢掉空天。 */
    function timelineDaysOf(data) {
      const days = data && Array.isArray(data.days) ? data.days : [];
      return days
        .map((day) => ({
          date: day && day.date ? String(day.date) : "",
          entries: (day && Array.isArray(day.entries) ? day.entries : []).filter((e) => !isGrayedEntry(e))
        }))
        .filter((day) => day.entries.length > 0);
    }

    function timelineEntryCount(days) {
      return (Array.isArray(days) ? days : []).reduce((sum, day) => sum + day.entries.length, 0);
    }

    /**
     * "2026-11-12" → { label:"11 月 12 日", sub:"周四" }。
     * 今天/昨天用相对日作主标签，具体日期与星期退到副标签 —— 两者都保留，
     * 避免时间线出现「今天 · 11 月 16 日 · 周一」这种三个词抢同一行。
     */
    function fmtDayParts(date) {
      const text = String(date || "").trim();
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
      if (!match) return { label: text || "日期未知", sub: "", title: text };
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const parsed = new Date(year, month - 1, day);
      if (Number.isNaN(parsed.getTime())) return { label: text, sub: "", title: text };
      const week = ["日", "一", "二", "三", "四", "五", "六"][parsed.getDay()];
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const target = new Date(year, month - 1, day);
      const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);
      const label = diffDays === 0
        ? "今天"
        : diffDays === 1
          ? "昨天"
          : (year === now.getFullYear() ? "" : year + " 年 ") + month + " 月 " + day + " 日";
      const sub = diffDays === 0 || diffDays === 1
        ? month + " 月 " + day + " 日 · 周" + week
        : "周" + week;
      return { label, sub, title: text };
    }

    /**
     * 「这份数字是几分钟前的快照」——D-05 前端修正（2026-11-06）。
     *
     * 【为什么必须有】/api/summary 读的是内存快照（SCAN_TTL_MS 内不重扫），
     * 实测与磁盘 library.json 差 1–3 个会话。原来界面把快照数字当实时数字展示，
     * 用户对不上账却无从判断"是我记错还是面板过期"。
     *
     * 返回空串表示"不显示"（不是"0 分钟前"）：
     *   · 后端没给 stale / stale !== true → 不显示。**不要**用 !stale 反推"新鲜"，
     *     字段缺失时我们根本不知道新不新，那就闭嘴。
     *   · 拿不到任何时间依据 → 不显示。编一个"0 分钟前"等于宣称"刚刚扫过"，
     *     那是本轮最不该犯的谎。
     *
     * 优先用 scanAgeMs（相对时长，不受客户端与服务端时钟差影响）；
     * 拿不到才回落到 scannedAt（绝对时间戳）现算。
     *
     * 分钟数下限取 1：50 秒的旧快照显示"1 分钟前"是往**更旧**的方向偏，
     * 方向上安全；显示"0 分钟前"则会让人以为是最新的，方向上危险。
     */
    function staleTextOf(summary) {
      const s = summary && typeof summary === "object" ? summary : null;
      if (!s) return "";
      if (s.stale !== true) return "";
      let ageMs = optNum(s.scanAgeMs);
      if (ageMs == null) {
        const scannedAt = optNum(s.scannedAt);
        // scannedAt 换算成毫秒：兼容秒级时间戳（10 位）与毫秒级（13 位）。
        if (scannedAt != null && scannedAt > 0) {
          const atMs = scannedAt < 1e12 ? scannedAt * 1000 : scannedAt;
          const delta = Date.now() - atMs;
          if (Number.isFinite(delta)) ageMs = delta;
        }
      }
      if (ageMs == null || !Number.isFinite(ageMs)) return "";
      const minutes = Math.max(1, Math.round(ageMs / 60000));
      return "数据 " + fmtNum(minutes) + " 分钟前";
    }

    /**
     * 汇总"提炼进度"三个数，供状态行使用（2026-11-05）。
     *
     * 数据来源有两条，优先级：/plan 新增字段 > /summary 现有字段。
     * 之所以两边都认：/plan 与 /summary 是两个独立请求，任一个先到都能显示出东西。
     *
     * 返回的每个字段都可能是 null —— 调用方用 fmtOrDash 渲染。
     *
     * 【2026-11-05 修正 · 删掉 remaining 的反推】
     * 我原先写了 `remaining = realTotal - distilled` 作为兜底，这是错的：
     *   · realTotal - distilled = "还没提炼的真实会话数"，**含根本提不了的**
     *   · 后端 remaining = stats.eligible - stats.queued = "真正合格、下一轮会被提的"
     * 两个口径数值明显不等。后果是 /plan 一旦缺字段，前端就悄悄算出一个偏大的数，
     * 用户看到的"剩余"和真实"还能提"对不上 —— 比不显示更糟。
     *
     * 原则（和修 distilledOf 同一条）：宁可少显示一个数，不显示口径不同的数。
     *
     * 【另】"已提炼会话数"只认 summary.distilledSessions（library.js:825 给的就是
     * stages.counts.distilled）。/plan 的 stats 是 pipeline.selectQueue 的产物
     * （pipeline.js:174：total/eligible/queued/skipped/maxSessions/...），
     * **里面没有 distilled 字段** —— 不要凭空去猜一个不存在的字段。
     */
    function distillProgressOf(plan, summary) {
      const p = plan && typeof plan === "object" ? plan : {};
      const s = summary && typeof summary === "object" ? summary : {};
      const distilled = optNum(s.distilledSessions);
      let realTotal = optNum(p.realTotal);
      if (realTotal == null) realTotal = optNum(s.real);
      // remaining 只认后端给的值，不反推 —— 反推出来的口径不同，会撒谎。
      const remaining = optNum(p.remaining);
      return { distilled, realTotal, remaining };
    }


    // 数字 slug（ch-01）→ "01"；非数字 slug（ch-宁谷微）→ 序号，别把 slug 当中文标题露出来。
    function chapterNo(chapter, index) {
      if (chapter && chapter.no != null) return String(chapter.no);
      const fallback = String(index + 1).padStart(2, "0");
      if (!chapter || chapter.slug == null) return fallback;
      const match = /(\d+)/.exec(String(chapter.slug));
      if (!match) return fallback;
      return match[1].length === 1 ? "0" + match[1] : match[1];
    }

    // host 侧 confidence 实测取值：high / medium / low / speculation
    function confidenceTone(value) {
      const text = value == null ? "" : String(value).trim().toLowerCase();
      if (text === "") return "var(--text-3)";
      const parsed = Number(text);
      if (text === "high" || text === "strong" || (Number.isFinite(parsed) && parsed >= 0.8)) return "var(--t-green)";
      if (text === "medium" || text === "mid" || (Number.isFinite(parsed) && parsed >= 0.5)) return "var(--t-orange)";
      if (text === "low" || text === "weak" || (Number.isFinite(parsed) && parsed < 0.5)) return "var(--t-red)";
      if (text === "speculation" || text === "guess") return "var(--text-3)";
      return "var(--t-orange)";
    }

    function confidenceLabel(value) {
      if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100) + "%";
      const text = value == null ? "" : String(value).trim();
      if (text === "") return "未标注";
      const parsed = Number(text);
      if (Number.isFinite(parsed)) return Math.round(parsed * 100) + "%";
      if (text.toLowerCase() === "speculation") return "推测";
      if (text.toLowerCase() === "medium") return "中";
      if (text.toLowerCase() === "high") return "高";
      if (text.toLowerCase() === "low") return "低";
      return text;
    }

    function scoreTone(value) {
      const parsed = num(value);
      if (parsed >= 80) return "var(--t-green)";
      if (parsed >= 60) return "var(--t-orange)";
      if (parsed > 0) return "var(--t-red)";
      return "var(--text-3)";
    }

    function ready(state) {
      return !!state && state.phase === "ready" && state.data != null;
    }

    // ── 数据读取（失败优雅降级，不抛错）─────────────────────────────────────
    // 同一 URL 在全页共享一次请求：侧栏卡片和主面板同时挂载也只发一次，
    // 卸载其中一个不会 cancel 掉另一个还在等的请求。成功后进 CACHE，切视图不闪。
    const CACHE = new Map();
    const INFLIGHT = new Map();
    const LISTENERS = new Map();

    // 【外部主动失效机制 2026-11-06】
    // 用户报的现象：「提炼一轮之后入册，界面还是显示 130/218」。
    // 根因不在后端 —— 入册后 requestJson 确实发出、后端也确实返回了新数据。
    // 坏在 useJson 的两个致命点：
    //   ① 首次挂载时若 CACHE 已有值 → 直接 `return`，**从不订阅** LISTENERS；
    //   ② effect 只依赖 [url]，而 url 是常量 → effect 永不重跑 → 永不重新订阅/取数。
    // 于是 publish() 写进 CACHE 却通知不到任何活着的组件，界面永远停在旧数字。
    // 修法：加一层「版本号 + 失效广播」。invalidate() 删缓存并 bump 版本号，
    // useJson 把版本号放进 effect 依赖 → effect 重跑 → 重新订阅 + 重新取数。
    // 这是通用修复：任何"已渲染之后的数据变化"（入册/提炼/重扫）都靠它。
    const REV = new Map();            // url -> revision（单调递增，只用于触发 effect 重跑）
    const REV_LISTENERS = new Map();  // url -> Set<() => void>（每个 useJson 实例的 bump）

    /**
     * 让某个（或某一组）URL 的缓存失效，并通知所有正在用它的 useJson 重新取数。
     *
     * @param {string} urlOrPrefix 完整 url，或前缀（配合 { prefix: true }）
     * @param {{ prefix?: boolean }} [opts]
     *
     * 前缀模式用于 API_VOLUME 这种「常量前缀 + 动态 id」的地址
     * （API_VOLUME = "/dsh-manuscript/api/volume/"，真实地址是 .../volume/vol-06）。
     * 入册会改变分册结构，但**不一定只有当前打开的那一册**变化 —— 按前缀全量失效
     * 比"记住当前 volumeId 只失效那一册"更稳，也覆盖"关掉当前册再打开另一册"。
     */
    function invalidate(urlOrPrefix, opts) {
      if (!urlOrPrefix) return;
      const prefix = !!(opts && opts.prefix);
      const targets = [];
      if (prefix) {
        for (const k of CACHE.keys()) if (k.startsWith(urlOrPrefix)) targets.push(k);
        for (const k of LISTENERS.keys()) if (k.startsWith(urlOrPrefix)) targets.push(k);
        for (const k of REV_LISTENERS.keys()) if (k.startsWith(urlOrPrefix)) targets.push(k);
        for (const k of REV.keys()) if (k.startsWith(urlOrPrefix)) targets.push(k);
      } else {
        targets.push(urlOrPrefix);
      }
      for (const u of new Set(targets)) {
        CACHE.delete(u);
        REV.set(u, (REV.get(u) || 0) + 1);
        const bucket = REV_LISTENERS.get(u);
        if (!bucket) continue;
        for (const fn of Array.from(bucket)) {
          try {
            fn();
          } catch (error) {
            // 单个订阅者失败不该阻断其他组件刷新
          }
        }
      }
    }

    function publish(url, state) {
      if (state.phase === "ready") CACHE.set(url, state.data);
      const bucket = LISTENERS.get(url);
      if (!bucket) return;
      for (const listener of Array.from(bucket)) listener(state);
    }

    function requestJson(url) {
      if (INFLIGHT.has(url)) return INFLIGHT.get(url);
      const pending = (async () => {
        const init = { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } };
        try {
          const response = await fetch(url, init);
          if (!response || !response.ok) {
            throw new Error("HTTP " + (response ? response.status : "no-response"));
          }
          const raw = await response.json();
          // host 侧统一包一层 { ok, ...payload }；ok:false 当失败处理，别把错误对象当数据画。
          if (raw && typeof raw === "object" && raw.ok === false) {
            throw new Error(String(raw.error || "接口返回 ok:false"));
          }
          const payload = raw;
          INFLIGHT.delete(url);
          publish(url, { phase: "ready", data: payload, error: null });
        } catch (error) {
          INFLIGHT.delete(url);
          const message = error && error.message ? error.message : String(error);
          publish(url, { phase: "error", data: null, error: message });
        }
      })();
      INFLIGHT.set(url, pending);
      return pending;
    }

    /**
     * POST 助手（2026-11-06 新增）。
     *
     * 【为什么单独一个函数而不是给 requestJson 加个 method 参数】
     * requestJson 是**共享缓存**的读路径：同 URL 只发一次、结果进 CACHE、publish 广播。
     * 这套机制对写操作全是坏事：
     *   · 写操作不能去重（两次入册合并成一次 = 少入一批）；
     *   · 写操作的结果不能当"某个 URL 的数据"缓存（下一次读会拿到写入回执）；
     *   · 写操作失败必须能被调用方 await 到，而不是走 publish → 状态机。
     * 所以写路径完全绕开 CACHE/INFLIGHT，错误语义仍与 requestJson 一致：
     * ok:false 或 HTTP 非 2xx 一律抛 Error，由调用方转成 error 态。
     *
     * 【守门头】x-dsh-manuscript: 1 —— 后端用它确认请求来自本插件前端。
     * 漏了这个头，后端会按"非本前端"拒绝，症状是点按钮毫无反应（且不报错）。
     *
     * @param {string} url
     * @param {object} [body] 会被 JSON.stringify
     * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
     * @returns {Promise<any>} 解析后的 JSON（已确认 ok !== false）
     */
    async function postJson(url, body, opts) {
      const options = opts || {};
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000;
      const init = {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          // 守门头必须在这里统一加：分散在各调用点迟早漏一个。
          [GUARD_HEADER]: GUARD_VALUE
        },
        body: JSON.stringify(body === undefined ? {} : body)
      };
      // AbortSignal.timeout 在旧环境可能不存在；测试沙箱里也是空实现。
      // 缺失时不设 signal，宁可没有超时也不要在这里抛 TypeError 把请求打成"失败"。
      const signal = options.signal
        || (typeof AbortSignal !== "undefined" && AbortSignal && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(timeoutMs)
          : undefined);
      if (signal) init.signal = signal;

      const response = await fetch(url, init);
      if (!response || !response.ok) {
        throw new Error("HTTP " + (response ? response.status : "no-response"));
      }
      const raw = await response.json();
      // 与 requestJson 同一条规矩：ok:false 当失败，别把错误对象当数据画。
      if (raw && typeof raw === "object" && raw.ok === false) {
        throw new Error(String(raw.error || "接口返回 ok:false"));
      }
      return raw;
    }

    function cachedState(url) {
      if (url && CACHE.has(url)) return { phase: "ready", data: CACHE.get(url), error: null };
      return { phase: url ? "loading" : "idle", data: null, error: null };
    }

    function useJson(url) {
      // rev 是本实例的本地代数：invalidate() 广播时 bump 一次，effect 因依赖变化重跑，
      // 于是「重新订阅 + 重新取数」都会发生。**effect 内绝不调用 setRev**，
      // 否则 effect → setRev → effect 自激死循环。
      const [rev, setRev] = react.useState(0);
      const [state, setState] = react.useState(() => cachedState(url));
      react.useEffect(() => {
        if (!url) {
          setState({ phase: "idle", data: null, error: null });
          return undefined;
        }
        // 【关键：缓存命中也要订阅】
        // 原来这里是 `if (CACHE.has(url)) { setState(...); return undefined; }` ——
        // 提前 return 意味着永远不进 LISTENERS 桶。之后任何 publish() 都通知不到
        // 这个组件，界面就永远停在首次渲染时的那份数据上（就是"入册后还是 130"）。
        // 订阅与"要不要发请求"是两件事，必须解耦。
        let bucket = LISTENERS.get(url);
        if (!bucket) {
          bucket = new Set();
          LISTENERS.set(url, bucket);
        }
        bucket.add(setState);

        const bump = () => setRev((n) => n + 1);
        let revBucket = REV_LISTENERS.get(url);
        if (!revBucket) {
          revBucket = new Set();
          REV_LISTENERS.set(url, revBucket);
        }
        revBucket.add(bump);

        if (CACHE.has(url)) {
          setState({ phase: "ready", data: CACHE.get(url), error: null });
          return () => {
            bucket.delete(setState);
            revBucket.delete(bump);
            if (bucket.size === 0) LISTENERS.delete(url);
            if (revBucket.size === 0) REV_LISTENERS.delete(url);
          };
        }

        // 缓存没有：请求。刷新（invalidate 后的重跑）时保留旧数据继续显示，
        // 避免数字先闪成 "--" 再跳回来。
        setState((prev) =>
          prev && prev.data != null
            ? { phase: prev.phase === "error" ? "loading" : prev.phase, data: prev.data, error: null }
            : { phase: "loading", data: null, error: null }
        );
        requestJson(url);
        return () => {
          bucket.delete(setState);
          revBucket.delete(bump);
          // 桶空了才删 —— 确保不会把别的组件还在用的桶删掉（删了那些组件就永久失联）
          if (bucket.size === 0) LISTENERS.delete(url);
          if (revBucket.size === 0) REV_LISTENERS.delete(url);
        };
      }, [url, rev]);
      return state;
    }

    // ── UI 组件工厂（闭包持有 ctx）──────────────────────────────────────────
    function createUi(ctx) {
      function openPanel() {
        try {
          if (ctx && ctx.layout && typeof ctx.layout.selectPanel === "function") {
            ctx.layout.selectPanel(PANEL_ID);
            return;
          }
        } catch (error) {
          if (typeof console !== "undefined") console.warn("[dsh-manuscript] selectPanel failed:", error);
          return;
        }
        if (typeof console !== "undefined") console.warn("[dsh-manuscript] layout service unavailable");
      }

      function activateOnKey(event) {
        if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
          event.preventDefault();
          if (typeof event.currentTarget.click === "function") event.currentTarget.click();
        }
      }

      // 书本图标：16/18px 画在 sidebar.panellist
      function BookGlyph(props) {
        const size = props && props.size ? props.size : 16;
        const active = !!(props && props.active);
        return jsxs("svg", {
          className: "ms-glyph",
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.6",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          style: { display: "block", flex: "none", color: active ? "var(--accent)" : "currentColor" },
          children: [
            jsx("path", { d: "M4 4.6A1.6 1.6 0 0 1 5.6 3H11v18H5.6A1.6 1.6 0 0 1 4 19.4z" }),
            jsx("path", { d: "M20 4.6A1.6 1.6 0 0 0 18.4 3H13v18h5.4a1.6 1.6 0 0 0 1.6-1.6z" }),
            jsx("path", { d: "M7.4 7.6h1.2" }),
            jsx("path", { d: "M7.4 11h1.2" })
          ]
        });
      }

      // 24px 进度环（rail 降级形态用）
      function ProgressRing(props) {
        const size = props && props.size ? props.size : 24;
        const stroke = 2;
        const radius = (size - stroke) / 2;
        const length = 2 * Math.PI * radius;
        const ratio = props && typeof props.ratio === "number" ? props.ratio : 0;
        const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
        const dash = length * clamped;
        const center = size / 2;
        return jsxs("svg", {
          width: size,
          height: size,
          viewBox: "0 0 " + size + " " + size,
          "aria-hidden": "true",
          style: { display: "block", flex: "none" },
          children: [
            jsx("circle", {
              cx: center,
              cy: center,
              r: radius,
              fill: "none",
              stroke: "var(--line)",
              strokeWidth: stroke
            }),
            jsx("circle", {
              cx: center,
              cy: center,
              r: radius,
              fill: "none",
              stroke: "var(--t-green)",
              strokeWidth: stroke,
              strokeDasharray: dash + " " + (length - dash),
              transform: "rotate(-90 " + center + " " + center + ")"
            })
          ]
        });
      }

      /**
       * 某一册"根本不存在"（而不是"接口坏了"）的判定。
       *
       * 【2026-11-08 实测】AI 协作册的 id 由 host 决定；当这一册没有任何条目时，
       * summary 里不会出现它，客户端退回字面量 `ai-collab` 去请求 → 404。
       * 原来这个 404 被当成"数据未就绪"展示，用户看到的是「HTTP 404」四个字，
       * 既不知道发生了什么、也不知道要不要处理。
       */
      function isMissingVolume(state) {
        if (!state || state.phase !== "error") return false;
        const msg = String(state.error || "");
        return /\b404\b/.test(msg);
      }

      function Placeholder(props) {
        const state = (props && props.state) || { phase: "loading" };
        const isError = state.phase === "error";
        const title = isError ? "数据未就绪" : "正在读取…";
        const detail = isError
          ? String(state.error || "接口未响应，等 host 侧 ready 后自动恢复。")
          : "接口返回后自动刷新。";
        const what = props && props.what ? String(props.what) + " · " : "";
        return jsxs("div", {
          className: "ms-empty",
          children: [
            jsx("b", { children: title }),
            jsx("span", { children: what + detail })
          ]
        });
      }

      // ① 左栏底部常驻迷你卡
      function ManuscriptCard(props) {
        const wide = !!(props && props.wide);
        const summary = useJson(API_SUMMARY);
        const data = summary.data;
        const total = num(data && data.total);
        const archived = num(data && data.archived);
        const ratio = ratioOf(archived, total);
        const loaded = summary.phase === "ready";
        const countText = loaded ? fmtNum(archived) + "/" + fmtNum(total) : "--/--";

        if (!wide) {
          return jsxs("div", {
            className: "ms-rail",
            role: "button",
            tabIndex: 0,
            title: "书阁",
            "aria-label": "书阁，已归档 " + fmtNum(archived) + " 条，共 " + fmtNum(total) + " 条",
            onClick: openPanel,
            onKeyDown: activateOnKey,
            children: [
              jsx(ProgressRing, { size: 24, ratio: loaded ? ratio : 0 }),
              jsx("span", { className: "ms-railPct", children: loaded ? Math.round(ratio * 100) + "%" : "--" })
            ]
          });
        }

        return jsxs("div", {
          className: "ms-card",
          role: "button",
          tabIndex: 0,
          title: "打开书阁面板",
          "aria-label": "打开书阁面板",
          onClick: openPanel,
          onKeyDown: activateOnKey,
          children: [
            jsxs("div", {
              className: "ms-cardHead",
              children: [
                jsx(BookGlyph, { size: 12 }),
                jsx("span", { className: "ms-cardName", children: "书阁" }),
                jsx("span", { className: "ms-cardCount", children: countText })
              ]
            }),
            jsxs("div", {
              className: "ms-meterRow",
              children: [
                jsx("div", {
                  className: "ms-meter",
                  children: jsx("div", {
                    className: "ms-meterFill",
                    style: { width: (ratio * 100).toFixed(1) + "%" }
                  })
                }),
                jsx("span", {
                  className: "ms-meterLabel",
                  children: loaded ? "归档 " + fmtNum(archived) : "数据未就绪"
                })
              ]
            })
          ]
        });
      }

      // ② 左栏图标入口（size: wide ? 16 : 18，active 来自面板选中态）
      function ManuscriptPanelIcon(props) {
        const size = props && props.size ? props.size : 16;
        const active = !!(props && props.active);
        return jsx(BookGlyph, { size, active });
      }

      // 书房 · 四段漏斗
      //
      // 【2026-11-05 重做】三个问题一起修：
      //   ① 量纲：原来"已提炼"取不到 summary.distilled 就退回 summary.entries
      //      （条目数 389），分母却是会话数 278 → 出现「278 / 389」这种不可能画面。
      //      **条目不能给会话兜底**。"已提炼"现在只认会话量纲的 distilledSessions。
      //   ② 分母不再统一：全部/已归档按 total（278，含噪声）算，已提炼按
      //      real（218 真实任务，用户已拍板）算，已入册按条目总数算。
      //      → **每段必须传自己的 whole**，并且把自己的分母写在下面。
      //      拿一个公共分母硬套，才会出现"每段都画满"的假象。
      //   ③ 拿不到数据时显示 "--"，不是 0 —— 0 会被误读成"真的一条都没有"。
      //
      // 单位不同这件事**不藏起来**：标签直接写「（会话）」/「（条目）」。
      // 已入册本来就是条目量纲（册子里装的是条目，library.js:591），
      // 把它硬改成会话数会得出"218/218 全部入册"这种假话 —— 试过，被驳回。
      function Funnel(props) {
        const summary = (props && props.summary) || {};
        // 分母全部用 optNum：可以未知（null），但绝不能用 0 假装已知。
        // 原来 real 取不到会退回 total，那是拿"全部 278"当"真实任务 218"，
        // 分母悄悄变大 → 进度条悄悄变短，用户看到的是一个安静的错误。
        const totalBase = optNum(summary.total);
        const realBase = optNum(summary.real);
        const entriesBase = optNum(summary.entries);
        const distilled = distilledOf(summary);        // 会话量纲
        const inBook = inBooksOf(summary);             // 条目量纲
        // 分母未知时的统一文案：说出来，而不是塞一个数字。
        function baseText(base, unit) {
          if (base == null || base <= 0) return "分母未知";
          return "共 " + fmtNum(base) + " " + unit;
        }
        const stages = [
          {
            key: "all", label: "全部", unit: "会话",
            value: optNum(summary.total), whole: totalBase,
            base: baseText(totalBase, "段会话"),
            tone: "var(--text)"
          },
          {
            key: "archived", label: "已归档", unit: "会话",
            value: optNum(summary.archived), whole: totalBase,
            base: baseText(totalBase, "段会话"),
            tone: "var(--t-green)"
          },
          {
            key: "distilled", label: "已提炼", unit: "会话",
            value: distilled, whole: realBase,
            base: baseText(realBase, "段真实任务"),
            tone: "var(--t-cyan)"
          },
          {
            key: "books", label: "已入册", unit: "条目",
            value: inBook, whole: entriesBase,
            // 分子是各册可见条目之和（catalog 里翻得到的），
            // 分母是盘上条目总数 —— 两者不等时表示有条目没进目录。
            base: baseText(entriesBase, "条（盘上全部）"),
            tone: "var(--t-orange)"
          }
        ];
        // 构成行：会话分诊结果 + 条目总数。条目数在这里**单列**，
        // 不再冒充上面的会话数 —— 那正是原来 278/389 矛盾的来源。
        const shape =
          "构成 · 实测 " + fmtOrDash(summary.real) + " · 冒烟 " + fmtOrDash(summary.smoke) + " · 空壳 " + fmtOrDash(summary.empty) +
          " · 条目 " + fmtOrDash(summary.entries);
        return jsxs("div", {
          children: [
            jsx("div", {
              className: "ms-funnel",
              children: stages.map((stage) => {
                const known = stage.value != null;
                // 每段用**自己的** whole。分子或分母任一未知 → 不画比例（0），
                // 而不是借一个别的分母硬算出一条好看的进度。
                const ratio = known && stage.whole != null && stage.whole > 0
                  ? ratioOf(stage.value, stage.whole)
                  : 0;
                return jsxs("div", {
                  className: "ms-fn",
                  key: stage.key,
                  children: [
                    jsx("div", {
                      className: "ms-fnLabel",
                      children: stage.label + "（" + stage.unit + "）"
                    }),
                    jsx("div", {
                      className: "ms-fnNum",
                      style: { color: known ? stage.tone : "var(--text-4)" },
                      children: known ? fmtNum(stage.value) : "--"
                    }),
                    jsx("div", {
                      className: "ms-fnBar",
                      children: jsx("div", {
                        className: "ms-fnFill",
                        style: { width: (ratio * 100).toFixed(1) + "%", background: stage.tone }
                      })
                    }),
                    jsx("div", { className: "ms-fnBase", children: stage.base })
                  ]
                });
              })
            }),
            jsx("div", { className: "ms-shape", children: shape })
          ]
        });
      }

      // 书房 · 分册卡片网格
      function VolumeGrid(props) {
        const volumes = props && Array.isArray(props.volumes) ? props.volumes : [];
        const onOpen = props && typeof props.onOpen === "function" ? props.onOpen : null;
        return jsx("div", {
          className: "ms-vols",
          children: volumes.map((volume, index) => {
            const id = volume && volume.id != null ? String(volume.id) : "vol-" + index;
            const name = volume && volume.name ? String(volume.name) : id;
            const meta = chapterCount(volume) + " 章 · " + entryCount(volume) + " 条";
            const kinds = volumeKindText(volume);
            return jsxs("div", {
              className: "ms-vol",
              key: id,
              role: "button",
              tabIndex: 0,
              "aria-label": "打开 " + name,
              onClick: () => {
                if (onOpen) onOpen(id);
              },
              onKeyDown: activateOnKey,
              children: [
                jsx("div", { className: "ms-volName", children: name }),
                jsxs("div", {
                  className: "ms-volMeta",
                  children: [
                    jsx("span", { children: meta }),
                    volume && volume.recent
                      ? jsx("span", { className: "ms-volDate", children: fmtDate(volume.recent) })
                      : null
                  ]
                }),
                kinds ? jsx("div", { className: "ms-volKind", children: kinds }) : null
              ]
            });
          })
        });
      }

      // 书房 · 最近会话
      //
      // 【2026-11-12 精简】原来每行四列：标题 / 工作区 / "N 轮 · M 调用" / 质量分。
      // 轮次与调用次数是给排查用的，对"翻书的人"没有信息量，还把那行挤成一片小字。
      // 现在只留标题 + 工作区 + 质量分，并且默认只列 5 行 —— 想看全部去侧栏会话树。
      function SessionStrip(props) {
        const data = props && props.data;
        const all = data && Array.isArray(data.items) ? data.items : [];
        const LIMIT = 5;
        const items = all.slice(0, LIMIT);
        if (items.length === 0) {
          return jsx("div", { className: "ms-sess", children: jsx("div", { className: "ms-seNone", children: "暂无会话记录。" }) });
        }
        return jsx("div", {
          className: "ms-sess",
          children: items.map((item, index) => {
            const row = item || {};
            // 标题缺失时不要拿 session-xxxx 这种内部 id 当标题露出来（实测很丑，
            // 而且读者会以为那是一段乱码）。id 只放在 hover 提示里，供排查对齐。
            const rawTitle = row.title ? String(row.title) : "";
            const title = rawTitle || "未命名会话";
            const project = row.project ? String(row.project) : "—";
            const score = row.qualityScore != null ? row.qualityScore : row.score;
            return jsxs("div", {
              className: "ms-serow",
              key: row.sid != null ? String(row.sid) : "row-" + index,
              children: [
                jsx("span", {
                  className: "ms-seTitle",
                  title: rawTitle || (row.sid ? String(row.sid) : title),
                  children: title
                }),
                jsx("span", { className: "ms-seNum", title: project, children: project }),
                jsx("span", {
                  className: "ms-seScore",
                  style: { color: scoreTone(score) },
                  children: fmtNum(score)
                })
              ]
            });
          })
        });
      }

      function EntryRow(props) {
        const entry = (props && props.entry) || {};
        const title = entry.title ? String(entry.title) : entry.id != null ? String(entry.id) : "未命名条目";
        const onOpen = props && typeof props.onOpen === "function" ? props.onOpen : null;
        return jsxs("div", {
          className: "ms-entry",
          // 2026-11-12：条目行从"只读列表"变成"正文入口"。
          // 元数据（authority / 引用数 / id）不再各占一枚 chip ——
          // 三枚边框小标签挤在标题下面，正是"信息繁杂"的直接来源。
          role: onOpen ? "button" : undefined,
          tabIndex: onOpen ? 0 : undefined,
          title: onOpen ? "打开正文" : undefined,
          onClick: onOpen ? () => onOpen(entry.id) : undefined,
          onKeyDown: onOpen ? activateOnKey : undefined,
          children: [
            jsxs("div", {
              className: "ms-entryTop",
              children: [
                jsx("span", { className: "ms-entryTitle", title, children: title }),
                jsx("span", {
                  className: "ms-entryConf",
                  style: { color: confidenceTone(entry.confidence) },
                  children: confidenceLabel(entry.confidence)
                })
              ]
            }),
            entry.claim ? jsx("div", { className: "ms-entryClaim", children: String(entry.claim) }) : null,
            jsx("div", {
              className: "ms-entryMeta",
              children: jsx("span", {
                children:
                  (entry.id != null ? String(entry.id) + " · " : "") +
                  "引用 " + fmtNum(entry.hits) +
                  (entry.authority ? " · " + String(entry.authority) : "")
              })
            })
          ]
        });
      }

      // 目录 / AI 协作 · 章列表（点击展开条目）
      //
      // 【2026-11-24 整改 4.3-6】骨架/真结论的判据**只留在宿主** lib/skeleton.js：
      // 服务端在 summary 的章节投影里下发 `entry.skeleton === true`，客户端只读标记，
      // 不再复制一份 claim 正则。判据出现两份时，改一处忘另一处就会静默漂移。
      function ChapterList(props) {
        const volume = (props && props.volume) || {};
        const chapters = Array.isArray(volume.chapters) ? volume.chapters : [];
        const onOpenEntry = props && typeof props.onOpenEntry === "function" ? props.onOpenEntry : null;
        const [openNo, setOpenNo] = react.useState(null);

        if (chapters.length === 0) {
          return jsx("div", { className: "ms-empty", children: jsx("span", { children: "这一册还没有章节。" }) });
        }

        return jsx("div", {
          className: "ms-chaps",
          children: chapters.map((chapter, index) => {
            // key 用 slug 保持稳定（展开态跟着章走）；显示号用 chapterNo。
            const key = chapter && chapter.slug != null ? String(chapter.slug) : "ch-" + index;
            const label = chapterNo(chapter, index);
            // 目录默认视图不展示打灰条目（服务端投影已剔除，这里再挡一层）。
            const allEntries = (chapter && Array.isArray(chapter.entries) ? chapter.entries : []).filter(
              (entry) => !isGrayedEntry(entry)
            );
            // 2026-11-24（整改 4.3-6）：目录默认只把真结论铺开，
            // 索引骨架（服务端用 claim 判出的统计卡）收进「索引」折叠区。
            // 不删除、仍可展开与点开正文 —— 只是不再占首屏。
            const entries = allEntries.filter((entry) => entry.skeleton !== true);
            const skeletonRows = allEntries.filter((entry) => entry.skeleton === true);
            const title = chapter && chapter.title ? String(chapter.title) : "未命名章节";
            const open = openNo === key;
            return jsxs("div", {
              className: "ms-chap",
              key,
              children: [
                jsxs("div", {
                  className: "ms-chapRow",
                  role: "button",
                  tabIndex: 0,
                  "aria-expanded": open,
                  onClick: () => setOpenNo(open ? null : key),
                  onKeyDown: activateOnKey,
                  children: [
                    jsx("span", { className: "ms-chapNo", children: label }),
                    jsx("span", { className: "ms-chapTitle", title, children: title }),
                    jsx("span", {
                      className: "ms-chapCount",
                      children: entries.length + " 条 " + (open ? "−" : "+")
                    })
                  ]
                }),
                open
                  ? jsx("div", {
                      className: "ms-entries",
                      children: [
                        entries.length > 0
                          ? entries.map((entry, entryIndex) =>
                              jsx(
                                EntryRow,
                                {
                                  entry,
                                  onOpen: onOpenEntry,
                                  key: entry && entry.id != null ? String(entry.id) : key + "-" + entryIndex
                                },
                                entry && entry.id != null ? String(entry.id) : key + "-" + entryIndex
                              )
                            )
                          : skeletonRows.length === 0
                            ? jsx("div", { className: "ms-entryEmpty", children: "这一章还没有条目。" })
                            : null,
                        skeletonRows.length > 0
                          ? jsxs("details", {
                              className: "ms-idx",
                              children: [
                                jsx("summary", { className: "ms-idxSum", children: "索引（" + skeletonRows.length + "）· 仅统计，不含结论" }),
                                jsx("div", {
                                  className: "ms-idxBody",
                                  children: skeletonRows.map((entry, entryIndex) =>
                                    jsx(
                                      EntryRow,
                                      {
                                        entry,
                                        onOpen: onOpenEntry,
                                        key: "sk-" + (entry && entry.id != null ? String(entry.id) : entryIndex)
                                      },
                                      "sk-" + (entry && entry.id != null ? String(entry.id) : entryIndex)
                                    )
                                  )
                                })
                              ]
                            })
                          : null
                      ]
                    })
                  : null
              ]
            });
          })
        });
      }

      // ── 搜索（2026-11-12 · P0/P1 体验改造）──────────────────────────────
      //
      // 结果行只回答三个问题：叫什么、一句话说了什么、收在哪一册哪一章。
      // P0：把服务端 matched[].text 里的命中词高亮，最多露两处片段（claim + 正文），
      //     让"为什么这条被搜出来"一眼可见，而不是只有标题发亮。
      // P1：册/章/置信度三个下拉，改动即带参重搜；0 结果给 3 个相邻词。
      // 命中分 / 条目 id 仍不进结果行 —— 它们是排查用的，收进详情页的折叠区。

      function SearchFilters(props) {
        const value = (props && props.value) || {};
        const volumes = props && Array.isArray(props.volumes) ? props.volumes : [];
        const chapters = props && Array.isArray(props.chapters) ? props.chapters : [];
        const onChange = props && typeof props.onChange === "function" ? props.onChange : null;
        const onReset = props && typeof props.onReset === "function" ? props.onReset : null;
        const active = !!(value.volume || value.chapter || value.confidence);
        const change = (key) => (event) => {
          if (!onChange) return;
          onChange(key, String((event && event.target && event.target.value) || ""));
        };
        return jsxs("div", {
          className: "ms-filters",
          children: [
            jsxs("select", {
              className: "ms-filter",
              "aria-label": "按册筛选",
              value: value.volume || "",
              onChange: change("volume"),
              children: [
                jsx("option", { value: "", children: "全部册" }),
                ...volumes.map((volume, index) =>
                  jsx(
                    "option",
                    {
                      value: volume && volume.id != null ? String(volume.id) : "vol-" + index,
                      children: volume && volume.name ? String(volume.name) : "未命名册"
                    },
                    volume && volume.id != null ? String(volume.id) : "vol-" + index
                  )
                )
              ]
            }),
            jsxs("select", {
              className: "ms-filter",
              "aria-label": "按章筛选",
              value: value.chapter || "",
              onChange: change("chapter"),
              children: [
                jsx("option", { value: "", children: "全部章" }),
                ...chapters.map((chapter) =>
                  jsx("option", { value: chapter, children: chapter }, "ch-" + chapter)
                )
              ]
            }),
            jsxs("select", {
              className: "ms-filter",
              "aria-label": "按置信度筛选",
              value: value.confidence || "",
              onChange: change("confidence"),
              children: [
                jsx("option", { value: "", children: "全部置信度" }),
                jsx("option", { value: "high", children: "高" }),
                jsx("option", { value: "medium", children: "中" }),
                jsx("option", { value: "low", children: "低" })
              ]
            }),
            active && onReset
              ? jsx("button", {
                  type: "button",
                  className: "ms-filterReset",
                  onClick: onReset,
                  children: "清除筛选"
                })
              : null
          ]
        });
      }

      function SearchView(props) {
        const query = props && props.query ? String(props.query) : "";
        const state = (props && props.state) || {};
        const onOpen = props && typeof props.onOpen === "function" ? props.onOpen : null;
        const onGoCatalog = props && typeof props.onGoCatalog === "function" ? props.onGoCatalog : null;
        const onSuggestion = props && typeof props.onSuggestion === "function" ? props.onSuggestion : null;
        const filters = (props && props.filters) || {};
        const volumeOptions = props && Array.isArray(props.volumeOptions) ? props.volumeOptions : [];
        const chapterOptions = props && Array.isArray(props.chapterOptions) ? props.chapterOptions : [];
        const onFilter = props && typeof props.onFilter === "function" ? props.onFilter : null;
        const onClearFilters = props && typeof props.onClearFilters === "function" ? props.onClearFilters : null;
        const fallbackSuggestions = props && Array.isArray(props.fallbackSuggestions) ? props.fallbackSuggestions : [];
        const hits = state.phase === "ready" && state.data && Array.isArray(state.data.hits) ? state.data.hits : [];
        const terms = searchTerms(query);
        const filterBar = jsx(SearchFilters, {
          value: filters,
          volumes: volumeOptions,
          chapters: chapterOptions,
          onChange: onFilter,
          onReset: onClearFilters
        });

        if (state.phase === "loading") {
          return jsxs("div", {
            className: "ms-view ms-results",
            children: [
              jsx("div", { className: "ms-resHead", children: "正在检索「" + query + "」…" }),
              filterBar,
              jsx("div", { className: "ms-empty", children: jsx("span", { children: "通常一秒内完成；数据来自本机书库，不走网络。" }) })
            ]
          });
        }

        if (state.phase === "error") {
          return jsxs("div", {
            className: "ms-view ms-results",
            children: [
              filterBar,
              jsx("div", {
                className: "ms-empty",
                children: [
                  jsx("b", { children: "检索暂时不可用" }),
                  jsx("span", { children: (state.error ? String(state.error) : "接口没有响应") + "。你仍然可以按册翻目录。" }),
                  onGoCatalog
                    ? jsx("button", { type: "button", className: "ms-back", style: { marginTop: "8px" }, onClick: onGoCatalog, children: "去目录 →" })
                    : null
                ]
              })
            ]
          });
        }

        if (hits.length === 0) {
          // 服务端给 suggestions 就用；还没有这条字段时由父组件按同册标题抽词兜底。
          const fromServer = normalizeSuggestions(state.data && state.data.suggestions, 3);
          const suggestions = fromServer.length > 0 ? fromServer : normalizeSuggestions(fallbackSuggestions, 3);
          return jsxs("div", {
            className: "ms-view ms-results",
            children: [
              filterBar,
              jsx("div", {
                className: "ms-empty",
                children: [
                  jsx("b", { children: "手册里没有这条" }),
                  jsx("span", { children: "换个更具体的词试试（器件型号、工具名、报错原文），或按册翻目录。" }),
                  suggestions.length > 0
                    ? jsxs("div", {
                        className: "ms-sug",
                        children: [
                          jsx("span", { className: "ms-sugLabel", children: "相邻词：" }),
                          ...suggestions.map((word) =>
                            jsx(
                              "button",
                              {
                                type: "button",
                                className: "ms-sugBtn",
                                onClick: () => onSuggestion && onSuggestion(word),
                                children: word
                              },
                              "sug-" + word
                            )
                          )
                        ]
                      })
                    : null,
                  onGoCatalog
                    ? jsx("button", { type: "button", className: "ms-back", style: { marginTop: "8px" }, onClick: onGoCatalog, children: "去目录 →" })
                    : null
                ]
              }),
              Array.isArray(state.data && state.data.retired) && state.data.retired.length > 0
                ? jsxs("div", {
                    className: "ms-retired",
                    children: [
                      jsx("div", { className: "ms-retiredHead", children: "旧记录（已退役，未提炼结论）" }),
                      ...state.data.retired.map((r) =>
                        jsxs("div", {
                          className: "ms-retiredItem",
                          onClick: () => onOpenEntry && onOpenEntry(r.id),
                          children: [
                            jsx("div", { className: "ms-retiredTitle", children: r.title || r.id }),
                            jsx("div", { className: "ms-retiredClaim", children: r.claim || "（无摘要）" })
                          ]
                        }, "ret0-" + r.id)
                      )
                    ]
                  })
                : null
            ]
          });
        }

        const retired = Array.isArray(state.data && state.data.retired) ? state.data.retired : [];
        const retiredBlock = retired.length > 0
          ? jsxs("div", {
              className: "ms-retired",
              children: [
                jsx("div", { className: "ms-retiredHead", children: "旧记录（已退役，未提炼结论）" }),
                ...retired.map((r) =>
                  jsxs("div", {
                    className: "ms-retiredItem",
                    onClick: () => onOpenEntry && onOpenEntry(r.id),
                    children: [
                      jsx("div", { className: "ms-retiredTitle", children: r.title || r.id }),
                      jsx("div", { className: "ms-retiredClaim", children: r.claim || "（无摘要）" })
                    ]
                  }, "ret-" + r.id)
                )
              ]
            })
          : null;
        return jsxs("div", {
          className: "ms-view ms-results",
          children: [
            jsxs("div", {
              className: "ms-resHead",
              children: ["找到 ", jsx("b", { children: fmtNum(hits.length) }), " 条相关记录"]
            }),
            filterBar,
            ...hits.map((hit, index) => {
              const matched = Array.isArray(hit.matched) ? hit.matched : [];
              // 一条扫描里同时收集 claim / 正文 两处片段；标题已经整行高亮，
              // 不再重复展示 title 片段。
              let claimSnippet = null;
              let whySnippet = null;
              const seen = new Set();
              for (const item of matched) {
                const text = item && item.text ? String(item.text).trim() : "";
                if (!text || seen.has(text)) continue;
                if (item.field === "claim" && claimSnippet == null) {
                  claimSnippet = text;
                  seen.add(text);
                } else if (item.field === "why" && whySnippet == null) {
                  whySnippet = text;
                  seen.add(text);
                }
              }
              if (claimSnippet == null && hit.claim) claimSnippet = String(hit.claim);
              return jsxs(
                "div",
                {
                  className: "ms-result",
                  role: "button",
                  tabIndex: 0,
                  onClick: () => onOpen && onOpen(hit.id),
                  onKeyDown: activateOnKey,
                  children: [
                    jsx("div", { className: "ms-resultTitle", children: highlightText(hit.title || "未命名条目", terms) }),
                    claimSnippet
                      ? jsx("div", { className: "ms-resultClaim", children: highlightText(claimSnippet, terms) })
                      : null,
                    whySnippet
                      ? jsxs("div", {
                          className: "ms-resultMatch",
                          children: [
                            jsx("span", { className: "ms-resultField", children: "正文" }),
                            jsx("span", { children: highlightText(whySnippet, terms) })
                          ]
                        })
                      : null,
                    jsx("div", {
                      className: "ms-resultPath",
                      children:
                        [hit.volumeName, hit.chapter].filter(Boolean).join(" / ") +
                        (isGrayedEntry(hit) ? " · 已打灰（无结论）" : "")
                    })
                  ]
                },
                hit.id != null ? String(hit.id) : "hit-" + index
              );
            }),
            retiredBlock
          ]
        });
      }

      // ── 首页 · 最近更新（P0）───────────────────────────────────────────
      //
      // 读者打开手册想知道"最近记了什么"，而不是"AI 最近跑了哪些会话"。
      // 最近会话挪进页面底部「维护与巡检 → 提炼与入库」里，首屏只留在册条目的更新。
      function RecentUpdates(props) {
        const state = (props && props.state) || {};
        const onOpen = props && typeof props.onOpen === "function" ? props.onOpen : null;
        const onGoTimeline = props && typeof props.onGoTimeline === "function" ? props.onGoTimeline : null;
        const onGoCatalog = props && typeof props.onGoCatalog === "function" ? props.onGoCatalog : null;
        const days = timelineDaysOf(state.data);
        const rows = [];
        for (const day of days) {
          for (const entry of day.entries) {
            rows.push({ entry, date: day.date });
            if (rows.length >= 5) break;
          }
          if (rows.length >= 5) break;
        }

        if (state.phase === "loading") {
          return jsx("div", {
            className: "ms-upd",
            children: jsx("div", { className: "ms-updEmpty", children: jsx("div", { className: "ms-updEmptyText", children: "正在读取最近更新…" }) })
          });
        }
        if (state.phase === "error") {
          return jsxs("div", {
            className: "ms-upd",
            children: jsxs("div", {
              className: "ms-updEmpty",
              role: "alert",
              children: [
                jsx("div", { className: "ms-updEmptyTitle", children: "最近更新暂时不可用" }),
                jsx("div", {
                  className: "ms-updEmptyText",
                  children: state.error ? String(state.error) : "接口没有响应。"
                }),
                jsxs("div", {
                  className: "ms-updEmptyActions",
                  children: [
                    onGoTimeline
                      ? jsx("button", { type: "button", className: "ms-rBtn", onClick: onGoTimeline, children: "看最近 30 天" })
                      : null,
                    onGoCatalog
                      ? jsx("button", { type: "button", className: "ms-rBtn", onClick: onGoCatalog, children: "翻目录" })
                      : null
                  ]
                })
              ]
            })
          });
        }
        if (rows.length === 0) {
          return jsxs("div", {
            className: "ms-upd",
            children: jsxs("div", {
              className: "ms-updEmpty",
              children: [
                jsx("div", { className: "ms-updEmptyTitle", children: "近 30 天没有更新" }),
                jsx("div", {
                  className: "ms-updEmptyText",
                  children: "这不代表书库是空的；完整记录在时间线里。"
                }),
                jsxs("div", {
                  className: "ms-updEmptyActions",
                  children: [
                    onGoTimeline
                      ? jsx("button", { type: "button", className: "ms-rBtn", onClick: onGoTimeline, children: "看最近 30 天" })
                      : null,
                    onGoCatalog
                      ? jsx("button", { type: "button", className: "ms-rBtn", onClick: onGoCatalog, children: "翻目录" })
                      : null
                  ]
                })
              ]
            })
          });
        }

        return jsx("div", {
          className: "ms-upd",
          children: rows.map((row, index) => {
            const entry = row.entry || {};
            const title = entry.title ? String(entry.title) : "未命名条目";
            const path = [entry.volumeName, entry.chapter].filter(Boolean).join(" / ");
            return jsxs(
              "div",
              {
                className: "ms-updRow",
                role: "button",
                tabIndex: 0,
                title: "打开正文",
                onClick: () => onOpen && onOpen(entry.id),
                onKeyDown: activateOnKey,
                children: [
                  jsx("div", { className: "ms-updTop", children: jsx("span", { className: "ms-updTitle", children: title }) }),
                  entry.claim ? jsx("div", { className: "ms-updClaim", children: String(entry.claim) }) : null,
                  jsx("div", {
                    className: "ms-updPath",
                    children: path + (row.date ? " · " + String(row.date).slice(5) : "")
                  })
                ]
              },
              entry.id != null ? String(entry.id) : "recent-" + index
            );
          })
        });
      }

      // ── 时间线（P2）────────────────────────────────────────────────────
      //
      // 按天分组，默认最近 30 天。日期是组标题，条目保持"标题 + claim + 册/章"，
      // 不额外加卡片、不加时间轴装饰 —— 时间信息交给分组，不再挤进每一行。
      function TimelineView(props) {
        const state = (props && props.state) || {};
        const onOpen = props && typeof props.onOpen === "function" ? props.onOpen : null;
        const onGoCatalog = props && typeof props.onGoCatalog === "function" ? props.onGoCatalog : null;
        const days = timelineDaysOf(state.data);
        const total = timelineEntryCount(days);

        if (state.phase === "loading") {
          return jsx("div", {
            className: "ms-view ms-tl",
            children: jsxs("div", {
              className: "ms-empty",
              children: [
                jsx("b", { children: "正在读取时间线" }),
                jsx("span", { children: "最近 30 天的条目（含已退役的旧记录），通常一秒内就能读完。" })
              ]
            })
          });
        }
        if (state.phase === "error") {
          return jsx("div", {
            className: "ms-view ms-tl",
            children: jsxs("div", {
              className: "ms-empty",
              role: "alert",
              children: [
                jsx("b", { children: "时间线暂时不可用" }),
                jsx("span", { children: (state.error ? String(state.error) : "接口没有响应") + "。目录和搜索不受影响。" }),
                onGoCatalog
                  ? jsx("button", { type: "button", className: "ms-rBtn", style: { marginTop: "8px" }, onClick: onGoCatalog, children: "去目录 →" })
                  : null
              ]
            })
          });
        }
        if (total === 0) {
          return jsx("div", {
            className: "ms-view ms-tl",
            children: jsxs("div", {
              className: "ms-empty",
              children: [
                jsx("b", { children: "最近 30 天没有更新" }),
                jsx("span", { children: "没有新增或修改的条目。这不代表书库是空的，可能只是这段时间很安静。" }),
                onGoCatalog
                  ? jsx("button", { type: "button", className: "ms-rBtn", style: { marginTop: "8px" }, onClick: onGoCatalog, children: "去目录看看 →" })
                  : null
              ]
            })
          });
        }

        return jsxs("div", {
          className: "ms-view ms-tl",
          children: [
            jsxs("div", {
              className: "ms-resHead",
              children: ["最近 30 天 · ", jsx("b", { children: fmtNum(total) }), " 条更新"]
            }),
            ...days.map((day) =>
              jsxs(
                "section",
                {
                  className: "ms-tlDay",
                  children: [
                    jsxs("div", {
                      className: "ms-tlDate",
                      title: day.date,
                      children: [
                        jsx("span", { className: "ms-tlDayLabel", children: fmtDayParts(day.date).label }),
                        jsx("span", { className: "ms-tlDaySub", children: fmtDayParts(day.date).sub }),
                        jsx("span", { className: "ms-tlCount", children: day.entries.length + " 条" })
                      ]
                    }),
                    jsx("div", {
                      className: "ms-tlList",
                      children: day.entries.map((entry, index) => {
                        const title = entry && entry.title ? String(entry.title) : "未命名条目";
                        const path = [entry && entry.volumeName, entry && entry.chapter].filter(Boolean).join(" / ");
                        return jsxs(
                          "div",
                          {
                            className: "ms-tlRow" + (entry && entry.skeleton ? " ms-tlRowSkel" : ""),
                            role: "button",
                            tabIndex: 0,
                            title: "打开正文",
                            onClick: () => onOpen && onOpen(entry && entry.id),
                            onKeyDown: activateOnKey,
                            children: [
                              jsx("div", { className: "ms-tlTitle", children: [title, entry && entry.skeleton ? jsx("span", { className: "ms-tlSkelTag", children: "仅统计" }) : null] }),
                              entry && entry.claim ? jsx("div", { className: "ms-tlClaim", children: String(entry.claim) }) : null,
                              jsx("div", { className: "ms-tlPath", children: path })
                            ]
                          },
                          entry && entry.id != null ? String(entry.id) : day.date + "-" + index
                        );
                      })
                    })
                  ]
                },
                "day-" + day.date
              )
            )
          ]
        });
      }

      // ── 条目正文（2026-11-12）──────────────────────────────────────────
      //
      // 阅读区：760px 行宽、15px/1.9 行高；元数据默认折叠。
      // 页面上只有三块：这是哪条（面包屑+标题）、说了什么（claim/正文）、从哪来（溯源）。
      function EntryView(props) {
        const state = (props && props.state) || {};
        const id = props && props.id != null ? String(props.id) : "";
        const onBack = props && typeof props.onBack === "function" ? props.onBack : null;
        const backLabel = props && props.backLabel ? String(props.backLabel) : "返回";
        const entryData = state.data && state.data.entry ? state.data.entry : null;
        const entryKey = entryData && entryData.id != null ? String(entryData.id) : "";

        // ── 复制 / 编辑（P0）──────────────────────────────────────────────
        // 编辑草稿只在点"编辑"时灌入一次；详情因 invalidate 重取而重渲染时**不**回灌，
        // 否则用户正在改的标点会被服务端旧值覆盖（巡检设置踩过同一个坑）。
        const [editing, setEditing] = react.useState(false);
        const [draft, setDraft] = react.useState({ title: "", claim: "", why: "" });
        const [saving, setSaving] = react.useState(false);
        const [editError, setEditError] = react.useState(null);
        const [editErrorField, setEditErrorField] = react.useState(null); // title | claim | why | null
        const [notice, setNotice] = react.useState(null); // { tone:"ok"|"err", text }
        const noticeTimer = react.useRef(null);
        const titleRef = react.useRef(null);
        const claimRef = react.useRef(null);
        const whyRef = react.useRef(null);
        const errorRef = react.useRef(null);

        react.useEffect(() => {
          if (!editing) return;
          if (titleRef.current && typeof titleRef.current.focus === "function") titleRef.current.focus();
        }, [editing]);

        // 错误条在表单顶部；保存按钮在底部时，用户可能看不到。滚到最近位置。
        react.useEffect(() => {
          if (editError && errorRef.current && typeof errorRef.current.scrollIntoView === "function") {
            errorRef.current.scrollIntoView({ block: "nearest" });
          }
        }, [editError]);

        react.useEffect(() => {
          return () => {
            if (noticeTimer.current) clearTimeout(noticeTimer.current);
          };
        }, []);

        // 切到另一条时收起编辑态与提示，避免把上一条的草稿写到新条目上。
        react.useEffect(() => {
          setEditing(false);
          setEditError(null);
          setEditErrorField(null);
          setNotice(null);
        }, [entryKey]);

        const showNotice = (text, tone) => {
          if (noticeTimer.current) clearTimeout(noticeTimer.current);
          setNotice({ tone: tone || "ok", text: String(text || "") });
          noticeTimer.current = setTimeout(() => {
            noticeTimer.current = null;
            setNotice(null);
          }, 3200);
        };

        const changeDraft = (key, value) => {
          setDraft((prev) => ({ ...prev, [key]: value }));
          if (editErrorField === key) {
            setEditError(null);
            setEditErrorField(null);
          }
        };

        const failEdit = (text, field) => {
          setEditError(String(text || ""));
          setEditErrorField(field || null);
          const node =
            field === "title" ? titleRef.current :
            field === "claim" ? claimRef.current :
            field === "why" ? whyRef.current : null;
          if (node && typeof node.focus === "function") node.focus();
        };

        const beginEdit = () => {
          if (!entryData) return;
          setDraft({
            title: entryData.title ? String(entryData.title) : "",
            claim: entryData.claim ? String(entryData.claim) : "",
            // 只有一句摘要的条目，正文留空即可 —— 不把 claim 复制进 why 造成两遍。
            why: entryData.bodyIsClaim ? "" : entryData.body ? String(entryData.body) : ""
          });
          setEditError(null);
          setEditErrorField(null);
          setEditing(true);
        };

        const copyEntry = async () => {
          if (!entryData) return;
          const parts = [String(entryData.title || "").trim()];
          if (entryData.claim) parts.push(String(entryData.claim).trim());
          if (!entryData.bodyIsClaim && entryData.body && entryData.body !== entryData.claim) {
            parts.push(String(entryData.body).trim());
          }
          const text = parts.filter(Boolean).join("\n\n");
          const legacyCopy = () => {
            // 临时 textarea + execCommand：剪贴板 API 在无 HTTPS、被策略禁用、
            // 或浏览器把权限判给别的页面时的兜底。返回 false 表示确实没写进去。
            const area = document.createElement("textarea");
            area.value = text;
            area.setAttribute("readonly", "");
            area.style.position = "fixed";
            area.style.left = "-9999px";
            document.body.appendChild(area);
            area.select();
            let ok = false;
            try {
              ok = document.execCommand("copy");
            } finally {
              document.body.removeChild(area);
            }
            return ok;
          };
          try {
            let copied = false;
            let clipboardError = null;
            if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
              try {
                await navigator.clipboard.writeText(text);
                copied = true;
              } catch (error) {
                // 【2026-11-12 实测】headless Chrome（及部分浏览器策略）会拒掉
                // writeText：不是"没实现"，而是权限被拒。此时不能直接报失败 ——
                // execCommand 在用户点击的同一手势里通常仍可写，先兜底再谈失败。
                clipboardError = error;
              }
            }
            if (!copied) copied = legacyCopy();
            if (!copied) {
              throw clipboardError || new Error("浏览器拒绝了剪贴板写入");
            }
            showNotice("已复制标题与正文", "ok");
          } catch (error) {
            showNotice("复制失败：" + (error && error.message ? error.message : String(error)) + "。可在正文里手动选中复制。", "err");
          }
        };

        const saveEntry = async () => {
          if (!entryData || saving) return;
          const title = draft.title.trim();
          const claim = draft.claim.trim();
          const why = draft.why;
          if (!title) {
            failEdit("标题不能为空。", "title");
            return;
          }
          if (title.length > 300) {
            failEdit("标题过长（上限 300 字，当前 " + title.length + " 字）。", "title");
            return;
          }
          if (!claim) {
            failEdit("摘要不能为空。", "claim");
            return;
          }
          if (claim.length > 2000) {
            failEdit("摘要过长（上限 2000 字，当前 " + claim.length + " 字）。", "claim");
            return;
          }
          if (why.trim().length > 20000) {
            failEdit("正文过长（上限 20000 字，当前 " + why.trim().length + " 字）。", "why");
            return;
          }
          setSaving(true);
          setEditError(null);
          setEditErrorField(null);
          try {
            const targetId = entryData.id != null ? String(entryData.id) : id;
            await postJson(
              API_ENTRY_SAVE,
              { id: targetId, title, claim, why },
              { timeoutMs: 30000 }
            );
            setEditing(false);
            // 详情、搜索结果、时间线、首页最近更新、分册目录都受这次写入影响。
            // 详情用精确 id；搜索/时间线/分册是动态 URL，按前缀全部失效。
            invalidate(API_ENTRY + "?id=" + encodeURIComponent(targetId));
            invalidate(API_SUMMARY);
            invalidate(API_SEARCH, { prefix: true });
            invalidate(API_TIMELINE, { prefix: true });
            invalidate(API_VOLUME, { prefix: true });
            showNotice("已保存 · 标题与正文已写回本机 Markdown", "ok");
          } catch (error) {
            // 不吞错：服务端拒绝的原因原样显示，草稿保留。
            failEdit("保存失败：" + (error && error.message ? error.message : String(error)), null);
          } finally {
            setSaving(false);
          }
        };

        const back = onBack
          ? jsx("button", { type: "button", className: "ms-back", onClick: onBack, children: "← " + backLabel })
          : null;

        // 刷新（invalidate 后重取）时若手上还有旧数据，继续显示而不是闪成"正在打开"。
        if (state.phase === "loading" && !entryData) {
          return jsxs("div", {
            className: "ms-view ms-reader",
            children: [
              back,
              jsx("div", { className: "ms-empty", children: jsx("span", { children: "正在打开条目…" }) })
            ]
          });
        }

        if (state.phase === "error" || !entryData) {
          return jsxs("div", {
            className: "ms-view ms-reader",
            children: [
              back,
              jsx("div", {
                className: "ms-empty",
                children: [
                  jsx("b", { children: "打不开这条" }),
                  jsx("span", { children: state.error ? String(state.error) : "条目可能已被重新归档，刷新后再试。" })
                ]
              })
            ]
          });
        }

        const e = entryData;
        const provenance = e.provenance && typeof e.provenance === "object" ? e.provenance : {};
        const evidence = e.evidence && typeof e.evidence === "object" ? e.evidence : null;
        const tags = Array.isArray(e.tags) ? e.tags : [];
        const date = fmtDate(e.sessionAt || provenance.timestamp);
        const hasWhy = !e.bodyIsClaim && e.body && e.body !== e.claim;

        const traceRows = [
          provenance.session_id ? ["来源会话", String(provenance.session_id), true] : null,
          Array.isArray(provenance.session_ids) && provenance.session_ids.length > 1
            ? ["合并会话", provenance.session_ids.map(String).join("、"), true]
            : null,
          provenance.turn != null ? ["轮次", String(provenance.turn), false] : null,
          provenance.message_id ? ["消息", String(provenance.message_id), true] : null,
          provenance.tool_call_id ? ["工具调用", String(provenance.tool_call_id), true] : null,
          provenance.kind ? ["来源类型", String(provenance.kind), false] : null,
          provenance.sample != null ? ["统计样本", String(provenance.sample) + " 个会话", false] : null,
          provenance.computedAt ? ["计算时间", String(provenance.computedAt), false] : null,
          provenance.timestamp ? ["会话时间", String(provenance.timestamp), false] : null
        ].filter(Boolean);

        const evidenceRows = evidence
          ? [
              Array.isArray(evidence.tools) && evidence.tools.length > 0
                ? ["调用工具", evidence.tools.map(String).join("、"), false]
                : null,
              Array.isArray(evidence.files) && evidence.files.length > 0
                ? ["涉及文件", evidence.files.map(String).join("、"), false]
                : null
            ].filter(Boolean)
          : [];

        const metaRows = [
          ["条目 id", entryKey || id, true],
          ["条目来源", e.handwritten ? "手写 Markdown" : (e.distilled ? "LLM 提炼" : "自动整理/骨架"), false],
          e.qualityScore != null ? ["质量分", fmtNum(e.qualityScore), false] : null,
          e.status
            ? ["状态", e.status === "expired" ? "已退役" : e.status === "grayed" ? "已打灰（无结论）" : "现行", false]
            : null,
          // 2026-11-24（整改 4.3-8）：退役条目现在可打开，详情页必须把
          // 「被哪条取代」原样标出来，否则读者会拿旧结论当现行经验。
          e.retiredNote ? ["退役说明", String(e.retiredNote), false] : null,
          ["需要复核", e.needsReview ? "是" : "否", false]
        ].filter(Boolean);

        return jsxs("div", {
          className: "ms-view ms-reader",
          children: [
            back,
            jsx("div", {
              className: "ms-crumb",
              children: [
                "书阁",
                jsx("span", { className: "ms-crumbSep", children: "/" }),
                e.volumeName || "未分册",
                jsx("span", { className: "ms-crumbSep", children: "/" }),
                e.chapter || "未分章"
              ]
            }),
            editing
              ? jsxs("div", {
                  className: "ms-edit",
                  children: [
                    editError
                      ? jsx("div", {
                          className: "ms-editErr",
                          id: "ms-edit-error",
                          ref: errorRef,
                          role: "alert",
                          "aria-live": "assertive",
                          children: editError
                        })
                      : null,
                    jsx("label", { className: "ms-editLabel", htmlFor: "ms-edit-title", children: "标题" }),
                    jsx("input", {
                      id: "ms-edit-title",
                      ref: titleRef,
                      type: "text",
                      className: "ms-editInput",
                      value: draft.title,
                      spellCheck: false,
                      disabled: saving,
                      "aria-invalid": editErrorField === "title" ? "true" : "false",
                      "aria-describedby": editError ? "ms-edit-error" : undefined,
                      "data-invalid": editErrorField === "title" ? "true" : undefined,
                      onChange: (event) =>
                        changeDraft("title", String((event && event.target && event.target.value) || ""))
                    }),
                    jsxs("div", {
                      className: "ms-editRow",
                      children: [
                        jsx("label", { className: "ms-editLabel", htmlFor: "ms-edit-claim", children: "摘要 · claim" }),
                        jsx("textarea", {
                          id: "ms-edit-claim",
                          ref: claimRef,
                          className: "ms-editArea",
                          style: { minHeight: "64px" },
                          value: draft.claim,
                          disabled: saving,
                          "aria-invalid": editErrorField === "claim" ? "true" : "false",
                          "aria-describedby": editError ? "ms-edit-error" : undefined,
                          "data-invalid": editErrorField === "claim" ? "true" : undefined,
                          onChange: (event) =>
                            changeDraft("claim", String((event && event.target && event.target.value) || ""))
                        })
                      ]
                    }),
                    jsxs("div", {
                      className: "ms-editRow",
                      children: [
                        jsx("label", { className: "ms-editLabel", htmlFor: "ms-edit-why", children: "正文 · why" }),
                        jsx("textarea", {
                          id: "ms-edit-why",
                          ref: whyRef,
                          className: "ms-editArea",
                          value: draft.why,
                          disabled: saving,
                          "aria-invalid": editErrorField === "why" ? "true" : "false",
                          "aria-describedby": editError ? "ms-edit-error" : undefined,
                          "data-invalid": editErrorField === "why" ? "true" : undefined,
                          onChange: (event) =>
                            changeDraft("why", String((event && event.target && event.target.value) || ""))
                        })
                      ]
                    }),
                    jsx("div", {
                      className: "ms-editHint",
                      children: e.bodyIsClaim
                        ? "这条原本只有一句话摘要；正文可以留空，也可以补一段为什么 / 怎么来的。"
                        : "保存会写入本机 Markdown 条目（原 id 不变），搜索与时间线随后刷新。"
                    }),
                    jsxs("div", {
                      className: "ms-editActions",
                      children: [
                        jsx("button", {
                          type: "button",
                          className: "ms-rBtn",
                          "data-tone": "primary",
                          disabled: saving,
                          onClick: saveEntry,
                          children: saving ? "保存中…" : "保存"
                        }),
                        jsx("button", {
                          type: "button",
                          className: "ms-rBtn",
                          disabled: saving,
                          onClick: () => {
                            setEditing(false);
                            setEditError(null);
                            setEditErrorField(null);
                          },
                          children: "取消"
                        })
                      ]
                    })
                  ]
                })
              : jsxs("div", {
                  children: [
                    jsx("h1", { className: "ms-readerTitle", children: e.title || "未命名条目" }),
                    jsx("div", {
                      className: "ms-readerMeta",
                      children: [
                        "置信 " + confidenceLabel(e.confidence),
                        e.authority ? String(e.authority) : null,
                        date || null,
                        e.needsReview ? "待复核" : null
                      ]
                        .filter(Boolean)
                        .join("  ·  ")
                    }),
                    jsxs("div", {
                      className: "ms-readerActions",
                      children: [
                        jsx("button", {
                          type: "button",
                          className: "ms-rBtn",
                          onClick: copyEntry,
                          children: "复制"
                        }),
                        jsx("button", {
                          type: "button",
                          className: "ms-rBtn",
                          onClick: beginEdit,
                          children: "编辑"
                        })
                      ]
                    }),
                    notice
                      ? jsx("div", {
                          className: "ms-toast",
                          "data-tone": notice.tone,
                          role: "status",
                          "aria-live": "polite",
                          children: notice.text
                        })
                      : null,
                    e.claim
                      ? jsx("div", { className: "ms-readerClaim", children: String(e.claim) })
                      : null,
                    hasWhy
                      ? jsxs("div", {
                          children: [
                            jsx("div", { className: "ms-sec", style: { marginTop: "24px" }, children: "为什么 / 怎么来的" }),
                            jsx("div", { className: "ms-readerBody", children: String(e.body) })
                          ]
                        })
                      : null,
                    e.bodyIsClaim
                      ? jsx("div", {
                          className: "ms-readerNote",
                          children: "这条只存了一句话摘要，没有单独的正文 —— 不是加载失败。"
                        })
                      : null
                  ]
                }),

            traceRows.length > 0
              ? jsxs("details", {
                  className: "ms-fold",
                  children: [
                    jsx("summary", { children: "溯源 · 这条是从哪来的" }),
                    jsxs("div", {
                      className: "ms-kv",
                      children: traceRows.map((row, i) =>
                        jsxs(
                          "div",
                          { style: { display: "contents" }, children: [
                            jsx("div", { className: "ms-kvKey", children: row[0] }),
                            jsx("div", { className: row[2] ? "ms-kvVal" : "ms-kvText", children: row[1] })
                          ] },
                          "tr-" + i
                        )
                      )
                    }),
                    evidenceRows.length > 0
                      ? jsxs("div", {
                          className: "ms-kv",
                          children: evidenceRows.map((row, i) =>
                            jsxs(
                              "div",
                              { style: { display: "contents" }, children: [
                                jsx("div", { className: "ms-kvKey", children: row[0] }),
                                jsx("div", { className: "ms-kvText", children: row[1] })
                              ] },
                              "ev-" + i
                            )
                          )
                        })
                      : null
                  ]
                })
              : null,

            jsxs("details", {
              className: "ms-fold",
              children: [
                jsx("summary", { children: "条目信息" }),
                jsx("div", {
                  className: "ms-kv",
                  children: metaRows.map((row, i) =>
                    jsxs(
                      "div",
                      { style: { display: "contents" }, children: [
                        jsx("div", { className: "ms-kvKey", children: row[0] }),
                        jsx("div", { className: row[2] ? "ms-kvVal" : "ms-kvText", children: row[1] })
                      ] },
                      "meta-" + i
                    )
                  )
                }),
                tags.length > 0
                  ? jsx("div", {
                      className: "ms-tagRow",
                      children: tags.map((tag, i) => jsx("span", { className: "ms-tag", children: String(tag) }, "tag-" + i))
                    })
                  : null
              ]
            })
          ]
        });
      }

      // ── 提炼区块（三层信息密度）────────────────────────────────────────
      //
      // 设计前提（用户明确诉求）：审阅的大部分交给 AI，UI 只负责
      //   "默认什么都不用做，真有需要才打扰人"。
      // 所以 92% 的场景只看第 1 层那一行；第 2 层通常为空；第 3 层默认收起。
      //
      // 三层：
      //   ① 一行状态（待提炼 N 个 / 结论 summary）      ← 永远渲染
      //   ② 只列 needsHuman（空就一行灰字，不渲染列表）  ← 少数情况
      //   ③ <details> 折叠：自动接受 / 自动拒绝明细      ← 要查才展开

      /** 第 3 层：折叠明细。只在真有人想查时才存在。 */
      function DistillDetails(props) {
        const adj = props.adjudication || {};
        const accepted = Array.isArray(adj.accepted) ? adj.accepted : [];
        const rejected = Array.isArray(adj.rejected) ? adj.rejected : [];
        if (accepted.length === 0 && rejected.length === 0) return null;

        const spot = accepted.filter((x) => x && x.spotCheck).length;
        const label =
          "明细 · 自动接受 " +
          accepted.length +
          " 条" +
          (spot > 0 ? "（" + spot + " 条建议抽查）" : "") +
          " · 自动拒绝 " +
          rejected.length +
          " 条";

        return jsx("details", {
          className: "ms-dMore",
          children: [
            jsx("summary", { className: "ms-dSum", children: label }),
            jsx("div", {
              className: "ms-dList",
              children: accepted
                .map((item, index) => {
                  const title = item && item.title ? String(item.title) : "未命名";
                  return jsxs(
                    "div",
                    {
                      className: "ms-dLine",
                      children: [
                        jsx("span", { className: "ms-dLineTitle", title, children: title }),
                        item && item.spotCheck
                          ? jsx("span", { className: "ms-dSpot", children: "建议抽查" })
                          : jsx("span", { className: "ms-dLineWhy", children: "已接受" })
                      ]
                    },
                    "a-" + index
                  );
                })
                .concat(
                  rejected.map((item, index) => {
                    const title = item && item.title ? String(item.title) : "未命名";
                    const reasons = item && Array.isArray(item.reasons) ? item.reasons : [];
                    const why = reasons.length > 0 ? String(reasons[0]) : "已丢弃";
                    return jsxs(
                      "div",
                      {
                        className: "ms-dLine",
                        children: [
                          jsx("span", { className: "ms-dLineTitle", title, children: title }),
                          jsx("span", { className: "ms-dLineWhy", title: why, children: why })
                        ]
                      },
                      "r-" + index
                    );
                  })
                )
            })
          ]
        });
      }

      /** 第 2 层：只列需要人看的。为空时整个列表不渲染。 */
      function DistillHuman(props) {
        const items = Array.isArray(props.items) ? props.items : [];
        // 丢弃会丢掉一条已提炼的提案；不弹 window.confirm（宿主会静默拦截），
        // 而是在原位展开一行「确认/取消」，并记住是哪一条。
        const [confirmReject, setConfirmReject] = react.useState(null);
        react.useEffect(() => {
          setConfirmReject(null);
        }, [props.items]);
        if (items.length === 0) {
          return jsx("div", { className: "ms-dNone", children: "本轮无需你确认" });
        }
        return jsxs("div", {
          className: "ms-dHuman",
          children: [
            jsx("div", {
              className: "ms-dHumanHead",
              children: "需要你看一眼 · " + items.length + " 条"
            }),
            items.map((item, index) => {
              const title = item && item.title ? String(item.title) : "未命名提案";
              const warnings = item && Array.isArray(item.warnings) ? item.warnings : [];
              // 只取第一条原因：这里要"一句话说清为什么打扰你"
              const why = warnings.length > 0 ? String(warnings[0]) : "AI 判断置信度不足，需要人工确认";
              const accepted = !!(props.decided && props.decided[index] === "accept");
              const dropped = !!(props.decided && props.decided[index] === "reject");
              return jsxs(
                "div",
                {
                  className: "ms-dItem",
                  children: [
                    jsx("div", { className: "ms-dItemTitle", title, children: title }),
                    jsx("div", { className: "ms-dItemWhy", title: why, children: why }),
                    jsxs("div", {
                      className: "ms-dItemActions",
                      children: [
                        jsx("button", {
                          type: "button",
                          className: "ms-dBtn",
                          "data-tone": "primary",
                          disabled: accepted || dropped,
                          onClick: () => props.onDecide && props.onDecide(index, "accept"),
                          children: accepted ? "已通过" : "通过"
                        }),
                        dropped
                          ? jsx("button", {
                              type: "button",
                              className: "ms-dBtn",
                              "data-tone": "danger",
                              disabled: true,
                              children: "已丢弃"
                            })
                          : confirmReject === index
                            ? jsxs("div", {
                                className: "ms-dConfirmInline",
                                role: "group",
                                "aria-label": "确认丢弃这条提案",
                                children: [
                                  jsx("span", {
                                    className: "ms-dConfirmText",
                                    children: "丢弃后不会入册，确定？"
                                  }),
                                  jsx("button", {
                                    type: "button",
                                    className: "ms-dBtn",
                                    "data-tone": "dangerConfirm",
                                    onClick: () => {
                                      setConfirmReject(null);
                                      if (props.onDecide) props.onDecide(index, "reject");
                                    },
                                    children: "确认丢弃"
                                  }),
                                  jsx("button", {
                                    type: "button",
                                    className: "ms-dBtn",
                                    onClick: () => setConfirmReject(null),
                                    children: "取消"
                                  })
                                ]
                              })
                            : jsx("button", {
                                type: "button",
                                className: "ms-dBtn",
                                "data-tone": "danger",
                                disabled: accepted,
                                onClick: () => setConfirmReject(index),
                                children: "丢弃"
                              })
                      ]
                    })
                  ]
                },
                "h-" + index
              );
            })
          ]
        });
      }

      // 本轮将提炼的会话清单（2026-11-05 新增）
      //
      // 【为什么必须有】用户原话：「可以一轮 20 个，但是得让用户知道这是在
      //  干什么，都提炼的哪些内容」。此前 /distill/plan 早就返回了 willDistill
      //  数组（index.js:2317，A 块改造后行号），但前端一次都没消费过 ——
      //  用户只看到一个数字 20，不知道自己押上了哪 20 段对话。
      //  这里是"把钱花在哪"的透明度问题。
      //
      // 数据来自已有的 distillPlan 请求，**不额外轮询**（/plan 会强制刷新快照，
      // 多打一次就多扫一次盘）。数组默认只露前 5 行，其余收进 <details>，
      // 20 行全铺开会把整个面板撑爆。
      function WillDistillList(props) {
        const items = props && Array.isArray(props.items) ? props.items : [];
        if (items.length === 0) return null;

        // 单行。字段全部做兜底：title 缺了退 sid，sid 再缺退占位文案。
        function row(item, index) {
          const r = item || {};
          const title = r.title ? String(r.title) : r.sid ? String(r.sid) : "未命名会话";
          const score = r.qualityScore != null ? r.qualityScore : null;
          // admission / shape 是后端英文枚举，翻译成短中文；
          // 认不出的值原样显示（不吞掉未知信息，也不假装认识）
          const shapeText =
            r.shape === "multi-turn" ? "多轮" : r.shape === "one-shot" ? "单轮" : r.shape ? String(r.shape) : "";
          const admText =
            r.admission === "strong" ? "强依据" : r.admission === "weak" ? "弱依据" : r.admission ? String(r.admission) : "";
          return jsxs(
            "div",
            {
              className: "ms-wdRow",
              children: [
                jsx("span", { className: "ms-wdTitle", title, children: title }),
                jsx("span", { className: "ms-wdTag", children: shapeText }),
                jsx("span", { className: "ms-wdTag", children: admText }),
                jsx("span", {
                  className: "ms-wdScore",
                  style: { color: scoreTone(score) },
                  title: score != null ? "质量分 " + fmtNum(score) : "无质量分",
                  children: score != null ? fmtNum(score) : "--"
                })
              ]
            },
            r.sid != null ? String(r.sid) : "wd-" + index
          );
        }

        const HEAD = 5;
        const head = items.slice(0, HEAD);
        const rest = items.slice(HEAD);
        return jsxs("div", {
          className: "ms-wd",
          children: [
            jsx("div", {
              className: "ms-wdHead",
              children: "本轮将提炼 · " + items.length + " 段对话"
            }),
            jsx("div", { className: "ms-wdList", children: head.map(row) }),
            rest.length > 0
              ? jsxs("details", {
                  className: "ms-dMore",
                  children: [
                    jsx("summary", {
                      className: "ms-dSum",
                      children: "展开其余 " + rest.length + " 段"
                    }),
                    jsx("div", { className: "ms-wdList", children: rest.map((item, i) => row(item, i + HEAD)) })
                  ]
                })
              : null
          ]
        });
      }

      /** 整个提炼区块。 */
      function DistillPanel(props) {
        const phase = props.phase; // idle | planning | ready | running | done | error
        const plan = props.plan; // /plan 的返回
        const result = props.result; // /run 的返回
        const error = props.error;
        const progress = props.progress || { startedAt: 0, elapsed: 0 };
        const decided = props.decided || {};
        // 可选模型清单与当前选中（来自 /plan 响应）
        const models = plan && Array.isArray(plan.models) ? plan.models : [];
        // 优先用用户刚选的（props.pickedModel），其次才是后端返回的
        const currentModel = props.pickedModel
          ? String(props.pickedModel)
          : plan && plan.currentModel
            ? String(plan.currentModel)
            : "";

        const busy = phase === "running" || phase === "planning";

        // ── 二次确认（D-03，2026-11-06）──────────────────────────────
        // 【为什么这是必需的不是可选的】一次点击的真实代价（实测 run 凭证）：
        //   7 次 LLM 调用 / 2.2 万 prompt 字符 / 约 38 秒 / 并且直接写真实书库。
        // 原来点下去立刻开跑，界面全程不提代价 —— 用户以为是个"预览"。
        // 现在拆成两步：点「开始提炼」只把这块区域展开，点「确认提炼」才发请求。
        //
        // 为什么用 state 而不是 window.confirm：
        //   ① window.confirm 无法排版，塞不进 4 个字段的表格；
        //   ② Node 侧测试环境里没有 window.confirm，写不了断言；
        //   ③ 某些宿主（Electron 自定义窗口）会把它静默拦掉 → 变成"点了没反应"。
        //
        // 状态本身放在 ManuscriptPage（和 runDistill 同一作用域），这里只负责渲染。
        // 之所以不放组件内：判定"该不该弹"必须和"真正发请求"在同一个函数里，
        // 否则 dryRun 预演这条豁免规则会散落两处，迟早对不上（预演也开始弹确认）。
        const confirming = !!props.confirming;
        // 提炼面板也要显示快照年龄（D-05）：这一区的"已提炼 X / 剩余 Y"同样来自
        // /summary 的内存快照，数字过期时用户会以为提炼没生效。
        const staleText = staleTextOf(props.summary);

        // ── 第 1 层文案 ──
        // 优先级：进行中 > 本轮结论 > 预演 > 未扫到
        let line = "";
        let dim = false;
        if (phase === "running") {
          line = "提炼中… 已跑 " + Math.round(progress.elapsed / 1000) + " 秒";
        } else if (result && result.adjudication && result.adjudication.summary) {
          // 后端已经拼好了人话，直接用，不要自己再拼
          line = String(result.adjudication.summary);
        } else if (phase === "error" && error) {
          line = "提炼失败：" + error;
        } else if (plan && plan.ok) {
          // 【2026-11-05 修正】这里原来写 `const q = num(plan.queue)`。
          // num() 把 null/undefined 变成 0 → 走进 q === 0 分支 →
          // 把"不知道队列多少"显示成"没有待提炼的会话"。
          // 那是最坏的一种谎：它让用户以为活已经干完了。
          // 现在保留 null 三态：q === null → 数据没到；q === 0 → 真的没有。
          const qRaw = plan.queue;
          const q = qRaw == null ? null : num(qRaw);
          // 同理：calls / chars 缺失时不要渲染成"预计 0 次调用"。
          // 2026-11-24（整改 4.4）：后端直接给 estCalls（按每批 2 会话算），优先用它。
          const calls = plan.estCalls != null
            ? optNum(plan.estCalls)
            : plan.plan && plan.plan.calls != null
              ? optNum(plan.plan.calls)
              : null;
          const chars = plan.plan && plan.plan.totalChars != null ? optNum(plan.plan.totalChars) : null;
          // 【2026-11-05】状态行改成"进度 + 本轮 + 剩余"。
          // 原本文案只有"待提炼 N 个" —— 用户看不出自己在 218 里的哪一格，
          // 也不知道点下去之后还剩多少。这正是"我不知道一共提炼了多少"。
          // 拿不到的字段渲染 "--"，不用 0 顶替（0 会被读成"一个都没有"）。
          const prog = distillProgressOf(plan, props.summary);
          const parts = [];
          if (prog.distilled != null || prog.realTotal != null) {
            parts.push("已提炼 " + fmtOrDash(prog.distilled) + " / " + fmtOrDash(prog.realTotal));
          }
          if (q === null) {
            // 队列数没拿到：只报已知的进度，不猜"没有了"
            parts.push("队列待读取");
            dim = true;
          } else if (q === 0) {
            // 队列确实空：这时"已提炼 218 / 218"才是用户想看的结论，
            // 只写"暂无可提炼"等于把最重要的数字藏起来。
            parts.push("没有待提炼的会话");
            dim = true;
          } else {
            parts.push("本轮 " + fmtNum(q) + " 个");
            if (prog.remaining != null) parts.push("剩余 " + fmtNum(prog.remaining) + " 个");
            if (calls != null) {
              parts.push(
                "预计 " + fmtNum(calls) + " 次调用" +
                (chars != null && chars > 0 ? " · 约 " + fmtCharK(chars) : "")
              );
            }
            // 上一次实跑耗时：让"点下去要等多久"有参照，而不是只看到次数。
            const lastMs = plan.lastRun && Number.isFinite(plan.lastRun.durationMs) ? plan.lastRun.durationMs : null;
            if (lastMs != null && lastMs > 0) {
              parts.push("上次 " + (lastMs >= 1000 ? (lastMs / 1000).toFixed(1) + " 秒" : Math.round(lastMs) + " 毫秒"));
            }
          }
          line = parts.join(" · ");
          if (plan.busy) {
            line = "已有提炼在跑，请稍候";
            dim = true;
          }
        } else {
          line = "正在读取提炼状态…";
          dim = true;
        }
        // 【D-05 前端 2026-11-06】把这批数字的"新鲜度"接到状态行末尾。
        // 只在后端明确 stale === true 时才有内容（staleTextOf 返回空串即不显示）。
        // 不用 0 顶替：字段缺失时安静地不显示，比编一句"0 分钟前"诚实。
        if (staleText) line = line ? line + " · " + staleText : staleText;

        // ── 按钮状态 ──
        // 注意这里同样不能用 num(plan.queue) === 0 判断"无可提炼"：
        // queue 缺失时 num 给 0，会把按钮误禁成"无可提炼"，让用户以为活干完了。
        // 只有 queue 确实是数字 0 才禁用。
        const queueKnown = plan && plan.ok && plan.queue != null;
        let actionLabel = "开始提炼";
        let actionDisabled = busy;
        if (phase === "running") actionLabel = "提炼中…";
        else if (phase === "ready" && queueKnown && num(plan.queue) === 0) {
          actionLabel = "无可提炼";
          actionDisabled = true;
        } else if (phase === "done" || result) actionLabel = "再跑一轮";

        // 进度条：进行中时显示一条不确定宽度的条，并按时长微增，给"还在动"的信号
        const barWidth = phase === "running" ? Math.min(92, 8 + progress.elapsed / 60) : 0;

        // ── 确认区要显示的成本（D-03，2026-11-06）────────────────────
        // 四个数全部来自已有的 /plan 响应，**不额外发请求**（点一下不该触发扫描）。
        // 每个字段先过 optNum 再渲染：缺失一律「未知」，绝不用 0 顶替 ——
        // "预计 0 次调用"会让用户以为这一轮免费，而真实代价可能是 7 次。
        const confQueue = plan && plan.ok && plan.queue != null ? optNum(plan.queue) : null;
        const confCalls = plan && plan.plan && plan.plan.calls != null ? optNum(plan.plan.calls) : null;
        const confChars = plan && plan.plan && plan.plan.totalChars != null ? optNum(plan.plan.totalChars) : null;
        // 模型名：拿不到就「未知」。不要回落到"默认模型"这种猜测性文案 ——
        // 用户是拿这个名字去对账单的，写错比写不出更糟。
        const confModel = currentModel ? String(currentModel) : "";
        const confRows = [
          { key: "本轮会话", value: confQueue == null ? "未知" : fmtNum(confQueue) + " 个" },
          { key: "模型调用", value: confCalls == null ? "未知" : "约 " + fmtNum(confCalls) + " 次" },
          // 字符数用原数而不是 fmtCharK：确认区是"看账单"，模糊成 22k 会掩盖量级差异。
          { key: "输入字符", value: confChars == null ? "未知" : "约 " + fmtNum(confChars) + " 字符" },
          { key: "模型", value: confModel || "未知" }
        ];

        const humanItems = result && result.adjudication && Array.isArray(result.adjudication.needsHuman)
          ? result.adjudication.needsHuman
          : [];

        return jsxs("div", {
          className: "ms-distill",
          children: [
            // ① 状态行
            jsxs("div", {
              className: "ms-dRow",
              children: [
                jsx("span", { className: "ms-dTag", children: "提炼" }),
                jsx("span", {
                  className: "ms-dText",
                  "data-dim": String(dim),
                  title: line,
                  children: line
                }),
                // ── 模型选择 ──
                // 为什么放在按钮左边而不是藏进设置：提炼是个花钱的操作，
                // 用户在点之前就应该能看到"用哪个模型"，而不是点完才发现选错。
                models.length > 0
                  ? jsx("select", {
                      className: "ms-dSel",
                      "aria-label": "提炼用的模型",
                      value: currentModel || "",
                      disabled: busy,
                      onChange: (e) => {
                        if (typeof props.onPickModel === "function") props.onPickModel(e.target.value);
                      },
                      children: models.map((m) =>
                        jsx("option", { value: m.id, children: m.fast ? m.label + " · 快" : m.label }, m.id)
                      )
                    })
                  : null,
                jsx("button", {
                  type: "button",
                  className: "ms-dBtn",
                  "data-tone": "primary",
                  disabled: actionDisabled,
                  // 【坑 2026-11-02】不能写 onClick: props.onRun ——
                  // React 会把事件对象作为第一个参数传进去，而 runDistill(dryRun)
                  // 判断 dryRun 真值 → 事件对象是真值 → 走了预演而不是真跑。
                  // 症状：点"开始提炼"后按钮变"再跑一轮"，过一阵又恢复原样。
                  //
                  // 【D-03 2026-11-06】这里改成 onRequestRun：它只负责"要不要先问一句"，
                  // 不再直接发网络请求。真正发请求的是确认区里的「确认提炼」。
                  onClick: () => { if (typeof props.onRequestRun === "function") props.onRequestRun(false); },
                  children: actionLabel
                })
              ]
            }),

            // ── 二次确认区（D-03，2026-11-06）──────────────────────────
            // 只在用户点了「开始提炼」之后出现，且只在真跑（非 dryRun）路径上。
            // 这是"花钱前的最后一道门"：左边列出本轮会花掉什么，右边两个按钮。
            // 缺任何一个数都显示「未知」，绝不显示 0 —— 见上方 confRows 注释。
            //
            // `!busy` 这层门：确认区开着的时候用户完全可能从别处（另一个窗口、
            // 另一个标签页）起了一轮提炼。那时若还留着「确认提炼」，点下去就是
            // 第二次重复扣费。已在进行中就不该再问"要不要开跑"。
            confirming && !busy
              ? jsxs("div", {
                  className: "ms-dConfirm",
                  role: "group",
                  "aria-label": "提炼代价确认",
                  children: [
                    jsx("div", {
                      className: "ms-dConfHead",
                      children: "确认提炼 · 这一步会真实产生费用"
                    }),
                    jsx("div", {
                      className: "ms-dConfGrid",
                      children: confRows.reduce((acc, row) => {
                        acc.push(jsx("span", { className: "ms-dConfKey", children: row.key }, "k-" + row.key))
                        acc.push(jsx("span", { className: "ms-dConfVal", title: row.value, children: row.value }, "v-" + row.key))
                        return acc
                      }, [])
                    }),
                    jsx("div", {
                      className: "ms-dConfWarn",
                      children: "这会真实调用模型并写入书库，不是预演。取消不会改变任何数字。"
                    }),
                    jsxs("div", {
                      className: "ms-dConfActions",
                      children: [
                        jsx("button", {
                          type: "button",
                          className: "ms-dBtn",
                          "data-tone": "primary",
                          // 确认后立刻收起确认区：否则 running 期间它还会挂着，
                          // 用户会以为要再点一次才开跑。
                          onClick: () => {
                            if (typeof props.onConfirmRun === "function") props.onConfirmRun();
                          },
                          children: "确认提炼"
                        }),
                        jsx("button", {
                          type: "button",
                          className: "ms-dBtn",
                          onClick: () => {
                            if (typeof props.onCancelRun === "function") props.onCancelRun();
                          },
                          children: "取消"
                        })
                      ]
                    })
                  ]
                })
              : null,

            // 进行中：细进度条 + 心跳，避免"以为卡死"
            phase === "running"
              ? jsx("div", {
                  className: "ms-dBar",
                  children: jsx("div", { className: "ms-dBarFill", style: { width: barWidth.toFixed(1) + "%" } })
                })
              : null,
            phase === "running"
              ? jsxs("div", {
                  className: "ms-dBusy",
                  children: [
                    jsx("span", { className: "ms-dDot" }),
                    jsx("span", {
                      children:
                        "模型正在逐批提炼，通常 20–180 秒。" +
                        (result && result.plan ? "本轮 " + num(result.plan.sessionCount || result.queue) + " 个会话" : "")
                    })
                  ]
                })
              : null,

            // 失败要显式显示，不能静默
            phase === "error" && error
              ? jsx("div", { className: "ms-dErr", role: "alert", children: error })
              : null,

            // ── 本轮将提炼的清单（2026-11-05）────────────────────────
            // 只在"还没跑"的状态下显示：提炼中/已出结果时，这一区被
            // needsHuman 与明细接管，再列一遍会重复且让人分不清哪个是"将"。
            // 数据直接取已有的 /plan 响应，不额外发请求。
            phase !== "running" && !result && plan && plan.ok
              ? jsx(WillDistillList, { items: plan.willDistill })
              : null,

            // ── 入册按钮（2026-11-03 新增）──────────────────────────
            // 提炼只是"生成提案"，入册才是"写入书库"。两者之间必须有人过一道
            // （行为规约第 9 条：写入手册要人确认），所以不自动入册。
            // 但没有这个按钮时，用户根本无法独立完成整条流程 —— 实测
            // API_DISTILL_COMMIT 定义了却从未被前端使用。
            result && Array.isArray(result.entries) && result.entries.length > 0
              ? jsxs("div", {
                  className: "ms-dRow",
                  style: { marginTop: "8px", gap: "8px", flexWrap: "wrap" },
                  children: [
                    jsx("button", {
                      type: "button",
                      className: "ms-dBtn",
                      "data-tone": "primary",
                      disabled: !!props.committing,
                      onClick: () => { if (typeof props.onCommit === "function") props.onCommit(); },
                      children: props.committing
                        ? "入册中…"
                        : "入册这 " + num(result.entries.length) + " 条"
                    }),
                    props.commitMsg
                      ? jsx("span", {
                          className: "ms-dText",
                          style: { color: /失败/.test(props.commitMsg) ? "var(--t-red)" : "var(--t-green)" },
                          children: props.commitMsg
                        })
                      : null
                  ]
                })
              : null,

            // ② 只列需要人看的（结论出来后才有）
            result && result.adjudication
              ? jsx(DistillHuman, {
                  items: humanItems,
                  decided,
                  onDecide: props.onDecide
                })
              : null,

            // ③ 折叠明细
            result && result.adjudication
              ? jsx(DistillDetails, { adjudication: result.adjudication })
              : null
          ]
        });
      }

      // ── 巡检设置（2026-11-12）────────────────────────────────────────────
      //
      // 【它为什么不是一个"设置页"】巡检只有两个旋钮（开/关、几点），为两个字段
      // 单开一页等于让用户多点两下才能确认"每天到底几点跑"。放在维护区里、
      // 一行看全状态，更符合"我只想知道它会不会在半夜跑"。
      //
      // 【它不直接改 timer】前端只 POST 设置文件；systemd path unit 负责把文件
      // 变化落到 OnCalendar 并 enable/disable。所以这里**不能**显示"已生效"这种
      // 断言 —— 我们能确认的只有"已保存"和"后端算出的下一次"。
      function CheckSettingsPanel(props) {
        const state = props.state || {};
        const data = state.data;
        const settings = data && data.settings && typeof data.settings === "object" ? data.settings : null;
        const loaded = !!(settings && typeof settings.time === "string");
        const busy = props.phase === "saving" || props.phase === "running";
        const nextRun = data ? data.nextRun : null;
        const warnings = data && Array.isArray(data.warnings) ? data.warnings : [];
        // 草稿与已保存值的差异必须显式说出来：勾选框是草稿，状态行是磁盘真值。
        // 不说的话，用户勾上开关以为已经好了，其实要再点一次保存（实测踩过）。
        const dirty = loaded && (!!props.enabled !== !!settings.enabled || String(props.time || "") !== settings.time);

        let status = "";
        let dim = false;
        if (!loaded) {
          if (state.phase === "error") {
            status = "巡检设置读取失败：" + String(state.error || "未知原因");
          } else {
            status = "正在读取巡检设置…";
          }
          dim = true;
        } else if (settings.enabled) {
          status = "已启用 · 每天 " + settings.time;
        } else {
          status = "已停用 · 不会自动巡检";
        }

        // 下次运行：停用就是"无"，不留空；后端没给 nextRun 也不编一个时间。
        let nextText = "";
        if (loaded) {
          if (!settings.enabled) {
            nextText = "下次运行：无（已停用）";
          } else if (nextRun) {
            // timer 带 RandomizedDelaySec=60，实际触发是 HH:MM:00 ~ HH:MM:59。
            // 与其写一个精确到秒的假承诺，不如把这段误差写在明面上。
            nextText = "下次运行：约 " + fmtNextRun(nextRun) + "（timer 有 0–60 秒随机延迟）";
          } else {
            nextText = "下次运行：未知（后端未给出时间）";
          }
        }

        return jsxs("div", {
          className: "ms-check",
          children: [
            jsxs("div", {
              className: "ms-dRow",
              children: [
                jsx("span", { className: "ms-dTag", children: "巡检" }),
                jsx("span", {
                  className: "ms-dText",
                  "data-dim": String(dim),
                  title: status,
                  children: status
                }),
                jsx("button", {
                  type: "button",
                  className: "ms-dBtn",
                  disabled: busy || !loaded,
                  // 同 DistillPanel 的坑：不能写 onClick: props.onRun，
                  // 否则 React 会把事件对象当参数传进去。
                  onClick: () => props.onRun(),
                  children: props.phase === "running" ? "触发中…" : "立即运行"
                })
              ]
            }),
            jsxs("div", {
              className: "ms-cRow",
              children: [
                jsxs("label", {
                  className: "ms-cToggle",
                  children: [
                    jsx("input", {
                      type: "checkbox",
                      checked: !!props.enabled,
                      disabled: busy || !loaded,
                      onChange: (e) => props.onEnabled(!!(e && e.target && e.target.checked))
                    }),
                    jsx("span", { children: "每天自动巡检" })
                  ]
                }),
                jsx("input", {
                  type: "time",
                  className: "ms-cTime",
                  value: props.time || "07:00",
                  step: 60,
                  "aria-label": "巡检时间",
                  // 停用时时间输入也禁用：留一个能改的框会让人以为改了就会跑。
                  disabled: busy || !loaded || !props.enabled,
                  onChange: (e) => props.onTime(String((e && e.target && e.target.value) || ""))
                }),
                jsx("span", { className: "ms-cSpacer" }),
                jsx("button", {
                  type: "button",
                  className: "ms-dBtn",
                  "data-tone": "primary",
                  disabled: busy || !loaded,
                  onClick: () => props.onSave(),
                  children: props.phase === "saving" ? "保存中…" : "保存"
                })
              ]
            }),
            dirty
              ? jsx("div", { className: "ms-cWarn", children: "有未保存的修改 —— 点「保存」后才会写盘并由 systemd 应用" })
              : null,
            nextText ? jsx("div", { className: "ms-cNote", children: nextText }) : null,
            warnings.length > 0
              ? jsx("div", { className: "ms-cWarn", children: "设置已回落：" + warnings.join("；") })
              : null,
            props.msg
              ? jsx("div", { className: "ms-cNote", "data-tone": props.msg.tone, children: props.msg.text })
              : null
          ]
        });
      }

      // 书房 · 三个安静的数字（替代原来的四格漏斗）
      //
      // 为什么不再用进度条：漏斗表达的是"处理流水线的转化率"，那是维护者视角；
      // 读者只想知道"这本手册里有多少可查的东西"。三格不带比例，反而不会
      // 因为"分母口径不同"造成误读 —— 这正是之前 278/389 矛盾的来源。
      function Statline(props) {
        const summary = (props && props.summary) || {};
        // 2026-11-24 用户反馈：只有「223 段会话 / 0 已提炼 / 211 条经验」三个词，
        // 新用户看不懂是什么。改成「数字 + 名字 + 一句解释」，并给 0 值补一句可行动的提示。
        const distilled = distilledOf(summary);
        const cells = [
          { key: "total", label: "对话", value: optNum(summary.total),
            hint: "扫到并整理过的会话数" },
          { key: "distilled", label: "已整理", value: distilled,
            hint: "其中已产出结论的会话" },
          { key: "conclusions", label: "真结论", value: optNum(summary.conclusionEntries),
            hint: "提炼出来、能直接引用的经验条数" },
          { key: "skeletons", label: "索引骨架", value: optNum(summary.skeletonEntries),
            hint: "每个会话一条的索引卡，只有统计没有结论" }
        ];
        return jsx("div", {
          className: "ms-statline",
          children: cells.map((cell) =>
            jsxs(
              "div",
              {
                className: "ms-stat",
                children: [
                  jsxs("div", {
                    children: [
                      jsxs("div", {
                        className: "ms-statValue",
                        children: [
                          jsx("span", { className: "ms-statNum", children: fmtOrDash(cell.value) }),
                          jsx("span", { className: "ms-statLabel", children: cell.label })
                        ]
                      }),
                      jsx("span", { className: "ms-statHint", children: cell.hint })
                    ]
                  })
                ]
              },
              cell.key
            )
          )
        });
      }

      /**
       * 索引骨架说明（2026-11-24 整改 P0-1）。
       *
       * 为什么必须常驻、且骨架数为 0 时也显示：
       *   「索引骨架」对第一次看到的人是陌生概念，只给一个数字等于没解释。
       *   这段说明要回答四个问题：从哪来（本地会话）、是不是 LLM 写的（零 LLM）、
       *   怎么变成经验（去提炼）、不想要怎么办（折叠 + 自动退役）。
       *   0 条同样要解释 —— 否则读者会以为「没显示 = 功能不存在」。
       */
      function SkeletonNote(props) {
        const summary = (props && props.summary) || {};
        const n = optNum(summary.skeletonEntries);
        return jsxs("div", {
          className: "ms-skelNote",
          children: [
            jsx("b", { children: "索引骨架" }),
            "：来自本地会话的统计卡，零 LLM 生成，只记轮次与工具调用，不含结论。" +
              "目录里默认收进「索引」折叠、不占首屏；同会话出现真结论后会自动退役。" +
              "要变成可引用的经验，到页面底部「维护与巡检 → 提炼与入库」运行提炼。" +
              (n == null ? "" : "当前 " + fmtNum(n) + " 条。")
          ]
        });
      }

      // ── 库路径（2026-11-12）─────────────────────────────────────────────
      //
      // 【为什么单独一块】这是「多实例共享」的唯一开关：两个 DSH 实例只要指向
      // 同一个目录，读到的就是同一批 Markdown。不需要端口、不需要登录。
      //
      // 【为什么不和巡检设置合并】巡检是 systemd 的调度，库路径是数据位置；
      // 混在一起会让人以为改路径会顺手重启巡检。
      function LibraryRootPanel(props) {
        const cfg = useJson(API_LIBRARY_CONFIG);
        const summaryState = props && props.summary ? props.summary : null;
        const summary = summaryState && summaryState.phase === "ready" ? summaryState.data : null;
        const [draft, setDraft] = react.useState("");
        const [synced, setSynced] = react.useState(false);
        const [phase, setPhase] = react.useState("idle"); // idle | saving
        const [msg, setMsg] = react.useState(null); // {tone, text}
        const data = cfg.data || {};
        const loaded = typeof data.root === "string";
        const busy = phase === "saving";
        const dirty = loaded && draft.trim() !== String(data.root || "");
        const sourceText = data.source === "env"
          ? "环境变量覆盖"
          : data.source === "config"
            ? "面板配置"
            : "默认路径";
        const warnings = Array.isArray(data.warnings) ? data.warnings : [];

        // 只在首次拿到真值时灌入草稿；之后用户改什么就是什么（同巡检区的回灌坑）。
        react.useEffect(() => {
          if (synced) return;
          if (!loaded) return;
          setDraft(data.root);
          setSynced(true);
        }, [data.root, loaded, synced]);

        const save = react.useCallback(async () => {
          setPhase("saving");
          setMsg(null);
          try {
            const r = await postJson(API_LIBRARY_CONFIG, { root: draft.trim() });
            setDraft(String(r.root || draft.trim()));
            setSynced(true);
            invalidate(API_SUMMARY);
            invalidate(API_LIBRARY_CONFIG);
            const bits = [];
            if (r.entries != null) bits.push(String(r.entries) + " 条");
            if (r.volumes != null) bits.push(String(r.volumes) + " 册");
            const suffix = r.effective === false
              ? "已保存，但环境变量正在覆盖，当前未生效"
              : "已切换" + (bits.length ? " · " + bits.join(" / ") : "");
            setMsg({
              tone: r.effective === false ? "err" : "ok",
              text: suffix + (Array.isArray(r.warnings) && r.warnings.length ? "（" + r.warnings.join("；") + "）" : "")
            });
          } catch (e) {
            setMsg({ tone: "err", text: "保存失败：" + String(e && e.message ? e.message : e) });
          } finally {
            setPhase("idle");
          }
        }, [draft]);

        let status = "正在读取库路径…";
        if (cfg.phase === "error") status = "库路径读取失败：" + String(cfg.error || "未知原因");
        else if (loaded) status = sourceText + " · " + (data.storage || "未知格式") + (data.entries != null ? " · 盘上 " + data.entries + " 条" : "");

        // 页头写的是「可翻条目」（目录里点得到的），这里写的是「盘上条目」（含退役/打灰）。
        // 两个数字并存但不解释，用户只会以为其中一个错了 —— 所以把差额拆开写清。
        const diskEntries = optNum(summary && summary.entries);
        const visibleEntries = optNum(summary && summary.catalogEntries);
        const retiredEntries = optNum(summary && summary.retiredEntries);
        const grayedEntries = optNum(summary && summary.grayedEntries);
        const uncatalogedEntries = optNum(summary && summary.uncatalogedEntries);
        const lossBits = [];
        if (retiredEntries != null) lossBits.push("已退役 " + fmtNum(retiredEntries));
        if (grayedEntries != null) lossBits.push("已打灰 " + fmtNum(grayedEntries));
        let reconciliation = "";
        if (diskEntries != null && visibleEntries != null) {
          reconciliation =
            "盘上 " + fmtNum(diskEntries) + " 条 / 可翻 " + fmtNum(visibleEntries) + " 条" +
            (lossBits.length ? "（" + lossBits.join("、") + "）" : "") +
            "。差额是主动移出主视图的旧条目，不丢数据。";
          if (uncatalogedEntries != null && uncatalogedEntries > 0) {
            reconciliation += "另有 " + fmtNum(uncatalogedEntries) + " 条不可查（已损）。";
          }
        }

        return jsxs("div", {
          className: "ms-check",
          children: [
            jsxs("div", {
              className: "ms-dRow",
              children: [
                jsx("span", { className: "ms-dTag", children: "库路径" }),
                jsx("span", {
                  className: "ms-dText",
                  "data-dim": String(!loaded),
                  title: status,
                  children: status
                })
              ]
            }),
            reconciliation
              ? jsxs("div", {
                  className: "ms-dRow",
                  children: [
                    jsx("span", { className: "ms-dTag", children: "口径" }),
                    jsx("span", { className: "ms-dText", children: reconciliation })
                  ]
                })
              : null,
            jsxs("div", {
              className: "ms-cRow",
              children: [
                jsx("input", {
                  type: "text",
                  className: "ms-cInput",
                  value: draft,
                  spellCheck: false,
                  "aria-label": "书库根目录",
                  placeholder: "绝对路径，例如 /home/you/.dsh/dsh-manuscript",
                  disabled: busy || !loaded,
                  onChange: (e) => setDraft(String((e && e.target && e.target.value) || ""))
                }),
                jsx("button", {
                  type: "button",
                  className: "ms-dBtn",
                  "data-tone": "primary",
                  disabled: busy || !loaded || !dirty,
                  onClick: save,
                  children: busy ? "切换中…" : "保存"
                })
              ]
            }),
            jsx("div", {
              className: "ms-cNote",
              children: "多个 DSH 实例（web / superagent）指向同一路径即可共享；条目以 Markdown 为准，切换后本进程立即重扫。"
            }),
            loaded && data.configFile
              ? jsx("div", { className: "ms-cNote", children: "配置文件：" + data.configFile })
              : null,
            dirty
              ? jsx("div", { className: "ms-cWarn", children: "有未保存的修改 —— 点「保存」后才会写配置并重扫" })
              : null,
            warnings.length > 0
              ? jsx("div", { className: "ms-cWarn", children: "配置警告：" + warnings.join("；") })
              : null,
            msg
              ? jsx("div", { className: "ms-cNote", "data-tone": msg.tone, children: msg.text })
              : null
          ]
        });
      }

      /**
       * 卡片分区（v1.3.0 控制面板）：每一块功能用同一套骨架。
       * 标题栏 16px/700 + 分隔线 + 卡片边界；meta 只放短数字/状态（等宽），
       * body 自带 16px 留白。flush=true 用于列表型内容，让行自己贴边。
       */
      function CardSection(props) {
        const p = props || {};
        return jsxs("section", {
          className: "ms-cardsec" + (p.className ? " " + p.className : ""),
          "aria-label": p.title ? String(p.title) : undefined,
          children: [
            p.title
              ? jsxs("header", {
                  className: "ms-cardsecHead",
                  children: [
                    jsx("h2", { className: "ms-cardsecTitle", children: p.title }),
                    p.meta ? jsx("span", { className: "ms-cardsecMeta", children: p.meta }) : null,
                    p.actions ? jsx("div", { className: "ms-cardsecActions", children: p.actions }) : null
                  ]
                })
              : null,
            p.hint ? jsx("p", { className: "ms-cardsecHint", children: p.hint }) : null,
            jsx("div", {
              className: "ms-cardsecBody",
              "data-flush": p.flush ? "true" : undefined,
              children: p.children
            })
          ]
        });
      }

      /** 书房 · 工具与调试卡的摘要行（不重复整页工具架）。 */
      function ToolSummary(props) {
        const state = (props && props.state) || {};
        if (state.phase === "error") {
          return jsx("p", {
            className: "ms-searchEntryHint",
            children: "工具列表读取失败：" + String(state.error || "未知原因") + "。可到工具架页重试。"
          });
        }
        if (!ready(state)) {
          return jsx("p", { className: "ms-searchEntryHint", children: "正在读取工具列表…" });
        }
        const d = state.data || {};
        const sum = d.summary || {};
        return jsxs("div", {
          className: "ms-toolSummary",
          children: [
            jsxs("span", { children: [jsx("b", { children: fmtOrDash(sum.visibleToolCount) }), " 个可见工具"] }),
            jsxs("span", { children: [jsx("b", { children: fmtOrDash(sum.schemaKb) + " KB" }), " schema 占用"] }),
            jsxs("span", { children: [jsx("b", { children: fmtOrDash(sum.unmountedPackCount) }), " 个未挂载包"] }),
            props.onGoTools
              ? jsx("button", {
                  type: "button",
                  className: "ms-btn",
                  onClick: props.onGoTools,
                  children: "打开工具架 →"
                })
              : null
          ]
        });
      }

      function ShelfView(props) {
        const summary = props.summary;
        const sessions = props.sessions;
        const recent = props.recent;
        const volumes = props.volumes;
        const tools = props.tools;
        const onOpenVolume = props.onOpenVolume;
        const onOpenEntry = props.onOpenEntry;
        const onGoTimeline = props.onGoTimeline;
        const onGoCatalog = props.onGoCatalog;
        const onGoTools = props.onGoTools;
        const distill = props.distill;
        const check = props.check;
        const search = props.search || {};
        const rawSuggestions = Array.isArray(props.suggestions) ? props.suggestions : [];
        // 章名/条目片段可能是整句（如「不会自动跟随跨域重定向」），当检索词不好用。
        // 中文只留 <=8 字，含 ASCII 的 token 放到 20 字符；最多 3 个。
        const suggestions = rawSuggestions
          .filter((word) => {
            const value = String(word || "").trim();
            if (!value) return false;
            return /[A-Za-z]/.test(value) ? value.length <= 20 : value.length <= 8;
          })
          .slice(0, 3);
        const volCount = volumes.length;
        const sub = volCount > 0
          ? "按册归档。开工前先翻目录，而不是把历史塞进提示词。"
          : "分册还没生成；先让 Agent 扫一遍归档对话。";
        const overviewMeta = ready(summary)
          ? fmtOrDash(inBooksOf(summary.data)) + " 条 · " + fmtNum(volCount) + " 册"
          : "数据未就绪";
        const toolSum = ready(tools) && tools.data && tools.data.summary ? tools.data.summary : null;

        return jsxs("div", {
          className: "ms-view ms-shelf",
          children: [
            jsx(CardSection, {
              title: "概览",
              meta: overviewMeta,
              children: [
                jsxs("div", {
                  className: "ms-hero",
                  children: [
                    jsx("div", { className: "ms-heroTitle", children: "把已归档的对话，整理成能查的手册。" }),
                    jsx("div", { className: "ms-heroSub", children: sub })
                  ]
                }),
                ready(summary)
                  ? jsx(Statline, { summary: summary.data })
                  : jsx(Placeholder, { state: summary, what: "内容库总量" }),
                ready(summary) ? jsx(SkeletonNote, { summary: summary.data }) : null,
                jsx("div", { className: "ms-subhead", children: "分册" }),
                volCount > 0
                  ? jsx(VolumeGrid, { volumes, onOpen: onOpenVolume })
                  : jsx(Placeholder, { state: summary, what: "分册清单" })
              ]
            }),

            jsx(CardSection, {
              title: "检索入口",
              hint: "按器件型号、工具名或报错原文搜一条结论；也可以直接翻目录或看最近 30 天。",
              children: jsxs("div", {
                className: "ms-searchEntry",
                children: [
                  jsxs("div", {
                    className: "ms-searchEntryRow",
                    children: [
                      jsx("button", {
                        type: "button",
                        className: "ms-btn",
                        "data-tone": "primary",
                        onClick: () => search.onFocus && search.onFocus(),
                        children: "搜索一条结论"
                      }),
                      jsx("button", {
                        type: "button",
                        className: "ms-btn",
                        onClick: onGoCatalog,
                        children: "翻目录"
                      }),
                      jsx("button", {
                        type: "button",
                        className: "ms-btn",
                        onClick: onGoTimeline,
                        children: "看时间线"
                      })
                    ]
                  }),
                  suggestions.length > 0
                    ? jsxs("div", {
                        className: "ms-searchEntryRow",
                        children: [
                          jsx("span", { className: "ms-searchEntryHint", children: "试试：" }),
                          ...suggestions.map((word) =>
                            jsx("button", {
                              type: "button",
                              className: "ms-sugBtn",
                              onClick: () => search.onSuggestion && search.onSuggestion(word),
                              children: word
                            }, "shelf-sug-" + word)
                          )
                        ]
                      })
                    : null,
                  jsx("p", {
                    className: "ms-searchEntryHint",
                    children: "结果可以进详情、复制，或直接编辑并写回本机 Markdown。"
                  })
                ]
              })
            }),

            jsx(CardSection, {
              title: "最近更新",
              hint: "近 30 天写进书库的条目；点开就能读正文。",
              flush: true,
              children: jsx(RecentUpdates, {
                state: recent,
                onOpen: onOpenEntry,
                onGoTimeline,
                onGoCatalog
              })
            }),

            jsx(CardSection, {
              title: "维护与巡检",
              hint: "提炼会真实调用模型并写入书库；巡检由 systemd 每天自动跑。两个动作互不影响。",
              children: [
                jsx("div", { className: "ms-subhead", children: "提炼与入库" }),
                distill
                  ? jsx(DistillPanel, distill)
                  : jsx("p", { className: "ms-searchEntryHint", children: "提炼状态读取中…" }),
                check
                  ? jsxs("details", {
                      className: "ms-subfold",
                      children: [
                        jsx("summary", { children: "巡检设置 · 每日自动检查" }),
                        jsx("div", { className: "ms-subfoldBody", children: jsx(CheckSettingsPanel, check) })
                      ]
                    })
                  : null
              ]
            }),

            jsx(CardSection, {
              title: "图书馆与路径",
              hint: "多个 DSH 实例指向同一目录即可共享同一本书；切换后本进程立即重扫。",
              children: jsx(LibraryRootPanel, { summary })
            }),

            jsx(CardSection, {
              title: "工具与调试",
              meta: toolSum ? fmtNum(toolSum.visibleToolCount) + " 个工具" : null,
              hint: "本机工具、挂载情况与最近的归档会话；排查时先看这里。",
              children: [
                jsx(ToolSummary, { state: tools, onGoTools }),
                jsx("div", { className: "ms-subhead", children: "最近会话" }),
                ready(sessions)
                  ? jsx(SessionStrip, { data: sessions.data })
                  : jsx(Placeholder, { state: sessions, what: "会话列表" })
              ]
            })
          ]
        });
      }

      function CatalogView(props) {
        const volumes = props.volumes;
        const volumeId = props.volumeId;
        const catalog = props.catalog;
        const summary = props.summary;
        const onPick = props.onPick;
        const onOpenEntry = props.onOpenEntry;
        const source = catalog.phase === "idle" ? summary : catalog;
        return jsxs("div", {
          className: "ms-view",
          children: [
            volumes.length > 0
              ? jsx("div", {
                  className: "ms-volPick",
                  children: volumes.map((volume, index) => {
                    const id = volume && volume.id != null ? String(volume.id) : "vol-" + index;
                    const name = volume && volume.name ? String(volume.name) : id;
                    const kinds = volumeKindText(volume);
                    return jsx(
                      "button",
                      {
                        type: "button",
                        className: "ms-pick",
                        "data-on": String(id === volumeId),
                        title: [name, kinds].filter(Boolean).join(" · "),
                        onClick: () => onPick(id),
                        children: [
                          jsx("span", { className: "ms-pickName", children: name }),
                          kinds ? jsx("span", { className: "ms-pickKind", children: kinds }) : null
                        ]
                      },
                      id
                    );
                  })
                })
              : null,
            ready(catalog)
              ? jsx(ChapterList, { volume: catalog.data, onOpenEntry })
              : jsx(Placeholder, { state: source, what: "章节目录" })
          ]
        });
      }

      function AiCollabView(props) {
        const ai = props.ai;
        const onOpenEntry = props.onOpenEntry;
        return jsx("div", {
          className: "ms-view",
          children: [
            ready(ai)
              ? jsx(ChapterList, { volume: ai.data, onOpenEntry })
              : isMissingVolume(ai)
                ? jsxs("div", {
                    className: "ms-empty",
                    children: [
                      jsx("b", { children: "这一册还没有内容" }),
                      jsx("span", {
                        children:
                          "AI 协作册是本机跨会话统计的离线产物，不入仓库（含会话片段，见 .gitignore）。" +
                          "生成它：在插件目录跑 `node scripts/build-vol06.mjs`，然后重扫一次即可。这不是故障，也不影响其它册。"
                      })
                    ]
                  })
              : jsx(Placeholder, { state: ai, what: "AI 协作册" })
          ]
        });
      }

      /**
       * 工具架 · 把本机所有工具与工具包摊开给用户看。
       *
       * 【为什么单独一个标签页】2026-11-03 用户反馈：REA 这种大工具包只出现在
       * 系统提示词里（模型看得到），书阁 UI 里完全没有 —— 用户不知道本机有什么能力。
       * 这不是"少个页面"，是模型可见与用户可见的鸿沟：
       * 用户无法判断某个能力该不该开、开了占多少、现在开没开。
       *
       * 展示原则：
       *   · 未挂载的包也要列（正是用户最需要知道的）—— 不能只显示已启用的
       *   · 静态挂载的（无包定义）与可卸载的分开标，避免用户以为 kicad 也能卸
       *   · 体积数字直接标，让"开不开"是个有依据的决定，而不是凭感觉
       */
      function ToolShelfView(props) {
        const data = props.data;
        if (!ready(data)) return jsx(Placeholder, { state: data, what: "工具架" });

        const d = data.data || {};
        const groups = Array.isArray(d.groups) ? d.groups : [];
        const sum = d.summary || {};
        const toolsError = d.toolsError;

        if (groups.length === 0) {
          return jsx("div", {
            className: "ms-view",
            children: jsx("div", {
              className: "ms-callout",
              children: toolsError
                ? "读不到当前工具列表：" + String(toolsError)
                : "当前没有可见工具。若刚启动，等一轮对话后刷新再看。"
            })
          });
        }

        return jsx("div", {
          className: "ms-view",
          children: [
            // 汇总数字：让"值不值得开"变成有依据的判断
            jsxs("div", {
              className: "ms-tsum",
              children: [
                jsxs("div", {
                  className: "ms-tsumCell",
                  children: [
                    jsx("div", { className: "ms-tsumNum", children: fmtNum(sum.visibleToolCount) }),
                    jsx("div", { className: "ms-tsumLbl", children: "当前可见工具" })
                  ]
                }),
                jsxs("div", {
                  className: "ms-tsumCell",
                  children: [
                    jsx("div", { className: "ms-tsumNum", children: fmtNum(sum.schemaKb) + " KB" }),
                    jsx("div", { className: "ms-tsumLbl", children: "schema 占用" })
                  ]
                }),
                jsxs("div", {
                  className: "ms-tsumCell",
                  children: [
                    jsx("div", {
                      className: "ms-tsumNum",
                      children: fmtNum(sum.unmountedPackCount)
                    }),
                    jsx("div", { className: "ms-tsumLbl", children: "未挂载工具包" })
                  ]
                }),
                jsxs("div", {
                  className: "ms-tsumCell",
                  children: [
                    jsx("div", {
                      className: "ms-tsumNum",
                      children: fmtNum(sum.savedKbByUnmounted) + " KB"
                    }),
                    jsx("div", { className: "ms-tsumLbl", children: "未占用" })
                  ]
                })
              ]
            }),

            jsx("div", {
              className: "ms-tshelf",
              children: groups.map((g, index) => {
                const key = g && g.key ? String(g.key) : "g-" + index;
                const isMcp = g.source === "mcp";
                const mounted = !!g.mounted;
                const isStatic = isMcp && mounted && !g.packId;
                const tools = Array.isArray(g.tools) ? g.tools : [];
                const PREVIEW = 10;
                return jsxs(
                  "div",
                  {
                    className: "ms-tpack",
                    "data-muted": String(isMcp && !mounted),
                    children: [
                      jsxs("div", {
                        className: "ms-tpackTop",
                        children: [
                          jsx("span", { className: "ms-tpackName", title: g.label, children: g.label }),
                          isStatic
                            ? jsx("span", { className: "ms-tchip", "data-static": "true", children: "静态挂载" })
                            : isMcp
                              ? jsx("span", {
                                  className: "ms-tchip",
                                  "data-on": String(mounted),
                                  "data-off": String(!mounted),
                                  children: mounted ? "已挂载" : "未挂载"
                                })
                              : jsx("span", { className: "ms-tchip", "data-on": "true", children: "常驻" })
                        ]
                      }),
                      g.desc ? jsx("div", { className: "ms-tpackDesc", children: g.desc }) : null,
                      jsxs("div", {
                        className: "ms-tpackMeta",
                        children: [
                          jsx("span", { children: fmtNum(g.toolCount) + " 个工具" }),
                          g.schemaKb
                            ? jsx("span", { children: "约 " + fmtNum(g.schemaKb) + " KB" })
                            : null,
                          isMcp && !mounted
                            ? jsx("span", { children: "当前不占上下文" })
                            : null
                        ].filter(Boolean)
                      }),
                      tools.length > 0
                        ? jsx("div", {
                            className: "ms-tnames",
                            children: tools.slice(0, PREVIEW).map((t, i) =>
                              jsx(
                                "span",
                                {
                                  className: "ms-tname",
                                  title: t.human ? t.human : t.name,
                                  children: t.name
                                },
                                t.name + "-" + i
                              )
                            ).concat(
                              tools.length > PREVIEW
                                ? [jsx("span", { className: "ms-tname", children: "+" + (tools.length - PREVIEW) }, "more")]
                                : []
                            )
                          })
                        : null,
                      // 未挂载时把"怎么开、代价多少"摆出来 —— 这是用户决策所需的最小信息
                      isMcp && !mounted
                        ? jsx("div", {
                            className: "ms-thelp",
                            children: [g.how, g.cost].filter(Boolean).join("  ")
                          })
                        : null,
                      isStatic
                        ? jsx("div", {
                            className: "ms-thelp",
                            children:
                              "由 profile 配置静态挂载，常驻占用，不能用 manual_unmount 释放。改配置后重启 DSH 生效。"
                          })
                        : null
                    ].filter(Boolean)
                  },
                  key
                );
              })
            })
          ]
        });
      }

      const TABS = [
        { id: "shelf", label: "书房" },
        { id: "timeline", label: "时间线" },
        { id: "catalog", label: "目录" },
        { id: "ai", label: "AI 协作" },
        { id: "tools", label: "工具架" }
      ];

      // ③ 主面板（keyed main · key = "manuscript"）
      function ManuscriptPage() {
        const [view, setView] = react.useState("shelf");
        const summary = useJson(API_SUMMARY);
        const volumes = react.useMemo(() => {
          const list = summary.data && summary.data.volumes;
          return Array.isArray(list) ? list : [];
        }, [summary.data]);
        const firstVolumeId =
          volumes.length > 0 && volumes[0] && volumes[0].id != null ? String(volumes[0].id) : null;
        const [volumeId, setVolumeId] = react.useState(null);

        // ── 搜索 / 条目正文（2026-11-12）──
        // query 是输入框的即时值；searchQ 是"防抖后真正发出去的值"。
        // 两者分开的目的：输入时不至于每个字符都打一次接口，也不会让
        // 结果列表在输入中途闪成空状态。
        const [query, setQuery] = react.useState("");
        const [searchQ, setSearchQ] = react.useState("");
        // P1 筛选：改任何一个都算"带参重搜"（URL 变化 → useJson 重新取数），
        // 不改输入框里的词。换册时章筛选清零，避免出现"这一册里没有那一章"的空结果。
        const [filterVolume, setFilterVolume] = react.useState("");
        const [filterChapter, setFilterChapter] = react.useState("");
        const [filterConfidence, setFilterConfidence] = react.useState("");
        // 详情页记住"从哪来的"，返回时能回到搜索结果而不是永远回目录。
        const [entryId, setEntryId] = react.useState(null);
        const [entryFrom, setEntryFrom] = react.useState("catalog");

        // 视图滚动位置：时间线有 30 天、几千像素，点进详情再返回时不能把人扔回顶部。
        // 打开详情前先记下当前 view 的 scrollTop；返回时由 layout effect 还原。
        const bodyRef = react.useRef(null);
        // 检索入口卡片的「搜索一条结论」按钮把焦点送到顶部搜索框。
        // 不复制第二个 input：同一份 query 只维护一处，避免两个输入框不同步。
        const searchInputRef = react.useRef(null);
        const focusSearch = react.useCallback(() => {
          const el = searchInputRef.current;
          if (el && typeof el.focus === "function") el.focus();
        }, []);
        const scrollPositions = react.useRef({});
        const rememberScroll = react.useCallback(() => {
          const el = bodyRef.current;
          if (el) scrollPositions.current[view] = el.scrollTop;
        }, [view]);
        const gotoView = react.useCallback(
          (next) => {
            if (!next || next === view) return;
            rememberScroll();
            // 2026-11-16 QA P3：切到时间线/目录时清空搜索词 —— 否则顶部还留着关键词，
            // 而视图内容并不按它过滤，读者会误以为结果被过滤了。
            // 2026-11-17 QA：任何**非搜索视图**都要清空搜索词。
            // 旧实现只清 timeline/catalog，切到书房后输入框仍留着旧词，
            // 而首页并不按它过滤 —— 读者会误以为首页被筛选了（P3）。
            if (next !== "search") {
              setQuery("");
            }
            setView(next);
          },
          [view, rememberScroll, setQuery]
        );
        react.useEffect(() => {
          const el = bodyRef.current;
          if (!el) return;
          const target = scrollPositions.current[view] || 0;
          if (target <= 0) {
            el.scrollTop = 0;
            return undefined;
          }
          // 视图切回来时内容可能还在 loading（高度为 0），立刻写 scrollTop 会被夹成 0。
          // 等内容长到够高再还原；MutationObserver 负责“数据到了”，超时则退到当前最大值。
          const attempt = () => {
            const max = el.scrollHeight - el.clientHeight;
            if (max >= target) {
              el.scrollTop = target;
              return true;
            }
            return false;
          };
          if (attempt()) return undefined;
          const observer = new MutationObserver(() => {
            if (attempt()) observer.disconnect();
          });
          observer.observe(el, { childList: true, subtree: true });
          const timer = setTimeout(() => {
            attempt();
            observer.disconnect();
          }, 1500);
          return () => {
            clearTimeout(timer);
            observer.disconnect();
          };
        }, [view]);

        const openEntry = react.useCallback((id, from) => {
          if (id == null || id === "") return;
          rememberScroll();
          setEntryId(String(id));
          setEntryFrom(
            from === "search" || from === "ai" || from === "timeline" || from === "shelf"
              ? from
              : "catalog"
          );
          setView("entry");
        }, [rememberScroll]);

        const backFromEntry = react.useCallback(() => {
          if (entryFrom === "search" && searchQ) gotoView("search");
          else if (entryFrom === "ai") gotoView("ai");
          else if (entryFrom === "timeline") gotoView("timeline");
          else if (entryFrom === "shelf") gotoView("shelf");
          else gotoView("catalog");
        }, [entryFrom, searchQ, gotoView]);

        // 筛选下拉的选项：册来自 summary；章跟随当前选中的册（未选册则全册去重）。
        const chapterOptions = react.useMemo(() => {
          const seen = new Set();
          const out = [];
          for (const volume of volumes) {
            if (!volume) continue;
            if (filterVolume && String(volume.id) !== filterVolume) continue;
            const chapters = Array.isArray(volume.chapters) ? volume.chapters : [];
            for (const chapter of chapters) {
              const title = chapter && chapter.title ? String(chapter.title) : "";
              if (!title || seen.has(title)) continue;
              seen.add(title);
              out.push(title);
            }
          }
          return out;
        }, [volumes, filterVolume]);

        const onSearchFilter = react.useCallback((key, value) => {
          if (key === "volume") {
            setFilterVolume(value);
            setFilterChapter("");
          } else if (key === "chapter") {
            setFilterChapter(value);
          } else if (key === "confidence") {
            setFilterConfidence(value);
          }
        }, []);

        // 输入防抖：停下 220ms 才查。空输入立刻收起搜索视图。
        react.useEffect(() => {
          const q = query.trim();
          if (!q) {
            setSearchQ("");
            return undefined;
          }
          const timer = setTimeout(() => {
            setSearchQ(q);
            setView("search");
          }, 220);
          return () => clearTimeout(timer);
        }, [query]);

        const clearSearch = react.useCallback(() => {
          setQuery("");
          setSearchQ("");
          if (view === "search") gotoView("shelf");
        }, [view, gotoView]);

        // ── 巡检设置（2026-11-12）──────────────────────────────────────
        // 读与写分开：checkSettings 是服务端真值的镜像（GET 缓存），
        // checkEnabled/checkTime 是**草稿**（用户正在改的值）。
        // 两者合并会让"改了没保存"看起来像"已经生效"。
        const checkSettings = useJson(API_CHECK_SETTINGS);
        const [checkEnabled, setCheckEnabled] = react.useState(true);
        const [checkTime, setCheckTime] = react.useState("07:00");
        // 只在第一次拿到真值时灌入草稿；之后用户改什么就是什么，
        // 后台重取（invalidate）不覆盖正在编辑的内容。
        //
        // 【2026-11-12 实测踩坑：保存后草稿被"旧数据"回灌】
        // 第一版保存成功后又 setCheckSynced(false) + invalidate()，想让草稿跟随服务端。
        // 结果 invalidate 是异步的：effect 立刻以**缓存里还没更新的旧 data** 跑了一次，
        // 把 checkEnabled 写回 false 并置 synced=true；等新数据到达时 effect 已经不跑了。
        // 症状极隐蔽：状态行读的是服务端 data（显示"已启用"），草稿却是 false ——
        // 下一次点保存会把 enabled:false 写回去，用户看到的是"点了保存反而被关掉"。
        // 现在：保存成功直接把 POST 返回值当草稿真值，同步标记保持 true，不再靠回灌。
        const [checkSynced, setCheckSynced] = react.useState(false);
        react.useEffect(() => {
          if (checkSynced) return;
          const s = checkSettings.data && checkSettings.data.settings;
          if (!s || typeof s.time !== "string") return;
          setCheckEnabled(!!s.enabled);
          setCheckTime(s.time);
          setCheckSynced(true);
        }, [checkSettings.data, checkSynced]);

        const [checkPhase, setCheckPhase] = react.useState("idle"); // idle | saving | running
        const [checkMsg, setCheckMsg] = react.useState(null); // { tone: "ok" | "err", text }

        const saveCheckSettings = react.useCallback(async () => {
          setCheckPhase("saving");
          setCheckMsg(null);
          try {
            const r = await postJson(API_CHECK_SETTINGS, { enabled: checkEnabled, time: checkTime });
            // POST 回执就是磁盘真值的回读（服务端写后立刻读），直接用它对齐草稿。
            // 不要在这里 setCheckSynced(false)：见上面 effect 注释里的回灌坑。
            const saved = r && r.settings ? r.settings : null;
            if (saved && typeof saved.time === "string") {
              setCheckEnabled(!!saved.enabled);
              setCheckTime(saved.time);
            }
            setCheckSynced(true);
            invalidate(API_CHECK_SETTINGS);
            setCheckMsg({
              tone: "ok",
              text: r && r.nextRun ? "已保存 · 下次运行约 " + fmtNextRun(r.nextRun) : "已保存 · 已停用，不会再自动跑"
            });
          } catch (e) {
            setCheckMsg({ tone: "err", text: "保存失败：" + String(e && e.message ? e.message : e) });
          } finally {
            setCheckPhase("idle");
          }
        }, [checkEnabled, checkTime]);

        const runCheckNow = react.useCallback(async () => {
          setCheckPhase("running");
          setCheckMsg(null);
          try {
            await postJson(API_CHECK_RUN, {});
            // 触发是异步的：这里只说"已交给 systemd"，不说"跑完了"。
            setCheckMsg({
              tone: "ok",
              text: "已交给 systemd 后台执行，约 1–3 分钟出结果（~/.dsh/logs/manuscript-daily-latest.md）"
            });
          } catch (e) {
            setCheckMsg({ tone: "err", text: "触发失败：" + String(e && e.message ? e.message : e) });
          } finally {
            setCheckPhase("idle");
          }
        }, []);

        // ── 提炼面板的数据与状态 ──
        // 【为什么必须在这里】2026-11-02 发现：DistillPanel 组件写好了，
        // 但 ShelfView 调用时没传 distill prop，所以它永远是 undefined，
        // 面板一次都没渲染出来。链路断在这里，不是缓存问题。
        const distillPlan = useJson(API_DISTILL_PLAN);
        // 初始值从模块级缓存恢复，避免切面板后丢结果
        const [distillPhase, setDistillPhaseRaw] = react.useState(DISTILL_MEMORY.phase);
        const [distillResult, setDistillResultRaw] = react.useState(DISTILL_MEMORY.result);
        const [distillError, setDistillErrorRaw] = react.useState(DISTILL_MEMORY.error);
        // 【倒计时归零的修法 2026-11-02】
        // 原来 elapsed 是"已经跑了多少秒"，存在组件 state 里。
        // 用户切到别的对话再切回来，组件被卸载重建，elapsed 从 0 重新算。
        //
        // 根因：把"累计量"当状态存了。正确做法是只存**起点时间戳**，
        // 每次渲染用 Date.now() - startedAt 现算 —— 时间戳在模块级缓存里，
        // 卸载重挂也还在，所以切回来能显示真实已跑时长。
        const [distillProgress, setDistillProgressRaw] = react.useState(() => {
          const t0 = DISTILL_MEMORY.startedAt;
          return { startedAt: t0, elapsed: t0 ? Date.now() - t0 : 0 };
        });
        const setDistillProgress = react.useCallback((v) => {
          if (v && v.startedAt) DISTILL_MEMORY.startedAt = v.startedAt;
          setDistillProgressRaw(v);
        }, []);
        // 每次 set 都同步写回缓存
        const setDistillPhase = (v) => { DISTILL_MEMORY.phase = v; setDistillPhaseRaw(v); };
        const setDistillResult = (v) => { DISTILL_MEMORY.result = v; setDistillResultRaw(v); };
        const setDistillError = (v) => { DISTILL_MEMORY.error = v; setDistillErrorRaw(v); };

        react.useEffect(() => {
          if (distillPhase !== "idle") return;
          if (distillPlan.data && distillPlan.data.ok) setDistillPhase("ready");
        }, [distillPhase, distillPlan.data]);

        react.useEffect(() => {
          if (distillPhase !== "running") return;
          const t0 = DISTILL_MEMORY.startedAt || distillProgress.startedAt || Date.now();
          // 挂载后立刻同步一次真实已跑时长 —— 否则切回来的第一秒显示的还是旧值
          setDistillProgress({ startedAt: t0, elapsed: Date.now() - t0 });
          const timer = setInterval(() => {
            setDistillProgress({ startedAt: t0, elapsed: Date.now() - t0 });
          }, 1000);
          return () => clearInterval(timer);
        }, [distillPhase, distillProgress.startedAt]);

                // 卡死自愈：如果上一次提炼因为面板卸载而 orphan，running 会残留。
        // 超过 5 分钟视为失效，重置回 idle，否则按钮永远卡在"提炼中…"。
        react.useEffect(() => {
          if (distillPhase !== "running" && distillPhase !== "planning") return;
          const t0 = distillProgress.startedAt || Date.now();
          if (Date.now() - t0 > 5 * 60 * 1000) {
            setDistillError("上一次提炼可能已中断（面板被关闭或超时），请重新点击");
            setDistillPhase("error");
          }
        }, [distillPhase, distillProgress.startedAt]);

        // ── 提炼：请求前置确认（D-03，2026-11-06）────────────────────
        // 这里把"点按钮"和"发请求"拆成两个函数，是本轮改动的主线：
        //   requestRun(dryRun)  —— 按钮唯一入口，只判断"要不要先问一句"
        //   runDistill(dryRun)  —— 真正发网络请求，只有确认后才走
        // 为什么要拆而不是在 runDistill 里加个 if：
        //   因为 runDistill 也被确认区自己调用，在它内部再加一次判断会变成
        //   "确认后又要求确认"的死循环。判定必须在**入口**做，不在执行体做。
        const [confirming, setConfirming] = react.useState(false);

        const runDistill = react.useCallback(async (dryRun) => {
          setDistillError(null);
          // 【2026-11-08】重置上一轮的"丢弃"决定与提交提示。
          // distillDecided 以 needsHuman 的**下标**为键，新一轮结果顺序一变就错位：
          // 上一轮丢弃了 needsHuman[0]，新一轮的第 0 条会显示"已丢弃"，
          // 提交时还会按旧下标把新条目标题排除 → 少入册一条。
          setDistillDecided({});
          setCommitMsg(null);
          setDistillPhase(dryRun ? "planning" : "running");
          setDistillProgress({ startedAt: Date.now(), elapsed: 0 });
          try {
            // 【2026-11-03 调整】limit 从 5 提到 20。
            // 原来每批 5 个：182 个待提炼要点 37 次，实际用不下去。
            // 后端 /distill/run 的 limit 上限是 50，20 是实测下来的稳妥值
            // （约 130 秒 + 25 秒刷新，单次点击能出 15-20 条真结论）。
            //
            // 【2026-11-06 改 POST】原来这里是 GET fetch。GET 触发真实提炼/写库
            // 意味着浏览器预取、刷新重放、地址栏回放都能把账单一再刷一遍。
            // 现在走 postJson，自动带守门头 x-dsh-manuscript 与 json content-type。
            const url = API_DISTILL_RUN + (dryRun ? "?dryRun=1" : "?limit=20");
            const json = await postJson(url, {}, { timeoutMs: DISTILL_TIMEOUT_MS });
            if (!json.ok && json.error) throw new Error(json.error);
            setDistillResult(json);
            setDistillPhase("done");
            // 提炼改变了 distilledSids，不失效的话「已提炼 X / 剩余 Y」仍是旧值
            // （用户看到的就是"提炼完了但数字没动"）。dryRun 不改库，跳过即可。
            if (!dryRun) {
              invalidate(API_SUMMARY);
              invalidate(API_DISTILL_PLAN);
            }
          } catch (e) {
            setDistillError(e && e.message ? e.message : String(e));
            setDistillPhase("error");
          }
        }, []);

        /**
         * 按钮唯一入口。dryRun（预演）不花钱，**不弹确认**；
         * 真跑才展开确认区。这条豁免必须写在这里、只有这一处，
         * 否则以后加个"预演按钮"就又要复制一遍判断、迟早就对不上。
         */
        const requestRun = react.useCallback((dryRun) => {
          if (dryRun) {
            setConfirming(false);
            runDistill(true);
            return;
          }
          setConfirming(true);
        }, [runDistill]);

        /** 用户在确认区点了「确认提炼」：收起确认区并真的开跑。 */
        const confirmRun = react.useCallback(() => {
          setConfirming(false);
          runDistill(false);
        }, [runDistill]);

        /**
         * 取消：只收起确认区，**不碰 phase**。
         *
         * 【为什么不把 phase 设回 "ready"】
         *   ① requestRun(false) 从没改过 phase —— 它只打开确认区。所以"取消"
         *      天然就是"什么都没发生"，数值/phase/结果全原样，这就是要的语义。
         *   ② 硬设 ready 有害：若当前是 done 且刚出了一轮结果，一取消就把
         *      按钮从"再跑一轮"退回"开始提炼"，还让进度行去读一份过期 plan。
         *   ③ setDistillPhase 是"写模块缓存 + setState"的普通函数，不接受
         *      updater 函数 —— 传 (prev) => ... 会把一个函数存进
         *      DISTILL_MEMORY.phase，下次挂载读到的就是函数，状态机直接坏掉。
         */
        const cancelRun = react.useCallback(() => {
          setConfirming(false);
        }, []);

        // ── 入册 ──────────────────────────────────────────────────────
        // 【为什么必须有这一段】2026-11-03 用户反馈："我希望我能在书阁的页面
        //  启动提炼而不是你来操作"。查下来发现：提炼按钮早就有，但
        //    API_DISTILL_COMMIT 定义了从未使用 —— 前端根本没有入册入口。
        //  也就是说提炼出来的 20 条真结论躺在内存里，必须由 AI 手动调 API 才进库。
        //  这不是"少了便利"，而是让整个功能无法由用户独立完成。
        const [committing, setCommitting] = react.useState(false);
        const [commitMsg, setCommitMsg] = react.useState(null);

        // ── 通过 / 丢弃 ──────────────────────────────────────────────
        // 【2026-11-03 用户反馈】"有两条让我选择的，我选不了丢弃，都只能选通过"。
        //
        // 查下来是完整的断链，三处都缺：
        //   ① distillProps 没传 onDecide → 按钮点击被 `props.onDecide && ...` 短路，
        //      两个按钮点了都毫无反应（不是"只能通过"，是两个都失效）
        //   ② distillProps 没传 decided → 即使点了也没地方记住选择
        //   ③ onCommit 提交的是 entries 全量，根本不看 decided
        //
        // 所以必须三处一起补，只修按钮等于给用户一个假开关。
        const [distillDecided, setDistillDecided] = react.useState({});
        const onDecide = react.useCallback((index, decision) => {
          setDistillDecided((prev) => {
            const next = { ...prev };
            // 再点一次同一个决定 = 取消（避免误点后无法挽回）
            if (next[index] === decision) delete next[index];
            else next[index] = decision;
            return next;
          });
        }, []);

        const onCommit = react.useCallback(async () => {
          const all = distillResult && Array.isArray(distillResult.entries) ? distillResult.entries : [];
          // 【不能用索引对齐】DistillHuman 列出的是 adjudication.needsHuman，
          // 而 entries 是全量 —— 两个数组长度和顺序都不同（实测：
          // entries 18 条、needsHuman 0 条）。用 index 过滤会丢错条目。
          //
          // 正确做法：用 **title** 做身份匹配。needsHuman 元素只有 title/claim，
          // 没有 id，所以 title 是唯一可用的键。
          const human = (distillResult && distillResult.adjudication && Array.isArray(distillResult.adjudication.needsHuman))
            ? distillResult.adjudication.needsHuman
            : [];
          const rejectedTitles = new Set();
          const decided = distillDecided || {};
          for (const [idx, decision] of Object.entries(decided)) {
            if (decision !== "reject") continue;
            const item = human[Number(idx)];
            if (item && item.title) rejectedTitles.add(String(item.title));
          }

          // 只有**明确点了丢弃**的才排除；没点过的默认保留。
          // 理由：让人逐条点"通过"是形式主义，会诱导无脑全点。
          // 真正需要的判断是"哪条我不想要"，其余默认接受。
          const entries = rejectedTitles.size > 0
            ? all.filter((e) => !rejectedTitles.has(String(e.title || "")))
            : all;
          const droppedCount = all.length - entries.length;

          if (entries.length === 0) {
            setCommitMsg("全部条目标记为丢弃，没有可入册的内容");
            return;
          }
          setCommitting(true);
          setCommitMsg(null);
          try {
            // 【2026-11-06 改 postJson】原来这里手写 fetch + 手写 Content-Type，
            // 唯独漏了守门头 x-dsh-manuscript —— 补上后与其它写操作同一套。
            // 错误语义不变：ok:false / 非 2xx 都抛，由下面 catch 转成 commitMsg。
            const json = await postJson(API_DISTILL_COMMIT, { entries }, { timeoutMs: 120000 });
            if (!json.ok) throw new Error(json.error || json.reason || "入册失败");
            setCommitMsg(
              "已入册 " + num(json.written) + " 条" +
              (droppedCount > 0 ? "，按你的选择丢弃 " + num(droppedCount) + " 条" : "") +
              (json.skipped ? "，跳过 " + num(json.skipped) + " 条" : "")
            );
            // 入册改变了条目数/分册/健康度：主动失效相关接口，让面板反映新数据。
            // 用 invalidate 而不是 location.reload —— 后者会把整个面板状态（选中的册、
            // 视图、提炼结果）全部清掉，用户刚入完册就"迷路"了。
            //
            // 【为什么不再是 CACHE.delete + requestJson 2026-11-06】
            // 老写法只删 CACHE 再发一次请求，但 useJson 那时**根本没订阅**（见 useJson
            // 顶部注释），publish() 写到 CACHE 也通知不到组件 → 界面停在 130/218。
            // 现在改由 invalidate 广播：挂着的 useJson 会因 rev 变化重跑 effect，
            // 自己重新订阅 + 重新取数。**不要再手工 requestJson**，否则语义重复、
            // 也绕开了"订阅"这一步。
            try {
              invalidate(API_SUMMARY);
              // 入册后剩余队列变了，提炼面板的 plan 必须一起失效
              invalidate(API_DISTILL_PLAN);
              // 会话条带（"最近会话"）里的状态也会变
              invalidate(API_SESSIONS);
              // 分册目录：API_VOLUME 是前缀常量，真实地址是 .../volume/<id>。
              // 册内条目数/章结构都变了，按前缀全量失效（关掉当前册再开另一册也要对）。
              invalidate(API_VOLUME, { prefix: true });
            } catch { /* 刷新失败不影响入册结果 */ }
            // 清掉本轮结果，避免重复点击把同一批入册两遍
            DISTILL_MEMORY.result = null;
            setDistillResultRaw(null);
            setDistillDecided({});
          } catch (e) {
            setCommitMsg("入册失败：" + (e && e.message ? e.message : String(e)));
          } finally {
            setCommitting(false);
          }
        }, [distillResult, distillDecided]);
        // 注意：依赖里刻意不放 props —— props 每次渲染都是新对象，
        // 放进来会让 onCommit 每次重建，进而让下游 useMemo 全部失效。

        // 切换模型：写回后端（/plan?model=），并本地记住选中
        const [pickedModel, setPickedModelRaw] = react.useState(DISTILL_MEMORY.model);
        // 用 useCallback 固定引用，否则每次渲染都换新函数，
        // 会让依赖它的 useCallback/useMemo 每次都失效。
        const setPickedModel = react.useCallback((v) => {
          DISTILL_MEMORY.model = v;
          setPickedModelRaw(v);
        }, []);

        /**
         * 切换模型。
         *
         * 【两个坑，2026-11-02 都踩过】
         *  ① 顺序：这个函数原来写在 setPickedModel 声明之前 ——
         *     const 有暂时性死区，运行时会抛 ReferenceError，点击直接无效。
         *  ② 时序：原来要等 /plan 请求返回才更新界面。网络慢时下拉框
         *     看起来"选不动"。现在本地先更新，请求只用来把选择同步到后端。
         *
         * 【2026-11-06 改 POST】原来是 `GET /plan?model=xxx` —— 一个 GET 顺手改
         * 后端状态。后果是任何预取/重放/刷新都会改配置，而且 /plan 本来是会
         * 触发扫描的重接口。现在换成轻量的 POST /distill/model，只写选择不动扫描。
         * 「本地先更新」的时序理由保持原样，不改。
         */
        const onPickModel = react.useCallback(
          async (id) => {
            if (!id) return;
            const prev = DISTILL_MEMORY.model;
            setPickedModel(id); // 先更新界面，不等网络
            try {
              const json = await postJson(API_DISTILL_MODEL, { model: String(id) });
              if (json && json.ok === false) throw new Error(json.error || "切换模型失败");
            } catch (e) {
              // 【2026-11-08】原来是一个空 catch —— 后端没切成功时界面照样显示新模型，
              // 而 /run 的 URL 不带 model，于是**按旧模型真跑并扣费**，用户毫无察觉。
              // 现在：失败就把选择退回，并把原因显示出来。
              setPickedModel(prev);
              setDistillError("切换模型失败：" + (e && e.message ? e.message : String(e)));
            }
          },
          [setPickedModel]
        );
        const distillProps = react.useMemo(
          () => ({
            phase: distillPhase,
            plan: distillPlan.data,
            result: distillResult,
            error: distillError,
            progress: distillProgress,
            // 【2026-11-05】把 /summary 一并传下去：状态行要显示
            // "已提炼 X / 218"，而 X 可能只存在于 /summary（A 块后端
            // 若只改了 summary 没改 plan），两边都认才不会显示 --。
            // 【2026-11-06】D-05 也用这个 prop：/summary 的 stale/scanAgeMs
            // 要靠它传进来，否则提炼状态行看不到"数据 N 分钟前"。
            summary: summary.data,
            // 【2026-11-06 D-03】onRun 仍保留（预演路径/既有契约用），
            // 按钮改走 onRequestRun —— 它才负责"先问一句再花钱"。
            onRun: runDistill,
            onRequestRun: requestRun,
            onConfirmRun: confirmRun,
            onCancelRun: cancelRun,
            confirming,
            onPickModel,
            // 入册：提炼出的条目要用户点一下才进库（规约：写手册要人确认）
            onCommit,
            committing,
            commitMsg,
            // 通过 / 丢弃。必须传，否则 DistillHuman 里两个按钮都被
            // `props.onDecide && ...` 短路 —— 点了毫无反应（2026-11-03 实测）。
            onDecide,
            decided: distillDecided,
            // 用户刚选的模型。优先级高于 plan.currentModel ——
            // 因为 plan 是 useJson 缓存的，切换后不会自动重取，
            // 不传这个的话下拉框会一直显示旧值（2026-11-02 实测的 bug）。
            pickedModel,
            // 【2026-11-06 更新】useJson 已支持外部失效：现在 plan 在提炼完成后会由
            // runDistill 里的 invalidate(API_DISTILL_PLAN) 主动刷新，不再依赖这个空回调。
            // 保留它是为了不改 DistillPanel 的既有 props 契约。
            onNeedRefresh: () => {}
          }),
          [distillPhase, distillPlan.data, distillResult, distillError, distillProgress, summary.data, runDistill, requestRun, confirmRun, cancelRun, confirming, onPickModel, pickedModel, onCommit, committing, commitMsg, onDecide, distillDecided]
        );


        react.useEffect(() => {
          if (volumeId === null && firstVolumeId !== null) setVolumeId(firstVolumeId);
        }, [volumeId, firstVolumeId]);

        const catalogUrl = view === "catalog" && volumeId !== null ? API_VOLUME + encodeURIComponent(volumeId) : null;
        const catalog = useJson(catalogUrl);
        // AI 协作册的 id 由 host 决定（实测是 vol-06，不是字面量 ai-collab）：
        // 优先认 id，再认名字里的「AI 协作」，都认不出才退回简报给的 ai-collab。
        const aiVolumeId = react.useMemo(() => {
          for (const volume of volumes) {
            if (volume && volume.id != null && String(volume.id) === AI_VOLUME_ID) return String(volume.id);
          }
          for (const volume of volumes) {
            if (!volume) continue;
            const name = volume.name ? String(volume.name) : "";
            if (name.indexOf(AI_VOLUME_HINT) >= 0 && volume.id != null) return String(volume.id);
          }
          return AI_VOLUME_ID;
        }, [volumes]);
        const ai = useJson(view === "ai" ? API_VOLUME + encodeURIComponent(aiVolumeId) : null);
        const sessions = useJson(view === "shelf" ? API_SESSIONS : null);
        // 工具架只在切到该页时才拉；useJson 传 null 表示不请求。
        const toolShelf = useJson(view === "tools" || view === "shelf" ? API_TOOLS : null);
        // P2：时间线默认最近 30 天；首页「最近更新」按契约只取 24 小时。
        const timeline = useJson(view === "timeline" ? API_TIMELINE + "?days=30" : null);
        // 2026-11-16 QA P2：原来只取 24 小时，库静默时首页「最近更新」整块为空；
        // 改成最近 30 天，取最先 5 条并在行尾标出更新日期（日期来自 timeline 的 day.date）。
        const recent = useJson(view === "shelf" ? API_TIMELINE + "?days=30" : null);
        // 搜索只在有词时请求；详情只在阅读视图请求（切换视图不重复打接口）。
        // 筛选参数直接拼进 URL：URL 变 → useJson 重新取数，不需要另写一套请求逻辑。
        const searchUrl = (() => {
          if (!searchQ) return null;
          const params = ["q=" + encodeURIComponent(searchQ), "topK=30"];
          if (filterVolume) params.push("volume=" + encodeURIComponent(filterVolume));
          if (filterChapter) params.push("chapter=" + encodeURIComponent(filterChapter));
          if (filterConfidence) params.push("confidence=" + encodeURIComponent(filterConfidence));
          return API_SEARCH + "?" + params.join("&");
        })();
        const search = useJson(searchUrl);
        // 服务端还没给 suggestions 时的兜底：同册条目里抽 3 个词。
        const fallbackSuggestions = react.useMemo(
          () => suggestionTerms(volumes, filterVolume, 3),
          [volumes, filterVolume]
        );
        const entryState = useJson(
          view === "entry" && entryId ? API_ENTRY + "?id=" + encodeURIComponent(entryId) : null
        );

        const metaText = ready(summary)
          ? fmtOrDash(inBooksOf(summary.data)) + " 条 · " + volumes.length + " 册"
          : "数据未就绪";
        // 【D-05 前端 2026-11-06】顶栏必须能看出"这排数字可能是旧的"。
        // /summary 读的是内存快照（SCAN_TTL_MS 内不重扫），实测与 disk 差 1–3 个会话。
        // 只有后端明确 stale === true 才显示；staleTextOf 返回空串就什么都不渲染
        // （字段缺失 = 不知道新不新，闭嘴比编"0 分钟前"诚实）。
        const staleText = ready(summary) ? staleTextOf(summary.data) : "";

        let body = null;
        if (view === "search") {
          body = jsx(CardSection, {
            title: "检索结果",
            hint: "点任一条进入详情；可在详情里复制或编辑。",
            children: jsx(SearchView, {
            query: searchQ,
            state: search,
            filters: {
              volume: filterVolume,
              chapter: filterChapter,
              confidence: filterConfidence
            },
            volumeOptions: volumes,
            chapterOptions,
            fallbackSuggestions,
            onFilter: onSearchFilter,
            onClearFilters: () => {
              setFilterVolume("");
              setFilterChapter("");
              setFilterConfidence("");
            },
            onSuggestion: (word) => setQuery(String(word || "")),
            onOpen: (id) => openEntry(id, "search"),
            onGoCatalog: () => gotoView("catalog")
          })
          });
        } else if (view === "entry") {
          body = jsx(CardSection, {
            className: "ms-readerCard",
            title: "条目详情与编辑",
            meta:
              entryState.data && entryState.data.entry
                ? [entryState.data.entry.volumeName, entryState.data.entry.chapter].filter(Boolean).join(" / ")
                : null,
            hint: "复制或编辑；保存会写回本机 Markdown。",
            children: jsx(EntryView, {
            id: entryId,
            state: entryState,
            onBack: backFromEntry,
            backLabel:
              entryFrom === "search"
                ? "返回搜索结果"
                : entryFrom === "ai"
                  ? "返回 AI 协作"
                  : entryFrom === "timeline"
                    ? "返回时间线"
                    : entryFrom === "shelf"
                      ? "返回书房"
                      : "返回章节目录"
          })
          });
        } else if (view === "shelf") {
          body = jsx(ShelfView, {
            summary,
            sessions,
            recent,
            volumes,
            tools: toolShelf,
            suggestions: fallbackSuggestions,
            search: {
              value: query,
              onFocus: focusSearch,
              onSuggestion: (word) => setQuery(String(word || ""))
            },
            distill: distillProps,
            check: {
              state: checkSettings,
              enabled: checkEnabled,
              time: checkTime,
              phase: checkPhase,
              msg: checkMsg,
              onEnabled: setCheckEnabled,
              onTime: setCheckTime,
              onSave: saveCheckSettings,
              onRun: runCheckNow
            },
            onOpenEntry: (id) => openEntry(id, "shelf"),
            onGoTimeline: () => gotoView("timeline"),
            onGoCatalog: () => gotoView("catalog"),
            onGoTools: () => gotoView("tools"),
            onOpenVolume: (id) => {
              setVolumeId(id);
              gotoView("catalog");
            }
          });
        } else if (view === "timeline") {
          body = jsx(CardSection, {
            title: "时间线",
            hint: "按天分组，点条目进入详情。",
            children: jsx(TimelineView, {
              state: timeline,
              onOpen: (id) => openEntry(id, "timeline"),
              onGoCatalog: () => gotoView("catalog")
            })
          });
        } else if (view === "catalog") {
          // 册标题旁也标口径：只改页头会让人以为「12 章」就是全部内容，
          // 而这一册可能大半是只有统计、没有结论的索引骨架。
          const selectedVolume = volumes.find((v) => v && String(v.id) === String(volumeId)) || null;
          const selectedKinds = volumeKindText(selectedVolume);
          const catalogMeta = ready(catalog)
            ? String(catalog.data.name || volumeId || "目录") + " · " + chapterCount(catalog.data) + " 章"
            : null;
          body = jsx(CardSection, {
            title: "目录",
            meta: [catalogMeta, selectedKinds].filter(Boolean).join(" · ") || null,
            hint: "按册 → 章 → 条目展开；点条目进入详情，可复制或编辑。",
            children: jsx(CatalogView, {
              summary,
              volumes,
              volumeId,
              catalog,
              onPick: (id) => setVolumeId(id),
              onOpenEntry: (id) => openEntry(id, "catalog")
            })
          });
        } else if (view === "tools") {
          body = jsx(CardSection, {
            title: "工具与调试",
            meta:
              ready(toolShelf) && toolShelf.data && toolShelf.data.summary
                ? fmtNum(toolShelf.data.summary.visibleToolCount) + " 个工具"
                : null,
            hint: "本机工具按来源归类；未挂载的包不占上下文。",
            children: jsx(ToolShelfView, { data: toolShelf })
          });
        } else {
          body = jsx(CardSection, {
            title: "AI 协作",
            meta: ready(ai) ? String(ai.data.name || "AI 协作") + " · " + chapterCount(ai.data) + " 章" : null,
            hint: "单独记 AI 自己干活时踩的坑：假设错了、工具用错、验证漏了。",
            children: jsx(AiCollabView, { ai, onOpenEntry: (id) => openEntry(id, "ai") })
          });
        }

        return jsxs("div", {
          className: "ms-root",
          children: [
            jsxs("header", {
              className: "ms-top",
              children: [
                jsx("span", { className: "ms-title", children: "书阁" }),
                jsx("nav", {
                  className: "ms-tabs",
                  "aria-label": "书阁视图",
                  children: TABS.map((tab) =>
                    jsx(
                      "button",
                      {
                        type: "button",
                        className: "ms-tab",
                        "data-on": String(tab.id === view),
                        "aria-pressed": tab.id === view,
                        onClick: () => gotoView(tab.id),
                        children: tab.label
                      },
                      tab.id
                    )
                  )
                }),
                // 快照过期徽标：放在 meta 左边而不是塞进 metaText 里 ——
                // metaText 是"事实型数字"，过期提示是"警告"，两者排版诉求不同
                // （一个吃宽度截断，一个必须短且带描边才被看见）。
                staleText
                  ? jsx("span", {
                      className: "ms-stale",
                      title: "后端内存快照，不是实时数字；重新扫描后才会更新",
                      children: staleText
                    })
                  : null,
                jsx("span", { className: "ms-meta", children: metaText })
              ]
            }),
            // 搜索独占一行：它是"人打开手册的第一动作"。
            jsx("div", {
              className: "ms-searchbar",
              children: jsxs("div", {
                className: "ms-search",
                children: [
                  jsx("span", {
                    className: "ms-searchIcon",
                    children: jsxs("svg", {
                      width: 14,
                      height: 14,
                      viewBox: "0 0 24 24",
                      fill: "none",
                      stroke: "currentColor",
                      strokeWidth: 2,
                      strokeLinecap: "round",
                      children: [jsx("circle", { cx: 11, cy: 11, r: 7 }), jsx("path", { d: "M20 20l-3.4-3.4" })]
                    })
                  }),
                  jsx("input", {
                    ref: searchInputRef,
                    type: "search",
                    className: "ms-searchInput",
                    "aria-label": "搜索手册条目",
                    placeholder: "搜一条结论：器件型号、工具名、报错原文…",
                    value: query,
                    onChange: (event) => {
                      const value = event && event.target ? event.target.value : "";
                      setQuery(value);
                      if (!value.trim()) {
                        setSearchQ("");
                        if (view === "search") gotoView("shelf");
                      }
                    },
                    onKeyDown: (event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setQuery("");
                        setSearchQ("");
                        if (view === "search") gotoView("shelf");
                      }
                    }
                  }),
                  query
                    ? jsx("button", {
                        type: "button",
                        className: "ms-searchClear",
                        title: "清空搜索",
                        onClick: clearSearch,
                        children: "×"
                      })
                    : null
                ]
              })
            }),
            jsx("div", { className: "ms-body", ref: bodyRef, children: body })
          ]
        });
      }

    /**
     * 插件管理页（设置 → 插件 → 已安装）里的配置视图。
     *
     * 没有这个组件，用户在"已安装插件"列表里**看不到书阁** —— 因为你装了插件
     * 却没有任何 UI 归属，管理页就不会为它渲染一行。这是 2026-11-02 实测发现的。
     *
     * props 契约（dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts）：
     *   { view: 'summary' | 'page', form?: ConfigPageForm }
     *   - summary：只渲染一行说明
     *   - page：渲染完整说明页
     *
     * 本插件零配置（不需要 key、不需要填路径），所以这里只做说明，不放表单。
     */
    function PluginConfigView(props) {
      const view = props && props.view ? props.view : "summary";
      const line = "把已归档对话编译成有目录、可溯源的手册（零配置，装上即用）";

      if (view === "summary") {
        return jsx("span", { style: { fontSize: "12px", color: "var(--text-2)" }, children: line });
      }

      return jsxs("div", {
        style: { display: "flex", flexDirection: "column", gap: "12px", fontSize: "12px", lineHeight: "1.7" },
        children: [
          jsxs("div", {
            style: { display: "flex", alignItems: "center", gap: "8px", color: "var(--text)", fontWeight: 600 },
            children: [
              jsx(BookGlyph, { size: 14 }),
              jsx("span", { children: "书阁 · dsh-manuscript" })
            ]
          }),
          jsx("p", {
            style: { margin: 0, color: "var(--text-2)" },
            children: "扫描 ~/.dsh/sessions 下的已归档会话，按工作类型归册成书，并提供 4 个查阅工具（manual_toc / manual_read / manual_recall / manual_trace）。"
          }),
          jsx("p", {
            style: { margin: 0, color: "var(--text-2)" },
            children: "零配置：不需要 API key，不需要填路径。扫描与建库全部在本地完成，不联网、不调用模型。"
          }),
          jsx("p", {
            style: { margin: 0, color: "var(--text-3)", fontSize: "11px" },
            children: "状态与进度：点左栏「书阁」图标打开面板，或看左栏底部的进度卡（折叠时显示为进度环）。"
          })
        ]
      });
    }

    return {
      ManuscriptCard,
        ManuscriptPanelIcon,
        ManuscriptPage,
        BookGlyph,
        PluginConfigView
      };
    }

    // ── 注册 ────────────────────────────────────────────────────────────────
    const inject = ["slots", "layout"];

    function apply(ctx) {
      ensureStyles();
      const ui = createUi(ctx);

      // ① 左栏底部常驻迷你卡（props: { wide }）
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({ name: "sidebar.footer.action", id: "manuscript-card" }, ui.ManuscriptCard)
      );

      // ② 左栏图标入口（id 必须等于 main 的 key）
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: -10, label: "书阁" },
          ui.ManuscriptPanelIcon
        )
      );

      // ③ 主面板（keyed main · key = "manuscript"）
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID }, ui.ManuscriptPage)
      );

      // ③ 插件管理页的配置入口（keyed 槽）。
      //    没有这一行，用户在「设置 → 插件 → 已安装」里**看不到书阁**。
      //    key 必须是 `<包名>#<行 id>`，行 id 就是 cordis.patch.yml 里 insert 的 id。
      //    契约：'plugins.row.config': { kind: 'keyed', scope: 'root', owner: PluginConfigViewProps }
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register(
          { name: "plugins.row.config", key: ENTRY_ID + "#" + ENTRY_ID },
          ui.PluginConfigView
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
