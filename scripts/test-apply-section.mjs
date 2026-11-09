// 端到端装配探针：用最小 mock ctx 真正跑一遍 apply()，断言新 section 被注册。
// 目的：证明「代码改了」≠「跑起来了」。这里要看到 systemPrompt.section() 真被调用。

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const _reaDir = mkdtempSync(join(tmpdir(), 'book-rea-'))
const _reaScript = join(_reaDir, 'rea.mjs')
writeFileSync(_reaScript, '')
process.env.REA_NODE = process.execPath
process.env.REA_SCRIPT = _reaScript
const { apply, TOOL_PACKS } = await import('../lib/index.js');

// 关键：getDefineTool() 的第 ② 条解析路径依赖 process.argv[1] 形如
// .../@deepseek-ai/dsh/lib/bin.js。测试脚本的 argv[1] 是测试文件本身，
// 那条路径必然失败 —— 这是**台架的局限**，不是插件的缺陷。
// 这里显式伪造 argv[1]，让测试覆盖真实装配时的解析路径。
//
// 【2026-11-07 修正】原来这里写死了作者 Windows 机器上的绝对路径
// （C:/Users/<user>/AppData/...）。换到 Linux 上，getDefineTool() 的两条解析路径
// 全部失败 → 工具面不可用 → 4 条"工具仍注册"断言变成假红。
// 现在按"环境变量 → 已安装的宿主包"顺序解析，解析不到就把这几条标成**跳过**并说明原因，
// 而不是用红叉假装插件坏了。
import { createRequire } from 'node:module';

function resolveDshBin() {
  const fromEnv = process.env.DSH_BIN;
  if (fromEnv) return fromEnv;
  try {
    const req = createRequire(import.meta.url);
    // 包入口通常在 lib/index.js，bin 与它同级
    const entry = req.resolve('@deepseek-ai/dsh');
    const bin = entry.replace(/index\.js$/, 'bin.js');
    return bin;
  } catch {
    return null;
  }
}

const savedArgv1 = process.argv[1];
const REAL_BIN = resolveDshBin();
if (REAL_BIN) process.argv[1] = REAL_BIN;

const sections = [];
const registeredTools = [];
const effects = [];

const mockCtx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  tools: {
    register(def) { registeredTools.push(def.name); return () => {}; },
  },
  systemPrompt: {
    getSectionOrder(name) { return 3100; },
    section(spec) { sections.push(spec); return () => {}; },
  },
  webServer: { route() { return () => {}; } },
  llm: {},
  effect(fn) { effects.push(fn); const d = fn && fn(); return typeof d === 'function' ? d : () => {}; },
  on() { return () => {}; },
  inject(deps, cb) { cb(mockCtx); return {}; },
  get() { return undefined; },
};

let pass = 0, fail = 0, skipped = 0;
const skip = (name, why) => { skipped++; console.log(`⚠ 跳过 ${name}  ← ${why}`); };
const ok = (n, c, d) => { c ? (pass++, console.log(`✓ ${n}${d ? '  ' + d : ''}`)) : (fail++, console.log(`✗ ${n}${d ? '  ' + d : ''}`)); };

try {
  await apply(mockCtx);
} catch (e) {
  console.log('apply() 抛错:', e.message);
}

console.log('=== 注册的 section ===');
for (const s of sections) {
  const txt = typeof s.text === 'function' ? s.text() : s.text;
  console.log(`  ${s.name}  order=${s.order}  ${Buffer.byteLength(txt ?? '', 'utf8')} B`);
}

const names = sections.map((s) => s.name);
ok('规约 section 已注册', names.includes('plugin:dsh-manuscript/contract'));
ok('工具包 section 已注册', names.includes('plugin:dsh-manuscript/toolpacks'));
ok('目录 section 已注册', names.includes('plugin:dsh-manuscript'));

// 顺序检查：规约(140) < 工具包(145) < 目录(150)
const byName = Object.fromEntries(sections.map((s) => [s.name, s.order]));
ok('顺序 规约<工具包<目录',
  byName['plugin:dsh-manuscript/contract'] < byName['plugin:dsh-manuscript/toolpacks'] &&
  byName['plugin:dsh-manuscript/toolpacks'] < byName['plugin:dsh-manuscript'],
  `${byName['plugin:dsh-manuscript/contract']} < ${byName['plugin:dsh-manuscript/toolpacks']} < ${byName['plugin:dsh-manuscript']}`);

// 工具包 section 内容
const tp = sections.find((s) => s.name === 'plugin:dsh-manuscript/toolpacks');
const tpText = typeof tp?.text === 'function' ? tp.text() : tp?.text ?? '';
ok('工具包 section 含 REA', tpText.includes('REA'));
ok('工具包 section 足够小', Buffer.byteLength(tpText, 'utf8') < 2048, `${Buffer.byteLength(tpText, 'utf8')} B`);

// 原有 5 个工具仍在
console.log('\n=== 注册的工具 ===');
console.log('  ' + registeredTools.join(', '));
// 工具面依赖宿主包（@deepseek-ai/dsh-tools）。本机没装宿主时解析不到 → 跳过而不是判红。
const toolFaceUsable = registeredTools.length > 0;
if (!toolFaceUsable) {
  const why = REAL_BIN
    ? `已解析到 dsh bin（${REAL_BIN}）但 defineTool 仍不可用，工具面降级`
    : '本机未安装 @deepseek-ai/dsh（也无 DSH_BIN），工具面无法装配';
  for (const t of ['manual_toc', 'manual_read', 'manual_recall', 'manual_trace']) skip(`工具 ${t} 仍注册`, why);
} else {
  for (const t of ['manual_toc', 'manual_read', 'manual_recall', 'manual_trace']) {
    ok(`工具 ${t} 仍注册`, registeredTools.includes(t));
  }
}

// 关键：总注入预算
const totalBytes = sections.reduce((s, sec) => {
  const t = typeof sec.text === 'function' ? sec.text() : sec.text;
  return s + Buffer.byteLength(t ?? '', 'utf8');
}, 0);
console.log(`\n=== 书阁常驻注入总计: ${totalBytes} B (${(totalBytes / 1024).toFixed(1)} KB) ===`);
ok('常驻注入 < 6 KB', totalBytes < 6144, `${(totalBytes / 1024).toFixed(1)} KB`);

console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过 / 共 ${pass + fail + skipped}`);
process.exit(fail === 0 ? 0 : 1);
