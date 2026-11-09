import {
  resolvePack,
  buildMountConfig,
  diffMountedTools,
  renderMountResult,
  renderUnmountResult,
  renderToolPacks,
  mountedPackIdsForScope,
  mountPack,
  unmountPack,
  TOOL_PACKS,
} from '../lib/index.js';

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log(`✓ ${n}${d ? '  ' + d : ''}`)) : (fail++, console.log(`✗ ${n}${d ? '  ' + d : ''}`)); };

console.log('=== 1. resolvePack（未知/空/正常）===\n');
ok('未知 id 被拒', !resolvePack('nope').ok);
const bad = resolvePack('nope');
ok('未知 id 报错含可用列表', bad.reason.includes('rea') && bad.reason.includes('未知'));
ok('空 id 被拒', !resolvePack('').ok);
ok('undefined 被拒', !resolvePack(undefined).ok);
const good = resolvePack('rea');
ok('rea 通过', good.ok);
ok('rea 带 serverName', good.pack?.serverName === 'rea');
const padded = resolvePack('  rea  ');
ok('前后空格被容忍', padded.ok && padded.pack.id === 'rea');

console.log('\n=== 2. buildMountConfig 关键字段 ===\n');
const cfg = buildMountConfig(good.pack);
ok('failOnStartupError 必须为 true', cfg.failOnStartupError === true, '（false 会让失败静默）');
ok('serverName 正确', cfg.serverName === 'rea');
ok('transport 为 stdio', cfg.transport === 'stdio');
ok('args 是数组且有 2 项', Array.isArray(cfg.args) && cfg.args.length === 2);
ok('toolCallTimeoutMs 保留 900000', cfg.toolCallTimeoutMs === 900000);
ok('env 保留 GHIDRA_INSTALL_DIR', typeof cfg.env?.GHIDRA_INSTALL_DIR === 'string');
ok('env 保留 JAVA_HOME', typeof cfg.env?.JAVA_HOME === 'string');
ok('reconnect 保留', cfg.reconnect?.enabled === true);
ok('未泄漏内部字段（what/when/cost）', cfg.what === undefined && cfg.cost === undefined);

console.log('\n=== 3. diffMountedTools ===\n');
const before = ['pwsh', 'read', 'manual_recall'];
const after = ['pwsh', 'read', 'manual_recall', 'mcp__rea__analyze_function', 'mcp__rea__compare_functions', 'mcp__kicad__x'];
const d = diffMountedTools(before, after, 'rea');
ok('只统计本 serverName 的新增', d.count === 2, d.added.join(', '));
ok('不含其他 server 的工具', !d.added.includes('mcp__kicad__x'));
ok('不含原有工具', !d.added.includes('pwsh'));
const d0 = diffMountedTools(before, before, 'rea');
ok('无新增且无可见时为 0', d0.count === 0);
const dEmpty = diffMountedTools(before, [], 'rea');
ok('工具消失时为 0（不报负数）', dEmpty.count === 0);

// ── 遮蔽场景回归（2026-11-03 实测发现的 bug）──
// 同名工具已存在时，scoped 挂载成功后名字列表不变，差集为空。
// 旧实现据此报 count:0/degraded，但工具其实完全可用 —— 假警报。
console.log('\n--- 遮蔽场景（回归）---');
const shadowBefore = ['pwsh', 'mcp__rea__echo', 'mcp__rea__ping'];
const shadowAfter = ['pwsh', 'mcp__rea__echo', 'mcp__rea__ping'];
const ds = diffMountedTools(shadowBefore, shadowAfter, 'rea');
ok('遮蔽时 count 仍为可见工具数 2', ds.count === 2, `count=${ds.count}`);
ok('遮蔽时 added 为空', ds.added.length === 0);
ok('遮蔽时 shadowed 标出 2 个', ds.shadowed === 2);
ok('遮蔽时不应被判 degraded', ds.count !== 0);

// 部分遮蔽：一个已存在、一个新增
const mixAfter = ['pwsh', 'mcp__rea__echo', 'mcp__rea__ping', 'mcp__rea__extra'];
const dm = diffMountedTools(shadowBefore, mixAfter, 'rea');
ok('部分遮蔽 count=3', dm.count === 3);
ok('部分遮蔽 added=1', dm.added.length === 1 && dm.added[0] === 'mcp__rea__extra');
ok('部分遮蔽 shadowed=2', dm.shadowed === 2);

console.log('\n=== 4. renderMountResult ===\n');
const rOk = renderMountResult({ ok: true, packId: 'rea', serverName: 'rea', count: 207, schemaKb: 757 });
ok('成功含工具数', rOk.includes('207'));
ok('成功含卸载提示', rOk.includes('manual_unmount'));
ok('成功含开销提示', rOk.includes('757'));
const rZero = renderMountResult({ ok: true, packId: 'rea', serverName: 'rea', count: 0, schemaKb: 757 });
ok('0 工具时显式告警', rZero.includes('没有任何工具'));
ok('0 工具时禁止假装可用', rZero.includes('不要假装'));
// 遮蔽场景：不能渲染成假警报
const rShadow = renderMountResult({ ok: true, packId: 'rea', serverName: 'rea', count: 2, shadowed: 2, schemaKb: 757 });
ok('遮蔽时不报"没有工具"', !rShadow.includes('没有任何工具'));
ok('遮蔽时说明遮蔽接管', rShadow.includes('遮蔽接管') && rShadow.includes('2'));
const rBad = renderMountResult({ ok: false, reason: '炸了' });
ok('失败时返回原因', rBad.includes('炸了') && rBad.includes('失败'));

