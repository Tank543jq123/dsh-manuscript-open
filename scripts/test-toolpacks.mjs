import { renderToolPacks, TOOL_PACKS, packAvailable, availablePacks, resolvePack } from '../lib/index.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`✗ ${name}${detail ? '  ' + detail : ''}`); }
}

console.log('=== 工具包清单渲染 ===\n');

// 【2026-11-09】显式传 TOOL_PACKS，而不是走默认值（默认已改成"只渲染本机可用的包"）。
// 这里测的是**渲染逻辑本身**对不对，所以要喂一个确定的输入，不依赖本机装没装。
const r = renderToolPacks(TOOL_PACKS);
console.log(r.text);
console.log('\n--- 字节数:', r.bytes, '---\n');

ok('渲染出标题', r.text.includes('## 书阁 · 可用但未挂载的工具包'));
// 【2026-11-09】这条要测的是**默认行为**（不传参时只渲染本机可用的包），
// 不能用上面那个显式传 TOOL_PACKS 的 r。单列一个变量。
const rDefault = renderToolPacks();
ok('默认只渲染本机可用的包（本机无 REA 则不含）',
  packAvailable(TOOL_PACKS.find((p) => p.id === 'rea'))
    ? rDefault.text.includes('REA 逆向工程工具包')
    : !rDefault.text.includes('REA 逆向工程工具包'),
  `本机可用 ${availablePacks().length}/${TOOL_PACKS.length} 个包`);
ok('包含默认未挂载声明', r.text.includes('默认未启用'));
// 启用方式已从「改配置重启」改为「模型自助挂载」，断言随之更新。
// 保留对两种路径的检查：文本里应指向 manual_mount，而不是让用户去改 yml。
ok('包含启用方法（自助挂载）', r.text.includes('manual_mount') && r.text.includes('manual_unmount'));
ok('不再要求用户改配置重启', !r.text.includes('disabled: true'));
ok('包含代价', r.text.includes('token'));
ok('包含禁令', r.text.includes('禁止') && r.text.includes('声称已调用'));
ok('体积在 2KB 内（自相矛盾检查）', r.bytes < 2048, `${r.bytes} B`);

console.log('\n=== 数据自洽性 ===\n');
for (const p of TOOL_PACKS) {
  ok(`${p.id}: 有 status`, typeof p.status === 'string' && p.status.length > 0);
  ok(`${p.id}: schemaKb 与 tools 数一致（量级）`, p.schemaKb > 0 && p.tools > 0,
    `${p.tools} 工具 / ${p.schemaKb} KB / 均 ${(p.schemaKb * 1024 / p.tools).toFixed(0)} B`);
  const avg = p.schemaKb * 1024 / p.tools;
  ok(`${p.id}: 单工具均体积在合理区间(1–8KB)`, avg > 1024 && avg < 8192, `${avg.toFixed(0)} B`);
}

console.log('\n=== 空清单降级（2026-11-09 改）===\n');
const empty = renderToolPacks([]);
// 空清单不该输出任何东西 —— 包括那句"以下能力存在于本机"。
// 本机一个包都没有时，这句话本身就是在说谎。
ok('空数组返回空串（不伪造"本机存在"）', empty.text === '', JSON.stringify(empty.text.slice(0, 40)));
ok('空数组字节数为 0', empty.bytes === 0, `${empty.bytes} B`);

console.log('\n=== 本机可用性探测（2026-11-09 用户报的 bug）===\n');
// 背景：TOOL_PACKS 硬编码了 REA，写它的人机器上装了 REA，别人机器上没有却照样显示。
// 用户看到自己从没装过的东西出现在工具架，报为 bug。
const rea = TOOL_PACKS.find((p) => p.id === 'rea');
const reaOk = packAvailable(rea);
ok('packAvailable 对 rea 给出布尔判定', typeof reaOk === 'boolean', `本机=${reaOk}`);
ok('入口脚本不存在时判为不可用',
  (() => {
    const fake = { id: 'x', args: ['/definitely/not/here-' + Date.now()] };
    return packAvailable(fake) === false;
  })());
ok('没有 args 的包不拦（纯展示包）', packAvailable({ id: 'y' }) === true);
ok('availablePacks 是本机可用集的子集',
  availablePacks().every((p) => TOOL_PACKS.some((q) => q.id === p.id)));
ok('availablePacks 过滤掉不可用的',
  availablePacks().length === TOOL_PACKS.filter(packAvailable).length,
  `${availablePacks().length}/${TOOL_PACKS.length}`);

// 挂载要给能照着做的错误，而不是让 MCP 客户端抛 spawn ENOENT
if (!reaOk) {
  const r2 = resolvePack('rea');
  ok('本机不可用时 mountPack 拒绝并说明原因', r2.ok === false);
  ok('错误里含"本机不可用"', r2.ok === false && r2.reason.includes('本机不可用'), (r2.reason || '').slice(0, 60));
  ok('错误里指出入口脚本路径', r2.ok === false && r2.reason.includes('入口脚本不存在'));
  ok('错误里给出补救方式（环境变量）', r2.ok === false && /REA_SCRIPT|REA_NODE/.test(r2.reason));
} else {
  ok('本机已装 REA，跳过不可用分支断言', true);
  ok('本机已装 REA，跳过', true);
  ok('本机已装 REA，跳过', true);
  ok('本机已装 REA，跳过', true);
}

console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
