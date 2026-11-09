'use strict';
/**
 * 内置浏览器代理：招聘平台的「登录」与「抓取」都在 Electron 自己的 Chromium 里完成。
 *
 * 为什么不再用 Playwright + Edge：
 * 招聘站（尤其 BOSS）的反自动化检测会把 Playwright 控制的页面重定向到 about:blank，
 * 用户看到的现象就是「打开浏览器后页面一直刷新 / 白屏」，既进不了登录页也抓不到列表。
 * 实测对照：同一个未登录状态，Electron 窗口访问搜索页会稳定停在登录页，
 * 而 Playwright 的 Edge 会走 security.html 校验后被清空成 about:blank。
 * 所以登录与抓取都搬到这里，每个平台一个持久化分区，登录一次长期有效。
 */
const { BrowserWindow, session } = require('electron');
const path = require('node:path');

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 判断当前落点是不是风控/登录页，返回给用户看的原因（空串表示正常）。 */
function diagnoseUrl(url, loggedIn) {
  const u = String(url || '');
  if (!u || /^about:blank/i.test(u)) {
    return '页面被站点清空成 about:blank（通常是被判定为自动化环境），请改用本窗口操作';
  }
  if (!loggedIn && /login|passport|signin|\/web\/user\/|account/i.test(u)) {
    return '当前还没登录，请先在窗口里扫码登录';
  }
  if (/security\.html|_security_check|captcha|verify/i.test(u)) {
    return '触发了站点安全验证，请在窗口里手动完成验证后重试';
  }
  return '';
}

/** 把选择器数组塞进页面里用的字符串字面量。 */
const lit = (v) => JSON.stringify(v || []);

// ---------------------------------------------------------------- 一键投递选择器
// 「立即沟通」入口。BOSS 改过好几次 class，所以按新版在前、老版后排，
// 全都没命中时还会退一步按可见文案找（站方改 class 的概率远高于改文案）。
const STARTCHAT_SELECTORS = [
  'a.btn-startchat',
  '.job-banner-con a.btn-startchat',
  '.btn-container a.btn-startchat',
  'button.btn-startchat',
  '.job-op a.btn-startchat',
  'a.op-btn-chat',
  '.op-btn-chat',
  "a[ka*='job-detail-chat']",
];

// 聊天输入框：BOSS 用的是 div[contenteditable]
const CHAT_INPUT_SELECTORS = [
  '#chat-input',
  '.chat-input[contenteditable="true"]',
  'div[contenteditable="true"]',
  'textarea.input-area',
  'textarea',
];

const SEND_SELECTORS = [
  '.send-message',
  'button.btn-send',
  '.chat-op .btn-send',
  '.chat-input-area .btn-send',
];

/** 风控/登录页判定：投递时撞上不能硬闯，否则只会加速封号。 */
const SECURITY_RE = /security\.html|\/web\/passport|\/web\/user\/|captcha|verify/i;
const SECURITY_TEXT_RE = /请稍候|安全验证|滑动验证|请完成验证|拖动滑块|扫码登录/;

// ---------------------------------------------------------------- JD 正文兜底
// 平台配置里那几条选择器（div.job-sec-text 等）站方一改版就整批落空，
// 实测过一次抓 60 条有 30 多条没正文 —— 全是「选择器还在、但正文没抓到」。
// 所以这里按「容器语义 + 整页文本关键词」再兜两层，尽量一次就抓到。
const JD_EXTRA_SELECTORS = [
  '.job-detail-section',
  '.job-sec-text',
  '.job-detail-content',
  '.job-detail',
  '.detail-content',
  '[class*="job-sec"]',
  '[class*="job-detail"]',
  '[class*="job-desc"]',
  '.job-description',
  '.desc',
];

// 正文段的起点/终点：从「岗位职责」起，到「公司介绍 / 工作地址」止。
// 只在选择器全落空时才用，属于最后的兜底，抓到的是整段纯文本。
const JD_START_RE = /(岗位职责|工作职责|职位描述|职位职责|工作内容|岗位描述|职位要求|任职要求|任职资格|工作职责：)/;
const JD_END_RE = /(公司介绍|公司简介|工商信息|工作地址|上班地址|企业信息|竞争力分析|相似职位|举报|投诉)/;

class BrowserAgent {
  /**
   * @param {(payload: {taskId?: string, level: string, msg: string}) => void} onLog
   * @param {(payload: {taskId?: string, job_id?: string, ok?: boolean, note?: string}) => void} onResult
   *        投递的单条结果回调：每投完一条就报一次，前端立刻写库，
   *        这样中途崩了也不会丢掉前面已经投出去的那些。
   */
  constructor(onLog, onResult) {
    this.onLog = onLog || (() => {});
    this.onResult = onResult || (() => {});
    this.windows = new Map(); // source -> BrowserWindow（登录与抓取共用）
    this.tasks = new Map(); // taskId -> { cancelled: boolean }
    this.busy = new Set(); // 正在抓取的 source
  }

  // ---------------------------------------------------------------- 基础
  partitionOf(source) {
    return `persist:src-${String(source || 'default').replace(/[^\w-]/g, '_')}`;
  }

  sessionOf(source) {
    return session.fromPartition(this.partitionOf(source));
  }

  log(taskId, level, msg) {
    try {
      this.onLog({ taskId, level, msg });
    } catch {
      /* 忽略日志转发异常 */
    }
  }

  async cookieNames(source) {
    try {
      const list = await this.sessionOf(source).cookies.get({});
      return new Set(list.map((c) => c.name));
    } catch {
      return new Set();
    }
  }

  async hasLogin(source, hints) {
    const names = await this.cookieNames(source);
    const wanted = (hints || []).filter(Boolean);
    if (!wanted.length) return names.size > 0;
    const list = [...names];
    // 兼容 cookie 名带前后缀的情况（如 __zp_token__ 之于 zp_token）
    return wanted.some((h) => names.has(h) || list.some((n) => n.includes(h)));
  }

  async logout(source) {
    const win = this.windows.get(source);
    if (win && !win.isDestroyed()) win.destroy();
    this.windows.delete(source);
    await this.sessionOf(source).clearStorageData();
    return true;
  }

