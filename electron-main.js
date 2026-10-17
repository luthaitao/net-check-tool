'use strict';
/**
 * Electron 桌面外壳
 *
 * 复用现有的 server.js 作为本地服务：Electron 只负责开窗口 + 管生命周期，
 * 业务逻辑一行没改。这样打包成桌面程序和浏览器版行为完全一致。
 *
 * 安全沿用服务端约定：默认只监听 127.0.0.1，且窗口本身不暴露 Node 能力
 * （contextIsolation 开启、nodeIntegration 关闭）。
 */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('node:path');

const PORT = Number(process.env.NETCHECK_PORT) || 7801;
const HOST = '127.0.0.1';

let mainWindow = null;
let httpServer = null;

// 允许命令行指定端口：网络检查工具.exe --port 9000
const argvPort = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : PORT;
})();
const FINAL_PORT = Number.isInteger(argvPort) && argvPort > 0 ? argvPort : PORT;
const FINAL_URL = `http://${HOST}:${FINAL_PORT}/`;

// 单实例：再次双击时聚焦已有窗口，而不是再开一个服务
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/**
 * GPU 容错。
 * 本工具界面是纯表单 + 表格，硬件加速没有实际收益，但缺 GPU 的环境
 *（虚拟机、远程桌面、部分服务器、被策略禁用的显卡驱动）会让 Chromium
 * 的 GPU 进程反复崩溃并触发 FATAL 退出。默认关掉硬件加速更稳。
 * 需要时可加 --gpu 保留硬件加速。
 */
if (!process.argv.includes('--gpu')) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  // 某些环境缺少系统字体目录，不加会渲染出方块字
  app.commandLine.appendSwitch('font-render-hinting', 'none');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#f4f6f9',
    title: '网络检查工具',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      // 安全：渲染进程拿不到 Node API
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(buildMenu());

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // 外部链接用系统浏览器打开，不在应用内导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== FINAL_URL) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadURL(FINAL_URL);

  if (process.env.NETCHECK_DEVTOOLS === '1') mainWindow.webContents.openDevTools();
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '操作',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '在浏览器中打开',
          click: () => shell.openExternal(FINAL_URL),
        },
        {
          label: '关于',
          click: () => dialog.showMessageBox({
            type: 'info',
            title: '关于',
            message: '网络检查工具',
            detail:
              `端口连通性检测 + 类 Postman API 调试台\n\n` +
              `版本 1.0.0\nElectron ${process.versions.electron}\n` +
              `本地服务端口 ${FINAL_PORT}`,
            buttons: ['确定'],
          }),
        },
      ],
    },
  ]);
}

async function startServer() {
  // 复用现有的 server.js，不改动业务代码
  const { server, start } = require('./server.js');
  httpServer = server;
  await start({ port: FINAL_PORT, host: HOST, open: false, silent: true });
  return httpServer;
}

// 端口冲突等启动失败：弹窗说明，别静默失败
function handlePortInUse(err) {
  const isBusy = err && err.code === 'EADDRINUSE';
  dialog.showErrorBox(
    isBusy ? '端口已被占用' : '启动失败',
    isBusy
      ? `端口 ${FINAL_PORT} 已被其他程序占用。\n\n请关闭占用程序，或用命令行指定其他端口：\n  网络检查工具.exe --port 9000`
      : `无法启动本地服务：\n${err ? err.message : '未知错误'}`
  );
  app.quit();
}

if (gotLock) {
  app.whenReady().then(async () => {
    try {
      // 服务起来后再开窗口，避免白屏；端口冲突由 start 的 onError 兜住
      await startServer();
    } catch (e) {
      handlePortInUse(e);
      return;
    }

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (httpServer) {
      try { httpServer.close(); } catch { /* 忽略关闭异常 */ }
    }
  });
}