console.log('\n=== 5. renderUnmountResult ===\n');
const uOk = renderUnmountResult({ ok: true, packId: 'rea', wasMounted: true, freed: 207 });
ok('卸载成功含释放数', uOk.includes('207'));
ok('卸载成功提醒核对', uOk.includes('仍能在工具列表'));
const uNo = renderUnmountResult({ ok: true, packId: 'rea', wasMounted: false, freed: 0 });
ok('未挂载时不报错', uNo.includes('无需卸载') && !uNo.includes('失败'));
const uBad = renderUnmountResult({ ok: false, reason: 'x' });
ok('卸载失败有原因', uBad.includes('卸载失败'));

console.log('\n=== 6. renderToolPacks 挂载态 ===\n');
const un = renderToolPacks(TOOL_PACKS);
const on = renderToolPacks(TOOL_PACKS, { mounted: ['rea'] });
ok('未挂载时说"未挂载"', un.text.includes('怎么启用'));
ok('未挂载时无"已挂载"字样', !un.text.includes('本会话已挂载'));
ok('已挂载时标注已挂载', on.text.includes('本会话已挂载'));
ok('已挂载时给出卸载指引', on.text.includes('manual_unmount'));
ok('已挂载时不再显示启用方法', !on.text.includes('怎么启用'));
ok('两者都在 2KB 内', un.bytes < 2048 && on.bytes < 2048, `${un.bytes} / ${on.bytes} B`);
ok('mounted 为字符串数组也支持', renderToolPacks(TOOL_PACKS, { mounted: ['rea'] }).text.includes('已挂载'));

console.log('\n=== 7. mountedPackIdsForScope ===\n');
const st = { byAgent: new Map(), byScope: new Map() };
const keyA = {};
st.byScope.set(keyA, new Set(['rea']));
ok('能读到 scope 的已挂载集合', mountedPackIdsForScope(st, keyA).includes('rea'));
ok('未知 scope 返回空', mountedPackIdsForScope(st, {}).length === 0);
ok('undefined scope 返回空', mountedPackIdsForScope(st, undefined).length === 0);
ok('state 为空时安全', mountedPackIdsForScope(null, keyA).length === 0);

console.log('\n=== 8. mountPack 守卫（不真挂载）===\n');
const mkState = () => ({ byAgent: new Map(), byScope: new Map() });

// 8a: 无 agent
const r1 = await mountPack({ state: mkState(), agent: null, packId: 'rea' });
ok('无 agent 时拒绝', !r1.ok);
ok('拒绝理由提到泄漏', r1.reason.includes('泄漏'));

// 8b: agent 无 ctx
const r2 = await mountPack({ state: mkState(), agent: { id: 'a1' }, packId: 'rea' });
ok('agent 无 ctx 时拒绝', !r2.ok);

// 8c: 未知包（在此之前不该触达 mcp-client 加载）
const r3 = await mountPack({ state: mkState(), agent: { id: 'a1', ctx: {} }, packId: 'ghost' });
ok('未知包时拒绝', !r3.ok);
ok('未知包理由明确', r3.reason.includes('未知工具包'));

// 8d: 幂等守卫 —— 预置一条已挂载记录
const st2 = mkState();
st2.byAgent.set('a1', new Map([['rea', { count: 5, fiber: {} }]]));
const r4 = await mountPack({ state: st2, agent: { id: 'a1', ctx: {} }, packId: 'rea' });
ok('重复挂载被拦', !r4.ok && r4.alreadyMounted === true);
ok('重复挂载理由可执行', r4.reason.includes('manual_unmount'));

console.log('\n=== 9. unmountPack 幂等 ===\n');
const st3 = mkState();
const u1 = await unmountPack({ state: st3, agent: { id: 'a1' }, packId: 'rea' });
ok('未挂载时卸载不报错', u1.ok && u1.wasMounted === false);
const u2 = await unmountPack({ state: st3, agent: { id: 'a1' }, packId: '' });
ok('空 id 被拒', !u2.ok);

// 真卸载：用一个假 fiber
const st4 = mkState();
let disposed = false;
st4.byAgent.set('a1', new Map([['rea', { count: 5, fiber: { dispose: async () => { disposed = true; } } }]]));
const u3 = await unmountPack({ state: st4, agent: { id: 'a1' }, packId: 'rea' });
ok('卸载调用了 fiber.dispose', disposed === true);
ok('卸载返回释放数', u3.ok && u3.freed === 5);
ok('卸载后状态已清', st4.byAgent.get('a1').size === 0);

// dispose 抛错时仍清理状态
const st5 = mkState();
st5.byAgent.set('a1', new Map([['rea', { count: 3, fiber: { dispose: async () => { throw new Error('boom'); } } }]]));
const u4 = await unmountPack({ state: st5, agent: { id: 'a1' }, packId: 'rea' });
ok('dispose 抛错时报告失败', !u4.ok && u4.reason.includes('boom'));
ok('dispose 抛错后状态仍被清理', st5.byAgent.get('a1').size === 0);

console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