  /**
   * 取（或建）该平台专用的浏览器窗口。
   *
   * mode:
   *   'visible'    → 正常显示（登录时用，用户要扫码）
   *   'background' → 用户看不到：移出屏幕 + 不进任务栏 + 不抢焦点。
   *                  刻意不用 show:false（隐藏窗口里 document.visibilityState 是 hidden，
   *                  部分站点的懒加载 / 定时请求会被浏览器节流，列表可能一直空着）。
   */
  ensureWindow(source, opts = {}) {
    const o = typeof opts === 'string' ? { title: opts } : opts || {};
    const title = o.title || '招聘平台';
    const mode = o.mode === 'background' ? 'background' : 'visible';

    const existed = this.windows.get(source);
    if (existed && !existed.isDestroyed()) {
      existed.setTitle(title);
      if (mode === 'background') {
        existed.setSkipTaskbar(true);
        existed.setPosition(-32000, -32000);
        if (!existed.isVisible()) existed.showInactive();
      } else {
        existed.setSkipTaskbar(false);
        if (existed.isMinimized()) existed.restore();
        existed.setPosition(120, 80);
        existed.show();
        existed.focus();
      }
      return existed;
    }

    const win = new BrowserWindow({
      width: 1180,
      height: 860,
      minWidth: 720,
      minHeight: 520,
      show: false,
      skipTaskbar: mode === 'background',
      title,
      backgroundColor: '#ffffff',
      autoHideMenuBar: true,
      webPreferences: {
        session: this.sessionOf(source),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        // 后台窗口不能被节流，否则页面自己的定时器 / 懒加载会停掉
        backgroundThrottling: false,
      },
    });
    win.webContents.setUserAgent(CHROME_UA);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) win.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    win.on('closed', () => {
      console.log(`[browser-agent] ${source} 窗口已销毁`);
      if (this.windows.get(source) === win) this.windows.delete(source);
    });
    win.webContents.on('render-process-gone', (_e, d) => {
      console.log(`[browser-agent] ${source} renderer 崩溃: ${JSON.stringify(d)}`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.log(`[browser-agent] ${source} 加载失败 ${code} ${desc} ${String(url).slice(0, 100)}`);
    });

    if (mode === 'background') {
      win.setPosition(-32000, -32000);
      win.showInactive(); // 让页面处于「可见」状态，但不抢焦点、不在任务栏
    } else {
      // 登录窗必须真的弹出来。之前这里漏了 show()，窗口建出来是隐藏的，
      // 用户点「登录」看不到任何东西、也没法扫码 —— 看起来像「点了没反应」。
      win.setPosition(120, 60);
      win.show();
      win.focus();
    }
    this.windows.set(source, win);
    return win;
  }

  /** 抓取中若窗口被用户关掉，视为取消。 */
  isCancelRequested(taskId, source) {
    const t = this.tasks.get(taskId);
    if (t && t.cancelled) return 'cancelled';
    const win = this.windows.get(source);
    if (!win || win.isDestroyed()) return 'closed';
    return '';
  }

  cancel(taskId) {
    const t = this.tasks.get(taskId);
    if (t) t.cancelled = true;
    return Boolean(t);
  }

  closeWindow(source) {
    const win = this.windows.get(source);
    if (win && !win.isDestroyed()) win.close();
    return true;
  }

  /** 退出应用时统一关掉招聘平台窗口，避免残留进程。 */
  closeAll() {
    for (const [, win] of this.windows) {
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {
        /* 忽略 */
      }
    }
    this.windows.clear();
  }

  // ---------------------------------------------------------------- 打开原网页
  /**
   * 用这个平台的内置浏览器打开一个真实页面（岗位详情页）。
   *
   * 为什么不直接 shell.openExternal 交给系统浏览器：招聘站的原岗位页要登录态才
   * 看得到内容，系统浏览器里是未登录状态，打开往往只看到登录墙 / 空白 ——
   * 用户会以为按钮没生效。内置窗口用的是 persist:src-<平台> 分区，扫码登录的
   * cookie 就在里面，打开即是真正的岗位页。
   */
  async openUrl(source, url, title = '岗位详情') {
    const u = String(url || '').trim();
    if (!/^https?:/i.test(u)) throw new Error('链接无效（只支持 http/https）');
    const win = this.ensureWindow(source, { title, mode: 'visible' });
    await win.loadURL(u);
    return { ok: true, reused: true };
  }

  // ---------------------------------------------------------------- 登录
  /**
   * 打开（或复用）浏览器窗口到登录页，等用户在窗口里完成扫码/验证码登录。
   * 轮询判定登录成功的 cookie，成功后窗口保留（紧接着可以直接抓取）。
   */
  async login({ source, name, loginUrl, hints, timeoutMs = 600000, taskId }) {
    const win = this.ensureWindow(source, { title: `登录 ${name || source}`, mode: 'visible' });
    if (taskId) this.tasks.set(taskId, { cancelled: false });

    try {
      return await this._loginLoop({ source, name, loginUrl, hints, timeoutMs, taskId, win });
    } finally {
      if (taskId) this.tasks.delete(taskId);
    }
  }

