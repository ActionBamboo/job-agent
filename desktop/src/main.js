'use strict';
/**
 * Electron 主进程：单实例、窗口、托盘、启动引导、后端进程生命周期。
 */
const {
  app, BrowserWindow, Menu, Tray, ipcMain, shell, dialog,
  protocol, net, nativeImage, screen,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { Backend } = require('./backend');
const { BrowserAgent } = require('./browser-agent');

const isPackaged = app.isPackaged;
const DESKTOP_DIR = path.join(__dirname, '..');          // desktop/
const PROJECT_DIR = path.join(DESKTOP_DIR, '..');        // 项目根
const RENDERER_DIR = isPackaged
  ? path.join(process.resourcesPath, 'renderer')
  : path.join(DESKTOP_DIR, 'renderer');

app.setAppUserModelId('cn.jobmatch.agent');

let win = null;
let tray = null;
let backend = null;
let appPort = 0;
let quitting = false;
let bootState = { phase: 'idle', message: '准备启动' };

// ---------------------------------------------------------------- 单实例
// 拿不到锁说明已经有一个实例在跑：立刻 exit，绝不能再往下跑 boot()。
// 以前这里用 app.quit()，但 quit 不会取消已经排进队列的 whenReady 回调，
// 结果是新进程照样拉起一个 Python 后端、建一个窗口，紧接着被退出流程干掉，
// 日志里只留下一条「启动后端」却没有任何后续输出 —— 用户看到的就是双击图标毫无反应。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

// ---------------------------------------------------------------- 工具
function dataDir() {
  return path.join(app.getPath('userData'), 'data');
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForHealth(port, timeoutMs = 45000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let lastErr = '';
    const tick = async () => {
      // 注意：这里不能要求 lastError 非空。后端可能在什么输出都没有的情况下
      // 直接挂掉（解释器起不来、DLL 缺失等），那样 lastError 是空字符串，
      // 以前的条件永远不成立，只能干等到超时才报错。
      if (backend && backend.exited) {
        return reject(new Error(backend.lastError || '本地服务进程已退出，且没有任何输出'));
      }
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2500);
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
        clearTimeout(t);
        if (res.ok) return resolve(true);
      } catch (e) {
        lastErr = e.message;
      }
      const waited = Date.now() - startedAt;
      if (waited > timeoutMs) {
        return reject(new Error(`后端启动超时（${Math.round(timeoutMs / 1000)} 秒）：${lastErr}`));
      }
      sendBoot('starting', `正在启动本地服务…（已等待 ${Math.round(waited / 1000)} 秒）`);
      setTimeout(tick, 400);
    };
    tick();
  });
}

function sendBoot(phase, message) {
  bootState = { phase, message };
  if (win && !win.isDestroyed()) {
    win.webContents.send('boot:status', bootState);
  }
}

let appProtocolReady = false;
function registerAppProtocol() {
  // protocol.handle 同一个 scheme 只能注册一次，重复注册会抛
  // "Already registered"，导致「重启本地服务 / 重试」直接失败。
  if (appProtocolReady) return;
  appProtocolReady = true;
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (!rel || rel === '/') rel = '/index.html';
      const target = path.normalize(path.join(RENDERER_DIR, rel));
      if (!target.startsWith(path.normalize(RENDERER_DIR))) {
        return new Response('forbidden', { status: 403 });
      }
      if (!fs.existsSync(target)) {
        return new Response('not found', { status: 404 });
      }
      return await net.fetch(pathToFileURL(target).toString());
    } catch (e) {
      return new Response('error: ' + e.message, { status: 500 });
    }
  });
}

// ---------------------------------------------------------------- 窗口
function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch {
    /* 首次运行没有状态文件 */
  }
  return { width: 1400, height: 900 };
}

/**
 * 校正窗口坐标：上次可能把窗口放在了已经拔掉的显示器上，
 * 或者分辨率变小了，这时窗口会「存在但看不见」，表现就是双击图标没反应。
 * 只要保存的位置和任何一块屏幕都没有像样的交集，就丢掉坐标让 Electron 居中。
 */
function sanitizeBounds(st) {
  const w = st.width || 1400;
  const h = st.height || 900;
  if (typeof st.x !== 'number' || typeof st.y !== 'number') {
    delete st.x;
    delete st.y;
    return st;
  }
  try {
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      // 标题栏那一条必须露在某块屏幕里，用户才拖得动窗口
      const titleBarVisible =
        st.y >= b.y - 8 && st.y <= b.y + b.height - 40 &&
        st.x + w - 80 > b.x && st.x < b.x + b.width - 80;
      return titleBarVisible;
    });
    if (!visible) {
      delete st.x;
      delete st.y;
    }
  } catch {
    /* 拿不到屏幕信息就交给 Electron 自己居中 */
  }
  return st;
}

/** 确保主窗口真的出现在用户眼前。 */
function revealWindow() {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
  } catch {
    /* 忽略 */
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(windowStateFile(), JSON.stringify(b), 'utf8');
  } catch {
    /* 忽略 */
  }
}

function createWindow() {
  const st = sanitizeBounds(loadWindowState());
  win = new BrowserWindow({
    width: Math.max(1040, st.width),
    height: Math.max(680, st.height),
    x: st.x,
    y: st.y,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#f4f5f9',
    title: 'JobMatch Agent',
    icon: path.join(RENDERER_DIR, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      additionalArguments: [`--api-base=http://127.0.0.1:${appPort}`],
    },
  });

  // 显示兜底：ready-to-show 在个别情况下不会触发（页面加载失败、窗口被系统判定为
  // 不可见等），那样窗口就一直藏在后台，用户以为程序没启动。这里多路保险。
  win.once('ready-to-show', revealWindow);
  win.webContents.on('did-finish-load', () => setTimeout(revealWindow, 60));
  setTimeout(revealWindow, 3000);
  win.on('close', () => saveWindowState());

  // 外部链接一律用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL('app://local/loading.html')
    .catch((e) => sendBoot('error', `引导页加载失败：${e.message}`));
  revealWindow();
}

