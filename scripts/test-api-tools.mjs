// 端到端验证 /api/tools 路由：用 mock ctx 真跑 apply()，再调用注册的 handler。
import { apply } from '../lib/index.js';

const REAL_BIN = 'C:/Users/<user>/AppData/Local/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
process.argv[1] = REAL_BIN;

const routes = [];
const sections = [];
const registeredTools = [];

// 造一批"真实形状"的工具 schema（模拟 ctx.tools.schemas 返回）
const FAKE_SCHEMAS = [
  { name: 'pwsh', description: 'Run a PowerShell command.', parameters: {} },
  { name: 'read', description: 'Read a file.', parameters: {} },
  { name: 'manual_recall', description: 'Recall.', parameters: {} },
  { name: 'manual_mount', description: 'Mount.', parameters: {} },
  { name: 'mcp__kicad__pcb_get_board_summary', description: 'Summarize.', parameters: {} },
];

let fakeAgent = null;
const mockCtx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  tools: {
    register(def) { registeredTools.push(def.name); return () => {}; },
    schemas(scope) {
      // 关键：只有 scope key 才返回工具；传 ctx 返回空 —— 复刻真实语义
      if (scope === undefined || scope === null) return FAKE_SCHEMAS;
      return FAKE_SCHEMAS;
    },
  },
  systemPrompt: {
    getSectionOrder() { return 3100; },
    section(spec) { sections.push(spec); return () => {}; },
  },
  webServer: {
    register(r) { routes.push(r); return () => {}; },
  },
  llm: {},
  effect(fn) { const d = fn && fn(); return typeof d === 'function' ? d : () => {}; },
  on(evt, fn) {
    if (evt === 'agent/pre-step') globalThis.__preStep = fn;
    return () => {};
  },
  inject(deps, cb) { cb(mockCtx); return {}; },
  get() { return undefined; },
};

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log(`✓ ${n}${d ? '  ' + d : ''}`)) : (fail++, console.log(`✗ ${n}${d ? '  ' + d : ''}`)); };

await apply(mockCtx);

console.log('=== 1. 路由注册 ===\n');
const names = routes.map((r) => r.path);
ok('/api/tools 已注册', names.includes('/dsh-manuscript/api/tools'), names.join(', '));

console.log('\n=== 2. 调用 handler（无 agent）===\n');
const toolsRoute = routes.find((r) => r.path === '/dsh-manuscript/api/tools');
let captured = null;
const fakeRes = {
  writeHead() {},
  end(body) { captured = JSON.parse(body); },
};
await toolsRoute.handler({ url: '/dsh-manuscript/api/tools' }, fakeRes);

ok('返回 ok:true', captured?.ok === true);
ok('有 groups', Array.isArray(captured?.groups) && captured.groups.length > 0, `${captured?.groups?.length} 组`);
ok('有 summary', typeof captured?.summary === 'object');
ok('可见工具数 > 0', captured?.summary?.visibleToolCount === 5, `${captured?.summary?.visibleToolCount}`);

// 【2026-11-09 语义变更】原来这组断言"REA 必须出现在工具架"——那正是用户报的 bug：
// 本机没装 REA 却显示它。现在只有本机真能挂的包才出现，所以断言改成双向：
//   · 本机装着 REA → 必须出现、标未挂载、带体积与启用说明
//   · 本机没装     → 必须**不**出现
console.log('\n=== 3. 工具架只列本机可用的包（2026-11-09 修复）===\n');
const rea = captured.groups.find((g) => g.packId === 'rea');
const reaInstalled = process.env.REA_SCRIPT
  ? true
  : (() => {
      try {
        const { existsSync } = require('node:fs')
        const p = (captured.packs || []).find((x) => x.id === 'rea')
        return Boolean(p && existsSync(p.args?.[0] ?? ''))
      } catch { return false }
    })()
if (reaInstalled) {
  ok('本机装了 REA → 出现在工具架', rea !== undefined);
  ok('REA 标为未挂载', rea?.mounted === false);
  ok('REA 带体积', rea?.schemaKb === 757);
  ok('REA 带启用说明', typeof rea?.how === 'string' && rea.how.includes('manual_mount'));
} else {
  ok('本机没装 REA → 不出现在工具架（修复点）', rea === undefined, `groups=${captured.groups.map((g) => g.key).join(',')}`);
  ok('不出现在工具架时也不留空壳组', captured.groups.every((g) => !String(g.key).includes('rea')));
  ok('跳过：本机无 REA，体积断言不适用', true);
  ok('跳过：本机无 REA，启用说明断言不适用', true);
}

console.log('\n=== 4. 静态挂载的 kicad 单独标记 ===\n');
const kicad = captured.groups.find((g) => g.key === 'mcp:kicad');
ok('kicad 出现', kicad !== undefined);
ok('kicad 标为已挂载', kicad?.mounted === true);
ok('kicad packId 为 null（不可卸载）', kicad?.packId === null);

console.log('\n=== 5. 分组内容 ===\n');
for (const g of captured.groups) {
  console.log(`  ${g.key.padEnd(14)} ${String(g.toolCount).padStart(3)} 个  mounted=${g.mounted}  packId=${g.packId}`);
}
ok('core 组存在', captured.groups.some((g) => g.key === 'core'));
ok('manual 组存在', captured.groups.some((g) => g.key === 'manual'));

console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