  async _loginLoop({ source, name, loginUrl, hints, timeoutMs, taskId, win }) {

    if (await this.hasLogin(source, hints)) {
      this.log(taskId, 'ok', `已有 ${name || source} 登录态，无需重复登录`);
      return { ok: true, already: true };
    }

    this.log(taskId, 'info', `已打开内置浏览器，请在窗口里扫码或验证码登录 ${name || source}`);
    try {
      await win.loadURL(loginUrl);
    } catch (e) {
      // 登录页偶尔因重定向失败，但页面通常已经在了，继续等 cookie 即可
      this.log(taskId, 'warn', `登录页加载提示：${String(e.message || e).slice(0, 120)}`);
    }

    // 多数招聘站的登录是一个弹窗，直接进 /web/user/ 只会落到首页，
    // 还得用户自己找「登录」按钮。这里替用户点开。
    await sleep(1500);
    const opened = await this.tryOpenLoginBox(win);
    if (opened && opened.startsWith('找不到')) {
      this.log(taskId, 'warn', opened);
    } else if (opened) {
      this.log(taskId, 'info', `已自动打开登录面板（${opened}），请扫码`);
    }

    const started = Date.now();
    let lastTick = 0;
    while (Date.now() - started < timeoutMs) {
      if (win.isDestroyed()) {
        this.log(taskId, 'warn', '登录窗口被关闭，已取消');
        return { ok: false, reason: 'closed' };
      }
      if (this.isCancelRequested(taskId, source) === 'cancelled') {
        this.log(taskId, 'warn', '登录已取消');
        return { ok: false, reason: 'cancelled' };
      }
      if (await this.hasLogin(source, hints)) {
        const wait = Math.round((Date.now() - started) / 1000);
        this.log(taskId, 'ok', `${name || source} 登录成功（用时 ${wait} 秒），登录态已保存`);
        win.setTitle(`${name || source} · 已登录`);
        // 登录完就把窗口收起来：用户要的是「抓完直接看结果」，不需要一直盯着招聘站页面
        win.hide();
        win.setSkipTaskbar(true);
        this.log(taskId, 'info', '登录窗口已收起，接下来在后台静默抓取');
        return { ok: true };
      }
      const waited = Date.now() - started;
      if (waited - lastTick > 20000) {
        lastTick = waited;
        this.log(taskId, 'info', `仍在等待登录…（已等待 ${Math.round(waited / 1000)} 秒）`);
      }
      await sleep(1500);
    }
    this.log(taskId, 'error', `等待登录超时（${Math.round(timeoutMs / 1000)} 秒），可重新点登录`);
    return { ok: false, reason: 'timeout' };
  }

  /**
   * 在页面里找「登录 / 立即登录」入口并点开登录面板。
   * 各站导航栏结构经常改，这里用「文本 + 位置 + 尺寸」三重条件，比写死 class 稳。
   */
  async tryOpenLoginBox(win) {
    try {
      return await win.webContents.executeJavaScript(`(() => {
        const wanted = ['登录', '登录/注册', '立即登录', '登录注册'];
        // 只找 a / button：点到外层包裹 div 往往没有任何反应
        const nodes = Array.from(document.querySelectorAll('a, button'));
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 10 || r.height < 10) return false;
          const st = getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
        };
        for (const el of nodes) {
          const t = (el.innerText || el.textContent || '').trim();
          if (!wanted.includes(t)) continue;
          if (!visible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.top > 300) continue;            // 只要顶部导航里的登录入口
          el.click();
          return t;
        }
        // 找不到就把顶部候选打出来，方便按站点实际结构修正
        const cands = nodes
          .filter((el) => visible(el) && el.getBoundingClientRect().top < 140)
          .map((el) => (el.innerText || el.textContent || '').trim().slice(0, 12) + '|' + (el.className || '').toString().slice(0, 40))
          .filter((s) => s.length > 1);
        return cands.length ? '找不到登录入口，顶部候选: ' + cands.slice(0, 20).join(' / ') : '';
      })()`);
    } catch {
      return '';
    }
  }


  // ---------------------------------------------------------------- 抓取
  /**
   * 探一下页面在说什么。
   *
   * 起因：BOSS 未登录时不会报错，只会把结果列表清空、页面上留一句
   * 「没有更多职位，尝试登录查看全部职位」+「立即登录」。如果不识别这句话，
   * 表现就是「抓取成功但 0 条」，用户完全看不出是登录问题。
   */
  async probePage(win) {
    try {
      return await win.webContents.executeJavaScript(`(() => {
        const t = document.body ? document.body.innerText : '';
        return {
          needLogin: /立即登录|登录查看全部职位|登录后查看|请先登录/.test(t),
          textLen: t.length,
          sample: t.replace(/\\s+/g, ' ').slice(0, 160),
        };
      })()`);
    } catch {
      return { needLogin: false, textLen: 0, sample: '' };
    }
  }

