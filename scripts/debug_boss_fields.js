// 诊断：卡片抽取字段 + 详情页真实结构
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const { BrowserAgent } = require('../desktop/src/browser-agent.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', 'C:/Users/PC/AppData/Roaming/JobMatch Agent');
app.setPath('sessionData', 'C:/Users/PC/AppData/Roaming/JobMatch Agent');

const SEL = {
  card: ['li.job-card-box', 'div.job-card-wrap'],
  title: ['a.job-name', 'span.job-name', '.job-name'],
  company: ['span.boss-name', '.boss-name', '.company-text', '.company-name'],
  salary: ['span.job-salary', '.job-salary'],
  area: ['span.company-location', '.company-location', '.job-area'],
  link: ['a.job-name', 'a[href*="/job_detail/"]'],
  jd: ['.job-sec-text', '.job-detail-section .text', '.job-detail'],
};

const URL = 'https://www.zhipin.com/web/geek/jobs?query=%E5%89%8D%E7%AB%AF%E5%BC%80%E5%8F%91&city=101280100';

app.whenReady().then(async () => {
  const agent = new BrowserAgent(() => {});
  const sess = session.fromPartition('persist:src-boss');
  sess.setUserAgent(UA);
  const win = new BrowserWindow({
    width: 1280, height: 900, show: true, x: -32000, y: -32000, skipTaskbar: true,
    webPreferences: { session: sess, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.setUserAgent(UA);
  await win.loadURL(URL).catch(() => {});
  await sleep(4500);

  const cards = await agent.extractCards(win, SEL, '广州');
  console.log('抽取到', cards.length, '张卡片');
  cards.slice(0, 6).forEach((c, i) => {
    const id = agent.makeJobId('boss', c.href);
    console.log(`${i + 1}. id=${id}`);
    console.log(`   title="${c.title}" company="${c.company}" salary="${c.salary}" area="${c.area}"`);
    console.log(`   href="${c.href}"`);
  });

  // 详情页
  const first = cards.find((c) => c.href);
  if (first) {
    const u = 'https://www.zhipin.com' + first.href;
    console.log('\n=== 打开详情:', u);
    const dw = new BrowserWindow({ show: false, webPreferences: { session: sess, sandbox: true, contextIsolation: true } });
    dw.webContents.setUserAgent(UA);
    await dw.webContents.loadURL(u).catch((e) => console.log('load err', e.message));
    await sleep(3500);
    const d = await dw.webContents.executeJavaScript(`(() => {
      const counts = {};
      document.querySelectorAll('*').forEach((el) => {
        const cls = (el.className || '').toString().trim();
        if (!cls || cls.includes(' ')) return;
        if (!/job|text|detail|sec|desc/i.test(cls)) return;
        counts[el.tagName.toLowerCase() + '.' + cls] = (counts[el.tagName.toLowerCase() + '.' + cls] || 0) + 1;
      });
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 18);
      const bodyLen = document.body.innerText.length;
      const sample = document.body.innerText.replace(/\\s+/g, ' ').slice(0, 600);
      return { top, bodyLen, sample, url: location.href };
    })()`);
    console.log('落地 url:', d.url, '正文长度', d.bodyLen);
    console.log('--- class 统计 ---');
    d.top.forEach(([k, v]) => console.log(' ', v, k));
    console.log('--- 正文样本 ---');
    console.log(d.sample);

    const chain = await dw.webContents.executeJavaScript(`(() => {
      const out = [];
      document.querySelectorAll('div, section, span').forEach((el) => {
        const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (!/岗位职责|职位描述|工作职责/.test(t.slice(0, 40))) return;
        if (t.length < 60) return;
        const path = [];
        let x = el;
        for (let i = 0; i < 4 && x; i += 1) {
          path.push(x.tagName.toLowerCase() + (x.className ? '.' + x.className.toString().trim().replace(/\\s+/g, '.') : ''));
          x = x.parentElement;
        }
        out.push({ cls: el.tagName.toLowerCase() + '.' + (el.className || '').toString().trim(), len: t.length, path });
      });
      // 经验/学历所在元素
      const meta = [...document.querySelectorAll('.job-banner .info-primary p, .job-info .text, .text-tip')]
        .slice(0, 6).map((e) => (e.innerText || '').replace(/\\s+/g, ' ').trim());
      return { out: out.slice(0, 5), meta };
    })()`);
    console.log('--- 含「岗位职责」的元素 ---');
    chain.out.forEach((o) => console.log(`  ${o.cls}  (${o.len} 字)  path=${o.path.join(' < ')}`));
    console.log('--- 经验/学历候选 ---', JSON.stringify(chain.meta));
    dw.destroy();
  }

  await sleep(1500);
  app.exit(0);
});
