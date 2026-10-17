'use strict';
/**
 * HTTP 调试客户端（类 Postman 后端引擎）
 *
 * 为什么不用 fetch / undici：
 * 1. 自签名证书放行需要自定义 Agent，fetch 无参数可传；
 * 2. 要精确拆分 DNS/TCP/TLS/TTFB 各阶段耗时，只能挂在 socket 事件上；
 * 3. 重定向要记录完整链路（Postman 的 -L 只给最终结果，排查 302 问题时很难用）。
 */

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const dns = require('node:dns');
const { URL } = require('node:url');

const MAX_REDIRECTS = 10;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024; // 20MB 上限，避免日志炸弹撑爆内存

/** Brotli/zlib 解压。部分服务端声明了 Content-Encoding 却没真压缩，这里做容错。 */
function decompress(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!buffer.length) return buffer;
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer);
    if (enc === 'deflate') {
      try { return zlib.inflateSync(buffer); } catch { return zlib.inflateRawSync(buffer); }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    return buffer; // 解压失败就返回原始内容，不让整个请求崩掉
  }
  return buffer;
}

/** 把请求配置 + 环境变量渲染成最终请求。 */
function buildRequest(config) {
  const env = config.env || {};
  const raw = String(config.url || '');

  // 变量插值：{{name}}
  const interpolate = (str) => String(str).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, key) => {
    const v = env[key];
    return v === undefined || v === null ? m : String(v);
  });

  // 裸主机（无 scheme）补全
  let urlStr = raw.trim();
  if (!urlStr) throw new Error('URL 不能为空');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(urlStr)) {
    urlStr = `http://${urlStr}`;
  }
  urlStr = interpolate(urlStr);

  let url;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`URL 格式无法解析: ${urlStr}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`仅支持 http/https，当前为 ${url.protocol.replace(':', '')}`);
  }
  if (!url.hostname) throw new Error('URL 缺少主机名');

  const method = (config.method || 'GET').toUpperCase();
  const headers = {};
  for (const h of config.headers || []) {
    if (!h || !h.key) continue;
    const key = interpolate(String(h.key)).trim();
    if (!key) continue;
    const rawKey = key;
    headers[rawKey] = interpolate(String(h.value ?? ''));
  }

  // URL 上的查询参数（Postman 风格单独表格）
  for (const q of config.params || []) {
    if (!q || !q.key) continue;
    url.searchParams.append(interpolate(String(q.key)), interpolate(String(q.value ?? '')));
  }

  // ---- 鉴权 ----
  const auth = config.auth || { type: 'none' };
  if (auth.type === 'basic') {
    const user = interpolate(auth.username || '');
    const pass = interpolate(auth.password || '');
    if (!headers.Authorization && !hasHeaderCI(headers, 'authorization')) {
      headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
    }
  } else if (auth.type === 'bearer') {
    const token = interpolate(auth.token || '');
    if (token && !hasHeaderCI(headers, 'authorization')) {
      headers.Authorization = `Bearer ${token}`;
    }
  } else if (auth.type === 'apikey') {
    const key = interpolate(auth.key || '');
    const val = interpolate(auth.value || '');
    if (key && val) {
      if (auth.in === 'query') url.searchParams.set(key, val);
      else if (auth.in === 'header') headers[key] = val;
    }
  } else if (auth.type === 'oauth2' && auth.token) {
    if (!hasHeaderCI(headers, 'authorization')) {
      headers.Authorization = `Bearer ${interpolate(auth.token)}`;
    }
  }

  // ---- 请求体 ----
  let bodyBuffer = null;
  const bodyType = config.bodyType || 'none';

  if (!['GET', 'HEAD'].includes(method) && bodyType !== 'none') {
    if (bodyType === 'raw') {
      bodyBuffer = Buffer.from(interpolate(config.rawBody || ''), 'utf8');
      if (!hasHeaderCI(headers, 'content-type')) {
        headers['Content-Type'] = config.contentType || 'text/plain; charset=utf-8';
      }
    } else if (bodyType === 'form') {
      const params = new URLSearchParams();
      for (const f of config.form || []) {
        if (!f || !f.key || f.enabled === false) continue;
        if (f.type === 'file') continue; // 文件走 multipart
        params.append(interpolate(String(f.key)), interpolate(String(f.value ?? '')));
      }
      bodyBuffer = Buffer.from(params.toString(), 'utf8');
      if (!hasHeaderCI(headers, 'content-type')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    } else if (bodyType === 'multipart') {
      const mp = buildMultipart(config.multipart || [], config.form || [], interpolate);
      bodyBuffer = mp.buffer;
      if (!hasHeaderCI(headers, 'content-type')) {
        headers['Content-Type'] = mp.contentType;
      }
    }
  }

  if (!hasHeaderCI(headers, 'accept')) headers.Accept = '*/*';
  if (!hasHeaderCI(headers, 'accept-encoding')) headers['Accept-Encoding'] = 'gzip, deflate, br';
  if (!hasHeaderCI(headers, 'user-agent')) headers['User-Agent'] = 'NetCheckTool/1.0';
  if (bodyBuffer && !hasHeaderCI(headers, 'content-length')) {
    headers['Content-Length'] = String(bodyBuffer.length);
  }

  return { method, url, headers, bodyBuffer };
}

/** header 名大小写不敏感判断。 */
function hasHeaderCI(headers, name) {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

/** 构造 multipart/form-data 二进制体。 */
function buildMultipart(parts, formParts, interpolate) {
  const boundary = `----NetCheckFormBoundary${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const chunks = [];
  for (const p of parts || []) {
    if (!p || !p.key || p.enabled === false) continue;
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    if (p.type === 'file') {
      const file = p.file || {};
      const filename = interpolate(file.name || 'file.bin');
      const mime = file.type || 'application/octet-stream';
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${interpolate(p.key)}"; filename="${filename}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`, 'utf8'));
      // 前端把文件内容以 base64 传上来
      const b64 = String(file.base64 || '').replace(/^data:[^,]*,/, '');
      chunks.push(Buffer.from(b64, 'base64'));
      chunks.push(Buffer.from('\r\n', 'utf8'));
    } else {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${interpolate(p.key)}"\r\n\r\n`, 'utf8'));
      chunks.push(Buffer.from(interpolate(String(p.value ?? '')), 'utf8'));
      chunks.push(Buffer.from('\r\n', 'utf8'));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  // 注意：不能把 Buffer 用展开运算符塞进对象（会变成下标键集合），这里显式包一层
  return { buffer: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** 发起单次 HTTP 请求，返回原始响应（不含重定向处理）。 */
function performOnce({ method, url, headers, bodyBuffer }, timeoutMs, insecure) {
  return new Promise((resolve) => {
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const started = process.hrtime.bigint();
    const marks = { dns: null, tcp: null, tls: null, ttfb: null, firstByte: null };

    const now = () => Number(process.hrtime.bigint() - started) / 1e6;

    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      // 关闭证书校验（自签名调试场景）
      ...(isHttps ? { rejectUnauthorized: !insecure } : {}),
    };

    const req = lib.request(options, (res) => {
      marks.ttfb = now();
      const chunks = [];
      let total = 0;
      let aborted = false;

      res.on('data', (c) => {
        if (marks.firstByte === null) marks.firstByte = now();
        if (total >= MAX_RESPONSE_BYTES) { aborted = true; res.destroy(); return; }
        chunks.push(c);
        total += c.length;
      });

      const finish = (err) => {
        const raw = Buffer.concat(chunks);
        const decoded = decompress(raw, res.headers['content-encoding']);
        resolve({
          err: err || null,
          aborted,
          truncated: aborted || total >= MAX_RESPONSE_BYTES,
          rawBytes: total,
          bodyBuffer: decoded,
          status: res.statusCode,
          statusMessage: res.statusMessage || '',
          httpVersion: res.httpVersion,
          headers: res.headers,
          socket: res.socket || req.socket,
          marks,
          totalMs: now(),
        });
      };

      res.on('end', () => finish(null));
      res.on('error', (e) => finish(e));
      res.on('aborted', () => finish(new Error('响应被中断')));
    });

    req.setTimeout(timeoutMs, () => {
      const e = new Error(`请求超时（${timeoutMs}ms）`);
      e.code = 'ETIMEDOUT';
      req.destroy(e);
    });

    req.on('socket', (sock) => {
      if (sock.connecting) {
        sock.on('lookup', () => { marks.dns = now(); });
        sock.once('connect', () => { marks.tcp = now(); });
        if (isHttps) sock.once('secureConnect', () => { marks.tls = now(); });
      } else {
        marks.tcp = 0; // 连接复用
      }
    });

    req.on('error', (err) => {
      resolve({
        err: { code: err.code || 'ERROR', message: err.message || String(err) },
        aborted: false, truncated: false, rawBytes: 0, bodyBuffer: Buffer.alloc(0),
        status: 0, statusMessage: '', httpVersion: '', headers: {}, socket: req.socket,
        marks, totalMs: now(),
      });
    });

    if (bodyBuffer && bodyBuffer.length) req.write(bodyBuffer);
    req.end();
  });
}

/** DNS 解析耗时单独测一次（连接池复用时 socket 事件拿不到）。 */
function measureDns(hostname) {
  return new Promise((resolve) => {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
      resolve(0); // 字面量 IP 无需解析
      return;
    }
    const t0 = process.hrtime.bigint();
    dns.lookup(hostname, { all: true }, () => {
      resolve(Number(process.hrtime.bigint() - t0) / 1e6);
    });
  });
}

