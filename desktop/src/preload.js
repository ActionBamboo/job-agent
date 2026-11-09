'use strict';
/** 预加载：向渲染进程暴露安全的桌面能力，不开放 Node。 */
const { contextBridge, ipcRenderer } = require('electron');

function argValue(prefix, fallback = '') {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

contextBridge.exposeInMainWorld('desktop', {
  apiBase: argValue('--api-base=', ''),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  openPath: (p) => ipcRenderer.invoke('app:open-path', p),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  retryBoot: () => ipcRenderer.invoke('app:retry-boot'),
  quit: () => ipcRenderer.invoke('app:quit'),
  getBootState: () => ipcRenderer.invoke('app:boot-state'),
  onBootStatus: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on('boot:status', handler);
    return () => ipcRenderer.removeListener('boot:status', handler);
  },
  onBackendLog: (cb) => {
    const handler = (_e, line) => cb(line);
    ipcRenderer.on('backend:log', handler);
    return () => ipcRenderer.removeListener('backend:log', handler);
  },

  /** 内置浏览器：招聘平台的登录与抓取都在 Electron 自己的 Chromium 里完成。 */
  scrape: {
    checkLogin: (source, hints) => ipcRenderer.invoke('scrape:check-login', { source, hints }),
    login: (payload) => ipcRenderer.invoke('scrape:login', payload),
    logout: (source) => ipcRenderer.invoke('scrape:logout', { source }),
    run: (payload) => ipcRenderer.invoke('scrape:run', payload),
    cancel: (taskId) => ipcRenderer.invoke('scrape:cancel', { taskId }),
    /** 补抓 JD 正文：给一批有链接但没正文的岗位重新取一次详情 */
    fetchJd: (payload) => ipcRenderer.invoke('scrape:fetch-jd', payload),
    /** 在内置浏览器（带登录态）里打开原岗位页，系统浏览器看不到内容时用它兜底 */
    openUrl: (payload) => ipcRenderer.invoke('scrape:open-url', payload),
    closeWindow: (source) => ipcRenderer.invoke('scrape:close-window', { source }),
    onLog: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('scrape:log', handler);
      return () => ipcRenderer.removeListener('scrape:log', handler);
    },
  },

  /** 一键投递：在内置浏览器里逐条点「立即沟通」把招呼语发出去。 */
  apply: {
    run: (payload) => ipcRenderer.invoke('apply:run', payload),
    cancel: (taskId) => ipcRenderer.invoke('apply:cancel', { taskId }),
    /** 每投完一条回调一次（job_id / ok / note），前端据此立刻写库 */
    onResult: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('apply:result', handler);
      return () => ipcRenderer.removeListener('apply:result', handler);
    },
  },
});
