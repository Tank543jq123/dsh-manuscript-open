// 模拟浏览器环境，验证 client.js 打包体能被正确解析并执行 factory。
// 目的：语法通过 ≠ 能在浏览器里加载。这里要把"引用不存在的变量/组件"这类错抓出来。
//
// 【2026-11-06 扩测】原版只做"能加载 + 源码里 grep 到字样"。
// 本轮加了 D-03（提炼二次确认）与 D-05（快照过期可见）之后，光 grep 不够：
// 一个渲染出来是空白的确认区照样能 grep 到「确认提炼」四个字。
// 所以这里加了一个**迷你渲染器**（fake jsx → 递归展开函数组件），
// 真的把 DistillPanel 执行一遍，再断言最终文本里出现了哪些字段。
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const noop = () => {};
// fakeJsx 保留 (组件, props) 两个参数 —— 迷你渲染器就靠 args[0] 认出子组件。
const fakeJsx = (...args) => ({ __jsx: true, args });
const jsxRuntime = { jsx: fakeJsx, jsxs: fakeJsx, Fragment: 'Fragment' };
const fakeReact = {
  createElement: fakeJsx,
  useState: (v) => [typeof v === 'function' ? v() : v, noop],
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useEffect: noop,
  useRef: () => ({ current: null }),
  Fragment: 'Fragment',
};

const moduleObj = { exports: {} };

globalThis.window = {};
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
  head: { appendChild: noop },
  addEventListener: noop,
  removeEventListener: noop,
  body: { appendChild: noop },
};
globalThis.fetch = async () => ({ json: async () => ({ ok: true }) });
globalThis.AbortSignal = { timeout: () => undefined };

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log(`✓ ${n}${d ? '  ' + d : ''}`)) : (fail++, console.log(`✗ ${n}${d ? '  ' + d : ''}`)); };

// client.js 的形状是 `window.__ModuleLoader__.load({ id, factory })` —— 一个**调用**，
// 不是表达式。所以要提供一个假的 __ModuleLoader__ 来捕获那个对象。
let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) { captured = def; },
  },
};

// ── 迷你渲染器 ──────────────────────────────────────────────────────────────
// 把 fake jsx 的元素树"展开"：函数组件直接调用，返回它渲染的东西。
// 没有 state 更新、没有 effect —— 我们只验证**这一次渲染输出什么**。
const MAX_DEPTH = 60;

