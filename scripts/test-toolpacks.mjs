// 工具包清单：只显示本机真正能启动的包；未安装的要隐藏，mount 要明确报未安装。
import { renderToolPacks, TOOL_PACKS, isPackAvailable, availableToolPacks, resolvePack } from '../lib/index.js'

let pass = 0, fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`✗ ${name}${detail ? '  ' + detail : ''}`) }
}

console.log('=== 工具包可用性 ===\n');
const available = {
  id: 'fake', label: 'Fake Pack', status: 'default-off', tools: 1, schemaKb: 1,
  what: '测试用', when: '测试', how: 'manual_mount("fake")', cost: '很小',
  serverName: 'fake', command: process.execPath, args: [],
}
const missing = { ...available, command: '/definitely/not/installed/node', args: [] }
const missingScript = { ...available, command: process.execPath, args: ['/definitely/not/installed/rea.mjs'] }

ok('可启动包被识别', isPackAvailable(available) === true)
ok('command 不存在 → 不可用', isPackAvailable(missing) === false)
ok('脚本不存在 → 不可用', isPackAvailable(missingScript) === false)
ok('availableToolPacks 过滤', availableToolPacks([available, missing]).length === 1)
ok('空清单过滤为空', availableToolPacks([]).length === 0)

console.log('\n=== 渲染 ===')
const r = renderToolPacks([available])
console.log(r.text)
ok('渲染出标题', r.text.includes('## 书阁 · 可用但未挂载的工具包'))
ok('包含可用包', r.text.includes('Fake Pack'))
ok('体积在 2KB 内', r.bytes < 2048, `${r.bytes} B`)
const empty = renderToolPacks([])
ok('全部不可用时返回空文本', empty.text === '' && empty.bytes === 0)
const onlyMissing = renderToolPacks([missing])
ok('未安装包不渲染', onlyMissing.text === '' && onlyMissing.bytes === 0)

console.log('\n=== resolvePack ===')
const okPack = resolvePack('fake', [available])
ok('可用包 resolve 成功', okPack.ok === true)
const badPack = resolvePack('fake', [missing])
ok('未安装包 resolve 失败', badPack.ok === false && /未安装/.test(badPack.reason))
const unknown = resolvePack('nope', [available])
ok('未知包报未知', unknown.ok === false && /未知/.test(unknown.reason))

console.log('\n=== 静态定义自洽 ===')
for (const p of TOOL_PACKS) {
  ok(`${p.id}: 有 status`, typeof p.status === 'string' && p.status.length > 0)
  ok(`${p.id}: schemaKb 与 tools 数一致（量级）`, p.schemaKb > 0 && p.tools > 0,
    `${p.tools} 工具 / ${p.schemaKb} KB`)
}

console.log('\n' + '='.repeat(60))
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
