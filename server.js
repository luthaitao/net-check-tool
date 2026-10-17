'use strict';
/**
 * 网络检查工具 —— 本地服务
 *
 * 安全设计：
 * - 默认只监听 127.0.0.1，不对外暴露。要改监听地址必须显式传 --host。
 * - 静态文件服务做了路径穿越防护（resolve 后必须仍在 public/ 内）。
 * - JSON 请求体有体积上限，避免内存被打爆。
 * 这个工具本质是「主动探测内网/外网端口 + 任意发 HTTP 请求」，一旦绑定到
 * 0.0.0.0 就等于把内网扫描器开放给局域网，所以默认必须锁死在回环地址。
 */

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const portCheck = require('./lib/port-check');
const httpClient = require('./lib/http-client');
const assertEngine = require('./lib/assert-engine');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_JSON_BODY = 32 * 1024 * 1024; // 32MB，容纳 base64 文件上传

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------- 工具函数

function sendJSON(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, status, message, extra) {
  sendJSON(res, status, { ok: false, error: { message, ...(extra || {}) } });
}

function readBody(req, limit = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > limit) {
        aborted = true;
        reject(new Error(`请求体超过上限 ${Math.floor(limit / 1024 / 1024)}MB`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!aborted) reject(e); });
  });
}

/** 标记一个「客户端输入有误」的异常，让路由层返回 400 而不是 500。 */
function clientError(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

async function readJSON(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw clientError(`请求体不是合法 JSON: ${e.message}`);
  }
}

/** 校验目标字符串长度，避免超长输入拖垮 DNS。 */
function cleanTarget(v, max = 253) {
  return String(v || '').trim().slice(0, max);
}

// ---------------------------------------------------------------- 静态资源

/**
 * 静态资源来源。两种运行形态共用同一套安全校验：
 *  - 普通运行：从 public/ 磁盘目录读
 *  - 打包成 exe：资源以 base64 内嵌在二进制里（见 build/embed-assets.js）
 * 统一走 readAsset(rel) 抽象，上层的路径穿越防护只需写一次。
 */
const EMBEDDED_ASSETS = globalThis.__NETCHECK_ASSETS__ || null;

function isInsidePublic(rel) {
  // 关键安全校验：规范化后必须仍在 public/ 内，挡掉 ..%2f%2fserver.js 这类请求
  const target = path.resolve(PUBLIC_DIR, `.${rel}`);
  const relCheck = path.relative(PUBLIC_DIR, target);
  return !(relCheck.startsWith('..') || path.isAbsolute(relCheck)) ? target : null;
}

/** 读取一个静态资源，返回 {buffer, size} 或 null。 */
async function readAsset(rel) {
  if (EMBEDDED_ASSETS) {
    const b64 = EMBEDDED_ASSETS[rel];
    if (!b64) return null;
    const buffer = Buffer.from(b64, 'base64');
    return { buffer, size: buffer.length };
  }
  const target = isInsidePublic(rel);
  if (!target) return null;
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return { isDir: true };
  return { buffer: await fsp.readFile(target), size: stat.size };
}

async function serveStatic(req, res, pathname) {
  // 目录请求 → index.html
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (!rel.startsWith('/')) rel = '/' + rel;

  // 目录请求归一：/css/ → /css/index.html（内嵌资源下也成立）
  if (rel.endsWith('/')) rel += 'index.html';

  const asset = await readAsset(rel);
  if (!asset) { sendError(res, 404, `文件不存在: ${rel}`); return; }
  if (asset.isDir) { sendError(res, 404, '目录列表已禁用'); return; }

  const ext = path.extname(rel).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': asset.size,
    // 本地工具但仍禁用缓存，避免改了代码看到旧界面
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  res.end(asset.buffer);
}

// ---------------------------------------------------------------- API 路由

/** GET /api/system —— 本机信息 + 网卡（排障「为什么连不上」的关键信息） */
async function handleSystem(req, res) {
  sendJSON(res, 200, { ok: true, ...portCheck.localInterfaces(), nodeVersion: process.version });
}

/** POST /api/dns —— 解析主机名，返回全部地址 */
async function handleDns(req, res) {
  const body = await readJSON(req);
  const host = cleanTarget(body.host);
  if (!host) { sendError(res, 400, 'host 不能为空'); return; }
  const result = await portCheck.resolveHost(host);
  // 嵌套一层 dns，避免内层 ok 覆盖外层「请求是否成功」的语义
  sendJSON(res, 200, { ok: true, dns: result });
}

