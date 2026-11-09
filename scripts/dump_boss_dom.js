// dump BOSS 搜索页真实 DOM 结构，找出岗位卡片的实际 class
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

  await win.loadURL(URL).catch((e) => console.log('load err', e.message));
  await sleep(5000);

  const dump = await win.webContents.executeJavaScript(`(() => {
    // 统计所有 class 里带 job 的元素
    const counts = {};
    document.querySelectorAll('*').forEach((el) => {
      const cls = (el.className || '').toString();
      if (!cls || cls.includes(' ')) return;
      if (!/job|card|list/i.test(cls)) return;
      counts[el.tagName.toLowerCase() + '.' + cls] = (counts[el.tagName.toLowerCase() + '.' + cls] || 0) + 1;
    });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25);

    // 找含「前端/工程师」文字且内部有链接的最近容器
    const anchors = Array.from(document.querySelectorAll('a[href*="job_detail"]'));
    const sample = anchors.slice(0, 3).map((a) => {
      const chain = [];
      let el = a;
      for (let i = 0; i < 4 && el; i += 1) {
        chain.push(el.tagName.toLowerCase() + (el.className ? '.' + el.className.toString().trim().replace(/\\s+/g, '.') : ''));
        el = el.parentElement;
      }
      return { href: a.getAttribute('href'), text: (a.innerText || '').replace(/\\s+/g, ' ').slice(0, 40), chain };
    });

    return { top, anchorCount: anchors.length, sample };
  })()`);

  console.log('\n=== class 统计（含 job/card/list 的单词 class）===');
  dump.top.forEach(([k, v]) => console.log(v, k));
  console.log('\n=== job_detail 链接数 ===', dump.anchorCount);
  console.log('\n=== 链接 + 祖先链 ===');
  dump.sample.forEach((s, i) => {
    console.log(`\n${i + 1}. href=${s.href}`);
    console.log('   text:', s.text);
    console.log('   chain:', s.chain.join('  <  '));
  });

  await sleep(2500);
  app.exit(0);
});
