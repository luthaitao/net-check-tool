'use strict';
/**
 * TCP 端口连通性检测
 *
 * 设计要点：
 * 1. 用「显式 setTimeout 定时器」而非 socket.setTimeout() 控制超时——后者在
 *    DNS 解析阶段不生效，解析慢的机器上会表现为「卡住」而不是「超时」。
 * 2. Banner 采用**被动抓取**：连上后只读、不主动发探测包。避免在生产设备上
 *    触发协议状态机（对 SMTP/SSH 等有副作用）。
 * 3.并发用固定大小 worker池，避免一次扫 65535 个端口把 fd 和事件循环打爆。
 */

const net = require('node:net');
const dns = require('node:dns');
const os = require('node:os');

// 常见端口 → 服务名。命中即标注，不保证绝对准确。
const WELL_KNOWN = {
  20: 'FTP-DATA', 21: 'FTP', 22: 'SSH', 23: 'TELNET', 25: 'SMTP', 53: 'DNS/T53',
  67: 'DHCP', 68: 'DHCP', 69: 'TFTP', 80: 'HTTP', 110: 'POP3', 119: 'NNTP',
  123: 'NTP', 135: 'MSRPC', 137: 'NetBIOS-NS', 138: 'NetBIOS-DGM',
  139: 'NetBIOS-SSN', 143: 'IMAP', 161: 'SNMP', 179: 'BGP', 389: 'LDAP',
  443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 514: 'Syslog', 587: 'SMTP-Submit',
  631: 'IPP', 636: 'LDAPS', 993: 'IMAPS', 995: 'POP3S', 1433: 'MSSQL',
  1521: 'Oracle', 2049: 'NFS', 2181: 'ZooKeeper', 2375: 'Docker',
  2376: 'Docker-TLS', 3000: 'HTTP-alt', 3306: 'MySQL', 3389: 'RDP',
  4840: 'GlassFish', 5000: 'HTTP-alt', 5432: 'PostgreSQL', 5672: 'AMQP',
  5900: 'VNC', 5985: 'WinRM', 6379: 'Redis', 7001: 'WebLogic',
  8000: 'HTTP-alt', 8009: 'AJP', 8080: 'HTTP-Proxy', 8081: 'HTTP-alt',
  8088: 'HTTP-alt', 8443: 'HTTPS-alt', 8888: 'HTTP-alt', 9000: 'PHP-FPM',
  9090: 'Prometheus', 9200: 'Elasticsearch', 9300: 'ES-Transport',
  10050: 'Kubelet', 11211: 'Memcached', 15672: 'RabbitMQ-Mgmt',
  27017: 'MongoDB', 50000: 'DB2', 50070: 'Hadoop-NN',
};

/** 把 socket 错误码翻译成人话。 */
function explainError(code) {
  switch (code) {
    case 'ECONNREFUSED': return '连接被拒绝（端口未监听 / 服务未启动）';
    case 'EHOSTUNREACH': return '主机不可达（无路由或主机离线）';
    case 'ENETUNREACH': return '网络不可达（未连接到该网段）';
    case 'ENETDOWN': return '网络已断开';
    case 'ETIMEDOUT': return '连接超时（被防火墙静默丢弃）';
    case 'EADDRNOTAVAIL': return '本地没有可用的对应地址（IPv4/IPv6 不匹配？）';
    case 'ECONNRESET': return '连接被重置（服务立即断开，可能不是目标服务）';
    case 'EPROTO': return '协议错误（TLS 版本/加密套件不匹配）';
    case 'EACCES': return '权限不足（低于 1024 的端口需管理员）';
    case 'EAI_AGAIN': return 'DNS 临时解析失败';
    case 'EAI_NONAME': return 'DNS 解析失败：主机名不存在';
    default: return code || '未知错误';
  }
}

/**
 * 检测单个端口。
 * @param {string} host IP 或主机名
 * @param {number} port
 * @param {object} opts { timeout, grabBanner, bannerMs }
 * @returns {Promise<object>} 端口状态对象
 */
