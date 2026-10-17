'use strict';
/**
 * 提示气泡逻辑测试（无需浏览器）
 *
 * 环境里没有可用的 GPU/显示栈，Electron 的页面渲染跑不起来，
 * 因此用最小 DOM 桩验证 tip.js 的核心逻辑：
 * 气泡能创建、内容能按属性装配、定位能翻转到视口内、
 * 绑定的事件确实挂在 document 上（真实悬停由浏览器派发）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const utilSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'util.js'), 'utf8');
const tipSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'tip.js'), 'utf8');

let pass = 0;
let fail = 0;
const problems = [];

function check(name, fn) {
  try {
    const msg = fn();
    if (msg) { fail++; problems.push(`${name}\n      ${msg}`); console.log(`  \x1b[31m✗\x1b[0m ${name}`); }
    else { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  } catch (e) {
    fail++; problems.push(`${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  }
}

console.log('\n\x1b[1m提示气泡逻辑测试\x1b[0m');

// ── 最小 DOM 桩 ──
function makeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    style: {},
    children: [],
    attrs: {},
    textContent: '',
    innerHTML: '',
    offsetWidth: 200,
    offsetHeight: 80,
    parentNode: null,
    _listeners: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) {
      if (c && c.__isEl !== false) {
        this.children.push(c);
        c.parentNode = this;
      }
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    getBoundingClientRect() {
      return { left: 100, top: 200, width: 180, height: 30, bottom: 230, right: 280 };
    },
    get childNodes() { return this.children; },
  };
  node.classList = {
    add(c) { if (!node.className.split(' ').includes(c)) node.className = (node.className + ' ' + c).trim(); },
    remove(c) { node.className = node.className.split(' ').filter((x) => x !== c).join(' '); },
    contains(c) { return node.className.split(' ').includes(c); },
  };
  node.contains = (n) => n === node;
  return node;
}

function loadTip() {
  const doc = makeEl('document');
  const body = makeEl('body');
  doc.body = body;
  doc._listeners = {};
  doc.addEventListener = (t, fn) => { (doc._listeners[t] = doc._listeners[t] || []).push(fn); };
  doc.createElement = (tag) => makeEl(tag);
  doc.createTextNode = (t) => ({ nodeType: 3, textContent: String(t), __isEl: false });

  const win = { innerWidth: 1440, innerHeight: 900, addEventListener() {} };
  win.document = doc;

  // util.js 与 tip.js 都是 `(function(global){...})(window)` 形式，
  // 只依赖 window/document/setTimeout 这几个全局，直接注入即可。
  const factory = new Function(
    'window', 'document', 'setTimeout', 'clearTimeout', 'navigator',
    `${utilSrc}\n${tipSrc}\n;return window.Tip;`
  );
  // tip.js 用 setTimeout 做淡出延迟，这里同步执行以便断言最终状态
  const Tip = factory(win, doc, (fn) => { fn(); return 0; }, () => {}, { userAgent: 'node-test' });
  return { Tip, doc, body, win };
}

// ── 测试 ──

check('tip.js 可加载并暴露 init/hide', () => {
  const { Tip } = loadTip();
  if (typeof Tip.init !== 'function') return '缺少 init()';
  if (typeof Tip.hide !== 'function') return '缺少 hide()';
  return null;
});

check('init() 注册了鼠标与键盘事件', () => {
  const { Tip, doc } = loadTip();
  Tip.init();
  const need = ['mouseover', 'mouseout', 'focusin', 'focusout'];
  const missing = need.filter((t) => !(doc._listeners[t] && doc._listeners[t].length));
  return missing.length ? `未注册: ${missing.join(', ')}` : null;
});

check('悬停带 data-tip 的元素会创建气泡', () => {
  const { Tip, doc, body } = loadTip();
  Tip.init();

  const target = makeEl('input');
  target.setAttribute('data-tip', '这是说明');
  target.setAttribute('data-tip-title', '标题');

  // 构造一个 target.closest 可用的替身
  target.closest = (sel) => (sel === '[data-tip]' ? target : null);

  const handler = doc._listeners.mouseover[0];
  handler({ target });

  if (!body.children.length) return '未创建气泡节点';
  const bubble = body.children[body.children.length - 1];
  if (!bubble.classList.contains('tip')) return '气泡缺少 .tip 类';
  if (!bubble.classList.contains('show')) return '气泡未显示';
  return null;
});

check('气泡内容按 title/正文/示例/警示装配', () => {
  const { Tip, doc, body } = loadTip();
  Tip.init();

  const target = makeEl('input');
  target.setAttribute('data-tip-title', '端口说明');
  target.setAttribute('data-tip', '要检测的端口');
  target.setAttribute('data-tip-ex', '80,443\n8000-8100');
  target.setAttribute('data-tip-warn', '注意范围');
  target.closest = (sel) => (sel === '[data-tip]' ? target : null);

  doc._listeners.mouseover[0]({ target });

  const bubble = body.children[body.children.length - 1];
  const classes = bubble.children.map((c) => c.className).join(' ');
  const text = JSON.stringify(bubble.children.map((c) => c.textContent || c.innerHTML || ''));

  const missing = [];
  if (!classes.includes('tip-title')) missing.push('缺少标题块');
  if (!classes.includes('tip-ex-block')) missing.push('多行示例应为代码块');
  if (!classes.includes('tip-warn')) missing.push('缺少警示块');
  if (!text.includes('端口说明')) missing.push('标题文本缺失');
  if (!text.includes('注意范围')) missing.push('警示文本缺失');
  return missing.length ? missing.join('; ') : null;
});

check('单行示例渲染为内联 code 片段', () => {
  const { Tip, doc, body } = loadTip();
  Tip.init();

  const target = makeEl('input');
  target.setAttribute('data-tip', '说明');
  target.setAttribute('data-tip-ex', '192.168.1.1    localhost');
  target.closest = (sel) => (sel === '[data-tip]' ? target : null);

  doc._listeners.mouseover[0]({ target });

  const bubble = body.children[body.children.length - 1];
  const hasCode = bubble.children.some((c) => c.children.some((g) => g.tagName === 'CODE'));
  return hasCode ? null : '未生成内联 code 元素';
});

check('靠近视口底部时气泡翻转到上方', () => {
  const { Tip, doc, body, win } = loadTip();
  Tip.init();

  const target = makeEl('input');
  target.setAttribute('data-tip', '说明');
  target.closest = (sel) => (sel === '[data-tip]' ? target : null);
  // 元素贴在视口底部
  target.getBoundingClientRect = () => ({ left: 100, top: 880, width: 180, height: 30, bottom: 910, right: 280 });

  doc._listeners.mouseover[0]({ target });

  const bubble = body.children[body.children.length - 1];
  const top = parseFloat(bubble.style.top);
  // 气泡高 80，元素 top=880 → 上方位置应为 880-80-8 = 792
  if (!(top < 880)) return `期望翻转到元素上方，实际 top=${top}`;
  return null;
});

check('靠近右边缘时气泡左移不出视口', () => {
  const { Tip, doc, body, win } = loadTip();
  Tip.init();

  const target = makeEl('input');
  target.setAttribute('data-tip', '说明');
  target.closest = (sel) => (sel === '[data-tip]' ? target : null);
  // 元素紧贴右侧
  target.getBoundingClientRect = () => ({ left: 1300, top: 200, width: 130, height: 30, bottom: 230, right: 1430 });

  doc._listeners.mouseover[0]({ target });

  const bubble = body.children[body.children.length - 1];
  const left = parseFloat(bubble.style.left);
  // 视口 1440，气泡宽 200，左边距应 <= 1440-200-12 = 1228
  if (left > 1228) return `气泡超出视口: left=${left}`;
  return null;
});

check('hide() 会移除 show 类', () => {
  const { Tip, doc, body } = loadTip();
  Tip.init();
  const target = makeEl('input');
  target.setAttribute('data-tip', '说明');
  target.closest = (sel) => (sel === '[data-tip]' ? target : null);
  doc._listeners.mouseover[0]({ target });

  const bubble = body.children[body.children.length - 1];
  if (!bubble.classList.contains('show')) return '前置状态异常：气泡未显示';
  Tip.hide();
  return bubble.classList.contains('show') ? 'hide() 后仍带 show 类' : null;
});

// ── 静态覆盖度检查 ──
check('关键输入控件都挂了 data-tip', () => {
  // 这些是用户高频填写、且不看说明容易填错的字段。
  // 说明既可能挂在控件自身，也可能挂在包裹它的 <label> 上——
  // 后者的 data-tip 属性写在控件之前，所以要向前回溯到最近的 <label 开标签。
  const mustHaveTip = [
    'pcHost', 'pcPorts', 'pcTimeout', 'pcConc', 'pcBanner',
    'reqMethod', 'reqUrl', 'authType', 'bodyType', 'bodySearch',
  ];
  const missing = [];
  for (const id of mustHaveTip) {
    const idx = html.search(new RegExp(`id="${id}"`, 'i'));
    if (idx < 0) { missing.push(`${id}(未找到控件)`); continue; }

    let found = false;
    // 1) 从控件位置逐级向前回溯开标签，直到找到带 data-tip 的那个。
    //    说明常写在包裹控件的 <label> 上，属性出现在控件之前；
    //    中途可能隔着已闭合的标签（如 <input ...>），要一直往前翻。
    let scan = html.slice(Math.max(0, idx - 1200), idx);
    for (let guard = 0; guard < 12; guard++) {
      const oi = scan.lastIndexOf('<');
      if (oi < 0) break;
      if (/data-tip(-title)?=/.test(scan.slice(oi))) { found = true; break; }
      scan = scan.slice(0, oi);
    }
    // 2) 控件之后紧跟的片段（有时属性写在闭合标签之前）
    if (!found && /data-tip(-title)?=/.test(html.slice(idx, idx + 200))) found = true;

    if (!found) missing.push(id);
  }
  return missing.length ? `缺少说明: ${missing.join(', ')}` : null;
});

check('data-tip 属性值全部正确转义', () => {
  let bad = [];
  for (const m of html.matchAll(/data-tip(?:-(?:title|ex|warn))?="([^"]*)"/g)) {
    const v = m[1].replace(/&lt;|&gt;|&amp;|&quot;/g, '');
    if (/[<>]/.test(v)) bad.push(v.slice(0, 40));
  }
  return bad.length ? `未转义的尖括号 ${bad.length} 处: ${bad[0]}…` : null;
});

check('CSS 提供 tip 气泡与箭头样式', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  const need = ['.tip', '.tip.show', '.tip-title', '.tip-arrow', '[data-tip]'];
  const missing = need.filter((s) => !css.includes(s));
  return missing.length ? `缺少样式: ${missing.join(', ')}` : null;
});

check('tip 气泡 z-index 高于所有浮层', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  const tipBlock = css.match(/\.tip \{([^}]*)\}/);
  if (!tipBlock) return '找不到 .tip 规则';
  const z = /z-index:\s*(\d+)/.exec(tipBlock[1]);
  if (!z) return '.tip 未设置 z-index';
  const others = [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
  const max = Math.max(...others);
  return Number(z[1]) >= max ? null : `.tip z-index(${z[1]}) 小于其它浮层(${max})`;
});

// ── 汇总 ──
console.log('─'.repeat(56));
if (fail === 0) {
  console.log(`\x1b[32m  ✓ 全部通过：${pass} / ${pass + fail}\x1b[0m`);
} else {
  console.log(`\x1b[31m  ✗ ${fail} 项失败\x1b[0m，${pass} / ${pass + fail} 通过\n`);
  for (const p of problems) console.log(`    · ${p}`);
}
console.log('─'.repeat(56) + '\n');
process.exit(fail === 0 ? 0 : 1);