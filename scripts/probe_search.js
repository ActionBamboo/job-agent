'use strict';
/**
 * 搜索源探测：哪个引擎能在真实浏览器里正常返回公司相关结果。
 *
 * 背景：直接 curl 必应会被降级成「查字典」（把公司名按单字解释），拿不到有用内容。
 * 这里用内置浏览器（真实 Chromium）分别打开必应 / 360 / 搜狗，抓正文对比。
 *
 * 运行：electron.exe scripts/probe_search.js
 */
const { app } = require('electron');
const path = require('node:path');
const { BrowserAgent } = require(path.join(__dirname, '..', 'desktop', 'src', 'browser-agent.js'));

const QUERY = process.env.Q || '博彦科技 外包';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENGINES = [
  ['必应', `https://cn.bing.com/search?q=${encodeURIComponent(QUERY)}&setlang=zh-CN`],
  ['360', `https://www.so.com/s?q=${encodeURIComponent(QUERY)}`],
  ['搜狗', `https://www.sogou.com/web?query=${encodeURIComponent(QUERY)}`],
];

app.whenReady().then(async () => {
  const agent = new BrowserAgent(() => {});
  const win = agent.ensureWindow('probe-search', { mode: 'background', title: '搜索探测' });
  win.webContents.setUserAgent(UA);

  try {
    for (const [name, url] of ENGINES) {
      try {
        await win.loadURL(url);
        await sleep(3500);
        const out = await win.webContents.executeJavaScript(`(() => {
          const body = (document.body.innerText || '').replace(/\\n{2,}/g, '\\n');
          return {
            title: document.title,
            len: body.length,
            head: body.slice(0, 700),
            hasCompany: /博彦|长亮|艾创/.test(body),
            hasOutsource: /外包|人力|驻场/.test(body),
          };
        })()`);
        console.log(`\n===== ${name} =====`);
        console.log(`标题: ${out.title} | 正文 ${out.len} 字 | 含公司名 ${out.hasCompany} | 含外包字样 ${out.hasOutsource}`);
        console.log(out.head.replace(/\n/g, ' / ').slice(0, 620));
      } catch (e) {
        console.log(`\n===== ${name} ===== 失败: ${e.message}`);
      }
      await sleep(1200);
    }
  } finally {
    agent.closeAll();
    setTimeout(() => app.exit(0), 400);
  }
});
