'use strict';
/**
 * 冒烟测试：起一个真实的本地服务，覆盖全部关键路径。
 * 运行：node test/smoke.js
 *
 * 默认测源码（node server.js）。加 --exe 参数则改为测打包好的单文件 exe，
 * 用来验证「打包后功能与源码一致」——SEA 打包容易踩相对 require 的坑，
 * 静态检查发现不了，必须跑一遍真实用例。
 *
 *   node test/smoke.js            测源码
 *   node test/smoke.js --exe      测 dist/网络检查工具.exe
 *
 * 设计原则：不 mock。端口检测和 HTTP 调试的价值全在「真实网络栈」上，
 * mock 掉就等于没测。所以这里起真服务打真请求。
 */

const http = require('node:http');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 17801;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function ok(name) {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}
function bad(name, err) {
  failed++;
  failures.push({ name, err });
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
}
async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    bad(name, e);
  }
}
function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function post(pathname, payload) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text, _status: res.status }; }
  return { status: res.status, data };
}

async function get(pathname) {
  const res = await fetch(BASE + pathname);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

// ═══════════════════════════════════════════════════════
// 被测目标服务：一个可控的 echo / 状态码 / 重定向 / cookie 服务
// ═══════════════════════════════════════════════════════
function startTargetServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const path = u.pathname;

        if (path === '/json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 0, msg: 'ok', data: { id: 42, name: '张三', tags: ['a', 'b'] } }));
        } else if (path === '/echo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, path, query: Object.fromEntries(u.searchParams), headers: req.headers, body }));
        } else if (path === '/status/404') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
        } else if (path === '/status/500') {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('server error');
        } else if (path === '/redirect') {
          res.writeHead(302, { Location: '/json' });
          res.end();
        } else if (path === '/cookie') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=abc123; Path=/; HttpOnly' });
          res.end(JSON.stringify({ ok: true }));
        } else if (path === '/basic-auth') {
          const auth = req.headers.authorization || '';
          const expected = 'Basic ' + Buffer.from('user:pass').toString('base64');
          if (auth !== expected) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"', 'Content-Type': 'text/plain' });
            res.end('unauthorized');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ authenticated: true, user: 'user' }));
          }
        } else if (path === '/bearer') {
          if ((req.headers.authorization || '') === 'Bearer TESTTOKEN') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ authenticated: true, token: 'TESTTOKEN' }));
          } else {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('unauthorized');
          }
        } else if (path === '/slow') {
          setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('slow ok'); }, 1500);
        } else if (path === '/big') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ blob: 'x'.repeat(300000) }));
        } else if (path === '/binary') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe]));
        } else if (path === '/xml') {
          res.writeHead(200, { 'Content-Type': 'application/xml' });
          res.end('<?xml version="1.0"?><root><id>1</id><name>test</name></root>');
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('unknown');
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ═══════════════════════════════════════════════════════

async function main() {
  console.log('\n\x1b[1m网络检查工具 — 冒烟测试\x1b[0m');
  console.log(`  Node ${process.version} | 平台 ${process.platform}`);

  // ---- 启动被测目标服务 & 被测应用 ----
  const useExe = process.argv.includes('--exe');
  const target = await startTargetServer();
  const targetPort = target.address().port;
  // TGT = 被测的目标服务（echo/status/redirect 等）；BASE = 被测应用本身。
  // 二者必须是不同端口：HTTP 用例打的是 TGT，只有静态资源/路由用例才打 BASE。
  const TGT = `http://127.0.0.1:${targetPort}`;
  console.log(`\n  目标测试服务: ${TGT}`);

  let cmd;
  let cmdArgs;
  let spawnCwd;
  if (useExe) {
    const exePath = path.join(ROOT, 'dist', '网络检查工具.exe');
    if (!fs.existsSync(exePath)) {
      console.error(`\n未找到打包产物: ${exePath}\n请先执行：node build/build-exe.js\n`);
      process.exit(1);
    }
    cmd = exePath;
    cmdArgs = ['--port', String(PORT), '--host', '127.0.0.1'];
    // 故意在空目录里启动，验证 exe 不依赖源码树
    spawnCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'netcheck-exe-'));
    console.log(`  被测应用:     ${BASE}（单文件 exe）`);
  } else {
    cmd = process.execPath;
    cmdArgs = [path.join(ROOT, 'server.js'), '--port', String(PORT), '--host', '127.0.0.1'];
    spawnCwd = ROOT;
    console.log(`  被测应用:     ${BASE}（源码）`);
  }

  const child = spawn(cmd, cmdArgs, {
    cwd: spawnCwd, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  child.stdout.on('data', (d) => { serverOut += d; });
  child.stderr.on('data', (d) => { serverOut += d; });

  // 等待端口就绪
  const deadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/system`);
      if (r.ok) { ready = true; break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (!ready) {
    console.error('\n\x1b[31m服务未能启动\x1b[0m\n' + serverOut);
    process.exit(1);
  }
  try {
    // ═════════════════ 静态资源 ═════════════════
    section('静态资源托管');

    await test('GET / 返回首页 HTML', async () => {
      const r = await get('/');
      assert.strictEqual(r.status, 200);
      assert.ok(r.text.includes('<title>网络检查工具'), '首页应包含标题');
      assert.ok(r.headers.get('content-type').includes('text/html'));
    });

    await test('CSS / JS 正常返回且 MIME 正确', async () => {
      const css = await get('/css/style.css');
      assert.strictEqual(css.status, 200);
      assert.ok(css.headers.get('content-type').includes('text/css'));
      const js = await get('/js/main.js');
      assert.strictEqual(js.status, 200);
      assert.ok(js.headers.get('content-type').includes('javascript'));
    });

    await test('未知路径返回 404', async () => {
      const r = await get('/no-such-file.html');
      assert.strictEqual(r.status, 404);
    });

    await test('路径穿越被拦截（..%2f..%2fserver.js）', async () => {
      const r = await get('/..%2f..%2fserver.js');
      assert.ok(r.status === 403 || r.status === 404, `应拒绝访问，实际 ${r.status}`);
      assert.ok(!r.text.includes('createServer'), '不应泄露 server.js 源码');
    });

    await test('目录列表被禁用', async () => {
      const r = await get('/css/');
      assert.ok(r.status === 403 || r.status === 404, `实际 ${r.status}`);
    });

    // ═════════════════ 路由校验 ═════════════════
    section('API 路由与参数校验');

    await test('GET /api/system 返回本机信息', async () => {
      const { status, data } = await post('/api/system', {});
      assert.strictEqual(status, 200);
      assert.ok(data.ok);
      assert.ok(typeof data.hostname === 'string' && data.hostname.length > 0);
      assert.ok(Array.isArray(data.interfaces));
      // 防回归：family 必须是 IPv4/IPv6，而不是 IPvIPv4
      for (const i of data.interfaces) {
        assert.ok(/^IPv[46]$/.test(i.family), `family 字段异常: ${i.family}`);
      }
    });

    await test('不存在的接口返回 404 JSON', async () => {
      const r = await get('/api/nope');
      assert.strictEqual(r.status, 404);
      assert.ok(JSON.parse(r.text).ok === false);
    });

    await test('非法 JSON 请求体返回 400', async () => {
      const res = await fetch(`${BASE}/api/dns`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json',
      });
      assert.strictEqual(res.status, 400);
    });

    // ═════════════════ DNS ═════════════════
    section('DNS 解析');

    await test('解析 localhost 返回 127.0.0.1', async () => {
      const { data } = await post('/api/dns', { host: 'localhost' });
      const r = data.dns || data; // 兼容扁平/嵌套两种返回
      assert.strictEqual(r.ok, true);
      assert.ok(r.addresses.some((a) => a.address === '127.0.0.1'), `实际: ${JSON.stringify(r.addresses)}`);
    });

    await test('不存在的域名被正确报告为解析失败', async () => {
      const { data } = await post('/api/dns', { host: 'no-such-domain-xyz-999.invalid' });
      const r = data.dns || data;
      assert.strictEqual(r.ok, false, `应报告解析失败，实际 ok=${r.ok}`);
      assert.ok(r.error, '应带错误码字段');
      assert.deepStrictEqual(r.addresses, []);
    });

    await test('空 host 返回 400', async () => {
      const r = await post('/api/dns', { host: '' });
      assert.strictEqual(r.status, 400);
    });

    // ═════════════════ 端口检测 ═════════════════
    section('端口连通性检测');

    await test('开放端口被正确识别', async () => {
      const { data } = await post('/api/port/check', { host: '127.0.0.1', port: targetPort, timeout: 2000 });
      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.result.open, true, `应开放，实际: ${data.result.reason}`);
      assert.ok(data.result.latencyMs >= 0, '应返回延迟');
    });

    await test('关闭端口被正确识别（ECONNREFUSED）', async () => {
      const { data } = await post('/api/port/check', { host: '127.0.0.1', port: 1, timeout: 1500 });
      assert.strictEqual(data.result.open, false);
      assert.strictEqual(data.result.errorCode, 'ECONNREFUSED');
      assert.ok(/拒绝/.test(data.result.reason), '应给出中文说明');
    });

    await test('批量扫描混合结果正确', async () => {
      const { data } = await post('/api/port/scan', {
        host: '127.0.0.1', ports: `1-5,${targetPort},65533`, timeout: 1200, concurrency: 10, grabBanner: false,
      });
      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.summary.total, 7);
      const open = data.results.filter((r) => r.open);
      assert.strictEqual(open.length, 1, `应只有 1 个开放端口，实际 ${open.length}`);
      assert.strictEqual(open[0].port, targetPort);
    });

    await test('端口区间解析（8000-8003 → 4 个）', async () => {
      const { data } = await post('/api/port/scan', { host: '127.0.0.1', ports: '8000-8003', timeout: 400 });
      assert.strictEqual(data.summary.total, 4);
    });

    await test('非法端口返回 400 且提示', async () => {
      const r = await post('/api/port/scan', { host: '127.0.0.1', ports: 'abc,xyz' });
      assert.strictEqual(r.status, 400);
    });

    await test('越界端口（70000）被拒绝', async () => {
      const r = await post('/api/port/check', { host: '127.0.0.1', port: 70000 });
      assert.strictEqual(r.status, 400);
    });

    await test('开放端口排在结果列表前面', async () => {
      const { data } = await post('/api/port/scan', {
        host: '127.0.0.1', ports: `1,2,3,${targetPort}`, timeout: 900, grabBanner: false,
      });
      assert.strictEqual(data.results[0].open, true, '开放端口应排最前');
    });

    // ═════════════════ HTTP 调试 ═════════════════
    section('HTTP 调试引擎');

    const send = (config) => post('/api/http/send', { config: Object.assign({ timeout: 8000 }, config) });

    await test('GET 返回 JSON 并自动解析', async () => {
      const { data } = await send({ method: 'GET', url: `${TGT}/json` });
      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.response.status, 200);
      assert.ok(data.response.body.json, '应自动解析 JSON');
      assert.strictEqual(data.response.body.json.code, 0);
    });

    await test('耗时分段完整（dns/tcp/ttfb/total）', async () => {
      const { data } = await send({ method: 'GET', url: `${TGT}/json` });
      const t = data.response.time;
      for (const f of ['total', 'dns', 'ttfb', 'download']) {
        assert.ok(typeof t[f] === 'number', `缺时间字段 ${f}`);
      }
      assert.ok(t.total >= 0);
    });

    await test('POST 提交 JSON 并被服务端收到', async () => {
      const payload = JSON.stringify({ hello: '世界', n: 123 });
      const { data } = await send({
        method: 'POST', url: `${TGT}/echo`, bodyType: 'raw', rawBody: payload,
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      });
      assert.strictEqual(data.response.status, 200);
      assert.strictEqual(data.response.body.json.method, 'POST');
      assert.ok(data.response.body.json.body.includes('世界'), '中文请求体应原样送达');
    });

    await test('查询参数正确拼接', async () => {
      const { data } = await send({
        method: 'GET', url: `${TGT}/echo`,
        params: [{ key: 'a', value: '1' }, { key: 'b', value: '中文值' }],
      });
      assert.strictEqual(data.response.body.json.query.a, '1');
      assert.strictEqual(data.response.body.json.query.b, '中文值');
    });

    await test('环境变量 {{}} 插值生效', async () => {
      const { data } = await send({
        method: 'GET', url: `${TGT}/echo?tok={{myToken}}`,
        env: { myToken: 'SECRET123' },
      });
      assert.strictEqual(data.response.body.json.query.tok, 'SECRET123');
    });

    await test('Basic Auth 鉴权成功', async () => {
      const { data } = await send({
        method: 'GET', url: `${TGT}/basic-auth`,
        auth: { type: 'basic', username: 'user', password: 'pass' },
      });
      assert.strictEqual(data.response.status, 200);
      assert.strictEqual(data.response.body.json.authenticated, true);
    });

    await test('Basic Auth 失败返回 401', async () => {
      const { data } = await send({
        method: 'GET', url: `${TGT}/basic-auth`,
        auth: { type: 'basic', username: 'u', password: 'wrong' },
      });
      assert.strictEqual(data.response.status, 401);
    });

    await test('Bearer Token 鉴权成功', async () => {
      const { data } = await send({
        method: 'GET', url: `${TGT}/bearer`,
        auth: { type: 'bearer', token: 'TESTTOKEN' },
      });
      assert.strictEqual(data.response.status, 200);
      assert.strictEqual(data.response.body.json.token, 'TESTTOKEN');
    });

    await test('自动跟随重定向（302 → 200）', async () => {
      const { data } = await send({ method: 'GET', url: `${TGT}/redirect`, followRedirects: true });
      assert.strictEqual(data.response.status, 200);
      assert.strictEqual(data.redirects.length, 1);
      assert.strictEqual(data.redirects[0].status, 302);
    });

    await test('关闭跟随重定向时停在 302', async () => {
      const { data } = await send({ method: 'GET', url: `${TGT}/redirect`, followRedirects: false });
      assert.strictEqual(data.response.status, 302);
      assert.strictEqual(data.redirects.length, 0);
    });

    await test('404 / 500 状态码如实返回', async () => {
      const r404 = await send({ method: 'GET', url: `${TGT}/status/404` });
      assert.strictEqual(r404.data.response.status, 404);
      const r500 = await send({ method: 'GET', url: `${TGT}/status/500` });
      assert.strictEqual(r500.data.response.status, 500);
    });

    await test('Cookie 被正确解析', async () => {
      const { data } = await send({ method: 'GET', url: `${TGT}/cookie` });
      assert.strictEqual(data.response.cookies.length, 1);
      assert.strictEqual(data.response.cookies[0].name, 'sid');
      assert.strictEqual(data.response.cookies[0].value, 'abc123');
    });

    await test('x-www-form-urlencoded 表单提交', async () => {
      const { data } = await send({
        method: 'POST', url: `${TGT}/echo`, bodyType: 'form',
        form: [{ key: 'x', value: '1' }, { key: 'y', value: '2' }],
      });
      // /echo 回显的是「收到的请求头」，要查的是它，不是响应的 Content-Type
      const echoedCt = data.response.body.json.headers['content-type'];
      assert.ok(echoedCt.includes('x-www-form-urlencoded'), `实际 CT: ${echoedCt}`);
      assert.ok(data.response.body.json.body.includes('x=1'));
      assert.ok(data.response.body.json.body.includes('y=2'));
    });

    await test('multipart/form-data 构造正确', async () => {
      const { data } = await send({
        method: 'POST', url: `${TGT}/echo`, bodyType: 'multipart',
        multipart: [
          { key: 'field', value: 'v1', type: 'text' },
          { key: 'up', type: 'file', file: { name: 'a.txt', type: 'text/plain', base64: Buffer.from('文件内容').toString('base64') } },
        ],
      });
      const ct = data.response.body.json.headers['content-type'];
      assert.ok(ct.includes('multipart/form-data'), `实际 CT: ${ct}`);
      assert.ok(ct.includes('boundary='), '应含 boundary');
      assert.ok(data.response.body.json.body.includes('name="up"'), '应含文件字段名');
      assert.ok(data.response.body.json.body.includes('文件名="a.txt"'.replace('文件名', 'filename')), '应含 filename 属性');
      assert.ok(data.response.body.json.body.includes('文件内容'), '文件内容应正确编码');
    });

    await test('二进制响应被识别为 binary 且不乱码', async () => {
      const { data } = await send({ method: 'GET', url: `${TGT}/binary` });
      assert.strictEqual(data.response.body.type, 'binary');
      const buf = Buffer.from(data.response.body.base64, 'base64');
      assert.strictEqual(buf[0], 0x89, '应还原原始字节');
      assert.strictEqual(buf.length, 8);
    });

    await test('XML 响应作为文本返回', async () => {
      const { data } = await send({ method: 'GET', url: `${TGT}/xml` });
      assert.strictEqual(data.response.body.type, 'text');
      assert.ok(data.response.body.text.includes('<name>test</name>'));
    });

    await test('大响应体（300KB）完整返回', async () => {
      const { data } = await send({ method: 'GET', url: `${TGT}/big` });
      assert.strictEqual(data.response.body.type, 'text');
      assert.ok(data.response.body.json.blob.length > 290000, `实际长度 ${data.response.body.json.blob.length}`);
    });

    await test('连接被拒绝时返回结构化错误', async () => {
      const { data } = await send({ method: 'GET', url: 'http://127.0.0.1:1/', timeout: 3000 });
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.code, '应带错误码');
    });

    await test('DNS 失败返回结构化错误', async () => {
      const { data } = await send({ method: 'GET', url: 'http://no-such-host-xyz-777.invalid/', timeout: 4000 });
      assert.strictEqual(data.ok, false);
      assert.ok(/ENOTFOUND|EAI_AGAIN/.test(data.error.message), data.error.message);
    });

    await test('空 URL 返回错误而非崩溃', async () => {
      const { data } = await send({ method: 'GET', url: '' });
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.message.includes('URL'));
    });

    await test('超时会按设定时间返回', async () => {
      const t0 = Date.now();
      const { data } = await send({ method: 'GET', url: `${TGT}/slow`, timeout: 500 });
      const elapsed = Date.now() - t0;
      assert.strictEqual(data.ok, false);
      assert.ok(elapsed < 1400, `应在超时后快速返回，实际 ${elapsed}ms`);
    });

    await test('裸主机名自动补 http://', async () => {
      const { data } = await send({ method: 'GET', url: `127.0.0.1:${targetPort}/json` });
      assert.strictEqual(data.response.status, 200);
    });

    // ═════════════════ 断言 ═════════════════
    section('断言引擎');

    await test('状态码断言通过', async () => {
      const { data } = await send({
        method: 'GET', url: `${TGT}/json`,
        assertions: [{ id: 'a1', name: '状态200', source: 'status', operator: 'equals', value: '200' }],
      });
      assert.strictEqual(data.assertions.total, 1);
      assert.strictEqual(data.assertions.passed, 1);
    });

    await test('状态码断言失败被正确捕获', async () => {
      const { data } = await send({
        method: 'GET', url: `${TGT}/status/404`,
        assertions: [{ id: 'a1', name: '状态200', source: 'status', operator: 'equals', value: '200' }],
      });
      assert.strictEqual(data.assertions.failed, 1);
      assert.strictEqual(data.assertions.results[0].passed, false);
    });

    await test('2xx 分组断言', async () => {
      const { data } = await send({
        method: 'GET', url: `${TGT}/json`,
        assertions: [{ id: 'a1', name: '2xx', source: 'statusGroup', path: '2xx', operator: 'isTrue' }],
      });
      assert.strictEqual(data.assertions.passed, 1);
    });

    await test('JSON 路径断言（含数组下标）', async () => {
      const { data } = await send({
        method: 'GET', url: `${TGT}/json`,
        assertions: [
          { id: 'a1', source: 'bodyJson', path: '$.data.id', operator: 'equals', value: '42' },
          { id: 'a2', source: 'bodyJson', path: '$.data.name', operator: 'equals', value: '张三' },
          { id: 'a3', source: 'bodyJson', path: '$.data.tags[1]', operator: 'equals', value: 'b' },
          { id: 'a4', source: 'bodyJson', path: '$.data.tags', operator: 'lengthEquals', value: '2' },
        ],
      });
      assert.strictEqual(data.assertions.passed, 4, JSON.stringify(data.assertions.results.map((r) => r.detail)));
    });

    await test('响应头 / Cookie / 耗时 / 大小断言', async () => {
      const { data } = await send({
        method: 'GET', url: `${TGT}/cookie`,
        assertions: [
          { id: 'h1', source: 'header', path: 'content-type', operator: 'contains', value: 'json' },
          { id: 'c1', source: 'cookie', path: 'sid', operator: 'equals', value: 'abc123' },
          { id: 't1', source: 'time', path: 'total', operator: 'lt', value: '5000' },
          { id: 's1', source: 'size', operator: 'gt', value: '0' },
        ],
      });
      assert.strictEqual(data.assertions.passed, 4, JSON.stringify(data.assertions.results.map((r) => r.detail)));
    });

    await test('正则匹配断言', async () => {
      const { data } = await send({
        method: 'GET', url: `${TGT}/json`,
        assertions: [{ id: 'r1', source: 'bodyJson', path: '$.msg', operator: 'matches', value: '^o.$' }],
      });
      assert.strictEqual(data.assertions.passed, 1);
    });

    await test('非法正则不会导致请求崩溃', async () => {
      const { data } = await send({
        method: 'GET', url: `${TGT}/json`,
        assertions: [{ id: 'r1', source: 'bodyText', operator: 'matches', value: '[未闭合' }],
      });
      assert.strictEqual(data.assertions.failed, 1);
      assert.ok(data.response.status, '响应本身仍应成功返回');
    });

    await test('不存在的 JSON 路径被正确判定', async () => {
      const { data } = await send({
        method: 'GET', url: `${TGT}/json`,
        assertions: [{ id: 'x1', source: 'bodyJson', path: '$.nope.deep', operator: 'isNotNull' }],
      });
      assert.strictEqual(data.assertions.failed, 1);
    });

    await test('断言统计总数正确（3 断言 2 失败）', async () => {
      const { data } = await send({
        method: 'GET', url: `${TGT}/json`,
        assertions: [
          { id: '1', source: 'status', operator: 'equals', value: '200' },
          { id: '2', source: 'status', operator: 'equals', value: '500' },
          { id: '3', source: 'bodyJson', path: '$.code', operator: 'equals', value: '999' },
        ],
      });
      assert.strictEqual(data.assertions.total, 3);
      assert.strictEqual(data.assertions.passed, 1);
      assert.strictEqual(data.assertions.failed, 2);
    });

    // ═════════════════ 真实外网 ═════════════════
    section('真实外网连通性（需要网络）');
    const online = await fetch('https://registry.npmjs.org/-/ping', { signal: AbortSignal.timeout(4000) }).then(() => true).catch(() => false);

    if (!online) {
      console.log('  \x1b[33m⚠ 当前无外网连接，跳过外网测试\x1b[0m');
    } else {
      await test('HTTPS 公网请求成功（含 TLS 计时）', async () => {
        const { data } = await send({ method: 'GET', url: 'https://registry.npmjs.org/-/ping', timeout: 15000 });
        assert.strictEqual(data.ok, true, JSON.stringify(data.error));
        assert.strictEqual(data.response.status, 200);
        assert.ok(data.response.time.tls >= 0, '应记录 TLS 握手耗时');
      });

      await test('公网主机 DNS 解析', async () => {
        const { data } = await post('/api/dns', { host: 'registry.npmjs.org' });
        const r = data.dns || data;
        assert.strictEqual(r.ok, true);
        assert.ok(r.addresses.length > 0);
      });
    }

    // ═════════════════ 单元级：端口表达式 ═════════════════
    section('端口表达式解析（单元）');
    const portCheck = require(path.join(ROOT, 'lib', 'port-check'));

    await test('单个端口', () => {
      assert.deepStrictEqual(portCheck.parsePortSpec('80').ports, [80]);
    });
    await test('逗号分隔', () => {
      assert.deepStrictEqual(portCheck.parsePortSpec('22,80,443').ports, [22, 80, 443]);
    });
    await test('区间展开', () => {
      assert.deepStrictEqual(portCheck.parsePortSpec('100-103').ports, [100, 101, 102, 103]);
    });
    await test('反向区间自动纠正', () => {
      assert.deepStrictEqual(portCheck.parsePortSpec('103-100').ports, [100, 101, 102, 103]);
    });
    await test('混写与去重排序', () => {
      assert.deepStrictEqual(portCheck.parsePortSpec('443, 80-82, 80').ports, [80, 81, 82, 443]);
    });
    await test('中文逗号/顿号可解析', () => {
      assert.deepStrictEqual(portCheck.parsePortSpec('80，443、22').ports, [22, 80, 443]);
    });
    await test('非法项被记录但不中断', () => {
      const r = portCheck.parsePortSpec('80,abc,99999');
      assert.deepStrictEqual(r.ports, [80]);
      assert.strictEqual(r.errors.length, 2);
    });
    await test('超大区间被限制', () => {
      const r = portCheck.parsePortSpec('1-65535', 100);
      assert.ok(r.ports.length <= 100, `实际 ${r.ports.length}`);
      assert.ok(r.errors.length > 0);
    });
    await test('空输入返回空数组', () => {
      assert.deepStrictEqual(portCheck.parsePortSpec('').ports, []);
    });

  } finally {
    child.kill();
    target.close();
    if (useExe && spawnCwd) {
      try { fs.rmSync(spawnCwd, { recursive: true, force: true }); } catch { /* 临时目录清理失败无所谓 */ }
    }
  }

  // ═════════════════ 汇总 ═════════════════
  console.log('\n' + '─'.repeat(56));
  const total = passed + failed;
  if (failed === 0) {
    console.log(`\x1b[32m  ✓ 全部通过：${passed} / ${total}\x1b[0m`);
  } else {
    console.log(`\x1b[31m  ✗ ${failed} 项失败\x1b[0m，${passed} / ${total} 通过\n`);
    for (const f of failures) console.log(`    · ${f.name}\n      ${f.err.message}`);
  }
  console.log('─'.repeat(56) + '\n');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n测试运行器异常:', e);
  process.exit(1);
});