// ---------------------------------------------------------------- 启动引导
async function boot() {
  if (!appPort) appPort = await findFreePort();
  registerAppProtocol();
  // 重启后端时复用已有窗口，不要每次 boot 都再造一个
  if (!win || win.isDestroyed()) createWindow();
  else revealWindow();

  sendBoot('starting', '正在启动本地服务…');

  const data = dataDir();
  fs.mkdirSync(data, { recursive: true });

  backend = new Backend({
    port: appPort,
    projectDir: PROJECT_DIR,
    dataDir: data,
    isPackaged,
  });

  backend.on('log', (line) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('backend:log', line);
  });
  backend.on('exit', ({ code, error }) => {
    if (quitting) return;
    sendBoot('error', `本地服务意外退出（code=${code}${error ? '，' + error : ''}）`);
  });

  try {
    backend.start();
  } catch (e) {
    sendBoot('error', e.message);
    return;
  }

  try {
    await waitForHealth(appPort);
    sendBoot('ready', '本地服务已就绪');
    await win.loadURL('app://local/index.html');
  } catch (e) {
    sendBoot('error', e.message);
  }
}

// ---------------------------------------------------------------- 菜单 / 托盘
function openLogFile() {
  const p = path.join(dataDir(), 'logs', 'backend.log');
  if (fs.existsSync(p)) shell.openPath(p);
  else dialog.showMessageBox({ message: '还没有生成日志文件', type: 'info' });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开数据目录', click: () => shell.openPath(dataDir()) },
        { label: '打开后端日志', click: openLogFile },
        { type: 'separator' },
        { label: '退出', accelerator: 'Ctrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载界面', accelerator: 'Ctrl+R', click: () => win && win.reload() },
        { label: '开发者工具', accelerator: 'F12', click: () => win && win.webContents.toggleDevTools() },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 JobMatch Agent',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于',
              message: `JobMatch Agent v${app.getVersion()}`,
              detail:
                '简历 × JD 智能匹配桌面应用\n\n' +
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\n` +
                `数据目录：${dataDir()}`,
              buttons: ['好'],
            });
          },
        },
        { label: '重启本地服务', click: () => { if (win) { bootState = { phase: 'idle', message: '' }; bootRestart(); } } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function bootRestart() {
  try {
    backend && backend.stop();
  } catch {
    /* 忽略 */
  }
  backend = null;
  appPort = 0;
  await boot();
}

function createTray() {
  const iconPath = path.join(RENDERER_DIR, 'icon.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip('JobMatch Agent');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => { if (win) { win.show(); win.focus(); } } },
      { label: '打开数据目录', click: () => shell.openPath(dataDir()) },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ])
  );
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('app:open-path', async (_e, p) => {
  if (typeof p !== 'string' || !p) return false;
  const target = fs.existsSync(p) ? p : path.dirname(p);
  await shell.openPath(target);
  return true;
});

ipcMain.handle('app:open-external', async (_e, url) => {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('app:open-logs', () => { openLogFile(); return true; });

ipcMain.handle('app:boot-state', () => bootState);

ipcMain.handle('app:retry-boot', async () => {
  await bootRestart();
  return true;
});

ipcMain.handle('app:quit', () => { quitting = true; app.quit(); return true; });

// ---------------------------------------------------------------- 内置浏览器（登录 / 抓取）
// 招聘站会识别 Playwright 环境并把页面清成 about:blank，所以登录与抓取都放在
// Electron 自己的 Chromium 里跑，每个平台一个持久化分区。
const agent = new BrowserAgent(({ taskId, level, msg }) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('scrape:log', { taskId, level, msg, t: Date.now() });
  }
});

ipcMain.handle('scrape:check-login', async (_e, { source, hints }) => {
  try {
    return await agent.hasLogin(source, hints || []);
  } catch {
    return false;
  }
});

ipcMain.handle('scrape:login', async (_e, payload = {}) => {
  try {
    return await agent.login(payload);
  } catch (e) {
    return { ok: false, reason: 'error', error: String(e.message || e) };
  }
});

ipcMain.handle('scrape:logout', async (_e, { source } = {}) => {
  try {
    await agent.logout(source);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('scrape:run', async (_e, payload = {}) => {
  try {
    const out = await agent.run(payload);
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('scrape:cancel', async (_e, { taskId } = {}) => agent.cancel(taskId));

/** 在内置浏览器里打开原岗位页（带该平台的登录态）。 */
ipcMain.handle('scrape:open-url', async (_e, { source, url, title } = {}) => {
  try {
    await agent.openUrl(source || 'boss', url, title || '岗位详情');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('scrape:close-window', async (_e, { source } = {}) => agent.closeWindow(source));

// ---------------------------------------------------------------- 生命周期
app.whenReady().then(async () => {
  // 双保险：拿不到单实例锁的进程在这里直接结束，不要再起后端、不要建窗口
  if (!gotLock) {
    app.exit(0);
    return;
  }
  buildMenu();
  await boot();
  try { createTray(); } catch { /* 托盘失败不影响主功能 */ }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
    else if (win) win.show();
  });
});

app.on('window-all-closed', () => {
  quitting = true;
  if (backend) backend.stop();
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  try {
    agent.closeAll();
  } catch {
    /* 忽略 */
  }
  if (backend) backend.stop();
});

process.on('exit', () => {
  if (backend) backend.stop();
});
