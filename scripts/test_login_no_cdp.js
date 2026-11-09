'use strict';
/**
 * 不带远程调试端口，模拟真实应用的窗口环境，验证内置浏览器登录窗口能稳定存在。
 * （带 --remote-debugging-port 时 BOSS 的页面会检测到调试连接并自行关窗，
 *   这是测试方式带来的干扰，真实用户不会触发。）
 *
 * 运行：electron.exe scripts/test_login_no_cdp.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { BrowserAgent } = require(path.join(__dirname, '..', 'desktop', 'src', 'browser-agent.js'));

const OUT = path.join(__dirname, '..', 'data', 'tmp');

app.whenReady().then(async () => {
  // 模拟真实应用里的主窗口
  const main = new BrowserWindow({ width: 1200, height: 780, show: true, title: '主窗口（模拟）' });
  await main.loadURL('data:text/html,<h1 style="font-family:sans-serif">主窗口（模拟真实应用）</h1>');

  const agent = new BrowserAgent(({ level, msg }) => console.log(`  [${level}] ${msg}`));
  const loginPromise = agent.login({
    source: 'boss',
    name: 'BOSS直聘',
    loginUrl: 'https://www.zhipin.com/web/user/',
    hints: ['geek_zp_token', 'zp_token', 'bst', 'wt2'],
    timeoutMs: 45000,
    taskId: 'no-cdp-test',
  });

  await new Promise((r) => setTimeout(r, 26000));

  const state = await Promise.race([
    loginPromise.then((r) => `已结束: ${JSON.stringify(r)}`),
    Promise.resolve('仍在等待登录（说明窗口存活正常）'),
  ]);
  console.log(`\n26 秒时状态: ${state}`);
  console.log('当前窗口:', BrowserWindow.getAllWindows().map((w) => w.getTitle()));

  const target = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('BOSS'));
  if (target && !target.isDestroyed()) {
    const img = await target.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'login-window-no-cdp.png'), img.toPNG());
    console.log('登录窗口截图已保存');
  } else {
    console.log('✗ 没有找到登录窗口');
  }

  agent.closeAll();
  app.quit();
});
