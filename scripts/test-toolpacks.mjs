import { renderToolPacks, TOOL_PACKS } from '../lib/index.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`✗ ${name}${detail ? '  ' + detail : ''}`); }
}

console.log('=== 工具包清单渲染 ===\n');

const r = renderToolPacks();
console.log(r.text);
console.log('\n--- 字节数:', r.bytes, '---\n');

ok('渲染出标题', r.text.includes('## 书阁 · 可用但未挂载的工具包'));
ok('包含 REA', r.text.includes('REA 逆向工程工具包'));
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

console.log('\n=== 空清单降级 ===\n');
const empty = renderToolPacks([]);
ok('空数组仍返回标题', empty.text.includes('## 书阁'));
ok('空数组体积很小', empty.bytes < 300, `${empty.bytes} B`);

console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
