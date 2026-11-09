'use strict';
/**
 * 验证 BrowserAgent.openUrl：在「内置浏览器」里打开原岗位页。
 *
 * 为什么单独测：卡片上的「看原岗位」以前调 shell.openExternal 交给系统浏览器，
 * 系统浏览器里没有该平台登录态，用户点完等于什么都没看到。现在改成用内置窗口
 * （带 persist:src-<平台> 分区 cookie）打开，必须确认：窗口真的可见、在屏幕内、
 * 且加载的是目标 URL。
 *
 * 运行：electron.exe scripts/test_open_url.js
 */
const { app } = require('electron');
const http = require('node:http');
const path = require('node:path');
const { BrowserAgent } = require(path.join(__dirname, '..', 'desktop', 'src', 'browser-agent.js'));

let failed = 0;
function check(name, ok, extra) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed += 1;
}

app.whenReady().then(async () => {
  // 本地假「岗位详情页」
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>假岗位页</title><h1 id="t">${req.url}</h1>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const jobUrl = `${base}/job_detail/abc123.html`;

  const agent = new BrowserAgent(({ level, msg }) => console.log(`  [${level}] ${msg}`));

  // 1) 非法链接应该抛错，而不是静默什么都不做
  let threw = false;
  try {
    await agent.openUrl('boss', 'javascript:alert(1)');
  } catch {
    threw = true;
  }
  check('非法链接被拒绝', threw);

  // 2) 正常打开岗位页
  const r = await agent.openUrl('boss', jobUrl, '测试岗位 · 原岗位');
  check('openUrl 返回 ok', !!(r && r.ok));

  const win = agent.windows.get('boss');
  check('窗口已创建', !!win && !win.isDestroyed());
  if (win) {
    check('窗口可见', win.isVisible());
    const [x, y] = win.getPosition();
    check('窗口在屏幕内', x > -1000 && y > -1000, `位置 ${x},${y}`);
    // 窗口标题会被页面自己的 <title> 覆盖，这里只要求不为空（页名比我们的标签更有信息量）
    check('窗口有标题', String(win.getTitle()).length > 0, win.getTitle());

    // 3) 页面真的加载了目标 URL
    const seen = await win.webContents.executeJavaScript(
      'document.getElementById("t") ? document.getElementById("t").textContent : ""'
    );
    check('页面内容为目标岗位页', String(seen).includes('/job_detail/abc123.html'), seen);
    check('当前 URL 一致', String(win.webContents.getURL()).startsWith(jobUrl), win.webContents.getURL());

    // 4) 再打开另一个 URL 应复用同一个窗口，不叠新窗口
    const before = agent.windows.size;
    await agent.openUrl('boss', `${base}/job_detail/def456.html`);
    check('复用同一窗口', agent.windows.size === before, `窗口数 ${agent.windows.size}`);
    const seen2 = await win.webContents.executeJavaScript(
      'document.getElementById("t") ? document.getElementById("t").textContent : ""'
    );
    check('第二次导航生效', String(seen2).includes('/job_detail/def456.html'), seen2);

    // 5) 不同平台用不同窗口（登录态隔离）
    await agent.openUrl('zhilian', `${base}/job/1`);
    check('不同平台独立窗口', agent.windows.size === before + 1, `窗口数 ${agent.windows.size}`);
  }

  try { agent.closeAll(); } catch { /* 忽略 */ }
  srv.close();
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  app.exit(failed ? 1 : 0);
});
