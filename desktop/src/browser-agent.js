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

class BrowserAgent {
  /**
   * @param {(payload: {taskId?: string, level: string, msg: string}) => void} onLog
   */
  constructor(onLog) {
    this.onLog = onLog || (() => {});
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

  /** 在详情页抽取 JD 文本 + 经验/学历要求。 */
  async extractDetail(win, sel) {
    return win.webContents
      .executeJavaScript(
        `(() => {
          const pickText = (sels) => {
            for (const s of sels) {
              const el = document.querySelector(s);
              if (el) { const t = (el.innerText || '').trim(); if (t) return t; }
            }
            return '';
          };
          const bits = Array.from(document.querySelectorAll(${lit(sel.experience)}.concat(${lit(sel.education)}).join(',')))
            .map((e) => (e.innerText || '').trim()).filter(Boolean);
          return { jd: pickText(${lit(sel.jd)}), bits };
        })()`
      )
      .catch(() => ({ jd: '', bits: [] }));
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
          await this.waitForText(detailWin, sel.jd || [], 10000);
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
}

module.exports = { BrowserAgent, CHROME_UA };
