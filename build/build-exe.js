'use strict';
/**
 * 单文件可执行程序构建脚本
 *
 * 用 Node SEA(Single Executable Application) 把整个工具打进一个 exe。
 * 需要解决两个 SEA 的固有限制：
 *   1. SEA 只打包「一个入口 JS」，不支持 require('./lib/xxx') 相对路径；
 *      → 自己写个极简 bundler，把 lib/ 下的模块内联成同一个文件。
 *   2. SEA 不会打包 public/ 静态资源；
 *      → 用embedAssets 把它们转成 base64 内嵌，server.js 运行时读取。
 *
 * 用法：node build/build-exe.js
 * 产物：dist/网络检查工具.exe （约 90-110 MB，含 Node 运行时）
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, '.sea');
const OUT_NAME = '网络检查工具.exe';

// 需要打进包里的模块（顺序无关，bundler 会解析依赖）
const ENTRY = 'server.js';
const LIB_MODULES = ['lib/port-check.js', 'lib/http-client.js', 'lib/assert-engine.js'];

function log(msg) {
  console.log(`  ${msg}`);
}

function step(n, total, msg) {
  console.log(`\n[${n}/${total}] ${msg}`);
}

/** 把 public/ 下的文件转成 { '/index.html': 'base64...' } */
function embedAssets() {
  const publicDir = path.join(ROOT, 'public');
  const out = {};
  let count = 0;
  let bytes = 0;

  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, rel);
      else {
        const buf = fs.readFileSync(full);
        out[rel] = buf.toString('base64');
        count++;
        bytes += buf.length;
      }
    }
  }
  walk(publicDir, '');

  log(`内嵌 ${count} 个静态资源，共 ${(bytes / 1024).toFixed(1)} KB`);
  return out;
}

/**
 * 极简 CommonJS bundler。
 * 把每个模块包成函数，用一个手写的 require 分发，
 * 只支持源码里实际用到的相对依赖（require('./lib/xxx')）。
 */
function bundle(assets) {
  const modules = new Map();

  for (const rel of LIB_MODULES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    modules.set(rel, src);
  }
  const entrySrc = fs.readFileSync(path.join(ROOT, ENTRY), 'utf8');
  modules.set(ENTRY, entrySrc);

  // 生成模块注册表：路径 → 源码
  const registry = {};
  for (const [rel, src] of modules) {
    registry[rel] = src;
  }

  // 内嵌资源放在最前面，挂到 globalThis，server.js 会读它
  const assetsLiteral = JSON.stringify(assets);

  const parts = [];
  parts.push('/* ===== 网络检查工具 单文件构建产物（勿手改）===== */');
  parts.push("'use strict';");
  parts.push(`globalThis.__NETCHECK_ASSETS__ = ${assetsLiteral};`);
  parts.push(`
const __modules = ${JSON.stringify(registry)};
const __cache = Object.create(null);
const __refs = Object.create(null);

function __makeRequire(fromPath) {
  const req = function (request) {
    // 只处理相对依赖；node: 内置模块直接转发给真 require
    if (!request.startsWith('.')) return require(request);
    const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const segments = (dir ? dir.split('/') : []).concat(request.split('/'));
    const stack = [];
    for (const seg of segments) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') stack.pop();
      else stack.push(seg);
    }
    let key = stack.join('/');
    // 补 .js
    if (!key.endsWith('.js')) key += '.js';
    if (!__modules[key]) {
      throw new Error('打包产物缺少模块: ' + key + '（来自 ' + fromPath + '）');
    }
    return __load(key);
  };

  // 关键：模块是用 new Function 执行的，拿到的是合成 module 对象，
  // 因此必须让 require.main 指向入口模块对应的合成对象，
  // 否则入口里的 require.main === module 恒为 false，start() 永不执行。
  Object.defineProperty(req, 'main', {
    get() { return __refs[${JSON.stringify(ENTRY)}]; },
  });
  Object.defineProperty(req, 'cache', { get() { return __cache; } });
  return req;
}

function __load(key) {
  if (__cache[key]) return __cache[key].exports;
  const module = { exports: {}, id: key, filename: key };
  __cache[key] = module;
  __refs[key] = module;
  const fn = new Function('module', 'exports', 'require', '__filename', '__dirname',
    __modules[key]);
  fn(module, module.exports, __makeRequire(key), key, key);
  return module.exports;
}

__load(${JSON.stringify(ENTRY)});
`);

  const bundleCode = parts.join('\n');
  const bundlePath = path.join(STAGE, 'bundle.js');
  fs.writeFileSync(bundlePath, bundleCode, 'utf8');
  return { bundlePath, size: Buffer.byteLength(bundleCode) };
}