function checkPort(host, port, opts = {}) {
  const timeout = Math.max(200, Number(opts.timeout) || 1500);
  const grabBanner = !!opts.grabBanner;
  const bannerMs = Math.min(2000, Math.max(100, Number(opts.bannerMs) || 500));

  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const socket = new net.Socket();
    // 关掉 Nagle，减少小包延迟对测量的干扰
    socket.setNoDelay(true);

    let settled = false;
    let bannerChunks = [];
    let bannerTimer = null;

    const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (bannerTimer) clearTimeout(bannerTimer);
      socket.removeAllListeners();
      socket.destroy();
      resolve({
        port,
        open: result.open,
        reason: result.reason || '',
        errorCode: result.errorCode || '',
        latencyMs: result.latencyMs === undefined ? null : Number(result.latencyMs.toFixed(2)),
        banner: result.banner || '',
        service: WELL_KNOWN[port] || (result.bannerService || ''),
        localAddress: result.localAddress || '',
        remoteAddress: result.remoteAddress || '',
      });
    }

    // 显式超时定时器：覆盖 DNS 解析 + 连接全过程
    const timer = setTimeout(() => {
      finish({ open: false, reason: `超时（${timeout}ms 无响应，通常被防火墙静默丢弃）` });
    }, timeout);

    socket.once('connect', () => {
      const latency = elapsedMs();
      const local = socket.localAddress || '';
      const remote = socket.remoteAddress || '';

      if (!grabBanner) {
        finish({ open: true, reason: '连接成功', latencyMs: latency, localAddress: local, remoteAddress: remote });
        return;
      }
      // 被动读取：等对方主动发数据，最多等 bannerMs
      bannerTimer = setTimeout(() => {
        finish({
          open: true,
          reason: '连接成功（未收到 Banner，可能为 HTTP 等需客户端先发请求的协议）',
          latencyMs: latency,
          banner: normalizeBanner(bannerChunks),
          bannerService: guessService(bannerChunks),
          localAddress: local,
          remoteAddress: remote,
        });
      }, bannerMs);

      socket.on('data', (chunk) => {
        if (bannerChunks.length < 8) bannerChunks.push(chunk);
        if (bannerChunks.reduce((n, c) => n + c.length, 0) > 4096) {
          // 抓够了就收工，别把对方的数据流一直挂着
          clearTimeout(bannerTimer);
          finish({
            open: true, reason: '连接成功（已截取 Banner）', latencyMs: latency,
            banner: normalizeBanner(bannerChunks),
            bannerService: guessService(bannerChunks),
            localAddress: local, remoteAddress: remote,
          });
        }
      });
    });

    socket.once('timeout', () => {
      finish({ open: false, reason: `超时（${timeout}ms）`, errorCode: 'ETIMEDOUT' });
    });

    socket.once('error', (err) => {
      finish({ open: false, reason: explainError(err.code), errorCode: err.code || 'ERR' });
    });

    try {
      socket.connect(port, host);
    } catch (err) {
      finish({ open: false, reason: explainError(err.code) || err.message, errorCode: err.code || 'ERR' });
    }
  });
}

/** 二进制 → 可打印字符串，超长截断。 */
function normalizeBanner(chunks) {
  if (!chunks.length) return '';
  const buf = Buffer.concat(chunks);
  const slice = buf.subarray(0, 512);
  // 可打印比例低于60% 说明是二进制协议，不硬转
  let printable = 0;
  for (const b of slice) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
  }
  if (slice.length && printable / slice.length < 0.6) return `<二进制 ${slice.length} 字节>`;
  return slice.toString('utf8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, 512).trim();
}

