#!/usr/bin/env node
/**
 * 给 client.js 增加 plugins.row.config 槽注册。
 *
 * 为什么单独写脚本而不是直接编辑：
 *   这个文件之前被 PowerShell 的 Set-Content -Encoding UTF8（PS 5.1 会写 BOM
 *   且按当前代码页处理中文）反复破坏，导致 80 行中文注释变成乱码、
 *   12 行注释把后面的代码吞掉。
 *   **Node 的 fs.writeFileSync(p, s, 'utf8') 严格输出 UTF-8 无 BOM**，
 *   不会再出现这个问题。
 *
 * 改动内容：
 *   ① 加 ENTRY_ID 常量
 *   ② 加 PluginConfigView 组件（view = 'summary' | 'page'）
 *   ③ 注册 plugins.row.config（keyed 槽，key = `包名#行id`）
 *   ④ 加入 createUi 的导出
 */

import { readFileSync, writeFileSync } from 'node:fs'

const p = process.argv[2]
if (!p) {
  console.error('用法: node add-plugins-row-config.mjs <client.js 路径>')
  process.exit(1)
}

let src = readFileSync(p, 'utf8')
const before = src.length

// 幂等：已经加过就跳过
if (src.includes("plugins.row.config")) {
  console.log('已存在 plugins.row.config，跳过')
  process.exit(0)
}

// ── ① ENTRY_ID 常量 ──
const anchorPanel = '    const PANEL_ID = "manuscript";'
if (!src.includes(anchorPanel)) {
  console.error('✗ 找不到 PANEL_ID 锚点')
  process.exit(1)
}
src = src.replace(
  anchorPanel,
  anchorPanel +
    '\n' +
    '    // 插件管理页里的行 id，必须与 cordis.patch.yml 的 insert id 一致\n' +
    '    const ENTRY_ID = "dsh-manuscript";'
)

// ── ② PluginConfigView 组件（插在 createUi 的 return 之前）──
const anchorReturn = `      return {
        ManuscriptCard,`
if (!src.includes(anchorReturn)) {
  console.error('✗ 找不到 createUi return 锚点')
  process.exit(1)
}

const component = `    /**
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
            style: { margin: 0, color: "var(--text-3)", fontSize: "11.5px" },
            children: "状态与进度：点左栏「书阁」图标打开面板，或看左栏底部的进度卡（折叠时显示为进度环）。"
          })
        ]
      });
    }

    return {
      ManuscriptCard,`

src = src.replace(anchorReturn, component)

// ── ③ 导出 ──
const anchorExport = `        ManuscriptPage,
        BookGlyph
      };`
if (!src.includes(anchorExport)) {
  console.error('✗ 找不到导出锚点')
  process.exit(1)
}
src = src.replace(
  anchorExport,
  `        ManuscriptPage,
        BookGlyph,
        PluginConfigView
      };`
)

// ── ④ 注册槽 ──
const anchorMain = `      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID }, ui.ManuscriptPage)
      );`
if (!src.includes(anchorMain)) {
  console.error('✗ 找不到 main 槽锚点')
  process.exit(1)
}
src = src.replace(
  anchorMain,
  anchorMain +
    `

      // ③ 插件管理页的配置入口（keyed 槽）。
      //    没有这一行，用户在「设置 → 插件 → 已安装」里**看不到书阁**。
      //    key 必须是 \`<包名>#<行 id>\`，行 id 就是 cordis.patch.yml 里 insert 的 id。
      //    契约：'plugins.row.config': { kind: 'keyed', scope: 'root', owner: PluginConfigViewProps }
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register(
          { name: "plugins.row.config", key: ENTRY_ID + "#" + ENTRY_ID },
          ui.PluginConfigView
        )
      );`
)

writeFileSync(p, src, 'utf8')
console.log(`✓ 完成：${before} → ${src.length} 字节`)
console.log('  ① ENTRY_ID 常量')
console.log('  ② PluginConfigView 组件')
console.log('  ③ plugins.row.config 注册')
console.log('  ④ 导出与注册接线')
