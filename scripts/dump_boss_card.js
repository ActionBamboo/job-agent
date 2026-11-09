// dump 单张 BOSS 岗位卡片的完整内部结构
const { app, BrowserWindow, session } = require('electron');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', 'C:/Users/PC/AppData/Roaming/JobMatch Agent');
app.setPath('sessionData', 'C:/Users/PC/AppData/Roaming/JobMatch Agent');

const KW = process.argv[2] || '前端开发';
const CITY = process.argv[3] || '101280100';
const URL = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(KW)}&city=${CITY}`;

app.whenReady().then(async () => {
  const sess = session.fromPartition('persist:src-boss');
  sess.setUserAgent(UA);
  const win = new BrowserWindow({
    width: 1280, height: 900, show: true, x: -32000, y: -32000, skipTaskbar: true,
    webPreferences: { session: sess, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.setUserAgent(UA);
  await win.loadURL(URL).catch(() => {});
  await sleep(4500);

  const dump = await win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('li.job-card-box')].slice(0, 3);
    return cards.map((card) => {
      const outline = [...card.querySelectorAll('*')]
        .filter((el) => el.children.length === 0)
        .map((el) => {
          const t = (el.innerText || el.textContent || '').trim();
          const cls = (el.className || '').toString().trim();
          return { tag: el.tagName.toLowerCase(), cls, text: t.slice(0, 40), w: Math.round(el.getBoundingClientRect().width) };
        })
        .filter((o) => o.text || o.cls);
      return {
        innerText: (card.innerText || '').replace(/\\n+/g, ' | ').slice(0, 300),
        outline: outline.slice(0, 24),
      };
    });
  })()`);

  dump.forEach((c, i) => {
    console.log(`\n########## 卡片 ${i + 1} ##########`);
    console.log('innerText:', c.innerText);
    console.log('--- 叶子节点 ---');
    c.outline.forEach((o) => console.log(`  ${o.tag}.${o.cls}  [${o.w}px]  "${o.text}"`));
  });

  await sleep(2000);
  app.exit(0);
});
