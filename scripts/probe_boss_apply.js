'use strict';
/**
 * 只读探测：「立即沟通」按钮长什么样。
 *
 * 投递是不可逆动作（真给 HR 发消息），所以先把岗位详情页的按钮结构摸清楚，
 * 不点击任何东西。复用安装版的 userData，才有该平台的登录态。
 *
 * 运行：electron.exe scripts/probe_boss_apply.js
 */
const { app } = require('electron');
const path = require('node:path');
const { BrowserAgent } = require(path.join(__dirname, '..', 'desktop', 'src', 'browser-agent.js'));

const USER_DATA = 'C:/Users/PC/AppData/Roaming/JobMatch Agent';
const JOB_URL = process.env.PROBE_URL
  || 'https://www.zhipin.com/job_detail/a6b2494454a5fe580nF-29y9FlRZ.html';

app.setPath('userData', USER_DATA);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const agent = new BrowserAgent(({ level, msg }) => console.log(`  [${level}] ${msg}`));
  const win = agent.ensureWindow('boss', { mode: 'background', title: '探测' });

  try {
    await win.loadURL(JOB_URL);
    // SPA 渲染需要一个像样的等待，太早读 DOM 只能读到骨架
    await sleep(7000);

    const info = await win.webContents.executeJavaScript(`(() => {
      const txt = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
      const cls = (el) => (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '') + '';

      const buttons = Array.from(document.querySelectorAll('button, a.btn, .btn, [class*="btn"], [class*="chat"], [class*="apply"]'))
        .map((el) => ({ tag: el.tagName.toLowerCase(), text: txt(el), cls: cls(el).slice(0, 90), disabled: el.disabled || /disabled/i.test(cls(el)) }))
        .filter((x) => x.text && x.text.length <= 30)
        .slice(0, 60);

      const hit = buttons.filter((b) => /沟通|投递|申请|聊|简历|面试/.test(b.text));
      const plain = Array.from(document.querySelectorAll('a, span, div'))
        .filter((el) => el.children.length === 0 && /立即沟通|继续沟通|投递简历|立即申请/.test(txt(el)))
        .map((el) => ({ tag: el.tagName.toLowerCase(), text: txt(el), cls: cls(el).slice(0, 90), parentCls: cls(el.parentElement).slice(0, 90) }))
        .slice(0, 15);

      return {
        title: document.title,
        url: location.href,
        needLogin: /请先登录|登录后查看|扫码登录/.test(document.body.innerText.slice(0, 3000)),
        hasVerify: /验证|滑动|安全验证|异常/.test(document.body.innerText.slice(0, 2000)),
        jobName: (document.querySelector('.name h1, .job-name, h1') || {}).innerText || '',
        hit,
        plain,
        buttonCount: buttons.length,
      };
    })()`);

    console.log('=== 页面信息 ===');
    console.log('标题:', info.title);
    console.log('地址:', info.url);
    console.log('岗位:', (info.jobName || '').trim().slice(0, 40));
    console.log('需要登录:', info.needLogin, '| 出现验证字样:', info.hasVerify);
    console.log('=== 含沟通/投递字样的按钮 ===');
    info.hit.forEach((b) => console.log(`  <${b.tag}> "${b.text}" cls="${b.cls}" disabled=${b.disabled}`));
    console.log('=== 叶子节点精确命中 ===');
    info.plain.forEach((b) => console.log(`  <${b.tag}> "${b.text}" cls="${b.cls}" | parent="${b.parentCls}"`));
  } catch (e) {
    console.log('探测失败:', e.message);
  } finally {
    agent.closeAll();
    setTimeout(() => app.exit(0), 500);
  }
});