/** 依据 Banner 特征猜协议。 */
function guessService(chunks) {
  if (!chunks.length) return '';
  const buf = Buffer.concat(chunks);
  const s = buf.toString('latin1');
  if (/^SSH-/.test(s)) return 'SSH';
  if (/^220[- ]/.test(s) && /SSH/i.test(s)) return 'SSH';
  if (/^HTTP\//.test(s)) return 'HTTP';
  if (/^\*\sOK\b/im.test(s)) return 'IMAP';
  if (/^\+OK\b/.test(s)) return 'POP3/FTP';
  if (/^220[- ]/.test(s)) return 'SMTP';
  if (/^-ERR|^:-(?!\?)/.test(s) && s.length > 3) return 'Redis/ Memcached';
  if (/^\x00\x00\x00/.test(s) || (buf[4] === 10 && buf.length > 8)) return 'MySQL/ 私有协议';
  if (/^RTSP|^SIP\/|^INVITE /.test(s)) return 'SIP/RTSP';
  if (/^\x16\x03/.test(s)) return 'TLS 直连';
  return '';
}

/**
 * 解析端口表达式：支持 "80", "80,443", "8000-8010", "1-100,443,8080"，并去重排序。
 * @returns {{ports:number[], errors:string[], truncated:boolean}}
 */
function parsePortSpec(spec, maxCount = 2000) {
  const errors = [];
  const set = new Set();
  const raw = String(spec || '').trim();

  if (!raw) return { ports: [], errors: ['端口为空'], truncated: false };

  for (const chunk of raw.split(/[,\s;、，]+/)) {
    const part = chunk.trim();
    if (!part) continue;

    // 单个端口
    if (/^\d{1,5}$/.test(part)) {
      const p = Number(part);
      if (p >= 1 && p <= 65535) set.add(p);
      else errors.push(`端口越界: ${part}`);
      continue;
    }

    // 区间 a-b
    const m = part.match(/^(\d{1,5})\s*[-~]\s*(\d{1,5})$/);
    if (m) {
      let a = Number(m[1]);
      let b = Number(m[2]);
      if (a > b) [a, b] = [b, a];
      if (a < 1 || b > 65535) { errors.push(`区间越界: ${part}`); continue; }
      if (b - a + 1 > maxCount) {
        errors.push(`区间 ${part} 过大（${b - a + 1} 个），已限制为 ${maxCount} 个`);
        b = a + maxCount - 1;
      }
      for (let p = a; p <= b; p++) set.add(p);
      continue;
    }

    errors.push(`无法解析: ${part}`);
  }

  const ports = [...set].sort((x, y) => x - y);
  return { ports, errors, truncated: ports.length > maxCount };
}

/** DNS 解析，返回全部地址。失败不抛，交给调用方展示。 */
function resolveHost(host) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    dns.lookup(host, { all: true, verbatim: true }, (err, addresses) => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (err) {
        resolve({ ok: false, host, error: err.code || err.message, addresses: [], resolveMs: Number(ms.toFixed(2)) });
        return;
      }
      resolve({
        ok: true,
        host,
        resolveMs: Number(ms.toFixed(2)),
        addresses: addresses.map((a) => ({ address: a.address, family: `IPv${a.family}` })),
      });
    });
  });
}

/** family 归一化：Node 18+ 是字符串 "IPv4"/"IPv6"，更早版本是数字 4/6。 */
function normalizeFamily(family) {
  if (typeof family === 'number') return `IPv${family}`;
  return String(family);
}

/** 监听本机网卡信息——排查「连不上」时非常关键。 */
function localInterfaces() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      out.push({ name, address: a.address, family: normalizeFamily(a.family), mac: a.mac });
    }
  }
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    interfaces: out,
  };
}

/**
 * 固定并发池执行端口检测。
 * @param {string} host
 * @param {number[]} ports
 * @param {object} opts { timeout, concurrency, grabBanner, onProgress(done,total,last) }
 */
async function scanPorts(host, ports, opts = {}) {
  const concurrency = Math.max(1, Math.min(512, Number(opts.concurrency) || 32));
  const results = new Array(ports.length);
  const total = ports.length;
  let cursor = 0;
  let doneCount = 0;

  async function worker() {
    for (;;) {
      const idx = cursor++;
      if (idx >= total) return;
      const port = ports[idx];
      results[idx] = await checkPort(host, port, opts);
      doneCount++;
      if (opts.onProgress) {
        // 回调里只放行轻量逻辑；用 microtask 让出事件循环，避免阻塞
        queueMicrotask(() => {
          try { opts.onProgress(doneCount, total, results[idx]); } catch { /* 忽略回调异常 */ }
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(workers);

  return {
    host,
    total,
    open: results.filter((r) => r.open).length,
    closed: results.filter((r) => !r.open).length,
    results,
    scannedAt: new Date().toISOString(),
  };
}

module.exports = { checkPort, parsePortSpec, resolveHost, scanPorts, localInterfaces, explainError, WELL_KNOWN };