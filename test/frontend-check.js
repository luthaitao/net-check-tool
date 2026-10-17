'use strict';
/**
 * 前端逻辑静态校验（无需浏览器）
 *
 * 目的：抓两类最容易漏、且到浏览器里才炸的错——
 *  1. JS 里 $('#id') 指向了 HTML 中不存在的元素；
 *  2. toConfig() 组装出的请求体与服务端期望的字段名不一致（拼写漂移）。
 * 做法：正则抓 id 引用 + 静态扫描配置字段，最后与 server/http-client 的
 * 实际读取字段做对照。
 *
 * 运行：node test/frontend-check.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const jsFiles = fs.readdirSync(path.join(ROOT, 'public', 'js')).map((f) => ({
  name: f,
  src: fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8'),
}));

let pass = 0;
let fail = 0;
const problems = [];

function check(name, fn) {
  try {
    const msg = fn();
    if (msg) { fail++; problems.push(`${name}\n      ${msg}`); console.log(`  \x1b[31m✗\x1b[0m ${name}`); }
    else { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  } catch (e) {
    fail++; problems.push(`${name}\n      ${e.message}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  }
}

console.log('\n\x1b[1m前端逻辑静态校验\x1b[0m');

// ── 1. DOM id 引用完整性 ──
check("JS 中所有 #id 引用都存在于 HTML", () => {
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  // 动态拼接出的 id 前缀不算（运行时才确定）
  const dynamicPrefixes = new Set(['panel-']);
  const missing = [];
  for (const { name, src } of jsFiles) {
    for (const m of src.matchAll(/\$\(\s*'#([A-Za-z0-9_-]+)'/g)) {
      if (!htmlIds.has(m[1])) missing.push(`${name} -> $('#${m[1]}')`);
    }
    for (const m of src.matchAll(/\$\(\s*`#([A-Za-z0-9_-]+)/g)) {
      const id = m[1];
      // 模板字符串里带 ${...} 的，只校验前缀确实存在对应族
      if (id.endsWith('-') && dynamicPrefixes.has(id)) {
        const family = [...htmlIds].filter((x) => x.startsWith(id));
        if (!family.length) missing.push(`${name} -> (#${id}\${...}) 族为空`);
      } else if (!htmlIds.has(id)) {
        missing.push(`${name} -> (\`#${id}\${...}\`)`);
      }
    }
    for (const m of src.matchAll(/getElementById\('([^']+)'\)/g)) {
      if (!htmlIds.has(m[1])) missing.push(`${name} -> getElementById('${m[1]}')`);
    }
  }
  return missing.length ? `缺失:\n      ${missing.join('\n      ')}` : null;
});

// ── 2. script 标签与文件对应 ──
check("index.html 引用的每个脚本文件都存在", () => {
  const missing = [];
  for (const m of html.matchAll(/<script src="\/js\/([^"]+)"><\/script>/g)) {
    const p = path.join(ROOT, 'public', 'js', m[1]);
    if (!fs.existsSync(p)) missing.push(m[1]);
  }
  return missing.length ? `缺失: ${missing.join(', ')}` : null;
});

// ── 3. 加载顺序：Store 必须早于用它的面板 ──
check("脚本加载顺序正确（util → store → 面板 → main）", () => {
  const order = [...html.matchAll(/<script src="\/js\/([^"]+)"><\/script>/g)].map((m) => m[1]);
  const idx = (n) => order.indexOf(n);
  if (idx('util.js') < 0) return 'util.js 未加载';
  if (idx('store.js') < idx('util.js')) return 'store.js 必须晚于 util.js';
  for (const p of ['port-panel.js', 'api-panel.js']) {
    if (idx(p) < idx('store.js')) return `${p} 必须晚于 store.js`;
  }
  if (idx('main.js') < idx('api-panel.js')) return 'main.js 必须晚于面板脚本';
  return null;
});

// ── 4. toConfig() 字段与服务端读取字段一致 ──
check("toConfig() 产出的字段名与服务端 http-client 一致", () => {
  const client = fs.readFileSync(path.join(ROOT, 'lib', 'http-client.js'), 'utf8');
  const api = jsFiles.find((f) => f.name === 'api-panel.js').src;

  // 从 toConfig 函数体里抽出 key:
  const body = api.match(/function toConfig\(\)\s*\{([\s\S]*?)\n  \}/);
  if (!body) return '未找到 toConfig()';
  const produced = new Set([...body[1].matchAll(/^\s{6}([a-zA-Z]+):/gm)].map((m) => m[1]));

  // 服务端 buildRequest 实际读取的字段
  const build = client.match(/function buildRequest\(config\)\s*\{([\s\S]*?)\n\}/);
  if (!build) return '未找到 buildRequest()';
  const consumed = new Set([...build[1].matchAll(/config\.([a-zA-Z]+)/g)].map((m) => m[1]));

  // 断言由 server.js 读取，不经 http-client
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  if (/config\.assertions/.test(server)) consumed.add('assertions');

  const required = ['method', 'url', 'params', 'headers', 'auth', 'bodyType',
    'rawBody', 'contentType', 'form', 'multipart', 'timeout',
    'followRedirects', 'insecureTLS', 'env'];
  const notProduced = required.filter((f) => !produced.has(f));
  if (notProduced.length) return `toConfig 未产出: ${notProduced.join(', ')}`;

  const unused = [...consumed].filter((f) => !produced.has(f));
  if (unused.length) return `服务端读取但前端未产出: ${unused.join(', ')}`;

  return null;
});

// ── 5. 断言引擎的 source 值前后端一致 ──
check("断言 source 取值前后端一致", () => {
  const engine = fs.readFileSync(path.join(ROOT, 'lib', 'assert-engine.js'), 'utf8');
  const api = jsFiles.find((f) => f.name === 'api-panel.js').src;

  const front = new Set([...api.matchAll(/\['(\w+)',\s*'[^']+'\]/g)].map((m) => m[1]));
  // 只取 SOURCES 数组里的
  const sourcesBlock = api.match(/const SOURCES = \[([\s\S]*?)\];/);
  const frontSources = sourcesBlock
    ? new Set([...sourcesBlock[1].matchAll(/\['(\w+)',/g)].map((m) => m[1]))
    : new Set();

  const extractBlock = engine.match(/if \(src === '(\w+)'\)/g) || [];
  const engineSources = new Set(extractBlock.map((s) => s.match(/'(\w+)'/)[1]));

  const frontOnly = [...frontSources].filter((s) => !engineSources.has(s));
  const engineOnly = [...engineSources].filter((s) => !frontSources.has(s));
  if (frontOnly.length || engineOnly.length) {
    return `前端独有: [${frontOnly}] 引擎独有: [${engineOnly}]`;
  }
  void front;
  return null;
});

// ── 6. 算子清单一致性 ──
check("断言 operator 取值前后端一致", () => {
  const engine = fs.readFileSync(path.join(ROOT, 'lib', 'assert-engine.js'), 'utf8');
  const api = jsFiles.find((f) => f.name === 'api-panel.js').src;

  const opsBlock = api.match(/const OPERATORS = \[([\s\S]*?)\];/);
  if (!opsBlock) return '未找到 OPERATORS';
  const frontOps = new Set([...opsBlock[1].matchAll(/\['(\w+)',/g)].map((m) => m[1]));

  const engineOps = new Set(
    [...engine.matchAll(/case '(\w+)':/g)].map((m) => m[1])
  );

  const frontOnly = [...frontOps].filter((o) => !engineOps.has(o));
  if (frontOnly.length) return `前端有但引擎不支持: ${frontOnly.join(', ')}`;
  return null;
});

// ── 7. API 路径前后端一致 ──
check("前端请求的 API 路径都存在于服务端路由表", () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const routes = new Set(
    [...server.matchAll(/'(GET|POST) (\/api\/[a-z/-]+)'/g)].map((m) => m[2])
  );
  const used = [];
  for (const { name, src } of jsFiles) {
    for (const m of src.matchAll(/api\('(\/api\/[a-z/-]+)'/g)) used.push([name, m[1]]);
  }
  const missing = used.filter(([, p]) => !routes.has(p));
  return missing.length
    ? `未注册: ${missing.map(([n, p]) => `${p} (${n})`).join(', ')}\n      已注册: ${[...routes].join(', ')}`
    : null;
});

// ── 8. HTML 内部锚点/标签闭合粗检 ──
check("HTML 标签基本闭合", () => {
  const voids = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);
  // 先把属性值（含 data: URI 里的内联 SVG）替换成等长空白，
  // 否则 href="data:image/svg+xml,<svg>…</svg>" 里的标签会被误判为真实标签
  const masked = html.replace(/"[^"]*"|'[^']*'/g, (s) => ' '.repeat(s.length));
  const stack = [];
  for (const m of masked.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, , selfClose] = m;
    const t = tag.toLowerCase();
    if (voids.has(t) || selfClose) continue;
    if (closing) {
      const top = stack.pop();
      if (top !== t) return `标签不匹配: 期望 </${top}>，实际 </${t}>`;
    } else stack.push(t);
  }
  return stack.length ? `未闭合标签: ${stack.join(', ')}` : null;
});

// ── 9. CSS 类名在 JS/HTML 中都有使用 ──
check("CSS 中定义的类名均被 HTML 或 JS 使用", () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const used = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => c && used.add(c));
  for (const { src } of jsFiles) {
    for (const m of src.matchAll(/class:\s*'([^']+)'/g)) m[1].split(/\s+/).forEach((c) => c && used.add(c));
    for (const m of src.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => c && used.add(c));
    for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) used.add(m[1]);
  }
  const unused = [...defined].filter((c) => !used.has(c));
  // 仅提示，不算失败（工具类/响应式辅助类可能确实只在特定状态出现）
  if (unused.length) console.log(`      \x1b[33m提示: ${unused.length} 个类名未被静态引用: ${unused.slice(0, 12).join(', ')}\x1b[0m`);
  return null;
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