/** POST /api/port/check —— 单端口检测（带 Banner） */
async function handlePortCheck(req, res) {
  const body = await readJSON(req);
  const host = cleanTarget(body.host);
  const port = Number(body.port);

  if (!host) { sendError(res, 400, 'host 不能为空'); return; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    sendError(res, 400, '端口必须是 1-65535 之间的整数');
    return;
  }

  const dnsResult = await portCheck.resolveHost(host);
  const result = await portCheck.checkPort(host, port, {
    timeout: Number(body.timeout) || 1500,
    grabBanner: body.grabBanner !== false,
    bannerMs: Number(body.bannerMs) || 600,
  });
  sendJSON(res, 200, { ok: true, host, dns: dnsResult, result });
}

/** POST /api/port/scan —— 批量端口扫描 */
async function handlePortScan(req, res) {
  const body = await readJSON(req);
  const host = cleanTarget(body.host);

  if (!host) { sendError(res, 400, 'host 不能为空'); return; }

  const MAX_PORTS = 4000;
  const { ports, errors, truncated } = portCheck.parsePortSpec(body.ports, MAX_PORTS);
  if (errors.length) {
    // 有解析错误时明确告知，但不中断——部分条目非法时仍扫描合法部分
    res.setHeader('X-Port-Spec-Warnings', encodeURIComponent(errors.join('; ')));
  }
  if (!ports.length) {
    sendError(res, 400, '没有可扫描的端口', { warnings: errors });
    return;
  }

  const dnsResult = await portCheck.resolveHost(host);
  const timeout = Math.max(200, Math.min(30000, Number(body.timeout) || 1000));
  const concurrency = Math.max(1, Math.min(512, Number(body.concurrency) || 50));
  // 端口多时默认关掉 Banner，否则每端口都要多等 bannerMs，扫描时间被拖长
  const grabBanner = body.grabBanner !== undefined ? !!body.grabBanner : ports.length <= 50;

  const result = await portCheck.scanPorts(host, ports, {
    timeout, concurrency, grabBanner,
    bannerMs: Math.min(2000, Number(body.bannerMs) || 500),
  });

  // 按响应时间排序，开的端口优先且快的在前——用户最关心「哪些开着」
  const sorted = [...result.results].sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    if (a.open && b.open) return (a.latencyMs || 0) - (b.latencyMs || 0);
    return a.port - b.port;
  });

  sendJSON(res, 200, {
    ok: true,
    host,
    dns: dnsResult,
    warnings: errors,
    truncated,
    summary: {
      total: result.total,
      open: result.open,
      closed: result.closed,
      timeout: timeout,
      concurrency,
      grabbedBanner: grabBanner,
      elapsedMs: null,
    },
    results: sorted,
    scannedAt: result.scannedAt,
  });
}

/** POST /api/http/send —— 类 Postman 请求发送 + 断言执行 */
async function handleHttpSend(req, res) {
  const body = await readJSON(req);
  const config = body.config || body;
  if (!config || typeof config !== 'object') {
    sendError(res, 400, '缺少 config');
    return;
  }

  const result = await httpClient.sendRequest(config);

  // 断言在服务端对完整响应执行（不受前端展示截断影响）
  const rules = Array.isArray(config.assertions) ? config.assertions : [];
  let assertionResult = { total: 0, passed: 0, failed: 0, results: [], error: null };

  if (result.ok && rules.length) {
    const r = result.response;
    assertionResult = assertEngine.runAssertions(rules, {
      status: r.status,
      headers: r.headers,
      cookies: r.cookies,
      time: r.time,
      size: r.size,
      bodyText: r.body.type === 'text' ? r.body.text : '',
      parsedJson: r.body.type === 'text' ? r.body.json : null,
      bodyType: r.body.type,
    });
  }

  sendJSON(res, 200, {
    // ok 反映「被请求的 HTTP 调用是否成功」，而非「本接口是否被处理」。
    // 请求失败时 error 有值、response 为 null，便于调用方统一判断。
    ok: !result.error,
    request: result.request,
    response: result.response,
    redirects: result.redirects || [],
    dnsMs: result.dnsMs,
    timeline: result.timeline || [],
    assertions: assertionResult,
    error: result.error || null,
  });
}

// ---------------------------------------------------------------- 主路由