function findDeep(node, pred, depth = 0) {
  if (node == null || depth > MAX_DEPTH) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findDeep(item, pred, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || node.__jsx !== true) return null;
  const [comp, props] = node.args;
  // 【坑 2026-11-06】先判定，再展开。第一版对函数组件直接 comp(props) 展开，
  // 永远没机会匹配组件**自身**的 props —— 而 DistillPanel 正是以
  // `jsx(DistillPanel, distillProps)` 的形式出现的，于是永远找不到。
  if (pred(node, props)) return node;
  if (typeof comp === 'function') {
    const inner = comp(props || {});
    return findDeep(inner, pred, depth + 1);
  }
  // 原生标签：继续往下钻 children。
  const kids = props && props.children;
  if (kids != null) {
    if (Array.isArray(kids)) {
      for (const child of kids) {
        const hit = findDeep(child, pred, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    return findDeep(kids, pred, depth + 1);
  }
  return null;
}

/** 收集树里所有可见文本（字符串 / 数字 children）。 */
function collectText(node, out, depth = 0) {
  if (node == null || node === false || node === true || depth > MAX_DEPTH) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const item of node) collectText(item, out, depth + 1); return out; }
  if (node && node.__jsx === true) {
    const [comp, props] = node.args;
    // 函数组件要展开，否则拿不到它内部的文本
    if (typeof comp === 'function' && props) {
      try { collectText(comp(props), out, depth + 1); } catch { /* 单个组件渲染失败不该炸掉整个检查 */ }
      return out;
    }
    collectText(props && props.children, out, depth + 1);
  }
  return out;
}

const allText = (tree) => collectText(tree, []).join(' | ');

try {
  const req = (name) => {
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === 'react') return fakeReact;
    throw new Error('未知依赖: ' + name);
  };
  // 用 vm 在带 window 的上下文里执行整个文件
  const { runInNewContext } = await import('node:vm');
  const ctx = { window: globalThis.window, document: globalThis.document, console, fetch: globalThis.fetch, AbortSignal: globalThis.AbortSignal };
  runInNewContext(src, ctx, { filename: 'client.js' });

  ok('__ModuleLoader__.load 被调用', captured !== null);
  ok('id 正确', captured?.id === 'dsh-manuscript', String(captured?.id));
  ok('有 factory 函数', typeof captured?.factory === 'function');

  // 真正跑 factory —— 这一步才会暴露"引用了不存在的组件/变量"
  const exported = captured.factory(req);
  ok('factory 执行无异常', true);
  ok('导出 apply', typeof exported?.apply === 'function');
  ok('导出 inject', exported?.inject !== undefined);

  // 检查工具架相关符号真的进了产物
  ok('产物含 ToolShelfView', src.includes('function ToolShelfView'));
  ok('产物含工具架 tab', src.includes('label: "工具架"'));
  ok('产物含 API_TOOLS', src.includes('/dsh-manuscript/api/tools'));

  // ── 注册一个假 ctx，把真实组件从 apply 里捞出来 ──────────────────────────
  const registered = {};
  const fakeCtx = {
    slots: {
      inject: (name, fn) => fn(),
      register: (spec, comp) => {
        registered[spec.name + (spec.key ? '#' + spec.key : '')] = comp;
        return comp;
      },
    },
    layout: { selectPanel: noop },
    logger: { info: noop, warn: noop, error: noop },
  };
  exported.apply(fakeCtx);
  const MainPanel = registered['main#manuscript'];
  ok('主面板已注册（key=manuscript）', typeof MainPanel === 'function');

  // 四个 tab 一个都不能少（回归保护：本轮改动不许删既有功能）
  const mainTree = typeof MainPanel === 'function' ? MainPanel({}) : null;
  const mainText = allText(mainTree);
  ok('四个 tab 齐全（书房/目录/AI 协作/工具架）',
    ['书房', '目录', 'AI 协作', '工具架'].every((t) => mainText.includes(t)),
    ['书房', '目录', 'AI 协作', '工具架'].filter((t) => !mainText.includes(t)).join(',') || 'all');
  // D-05 顶栏：useJson 在测试环境里拿不到数据（summary.phase 不是 ready），
  // 所以这里断言"未就绪时不编造过期时间"—— 这正是要的诚实行为。
  ok('数据未就绪时不显示分钟前', !mainText.includes('分钟前'), mainText.slice(0, 80));

  // ── D-03 / 接口契约：源码级断言 ────────────────────────────────────────
  ok('产物含守门头 x-dsh-manuscript', src.includes('x-dsh-manuscript'));
  ok('产物含 POST 路由 /api/distill/model', src.includes('/api/distill/model'));
  ok('产物含 postJson 助手', /async function postJson\s*\(/.test(src));
  // 旧的 GET 改模型写法必须消失，否则等于没改
  ok('已移除 GET /plan?model= 旧写法', !src.includes('API_DISTILL_PLAN + "?model="'));

  // ── 找到真实的 DistillPanel（props 里带 onRequestRun 的那个元素）────────
  const distillEl = findDeep(mainTree, (_el, props) => props && typeof props.onRequestRun === 'function');
  const DistillPanel = distillEl ? distillEl.args[0] : null;
  ok('提炼面板已渲染（props 含 onRequestRun）', typeof DistillPanel === 'function');

  if (typeof DistillPanel === 'function') {
    const basePlan = {
      ok: true,
      queue: 20,
      plan: { calls: 7, totalChars: 22000 },
      currentModel: 'deepseek-chat',
      models: [{ id: 'deepseek-chat', label: 'deepseek-chat' }],
      willDistill: [],
    };
    const baseProps = {
      phase: 'ready',
      plan: basePlan,
      result: null,
      error: null,
      progress: { startedAt: 0, elapsed: 0 },
      summary: { stale: false, scanAgeMs: 0 },
      onRequestRun: noop,
      onConfirmRun: noop,
      onCancelRun: noop,
      onCommit: noop,
      onDecide: noop,
      onPickModel: noop,
      decided: {},
      committing: false,
      commitMsg: null,
      pickedModel: 'deepseek-chat',
    };

    // ① 未确认：不出现确认区
    const idleText = allText(DistillPanel({ ...baseProps, confirming: false }));
    ok('未点提炼时不显示确认区', !idleText.includes('确认提炼'), idleText.slice(0, 60));

    // ①b 点「开始提炼」必须走 onRequestRun(false)，且**不**直接发请求。
    // 【为什么要断言这个 2026-11-06】2026-11-02 踩过的坑：把 onClick 写成
    // props.onRun，React 会把事件对象当第一个参数 → dryRun 被判定为真 →
    // 点了"开始提炼"却跑了预演。这里直接拿假事件对象点一次，验证实参是 false。
    {
      let calledWith = 'not-called';
      let runDirect = 'not-called';
      const tree = DistillPanel({
        ...baseProps,
        confirming: false,
        onRequestRun: (v) => { calledWith = v; },
        onRun: (v) => { runDirect = v; },
      });
      const btn = findDeep(tree, (_el, props) => props && props.children === '开始提炼'
        || (_el && _el.args && _el.args[0] === 'button' && props && props.children === '开始提炼'));
      const handler = btn && btn.args[1] && btn.args[1].onClick;
      if (typeof handler === 'function') handler({ nativeEvent: {}, preventDefault: noop });
      ok('点「开始提炼」→ onRequestRun(false)', calledWith === false, 'calledWith=' + String(calledWith));
      ok('点「开始提炼」→ 不直接发请求', runDirect === 'not-called', 'runDirect=' + String(runDirect));
    }

    // ①c 确认区两个按钮分别接到 onConfirmRun / onCancelRun
    {
      let confirmed = 0, cancelled = 0;
      const tree = DistillPanel({ ...baseProps, confirming: true, onConfirmRun: () => { confirmed++; }, onCancelRun: () => { cancelled++; } });
      const findByText = (label) => findDeep(tree, (el, props) => el && el.args && el.args[0] === 'button' && props && props.children === label);
      const cEl = findByText('确认提炼');
      const xEl = findByText('取消');
      if (cEl) cEl.args[1].onClick({ nativeEvent: {} });
      if (xEl) xEl.args[1].onClick({ nativeEvent: {} });
      ok('「确认提炼」接到 onConfirmRun', confirmed === 1, 'confirmed=' + confirmed);
      ok('「取消」接到 onCancelRun', cancelled === 1, 'cancelled=' + cancelled);
    }

    // ② 确认态：四个成本字段 + 两个按钮 + 免责句
    const confText = allText(DistillPanel({ ...baseProps, confirming: true }));
    ok('确认区含「确认提炼」按钮', confText.includes('确认提炼'));
    ok('确认区含「取消」按钮', confText.includes('取消'));
    ok('确认区含「真实调用模型并写入书库」告知', confText.includes('这会真实调用模型并写入书库'));
    ok('确认区显示本轮会话数 20', confText.includes('20 个'));
    ok('确认区显示调用次数 7', confText.includes('7 次'));
    ok('确认区显示输入字符 22000', confText.includes('22,000 字符'));
    ok('确认区显示模型名', confText.includes('deepseek-chat'));

    // ③ 字段缺失 → 「未知」，且不许出现 0
    const missingText = allText(DistillPanel({
      ...baseProps,
      confirming: true,
      plan: { ok: true },
      pickedModel: null,
    }));
    ok('缺失字段渲染「未知」', (missingText.match(/未知/g) || []).length >= 4,
      '未知 出现 ' + (missingText.match(/未知/g) || []).length + ' 次');
    ok('缺失字段不渲染 0 个/0 次',
      !/0 个|0 次|0 字符/.test(missingText),
      (missingText.match(/0 个|0 次|0 字符/g) || []).join(','));

    // ④ D-05：stale 可见
    const staleText = allText(DistillPanel({
      ...baseProps,
      phase: 'ready',
      summary: { stale: true, scanAgeMs: 5 * 60 * 1000 },
    }));
    ok('stale=true 时状态行含「分钟前」', staleText.includes('分钟前'), staleText.slice(0, 80));
    ok('stale=true 时显示 5 分钟', staleText.includes('5 分钟前'));

    // ⑤ D-05：非 stale / 字段缺失 → 不显示（不许编 0 分钟）
    const freshText = allText(DistillPanel({ ...baseProps, summary: { stale: false, scanAgeMs: 0 } }));
    ok('stale=false 时不显示分钟前', !freshText.includes('分钟前'));
    const unknownAgeText = allText(DistillPanel({ ...baseProps, summary: { stale: true } }));
    ok('stale=true 但无时间依据时不显示 0 分钟',
      !unknownAgeText.includes('0 分钟前'), unknownAgeText.slice(0, 80));

    // ⑥ 入册 / 通过-丢弃 两个既有入口仍在（回归保护）
    const withEntries = allText(DistillPanel({
      ...baseProps,
      result: { entries: [{ title: 'a' }, { title: 'b' }], adjudication: { needsHuman: [], summary: '入册 2 条' } },
    }));
    ok('入册按钮仍在', withEntries.includes('入册这 2 条'), withEntries.slice(0, 100));
  }
} catch (e) {
  ok('client.js 解析/执行', false, e.message);
}

console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
