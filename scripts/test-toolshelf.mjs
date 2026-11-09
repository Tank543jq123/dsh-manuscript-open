import {
  classifyTool,
  buildToolShelf,
  renderToolShelfText,
  TOOL_SOURCES,
} from '../lib/toolshelf.js';
import { TOOL_PACKS } from '../lib/index.js';

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log(`✓ ${n}${d ? '  ' + d : ''}`)) : (fail++, console.log(`✗ ${n}${d ? '  ' + d : ''}`)); };

console.log('=== 1. classifyTool ===\n');
ok('MCP 工具归类', classifyTool('mcp__rea__analyze_function').source === 'mcp');
ok('MCP 取到 serverName', classifyTool('mcp__rea__analyze_function').serverName === 'rea');
ok('MCP 带下划线的工具名仍正确', classifyTool('mcp__kicad__pcb_get_board_summary').serverName === 'kicad');
ok('书阁工具归类', classifyTool('manual_recall').source === 'manual');
ok('书阁工具 serverName 为 null', classifyTool('manual_recall').serverName === null);
ok('核心工具归类', classifyTool('pwsh').source === 'core');
ok('空名容错', classifyTool('').source === 'unknown');
ok('非字符串容错', classifyTool(null).source === 'unknown');
ok('MCP 缺 serverName 段容错', classifyTool('mcp__broken').serverName === null);

console.log('\n=== 2. buildToolShelf 基本分组 ===\n');
const tools = [
  { name: 'pwsh', description: 'Run a PowerShell command.' },
  { name: 'read', description: 'Read a file.' },
  { name: 'manual_recall', description: 'Recall from manual.' },
  { name: 'manual_mount', description: 'Mount a tool pack.' },
  { name: 'mcp__kicad__pcb_get_board_summary', description: 'Summarize board.' },
];
const shelf = buildToolShelf({ tools, packs: TOOL_PACKS, mounted: [] });
// 4 组 = core + manual + MCP(rea, 未挂载) + MCP(kicad, 静态挂载无包定义)
// kicad 这条是刻意保留的：不能因为没有工具包定义就把用户实际在用的 MCP 藏起来。
ok('产出 4 组（core/manual/mcp:rea/mcp:kicad）', shelf.groups.length === 4, `实际 ${shelf.groups.length}`);
ok('core 组含 2 个', shelf.groups.find((g) => g.key === 'core')?.toolCount === 2);
ok('manual 组含 2 个', shelf.groups.find((g) => g.key === 'manual')?.toolCount === 2);
ok('可见工具总数正确', shelf.summary.visibleToolCount === 5);

console.log('\n=== 2b. 静态挂载 vs 可卸载包（必须分开）===\n');
ok('静态挂载包计数 = 1（kicad）', shelf.summary.staticPackCount === 1, `${shelf.summary.staticPackCount}`);
ok('可卸载包计数 = 0（都没挂）', shelf.summary.unmountableCount === 0);
ok('kicad 的 packId 为 null', shelf.groups.find((g) => g.key === 'mcp:kicad')?.packId === null);

console.log('\n=== 3. 未挂载的工具包必须露出（本次核心诉求）===\n');
const reaGroup = shelf.groups.find((g) => g.packId === 'rea');
ok('未挂载的 rea 出现在工具架里', reaGroup !== undefined);
ok('rea 标为未挂载', reaGroup?.mounted === false);
ok('rea 带体积信息', reaGroup?.schemaKb === 757);
ok('rea 带启用方法', typeof reaGroup?.how === 'string' && reaGroup.how.length > 0);
ok('未挂载包计数为 1', shelf.summary.unmountedPackCount === 1);
ok('省下的 KB 被统计', shelf.summary.savedKbByUnmounted === 757, `${shelf.summary.savedKbByUnmounted} KB`);

console.log('\n=== 4. 挂载后状态翻转 ===\n');
const mountedTools = [...tools,
  { name: 'mcp__rea__echo', description: 'x' },
  { name: 'mcp__rea__ping', description: 'y' },
];
const shelf2 = buildToolShelf({ tools: mountedTools, packs: TOOL_PACKS, mounted: ['rea'] });
const rea2 = shelf2.groups.find((g) => g.packId === 'rea');
ok('rea 标为已挂载', rea2?.mounted === true);
ok('rea 工具数 = 2', rea2?.toolCount === 2);
// mountedPackCount 含 kicad（静态挂的也是"已挂载的 MCP"），所以是 2
ok('已挂载包计数 = 2（rea + kicad）', shelf2.summary.mountedPackCount === 2, `${shelf2.summary.mountedPackCount}`);
ok('其中可卸载的只有 rea = 1', shelf2.summary.unmountableCount === 1, `${shelf2.summary.unmountableCount}`);
ok('未挂载包计数归零', shelf2.summary.unmountedPackCount === 0);
ok('省下的 KB 归零', shelf2.summary.savedKbByUnmounted === 0);
ok('工具名已列出', rea2?.tools.some((t) => t.name === 'mcp__rea__echo'));

console.log('\n=== 5. 没有包定义的 MCP 也要露出（不能藏）===\n');
// kicad 在 TOOL_PACKS 里没有定义，是 profile 静态挂的
const kicadGroup = shelf.groups.find((g) => g.key === 'mcp:kicad');
ok('未定义的 MCP 服务仍展示', kicadGroup !== undefined);
ok('未定义的 MCP 标为已挂载', kicadGroup?.mounted === true);
ok('未定义的 MCP 说明来源', typeof kicadGroup?.desc === 'string');
ok('未定义的 MCP toolCount=1', kicadGroup?.toolCount === 1, `实际 ${kicadGroup?.toolCount}`);

console.log('\n=== 6. 用户向说明文案 ===\n');
const coreG = shelf.groups.find((g) => g.key === 'core');
const pwshTool = coreG.tools.find((t) => t.name === 'pwsh');
ok('手写说明优先于 schema', pwshTool.human === '执行 PowerShell 命令', pwshTool.human);
const manualG = shelf.groups.find((g) => g.key === 'manual');
ok('manual_mount 有中文说明', manualG.tools.find((t) => t.name === 'manual_mount').human === '挂载工具包');

console.log('\n=== 7. 无 hints 时回落到 schema description ===\n');
const noHint = buildToolShelf({ tools: [{ name: 'unknown_tool_x', description: 'Does something cool. More text here.' }], hints: {} });
ok('回落到 description', noHint.groups[0].tools[0].human === 'Does something cool');

console.log('\n=== 8. renderToolShelfText ===\n');
const txt = renderToolShelfText(shelf);
ok('有标题', txt.includes('## 书阁 · 工具架'));
ok('含可见工具数', txt.includes('5 个工具'));
ok('含未挂载提示', txt.includes('未挂载'));
ok('含 REA', txt.includes('REA'));
ok('不含模型向命令语（"禁止声称"）', !txt.includes('禁止声称'));
ok('空输入安全', renderToolShelfText(null) === '（工具架为空）');

console.log('\n=== 9. 边界 ===\n');
const empty = buildToolShelf({});
ok('全空安全', empty.groups.length === 0 && empty.summary.visibleToolCount === 0);
const onlyPacks = buildToolShelf({ tools: [], packs: TOOL_PACKS });
ok('无工具但有包时仍列出包', onlyPacks.groups.some((g) => g.packId === 'rea'));
ok('且标为未挂载', onlyPacks.groups.find((g) => g.packId === 'rea').mounted === false);
const dupTools = buildToolShelf({ tools: [{ name: 'pwsh' }, { name: 'pwsh' }] });
ok('重复工具不炸', dupTools.groups[0].toolCount === 2);

console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