const ROUTES = {
  'POST /api/system': handleSystem,
  'GET /api/system': handleSystem,
  'POST /api/dns': handleDns,
  'POST /api/port/check': handlePortCheck,
  'POST /api/port/scan': handlePortScan,
  'POST /api/http/send': handleHttpSend,
};

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let pathname = '/';
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    sendError(res, 400, 'URL 无法解析');
    return;
  }

  // CORS：本工具可能被人从别的本地页面调，仅回显不允许携带凭据
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const handler = ROUTES[`${req.method} ${pathname}`];
  if (handler) {
    try {
      await handler(req, res);
    } catch (e) {
      if (!res.headersSent) {
        sendError(res, e.statusCode || 500, e.message || '服务端内部错误');
      }
    }
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendError(res, 404, `接口不存在: ${req.method} ${pathname}`);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, '静态资源仅支持 GET/HEAD');
    return;
  }

  try {
    await serveStatic(req, res, pathname);
  } catch (e) {
    if (!res.headersSent) sendError(res, 500, e.message);
  } finally {
    void started;
  }
});

// ---------------------------------------------------------------- 启动

function parseArgs(argv) {
  const out = { port: 7801, host: '127.0.0.1', open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host' || a === '-h') out.host = String(argv[++i]);
    else if (a === '--open') out.open = true;
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) out.port = 7801;
  return out;
}

function localAddresses() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      // family 在不同 Node 版本里可能是数字 4/6 或字符串 'IPv4'
      const family = typeof a.family === 'number' ? `IPv${a.family}` : String(a.family);
      if (family === 'IPv4' && !a.internal) list.push({ name, address: a.address });
    }
  }
  return list;
}

/**
 * 启动服务。
 * @param {object} [opts] 显式参数 { port, host, open, silent }；
 *   不传则从命令行读取。桌面版（Electron）用显式参数调用，
 *   并传 silent:true 跳过控制台横幅（失败通过 onError 回调交给调用方）。
 * @param {(err:Error)=>void} [onError] 监听失败（如端口占用）。
 * @returns {Promise<string>} 实际监听地址
 */
function start(opts, onError) {
  const parsed = parseArgs(process.argv.slice(2));
  const args = {
    port: opts && opts.port ? opts.port : parsed.port,
    host: opts && opts.host ? opts.host : parsed.host,
    open: opts && opts.open !== undefined ? opts.open : parsed.open,
  };
  const silent = !!(opts && opts.silent);

  // 打包成 exe 后用户是双击运行的，没有命令行，必须默认自动开浏览器
  const shouldOpen = args.open || !!EMBEDDED_ASSETS;
  const label = EMBEDDED_ASSETS ? '网络检查工具 (单文件版)' : '网络检查工具已启动';

  return new Promise((resolve, reject) => {
    function onServerError(e) {
      const err = new Error(e.code === 'EADDRINUSE'
        ? `端口 ${args.port} 已被占用`
        : (e.message || '服务启动失败'));
      err.code = e.code || 'ERR';
      if (onError) {
        onError(err);
      } else {
        console.error(`\n[错误] ${err.message}`);
        console.error(`       换个端口启动：${EMBEDDED_ASSETS ? '网络检查工具.exe --port ' + (args.port + 1) : 'node server.js --port ' + (args.port + 1)}\n`);
        process.exit(1);
      }
      reject(err);
    }

    server.once('error', onServerError);

    server.listen(args.port, args.host, () => {
      const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(args.host);
      const url = `http://${args.host}:${args.port}/`;

      if (silent) { resolve(url); return; }

      console.log('');
      console.log('  ╔══════════════════════════════════════════════╗');
    // 注意：中文在终端里占两列，用 displayWidth 计算才对得齐边框
    const innerWidth = 46;
    const labelWidth = [...label].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
    const pad = ' '.repeat(Math.max(0, innerWidth - labelWidth));
    console.log(`  ║  ${label}${pad}║`);
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
    console.log(`  访问地址:  ${url}`);
    if (!isLoopback) {
      console.log('');
      console.log('  ⚠️  警告：已绑定到非回环地址，局域网内其他机器也能访问本工具。');
      console.log('     本工具具备端口扫描与任意 HTTP 请求能力，请确认网络环境可信。');
      const addrs = localAddresses();
      for (const a of addrs) console.log(`       - http://${a.address}:${args.port}/  (${a.name})`);
    }
    console.log('');
    console.log('  功能: [端口连通性检测]  [类 Postman API 调试]');
    console.log('  停止: Ctrl + C 或直接关闭此窗口');
    console.log('');

    if (shouldOpen) openBrowser(url);
      resolve(url);
    });
  });
}

function openBrowser(url) {
  const { spawn } = require('node:child_process');
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* 打不开浏览器不影响服务本身 */ }
}

if (require.main === module) start();

module.exports = { server, start };