/** 判断响应体是否是「可读文本」。 */
function looksTextual(buf, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (/text\/|json|xml|javascript|html|csv|yaml|x-www-form-urlencoded|graphql/.test(ct)) return true;
  if (!buf.length) return true;
  // 无 Content-Type 时看是不是像文本：无可打印控制字符即可
  let suspicious = 0;
  const sample = buf.subarray(0, Math.min(buf.length, 1024));
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / sample.length < 0.05;
}

/**
 * 完整请求：处理变量、鉴权、重定向链、耗时分段、响应体格式化。
 */
async function sendRequest(config) {
  const timeoutMs = Math.max(200, Math.min(300000, Number(config.timeout) || 30000));
  const followRedirects = config.followRedirects !== false;
  const insecure = !!config.insecureTLS;

  let built;
  try {
    built = buildRequest(config);
  } catch (e) {
    return { ok: false, error: { message: e.message }, request: null, response: null, timeline: [] };
  }

  const timeline = [];
  let current = built;
  let response = null;
  let hops = 0;
  const redirectChain = [];

  const dnsMs = await measureDns(built.url.hostname);

  while (true) {
    const r = await performOnce(current, timeoutMs, insecure);
    timeline.push({
      url: current.url.toString(),
      method: current.method,
      status: r.status,
      ms: Number(r.totalMs.toFixed(1)),
      stage: hops === 0 ? 'request' : `redirect-${hops}`,
    });

    if (r.err) {
      response = r;
      break;
    }

    const loc = r.headers.location;
    const isRedirect = [301, 302, 303, 307, 308].includes(r.status) && loc;

    if (isRedirect && followRedirects && hops < MAX_REDIRECTS) {
      redirectChain.push({ status: r.status, from: current.url.toString(), location: loc });
      let nextUrl;
      try {
        nextUrl = new URL(loc, current.url);
      } catch {
        response = r; // Location 非法，停在当前响应
        break;
      }
      hops++;
      // 303 一律转 GET；301/302 对 POST 也按浏览器行为转 GET
      let nextMethod = current.method;
      let nextBody = current.bodyBuffer;
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && current.method === 'POST')) {
        nextMethod = 'GET';
        nextBody = null;
        const h = { ...current.headers };
        delete h['Content-Length'];
        delete h['content-length'];
        delete h['Content-Type'];
        delete h['content-type'];
        current = { ...current, headers: h };
      }
      // 跨域跳转时清掉 Authorization，避免凭据泄漏到新主机
      const headers = { ...current.headers };
      if (nextUrl.host !== current.url.host && hasHeaderCI(headers, 'authorization')) {
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === 'authorization') delete headers[k];
        }
      }
      current = { method: nextMethod, url: nextUrl, headers, bodyBuffer: nextBody };
      continue;
    }

    response = r;
    break;
  }

  if (!response) {
    return { ok: false, error: { message: '未获得响应' }, request: built, response: null, timeline };
  }

  const requestSummary = {
    method: built.method,
    url: built.url.toString(),
    headers: built.headers,
    bodySize: built.bodyBuffer ? built.bodyBuffer.length : 0,
    bodyPreview: built.bodyBuffer ? built.bodyBuffer.toString('utf8').slice(0, 2000) : '',
  };

  if (response.err) {
    return {
      ok: false,
      error: response.err,
      request: requestSummary,
      response: null,
      redirects: redirectChain,
      dnsMs: Number(dnsMs.toFixed(2)),
      timeline,
    };
  }

  const bodyBuf = response.bodyBuffer;
  const contentType = response.headers['content-type'] || '';
  const isText = looksTextual(bodyBuf, contentType);
  const charsetMatch = /charset=([\w-]+)/i.exec(contentType);
  let charset = (charsetMatch ? charsetMatch[1] : 'utf-8').toLowerCase();
  if (!['utf-8', 'utf8', 'gbk', 'gb2312', 'gb18030', 'big5', 'iso-8859-1', 'latin1', 'shift_jis'].includes(charset)) {
    charset = 'utf-8';
  }

  let body;
  if (isText) {
    let text;
    try {
      text = new TextDecoder(charset, { fatal: false }).decode(bodyBuf);
    } catch {
      text = bodyBuf.toString('utf8');
    }
    let parsed = null;
    const trimmed = text.trim();
    if (trimmed && (/json/.test(contentType) || /^[[{]/.test(trimmed))) {
      try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
    }
    body = {
      type: 'text',
      size: bodyBuf.length,
      text: text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text,
      charset,
      json: parsed,
      truncated: text.length > MAX_RESPONSE_BYTES || response.truncated,
    };
  } else {
    body = {
      type: 'binary',
      size: bodyBuf.length,
      base64: bodyBuf.subarray(0, 4 * 1024 * 1024).toString('base64'),
      contentType: contentType || 'application/octet-stream',
      truncated: response.truncated,
    };
  }

  const headerList = Object.entries(response.headers).map(([k, v]) => ({
    key: k,
    value: Array.isArray(v) ? v.join(', ') : String(v),
  }));

  // 解析 Set-Cookie
  const rawCookies = response.headers['set-cookie'] || [];
  const cookies = (Array.isArray(rawCookies) ? rawCookies : [rawCookies]).map((c) => {
    const [pair, ...attrs] = String(c).split(';');
    const idx = pair.indexOf('=');
    return {
      raw: String(c),
      name: idx >= 0 ? pair.slice(0, idx).trim() : pair.trim(),
      value: idx >= 0 ? pair.slice(idx + 1).trim() : '',
      attrs: attrs.map((a) => a.trim()).filter(Boolean),
    };
  });

  const m = response.marks;
  const time = {
    total: Number(response.totalMs.toFixed(1)),
    dns: Number((m.dns ?? dnsMs ?? 0).toFixed(1)),
    tcp: m.tcp === null ? null : Number(m.tcp.toFixed(1)),
    tls: m.tls === null ? null : Number(m.tls.toFixed(1)),
    ttfb: m.ttfb === null ? null : Number(m.ttfb.toFixed(1)),
    download: m.ttfb === null ? null : Number(Math.max(0, response.totalMs - m.ttfb).toFixed(1)),
  };

  const tlsInfo = response.socket && typeof response.socket.getPeerCertificate === 'function'
    ? (() => {
        const cert = response.socket.getPeerCertificate() || {};
        return {
          protocol: response.socket.getProtocol ? response.socket.getProtocol() : '',
          authorized: response.socket.authorized,
          subject: cert.subject ? Object.entries(cert.subject).map(([k, v]) => `${k}=${v}`).join(', ') : '',
          issuer: cert.issuer ? Object.entries(cert.issuer).map(([k, v]) => `${k}=${v}`).join(', ') : '',
          validFrom: cert.valid_from || '',
          validTo: cert.valid_to || '',
          fingerprint256: cert.fingerprint256 || '',
        };
      })()
    : null;

  return {
    ok: true,
    request: requestSummary,
    response: {
      status: response.status,
      statusMessage: response.statusMessage,
      httpVersion: response.httpVersion,
      headers: headerList,
      cookies,
      body,
      time,
      size: body.size,
      remoteAddress: response.socket ? response.socket.remoteAddress : '',
      localAddress: response.socket ? response.socket.localAddress : '',
      tls: response.socket && tlsInfo && tlsInfo.protocol ? tlsInfo : null,
    },
    redirects: redirectChain,
    dnsMs: Number(dnsMs.toFixed(2)),
    timeline,
  };
}

module.exports = { sendRequest, buildRequest, decompress };