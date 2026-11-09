// 真实 BOSS 抓取诊断：复用安装版 userData 的登录态，跑当前选择器
const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 复用真实 userData 才有登录态
app.setPath('userData', 'C:/Users/PC/AppData/Roaming/JobMatch Agent');
app.setPath('sessionData', 'C:/Users/PC/AppData/Roaming/JobMatch Agent');

const CARD_SEL = ['div.job-card-wrapper', 'li.job-card-wrapper', 'div.job-card', 'ul.job-list-box li'];
const KW = process.argv[2] || '前端开发';
const CITY = process.argv[3] || '101280100';
const URL = `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(KW)}&city=${CITY}`;

app.whenReady().then(async () => {
  const sess = session.fromPartition('persist:src-boss');
  sess.setUserAgent(UA);

  const win = new BrowserWindow({
    width: 1280, height: 900,
    show: true,
    x: -32000, y: -32000,
    skipTaskbar: true,
    webPreferences: { session: sess, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.setUserAgent(UA);

  console.log('打开:', URL);
  try {
    await win.loadURL(URL);
  } catch (e) {
    console.log('加载异常:', e.message);
  }
  await sleep(4000);

  const info = await win.webContents.executeJavaScript(`(() => {
    const url = location.href;
    const body = document.body ? document.body.innerText : '';
    const hits = {};
    ${JSON.stringify(CARD_SEL)}.forEach((s) => { hits[s] = document.querySelectorAll(s).length; });
    return { url, title: document.title, textLen: body.length, head: body.slice(0, 400), hits };
  })()`);

  console.log('\n=== 落地页 ===');
  console.log('url:', info.url);
  console.log('title:', info.title);
  console.log('正文长度:', info.textLen);
  console.log('各选择器命中数:', info.hits);
  console.log('\n=== 正文前 400 字 ===');
  console.log(info.head);

  // 尝试抽卡片
  const cards = await win.webContents.executeJavaScript(`(() => {
    const sels = ${JSON.stringify(CARD_SEL)};
    let nodes = [];
    for (const s of sels) {
      const n = [...document.querySelectorAll(s)];
      if (n.length) { nodes = n; break; }
    }
    return nodes.slice(0, 8).map((el) => {
      const q = (list) => { for (const s of list) { const e = el.querySelector(s); if (e && e.innerText.trim()) return e.innerText.trim(); } return ''; };
      const a = el.querySelector('a[href*="/job_detail/"]') || el.querySelector('a');
      return {
        title: q(['span.job-name', '.job-name', 'span.job-title', '.job-title']),
        company: q(['h3.company-name a', 'h3.company-text a', '.company-text', 'h3.name a', '.company-name']),
        salary: q(['span.salary', '.salary', '.job-salary']),
        area: q(['span.job-area', '.job-area']),
        href: a ? a.getAttribute('href') : '',
        rawLen: el.innerText.length,
      };
    });
  })()`);

  console.log('\n=== 抽到的卡片（前 8 张）===');
  cards.forEach((c, i) => console.log(`${i + 1}.`, JSON.stringify(c, null, 0)));

  // 抓一条详情
  if (cards.length && cards[0].href) {
    const u = new URL(cards[0].href, 'https://www.zhipin.com').href;
    console.log('\n=== 打开详情 ===', u);
    const dw = new BrowserWindow({ show: false, webPreferences: { session: sess, sandbox: true, contextIsolation: true } });
    dw.webContents.setUserAgent(UA);
    try {
      await dw.webContents.loadURL(u);
      await sleep(2500);
      const d = await dw.webContents.executeJavaScript(`(() => {
        const pick = (list) => { for (const s of list) { const e = document.querySelector(s); if (e && e.innerText.trim()) return e.innerText.trim(); } return ''; };
        return {
          url: location.href,
          title: pick(['.job-banner .name h1', '.job-name', 'h1']),
          jd: pick(['.job-sec-text', '.job-detail-section .text', '.job-detail']),
          jdLen: (pick(['.job-sec-text', '.job-detail-section .text', '.job-detail']) || '').length,
          bodyLen: document.body.innerText.length,
          keys: [...document.querySelectorAll('.job-keyword-list li, .tag-list li')].map(e => e.innerText.trim()).slice(0, 15),
        };
      })()`);
      console.log(JSON.stringify(d, null, 2).slice(0, 2000));
    } catch (e) {
      console.log('详情加载失败:', e.message);
    }
    dw.destroy();
  }

  console.log('\n完成，5 秒后退出');
  await sleep(5000);
  app.exit(0);
});