  /** 等页面出现任意一组选择器，返回命中数量。 */
  async waitForCards(win, selectors, timeoutMs, taskId) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (win.isDestroyed()) return 0;
      const n = await win.webContents
        .executeJavaScript(
          `(() => { for (const s of ${lit(selectors)}) { const n = document.querySelectorAll(s).length; if (n) return n; } return 0; })()`
        )
        .catch(() => 0);
      if (n) return n;
      await sleep(700);
    }
    return 0;
  }

  /** 在页面内抽取岗位卡片。 */
  async extractCards(win, sel, cityName) {
    return win.webContents
      .executeJavaScript(
        `(() => {
          const pickText = (root, sels) => {
            for (const s of sels) {
              const el = root.querySelector(s);
              if (el) { const t = (el.innerText || '').trim().replace(/\\s+/g, ' '); if (t) return t; }
            }
            return '';
          };
          const pickEl = (root, sels) => {
            for (const s of sels) { const el = root.querySelector(s); if (el) return el; }
            return null;
          };
          let cards = [];
          for (const s of ${lit(sel.card)}) {
            const els = Array.from(document.querySelectorAll(s));
            if (els.length) { cards = els; break; }
          }
          return cards.map((el) => {
            const linkEl = pickEl(el, ${lit(sel.link)});
            return {
              title: pickText(el, ${lit(sel.title)}),
              company: pickText(el, ${lit(sel.company)}),
              salary: pickText(el, ${lit(sel.salary)}),
              area: pickText(el, ${lit(sel.area)}),
              href: linkEl ? (linkEl.getAttribute('href') || '') : '',
              city: ${JSON.stringify(cityName || '')},
            };
          }).filter((x) => x.title);
        })()`
      )
      .catch(() => []);
  }

  /** 详情页是单页应用，loadURL 返回时正文往往还没渲染，必须等选择器出内容。 */
  async waitForText(win, selectors, timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (win.isDestroyed()) return false;
      const n = await win.webContents
        .executeJavaScript(
          `(() => {
            for (const s of ${lit(selectors)}) {
              const el = document.querySelector(s);
              if (el && (el.innerText || '').trim().length >= 30) return 1;
            }
            return 0;
          })()`
        )
        .catch(() => 0);
      if (n) return true;
      await sleep(400);
    }
    return false;
  }

  /**
   * 在详情页抽取 JD 文本 + 经验/学历要求。
   *
   * 三层取法，越往后越粗糙，但总比空着强：
   *   1. 平台配置的选择器（准确）
   *   2. 通用容器选择器 JD_EXTRA_SELECTORS（站方改版后仍大概率命中）
   *   3. 整页文本里从「岗位职责」截到「公司介绍」（兜底）
   * 每层都取「文本最长的那个节点」——同一个 class 在详情页常出现多次，
   * 第一次命中的往往是被折叠的小标题，正文在另一个节点里。
   */
  async extractDetail(win, sel) {
    return win.webContents
      .executeJavaScript(
        `(() => {
          const textOf = (el) => (el && (el.innerText || el.textContent || '').trim()) || '';
          const pickLongest = (sels) => {
            let best = '';
            for (const s of sels) {
              let els = [];
              try { els = document.querySelectorAll(s); } catch { continue; }
              for (const el of els) {
                const t = textOf(el);
                if (t.length > best.length) best = t;
              }
            }
            return best;
          };
          const bits = Array.from(document.querySelectorAll(${lit(sel.experience)}.concat(${lit(sel.education)}).join(',')))
            .map((e) => textOf(e)).filter(Boolean);

          let jd = pickLongest(${lit(sel.jd)});
          let from = jd.length >= 60 ? 'selector' : '';
          if (jd.length < 60) {
            const alt = pickLongest(${lit(JD_EXTRA_SELECTORS)});
            if (alt.length > jd.length) { jd = alt; from = 'extra-selector'; }
          }
          if (jd.length < 60) {
            const body = textOf(document.body);
            const s = body.search(${JD_START_RE});
            if (s >= 0) {
              let tail = body.slice(s);
              const e = tail.slice(40).search(${JD_END_RE});
              if (e > 40) tail = tail.slice(0, e + 40);
              if (tail.trim().length >= 60) { jd = tail; from = 'body-text'; }
            }
          }
          return { jd: jd.slice(0, 12000), bits, from };
        })()`
      )
      .catch(() => ({ jd: '', bits: [], from: '' }));
  }

  makeJobId(source, href) {
    const s = String(href || '');
    // BOSS 的详情路径是 /job_detail/<hash>.html（job 与 detail 之间是下划线），
    // 旧正则 /\/job(?:detail)?[\/_]([^./?]+)/ 会把 "_detail" 里的 detail 当成 id，
    // 结果一页 15 条岗位全被判成同一条、去重后只剩 1 条。这里按真实路径匹配。
    const m = s.match(/\/(?:job_detail|jobdetail|job)\/([^./?#]+)/) || s.match(/[?&](?:jobId|encryptJobId)=([^&#]+)/);
    if (m) return `${source}-${m[1]}`;
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
    return `${source}-${Math.abs(h)}`;
  }

  resolveUrl(href, origin) {
    const h = String(href || '');
    if (!h) return '';
    try {
      return new URL(h, origin || undefined).toString();
    } catch {
      return '';
    }
  }

  fillTemplate(tpl, kw, cityCode, page) {
    return String(tpl || '')
      .replace(/\{kw\}/g, encodeURIComponent(kw))
      .replace(/\{city\}/g, encodeURIComponent(cityCode))
      .replace(/\{page\}/g, String(page));
  }

  /**
   * 后台静默抓取：不弹任何可见窗口（除非还没登录，需要开一次登录窗）。
   *
   * 流程：搜索页收集卡片 → 逐条进详情取 JD → **凑够 N 条有正文的 JD 就收手**。
   * N 就是用户在界面上选的「抓取 JD 条数」，不会再多抓也不按关键词均摊。
   */
  async run({ source, spec, keywords, city, pages, detailLimit, taskId }) {
    if (this.busy.has(source)) {
      throw new Error(`${spec.name || source} 正在抓取中，请等当前任务结束`);
    }
    this.busy.add(source);
    this.tasks.set(taskId, { cancelled: false });

    const sel = spec.selectors || {};
    const hints = spec.cookie_hints || [];
    const cityCodes = spec.city_codes || {};
    const cityName = String(city || '').trim();
    const cityCode = cityCodes[cityName] || cityName;
    const pageCount = Math.max(1, Math.min(Number(pages) || 1, 10));
    const kws = (keywords || []).map((k) => String(k || '').trim()).filter(Boolean);
    // 用户要多少条带 JD 的岗位
    const want = Math.max(1, Math.min(Number(detailLimit) || 20, 60));
    // 卡片候选上限：留一倍余量，因为有些详情页打不开 / JD 抓不全
    const candidateCap = Math.min(Math.max(want * 2, want + 12), 90);
    const MIN_JD = 20; // 少于这个字数视为没抓到正文

    let detailWin = null;
    const results = [];
    const seen = new Set();

    // 相对链接（如 /job/123.html）要按站点自身 origin 解析，不能写死某个域名
    let siteOrigin = '';
    try {
      siteOrigin = new URL(this.fillTemplate(spec.search_url, 'x', 'x', 1)).origin;
    } catch {
      siteOrigin = '';
    }

    try {
      // 没登录就就地拉起登录窗：用户点的是「抓取」，不该再让他去别处点「登录」
      if (!(await this.hasLogin(source, hints))) {
        this.log(taskId, 'info', `需要先登录 ${spec.name || source}，已为你打开登录窗口，扫码后会自动继续抓取`);
        const logged = await this._loginLoop({
          source,
          name: spec.name || source,
          loginUrl: spec.login_url,
          hints,
          timeoutMs: 600000,
          taskId,
          win: this.ensureWindow(source, { title: `登录 ${spec.name || source}`, mode: 'visible' }),
        });
        if (!logged.ok) {
          const why = logged.reason === 'timeout' ? '登录超时' : logged.reason === 'closed' ? '登录窗口被关闭' : '已取消登录';
          throw new Error(`${why}，本次抓取未开始`);
        }
      }

      const win = this.ensureWindow(source, {
        title: `${spec.name || source} · 后台抓取中`,
        mode: 'background',
      });
      this.log(taskId, 'ok', `开始后台抓取 ${spec.name || source}，目标 ${want} 条带 JD 的岗位`);

      outer:
      for (let ki = 0; ki < kws.length; ki += 1) {
        const kw = kws[ki];
        const head = kws.length > 1 ? `[${ki + 1}/${kws.length}] ${kw}` : kw;

        for (let page = 1; page <= pageCount; page += 1) {
          const stop = this.isCancelRequested(taskId, source);
          if (stop) {
            this.log(taskId, 'warn', stop === 'closed' ? '抓取窗口已关闭，任务中止' : '已取消抓取');
            break outer;
          }
          if (results.length >= candidateCap) break outer;

          const url = spec.page_url
            ? this.fillTemplate(spec.page_url, kw, cityCode, page)
            : this.fillTemplate(spec.search_url, kw, cityCode, page);

          this.log(taskId, 'info', `${head} · 第 ${page} 页加载中…`);
          try {
            await win.loadURL(url);
          } catch (e) {
            this.log(taskId, 'warn', `${head} · 页面加载异常：${String(e.message || e).slice(0, 100)}`);
          }

          const current = win.webContents.getURL();
          const logged = await this.hasLogin(source, hints);
          const hint = diagnoseUrl(current, logged);
          if (hint) {
            this.log(taskId, 'error', `${head} · ${hint}`);
            if (/登录|about:blank/.test(hint)) throw new Error(hint);
          }

          const count = await this.waitForCards(win, sel.card || [], 30000, taskId);
          if (!count) {
            // 卡片为空时先分辨原因：站点在要求登录，还是选择器失效
            const probe = await this.probePage(win);
            if (probe.needLogin) {
              this.log(taskId, 'error', `${head} · 站点提示需要登录（登录态已失效），本次抓取作废`);
              throw new Error(`${spec.name || source} 登录态已失效，请点「登录 / 换账号」重新扫码后再抓`);
            }
            this.log(taskId, 'warn', `${head} · 第 ${page} 页没找到岗位卡片（可能选择器失效或触发风控）`);
            if (page > 1) break;
            continue;
          }

          const cards = await this.extractCards(win, sel, cityName);
          let added = 0;
          for (const c of cards) {
            const jobUrl = this.resolveUrl(c.href, siteOrigin);
            const id = this.makeJobId(source, c.href || jobUrl);
            if (seen.has(id)) continue;
            seen.add(id);
            added += 1;
            results.push({
              id,
              title: c.title,
              company: c.company,
              city: c.area || c.city || cityName,
              salary: c.salary,
              experience_req: '',
              education_req: '',
              jd_text: '',
              url: jobUrl,
              source,
            });
          }
          this.log(taskId, 'ok', `${head} · 第 ${page} 页 ${cards.length} 张卡片，新增 ${added} 条（累计 ${results.length} 条待补 JD）`);

          if (!spec.page_url && page < pageCount) {
            const clicked = await this.clickNext(win, sel.next || []);
            if (!clicked) {
              this.log(taskId, 'info', `${head} · 没有更多页了`);
              break;
            }
            await sleep(2200);
          }
        }
      }

      if (!results.length) {
        this.log(taskId, 'warn', '没有抓到任何岗位：可能是选择器变化、未登录或触发风控');
        return { jobs: [], jd_jobs: [], fetched: 0 };
      }

      // ---- 详情 JD：后台窗口逐条补，凑够 want 条就停 ----
      const targets = results.filter((j) => j.url);
      if (!targets.length) {
        this.log(taskId, 'warn', '岗位卡片里没有可用链接，无法抓 JD 详情');
        return { jobs: results, jd_jobs: [], fetched: 0 };
      }

      this.log(taskId, 'info', `开始补 JD 详情，目标 ${want} 条…`);
      detailWin = this.ensureWindow(source, {
        title: `${spec.name || source} · 详情抓取`,
        mode: 'background',
      });

      let got = 0;
      let tried = 0;
      for (let i = 0; i < targets.length; i += 1) {
        if (got >= want) break;
        const stop = this.isCancelRequested(taskId, source);
        if (stop) {
          this.log(taskId, 'warn', '已取消详情抓取');
          break;
        }
        const job = targets[i];
        tried += 1;
        try {
          await detailWin.webContents.loadURL(job.url);
          // 固定 sleep 抓不到正文（SPA 渲染慢），改成等 JD 容器真出文字
          await this.waitForText(detailWin, (sel.jd || []).concat(JD_EXTRA_SELECTORS), 15000);
          const d = await this.extractDetail(detailWin, sel);
          job.jd_text = d.jd || '';
          for (const bit of d.bits || []) {
            if (!job.experience_req && /年|经验不限/.test(bit)) job.experience_req = bit;
            else if (!job.education_req && /本科|大专|硕士|博士|学历不限/.test(bit)) job.education_req = bit;
          }
          if (job.jd_text.trim().length >= MIN_JD) {
            got += 1;
            this.log(taskId, 'ok', `[${got}/${want}] ${job.title} · JD ${job.jd_text.trim().length} 字`);
          } else {
            this.log(taskId, 'warn', `第 ${tried} 条详情没抓到正文（${job.title}），继续下一条`);
          }
        } catch (e) {
          this.log(taskId, 'warn', `第 ${tried} 条详情失败：${String(e.message || e).slice(0, 80)}`);
        }
        // 抓得越快越容易被风控，留一点节流
        await sleep(500 + Math.floor(Math.random() * 500));
      }

      const jdJobs = results.filter((j) => j.jd_text.trim().length >= MIN_JD);
      if (jdJobs.length < want) {
        this.log(taskId, 'warn', `只拿到 ${jdJobs.length} 条完整 JD（目标 ${want}），已抓到的先给你`);
      }
      this.log(taskId, 'ok', `抓取结束：${results.length} 条岗位，其中 ${jdJobs.length} 条有完整 JD`);
      return { jobs: results, jd_jobs: jdJobs, fetched: jdJobs.length };
    } finally {
      if (detailWin && !detailWin.isDestroyed() && detailWin !== this.windows.get(source)) {
        detailWin.destroy();
      }
      this.busy.delete(source);
      this.tasks.delete(taskId);
    }
  }

  /**
   * 补抓 JD 正文。
   *
   * 场景：早先抓取时详情页没渲染出来，库里存了岗位和链接、JD 是空的。
   * 这种岗位写不出「对着要求」的招呼语，删了又可惜 —— 一键投递前先拿它的
   * 原链接重新进一次详情页，把正文补回来。
   *
   * 与抓取的区别：不打列表页、不翻页，只按给定链接逐条取正文，所以很快。
   */
  async fetchJd({ source, spec = {}, items = [], taskId } = {}) {
    const label = spec.name || source || '平台';
    if (this.busy.has(source)) {
      throw new Error(`${label} 正在忙（抓取或投递中），等当前任务结束再补 JD`);
    }
    const id = taskId || `jd-${Date.now()}`;
    const want = (items || []).filter((i) => i && i.url);
    if (!want.length) return { ok: true, jobs: [], got: 0, asked: 0, error: '' };

    this.busy.add(source);
    this.tasks.set(id, { cancelled: false });
    const out = [];
    const sel = spec.selectors || {};

    try {
      if (!(await this.hasLogin(source, spec.cookie_hints || []))) {
        throw new Error(`还没有登录 ${label}，先在「抓取」页扫码登录，再回来补 JD`);
      }
      const win = this.ensureWindow(source, { title: `${label} · 补抓 JD`, mode: 'background' });
      this.log(id, 'info', `${want.length} 条没抓到 JD 正文，先去原岗位页补回来…`);

      for (let i = 0; i < want.length; i += 1) {
        const stop = this.isCancelRequested(id, source);
        if (stop) {
          this.log(id, 'warn', stop === 'closed' ? '窗口被关掉，补 JD 中止' : '已取消补 JD');
          break;
        }
        const it = want[i];
        const title = it.title || it.job_id;
        let ok = false;
        try {
          await win.webContents.loadURL(it.url);
          await sleep(900);
          let st = await this.applyPageState(win);
          if (st.security) {
            for (let k = 0; k < 3; k += 1) {
              await sleep(1500);
              st = await this.applyPageState(win);
              if (!st.security) break;
            }
            if (st.security) {
              this.log(id, 'error', `${title} · 撞到安全验证，补 JD 停下。在窗口里手动过一次再试`);
              out.push({ job_id: it.job_id, jd_text: '', ok: false });
              break;
            }
          }
          if (st.needLogin) {
            this.log(id, 'error', `${label} 登录态失效，补 JD 停下，请重新扫码登录`);
            out.push({ job_id: it.job_id, jd_text: '', ok: false });
            break;
          }
          await this.waitForText(win, (sel.jd || []).concat(JD_EXTRA_SELECTORS), 15000);
          const d = await this.extractDetail(win, sel);
          const jd = String(d.jd || '').trim();
          if (jd.length >= 20) {
            ok = true;
            const exp = (d.bits || []).find((b) => /年|经验不限/.test(b)) || '';
            const edu = (d.bits || []).find((b) => /本科|大专|硕士|博士|学历不限/.test(b)) || '';
            this.log(id, 'ok', `[${i + 1}/${want.length}] ${title} · JD 补到 ${jd.length} 字`);
            out.push({ job_id: it.job_id, jd_text: jd, experience_req: exp, education_req: edu, ok: true });
          } else {
            this.log(id, 'warn', `[${i + 1}/${want.length}] ${title} · 还是没正文，这条跳过`);
            out.push({ job_id: it.job_id, jd_text: '', ok: false });
          }
        } catch (e) {
          this.log(id, 'warn', `[${i + 1}/${want.length}] ${title} · 补 JD 失败：${String(e.message || e).slice(0, 80)}`);
          out.push({ job_id: it.job_id, jd_text: '', ok: false });
        }
        if (!ok) {
          // 失败立刻连着开下一条容易被风控，歇久一点
          await sleep(1500 + Math.floor(Math.random() * 1200));
        } else {
          await sleep(600 + Math.floor(Math.random() * 700));
        }
      }

      const got = out.filter((o) => o.ok).length;
      this.log(id, got ? 'ok' : 'warn', `补 JD 结束：${got}/${want.length} 条拿到正文`);
      return { ok: true, jobs: out, got, asked: want.length };
    } finally {
      this.busy.delete(source);
      this.tasks.delete(id);
    }
  }

  async clickNext(win, selectors) {
    return win.webContents
      .executeJavaScript(
        `(() => {
          for (const s of ${lit(selectors)}) {
            const els = Array.from(document.querySelectorAll(s));
            for (const el of els) {
              const cls = (el.className || '') + '';
              if (/disabled/i.test(cls) || el.getAttribute('aria-disabled') === 'true') continue;
              el.click();
              return true;
            }
          }
          return false;
        })()`
      )
      .catch(() => false);
  }

  // ---------------------------------------------------------------- 一键投递
  /**
   * 看一眼当前页面是什么状态。
   *
   * 投递比抓取更怕风控：抓取失败只是没数据，投递失败可能被限制打招呼甚至封号。
   * 所以每步都先确认页面状态，撞上验证页就停，不硬点。
   */
  async applyPageState(win) {
    try {
      return await win.webContents.executeJavaScript(`(() => {
        const url = location.href || '';
        const t = document.body ? document.body.innerText : '';
        return {
          url,
          security: ${SECURITY_RE.toString()}.test(url) || ${SECURITY_TEXT_RE.toString()}.test(t),
          needLogin: /立即登录|请先登录|登录后查看|扫码登录/.test(t),
          textLen: t.length,
          sample: t.replace(/\\s+/g, ' ').slice(0, 120),
        };
      })()`);
    } catch {
      return { url: '', security: false, needLogin: false, textLen: 0, sample: '' };
    }
  }

  /** 点「立即沟通 / 继续沟通」。找不到时把页面上像按钮的候选吐出来，方便校准。 */
  async clickStartChat(win) {
    return win.webContents
      .executeJavaScript(
        `(() => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 20 || r.height < 14) return false;
            const st = getComputedStyle(el);
            return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
          };
          for (const s of ${lit(STARTCHAT_SELECTORS)}) {
            for (const el of document.querySelectorAll(s)) {
              if (!visible(el)) continue;
              const txt = (el.innerText || el.textContent || '').trim();
              el.click();
              return { ok: true, by: 'selector', sel: s, text: txt.slice(0, 12) };
            }
          }
          // 文本兜底：只认真实按钮，避免点到外层容器没反应
          const nodes = Array.from(document.querySelectorAll('a, button, span, div'));
          for (const el of nodes) {
            const t = (el.innerText || '').trim();
            if (t !== '立即沟通' && t !== '继续沟通') continue;
            if (!visible(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 400 || r.height > 90) continue;
            el.click();
            return { ok: true, by: 'text', text: t };
          }
          const cand = nodes
            .filter((el) => visible(el) && /沟通|聊一聊|投递|申请|打招呼/.test((el.innerText || '').slice(0, 8)))
            .slice(0, 8)
            .map((el) => ((el.innerText || '').trim().slice(0, 10)) + '|' + String(el.className || '').slice(0, 36));
          return { ok: false, cand };
        })()`
      )
      .catch((e) => ({ ok: false, error: String(e.message || e) }));
  }

  /** 找聊天输入框并聚焦，顺便把光标移到末尾。 */
  async focusChatInput(win) {
    return win.webContents
      .executeJavaScript(
        `(() => {
          for (const s of ${lit(CHAT_INPUT_SELECTORS)}) {
            for (const el of document.querySelectorAll(s)) {
              const r = el.getBoundingClientRect();
              if (r.width < 60 || r.height < 12) continue;
              if (el.disabled || el.readOnly) continue;
              try { el.focus(); } catch {}
              try { el.click(); } catch {}
              try {
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(el);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
              } catch {}
              return { ok: true, sel: s, tag: el.tagName.toLowerCase() };
            }
          }
          return { ok: false };
        })()`
      )
      .catch((e) => ({ ok: false, error: String(e.message || e) }));
  }

  /** 输入框里还剩多少字（用来判断是不是压根没发出去）。 */
  async chatDraftLeft(win) {
    return win.webContents
      .executeJavaScript(
        `(() => {
          for (const s of ${lit(CHAT_INPUT_SELECTORS)}) {
            for (const el of document.querySelectorAll(s)) {
              const r = el.getBoundingClientRect();
              if (r.width < 60 || r.height < 12) continue;
              const v = el.isContentEditable ? (el.innerText || '') : (el.value || '');
              return v.trim();
            }
          }
          return '';
        })()`
      )
      .catch(() => '');
  }

  /** 点发送。找不到按钮就返回 false，由调用方退化成回车。 */
  async clickSend(win) {
    return win.webContents
      .executeJavaScript(
        `(() => {
          const area = (el) => {
            const r = el.getBoundingClientRect();
            return r.width >= 12 && r.height >= 12 && r.width <= 260;
          };
          for (const s of ${lit(SEND_SELECTORS)}) {
            for (const el of document.querySelectorAll(s)) {
              if (!area(el)) continue;
              el.click();
              return { ok: true, by: 'selector', sel: s };
            }
          }
          for (const el of document.querySelectorAll('button, span, div, a')) {
            const t = (el.innerText || '').trim();
            if (t !== '发送') continue;
            if (!area(el)) continue;
            el.click();
            return { ok: true, by: 'text' };
          }
          return { ok: false };
        })()`
      )
      .catch(() => ({ ok: false }));
  }

  /** 消息是否已经出现在页面上（发出去的最硬证据）。 */
  async pageHasText(win, probe) {
    try {
      return await win.webContents.executeJavaScript(
        `(() => (document.body ? document.body.innerText : '').includes(${JSON.stringify(probe)}))()`
      );
    } catch {
      return false;
    }
  }

  /** 按「人打字的节奏」把话送进输入框：分小段插入，段间有停顿。 */
  async typeLikeHuman(win, message) {
    const chars = Array.from(String(message || ''));
    let i = 0;
    while (i < chars.length) {
      const step = 2 + Math.floor(Math.random() * 4);
      const chunk = chars.slice(i, i + step).join('');
      i += step;
      try {
        win.webContents.insertText(chunk);
      } catch {
        return false;
      }
      await sleep(45 + Math.floor(Math.random() * 90));
    }
    return true;
  }

  /**
   * 投一条：打开岗位 → 像人一样看两下 → 点立即沟通 → 填招呼语 → 发送 → 核对。
   *
   * 任何一步不符合预期都返回失败原因，不往前硬走。
   */
  async applyOne(win, task, taskId, name) {
    const title = task.title || task.job_id || '';
    const url = String(task.url || '').trim();
    const message = String(task.message || '').trim();

    if (!url) return { ok: false, note: '没有原岗位链接，投不了' };
    if (!message) return { ok: false, note: '招呼语是空的' };

    try {
      await win.loadURL(url);
    } catch (e) {
      return { ok: false, note: `岗位页打不开：${String(e.message || e).slice(0, 80)}` };
    }
    await sleep(1200);

    // 撞验证页：给它几秒自动过，过不了就交回给人
    let st = await this.applyPageState(win);
    if (st.security) {
      this.log(taskId, 'warn', `${title} · 撞到安全验证，等它自动通过…`);
      for (let i = 0; i < 8; i += 1) {
        await sleep(1500);
        st = await this.applyPageState(win);
        if (!st.security) break;
      }
      if (st.security) {
        return {
          ok: false,
          manual: true,
          note: '卡在安全验证页，需要你在窗口里手动过一次验证。整批已暂停',
        };
      }
    }
    if (st.needLogin) {
      return { ok: false, manual: true, note: '页面要求登录（登录态失效），先重新扫码登录。整批已暂停' };
    }

    // 像人一样看一会儿 JD：往下滚两下，中间停一停
    for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i += 1) {
      try {
        await win.webContents.executeJavaScript(
          `(() => { window.scrollBy(0, ${240 + Math.floor(Math.random() * 380)}); return 1; })()`
        );
      } catch {
        /* 忽略 */
      }
      await sleep(700 + Math.floor(Math.random() * 1100));
    }

    const clicked = await this.clickStartChat(win);
    if (!clicked || !clicked.ok) {
      const hint = clicked && clicked.cand && clicked.cand.length
        ? `页面上像按钮的有：${clicked.cand.join(' / ')}`
        : '页面上没有「立即沟通」按钮（岗位可能已下线，或页面结构变了）';
      return { ok: false, note: hint };
    }
    this.log(taskId, 'info', `${title} · 点了「${clicked.text || '立即沟通'}」，等聊天框`);

    // 点击后可能同页跳转，也可能开新窗口（已被 setWindowOpenHandler 接管成同窗口）
    let box = null;
    for (let i = 0; i < 20; i += 1) {
      await sleep(700);
      const s2 = await this.applyPageState(win);
      if (s2.security) return { ok: false, manual: true, note: '点沟通后跳到验证页，需要手动过一次' };
      box = await this.focusChatInput(win);
      if (box && box.ok) break;
    }
    if (!box || !box.ok) {
      return { ok: false, note: '进了聊天页但没找到输入框（选择器需要校准）' };
    }

    await sleep(500 + Math.floor(Math.random() * 900));
    const typed = await this.typeLikeHuman(win, message);
    if (!typed) return { ok: false, note: '文字没能输进输入框' };
    await sleep(400 + Math.floor(Math.random() * 700));

    const sent = await this.clickSend(win);
    if (!sent || !sent.ok) {
      // 大多数聊天框回车即发送，作为兜底
      try {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      } catch {
        return { ok: false, note: '没找到发送按钮，回车也没送进去' };
      }
    }

    // 核对：发出去的这段话应该出现在页面上
    await sleep(1800);
    const probe = message.slice(0, 12).replace(/\s+/g, ' ');
    const seen = await this.pageHasText(win, probe);
    if (seen) {
      const left = await this.chatDraftLeft(win);
      if (left && left.includes(message.slice(0, 6))) {
        return { ok: false, note: '文字还在输入框里，可能没点中发送' };
      }
      return { ok: true, note: `已发送（${message.length} 字）` };
    }

    const left = await this.chatDraftLeft(win);
    if (left && left.includes(message.slice(0, 6))) {
      return { ok: false, note: '文字留在输入框里，没发出去（发送按钮可能变了）' };
    }
    return { ok: false, note: '点了发送但页面没出现这段消息，去聊天页核对一下' };
  }

  /**
   * 批量投递。
   *
   * 节奏按真人来：一条投完等 interval 秒再动下一条。用户看得到的是「进度 + 每条的成败」，
   * 看不到的是中间那些随机停顿 —— 固定节奏本身就是机器特征。
   */
  async apply({ source, spec = {}, tasks = [], interval = 30, taskId, name }) {
    if (this.busy.has(source)) {
      throw new Error(`${spec.name || source} 正在忙（抓取或投递中），等当前任务结束再投`);
    }
    this.busy.add(source);
    this.tasks.set(taskId, { cancelled: false });

    const hints = spec.cookie_hints || [];
    const label = spec.name || name || source;
    const gaps = Math.max(5, Math.min(Number(interval) || 30, 600));
    const results = [];
    const report = (r) => {
      results.push(r);
      try {
        this.onResult({ taskId, ...r });
      } catch {
        /* 忽略回调异常，别因为写库失败中断投递 */
      }
    };

    try {
      if (!(await this.hasLogin(source, hints))) {
        throw new Error(`还没有登录 ${label}，先在「抓取」页点一次「登录」扫码`);
      }

      const win = this.ensureWindow(source, { title: `${label} · 一键投递中`, mode: 'background' });
      this.log(taskId, 'ok', `开始投递 ${tasks.length} 条，每条间隔 ${gaps} 秒。窗口在后台，别关它`);

      for (let i = 0; i < tasks.length; i += 1) {
        const stop = this.isCancelRequested(taskId, source);
        if (stop) {
          this.log(taskId, 'warn', stop === 'closed' ? '投递窗口被关掉，任务中止' : '已取消投递');
          break;
        }

        const t = tasks[i];
        const title = t.title || t.job_id;
        this.log(taskId, 'info', `[${i + 1}/${tasks.length}] ${title} · ${t.company || ''}`);

        const out = await this.applyOne(win, t, taskId, label);
        if (out.ok) {
          this.log(taskId, 'ok', `[${i + 1}/${tasks.length}] ${title} · ${out.note}`);
          report({ job_id: t.job_id, title, ok: true, note: out.note, message: t.message });
        } else {
          this.log(taskId, 'error', `[${i + 1}/${tasks.length}] ${title} · ${out.note}`);
          report({ job_id: t.job_id, title, ok: false, note: out.note, message: t.message });
          if (out.manual) {
            // 把窗口挪到眼前让用户处理，然后整批停下 —— 硬闯只会加速封号
            try {
              win.setSkipTaskbar(false);
              win.setPosition(120, 60);
              win.show();
              win.focus();
            } catch {
              /* 忽略 */
            }
            this.log(taskId, 'warn', '需要你手动处理，窗口已经调出来了。处理完可以再点一次一键投递');
            break;
          }
        }

        if (i < tasks.length - 1) {
          this.log(taskId, 'info', `等 ${gaps} 秒再投下一条`);
          for (let w = 0; w < gaps; w += 1) {
            if (this.isCancelRequested(taskId, source)) break;
            await sleep(1000);
          }
        }
      }

      const okN = results.filter((r) => r.ok).length;
      this.log(taskId, okN ? 'ok' : 'warn', `投递结束：成功 ${okN} 条，失败 ${results.length - okN} 条`);
      return { results, sent: okN, failed: results.length - okN };
    } catch (e) {
      this.log(taskId, 'error', String(e.message || e));
      return { results, sent: results.filter((r) => r.ok).length, failed: results.length, error: String(e.message || e) };
    } finally {
      this.busy.delete(source);
      this.tasks.delete(taskId);
    }
  }
}

module.exports = { BrowserAgent, CHROME_UA };