async function main() {
  const total = 5;
  // --keep-bundle: 保留中间产物，便于排错（默认构建结束会清掉）
  const keepBundle = process.argv.includes('--keep-bundle');
  console.log('\n\x1b[1m构建单文件可执行程序\x1b[0m');

  // ── 0. 环境检查 ──
  step(0, total, '检查构建环境');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    console.error(`  ✗ 需要 Node 20+ 才能构建（当前 ${process.version}）`);
    process.exit(1);
  }
  log(`Node ${process.version}`);

  // postject 是官方用来把 SEA blob 注入 exe 的工具
  let postjectBin = null;
  const localPostject = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  if (fs.existsSync(localPostject)) {
    postjectBin = localPostject;
    log('postject: 项目本地');
  } else {
    // 尝试 npx
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', ['npx'], { stdio: 'ignore' });
      postjectBin = 'npx';
      log('postject: 通过 npx 调用');
    } catch {
      console.error('  ✗ 未找到 postject，请先执行：npm install postject --no-save');
      process.exit(1);
    }
  }

  // ── 1. 准备目录 ──
  step(1, total, '准备构建目录');
  await fsp.rm(STAGE, { recursive: true, force: true });
  await fsp.mkdir(STAGE, { recursive: true });
  await fsp.mkdir(DIST, { recursive: true });

  // ── 2. 内嵌静态资源 + 打包 JS ──
  step(2, total, '内嵌静态资源并打包 JS');
  const assets = embedAssets();
  const { bundlePath, size } = bundle(assets);
  log(`bundle.js: ${(size / 1024).toFixed(1)} KB`);

  // ── 3. 生成 SEA 配置与 blob ──
  step(3, total, '生成 SEA blob');
  const seaConfig = {
    main: bundlePath,
    output: path.join(STAGE, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,   // 运行时 require 动态行为多，快照反而容易出问题
    useCodeCache: false,  // 同上；也便于排错
  };
  const seaConfigPath = path.join(STAGE, 'sea-config.json');
  await fsp.writeFile(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');

  execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const blobPath = seaConfig.output;
  const blobStat = await fsp.stat(blobPath);
  log(`sea-prep.blob: ${(blobStat.size / 1024 / 1024).toFixed(1)} MB`);

  // ── 4. 注入到 node.exe 副本 ──
  step(4, total, '注入运行时并生成 exe');
  const nodeExe = process.execPath;
  const exePath = path.join(DIST, OUT_NAME);
  await fsp.copyFile(nodeExe, exePath);

  const isWindows = process.platform === 'win32';
  if (!isWindows) fs.chmodSync(exePath, 0o755);

  // 两种调用方式：
  //  - 本地 postject：node node_modules/postject/dist/cli.js <exe> NODE_SEA_BLOB <blob> ...
  //  - npx postject：npx [--yes] postject <exe> NODE_SEA_BLOB <blob> ...
  const postjectArgs = [
    exePath, 'NODE_SEA_BLOB', blobPath,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];

  let cmd;
  let cmdArgs;
  if (postjectBin === 'npx') {
    cmd = isWindows ? 'npx.cmd' : 'npx';
    cmdArgs = ['--yes', 'postject', ...postjectArgs];
  } else {
    cmd = process.execPath;
    cmdArgs = [postjectBin, ...postjectArgs];
  }

  execFileSync(cmd, cmdArgs, { stdio: ['ignore', 'ignore', 'inherit'], cwd: ROOT });

  const exeStat = await fsp.stat(exePath);
  log(`\x1b[32m${OUT_NAME}: ${(exeStat.size / 1024 / 1024).toFixed(1)} MB\x1b[0m`);

  // 顺手在项目根目录放一份，方便用户直接双击（dist/ 里的是同一份文件）
  const rootExe = path.join(ROOT, OUT_NAME);
  await fsp.copyFile(exePath, rootExe);

  // ── 5. 冒烟验证 ──
  step(5, total, '验证 exe 可独立运行');
  const PORT = 17999;
  log('启动 exe 并探测端口…');

  // 故意在一个空目录里启动，验证 exe 不依赖源码树
  const probeDir = path.join(DIST, '_probe');
  await fsp.mkdir(probeDir, { recursive: true });

  const child = require('node:child_process').spawn(exePath, ['--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: probeDir,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const deadline = Date.now() + 15000;
  let ok = false;
  let probe = null;
  let assetChecks = [];
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/system`);
      if (res.ok) {
        probe = await res.json();
        ok = true;
        // 服务还活着的时候就把静态资源也验完，别等关掉了再猜
        const paths = ['/', '/css/style.css', '/js/main.js', '/js/api-panel.js'];
        for (const p of paths) {
          try {
            const r2 = await fetch(`http://127.0.0.1:${PORT}${p}`);
            const t2 = await r2.text();
            assetChecks.push({ path: p, status: r2.status, len: t2.length, sample: t2.slice(0, 80) });
          } catch (e) {
            assetChecks.push({ path: p, status: 0, len: 0, sample: String(e.message) });
          }
        }
        break;
      }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();

  if (!ok) {
    console.error('\n\x1b[31m  ✗ exe 未能启动\x1b[0m');
    console.error(out || '(无输出)');
    process.exit(1);
  }

  log(`\x1b[32m✓ exe 独立启动成功\x1b[0m（Node ${probe.nodeVersion}，网卡 ${probe.interfaces.length} 个）`);

  const badAssets = assetChecks.filter((a) => a.status !== 200 || a.len < 100);
  if (badAssets.length) {
    console.error('\n\x1b[31m  ✗ 内嵌静态资源读取异常\x1b[0m');
    for (const a of badAssets) console.error(`    ${a.path} → HTTP ${a.status} (${a.len} bytes)`);
    process.exit(1);
  }
  log('✓ 内嵌静态资源读取正常');
  for (const a of assetChecks) log(`   ${a.path.padEnd(20)} 200  ${a.len} bytes`);

  // 清理探测目录与中间产物。
  // 清理失败不能算构建失败——产物已经生成并验证过了，
  // 而且部分环境（如只读沙箱/回收站拦截）本就删不掉临时目录。
  try {
    await fsp.rm(probeDir, { recursive: true, force: true });
  } catch (e) {
    log(`（探测目录未清理，可手动删除: ${probeDir}）`);
  }
  if (!keepBundle) {
    try {
      await fsp.rm(STAGE, { recursive: true, force: true });
    } catch (e) {
      log(`（中间目录未清理，可手动删除: ${STAGE}）`);
    }
  } else log(`保留中间产物: ${STAGE}`);

  console.log('\n' + '─'.repeat(56));
  console.log(`\x1b[32m  ✓ 构建完成\x1b[0m`);
  console.log(`  产物 1: ${rootExe}`);
  console.log(`  产物 2: ${exePath}（同上，dist 目录内）`);
  console.log(`  大小  : ${(exeStat.size / 1024 / 1024).toFixed(1)} MB`);
  console.log('');
  console.log('  用法: 双击「网络检查工具.exe」，浏览器自动打开 http://127.0.0.1:7801/');
  console.log('        目标机器无需安装 Node.js，拷过去就能用');
  console.log('  可选: --port 9000 / --host 0.0.0.0');
  console.log('─'.repeat(56) + '\n');
}

main().catch((e) => {
  console.error('\n\x1b[31m构建失败\x1b[0m\n', e);
  process.exit(1);
});