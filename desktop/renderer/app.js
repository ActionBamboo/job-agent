/* ============================================================
   JobMatch Agent · 桌面端前端（无框架、无构建）
   ============================================================ */

const API = (window.desktop && window.desktop.apiBase) || '';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function scoreColor(score) {
  const s = Number(score) || 0;
  if (s >= 80) return 'var(--green)';
  if (s >= 60) return 'var(--amber)';
  return 'var(--red)';
}

function scoreClass(score) {
  const s = Number(score) || 0;
  return s >= 80 ? 'green' : s >= 60 ? 'amber' : 'red';
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(String(ts).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method };
  if (form) {
    opts.body = form;
  } else if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(API + path, opts);
  } catch (e) {
    throw new Error('无法连接本地服务，请重启应用（' + e.message + '）');
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const detail = data && typeof data === 'object' ? data.detail : data;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail || r.statusText));
  }
  return data;
}

function toast(msg, type = 'info', title = '') {
  const icons = {
    ok: '<path d="M20 6L9 17l-5-5"/>',
    err: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>',
    warn: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  };
  const node = document.createElement('div');
  node.className = 'toast ' + type;
  node.innerHTML = `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[type] || icons.info}</svg>
    <div>${title ? `<b>${esc(title)}</b><br>` : ''}${esc(msg)}</div>`;
  $('#toast-root').appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s ease, transform .2s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateX(12px)';
    setTimeout(() => node.remove(), 220);
  }, type === 'err' ? 5200 : 2800);
}

function copyText(text, okTip = '已复制到剪贴板') {
  const done = () => toast(okTip, 'ok');
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = String(text ?? '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { toast('复制失败，请手动选择文本', 'err'); }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

/* ---------------- 弹窗 ---------------- */

function openDialog({ title, subtitle = '', body = '', footer = '', wide = false, onMount }) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="dialog ${wide ? 'wide' : ''}" role="dialog">
      <div class="dialog-head">
        <div>
          <h3>${esc(title)}</h3>
          ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
        </div>
        <button class="btn ghost icon sm" data-close>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="dialog-body">${body}</div>
      ${footer ? `<div class="dialog-foot">${footer}</div>` : ''}
    </div>`;
  const close = () => overlay.remove();
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  $$('[data-close]', overlay).forEach((b) => b.addEventListener('click', close));
  document.body.appendChild(overlay);
  const dlg = $('.dialog', overlay);
  if (onMount) onMount(dlg, close);
  return { el: dlg, close };
}

function confirmBox(title, message, okText = '确定') {
  return new Promise((resolve) => {
    const { el, close } = openDialog({
      title,
      body: `<p class="small" style="color:var(--text-2);line-height:1.8">${esc(message)}</p>`,
      footer: `<div class="left"></div>
        <button class="btn" data-no>取消</button>
        <button class="btn primary" data-yes>${esc(okText)}</button>`,
    });
    $('[data-no]', el).onclick = () => { close(); resolve(false); };
    $('[data-yes]', el).onclick = () => { close(); resolve(true); };
  });
}

/** 数字输入弹窗。Electron 里没有 window.prompt，只能用自绘的。返回 null 表示取消。 */
function askNumber(title, { label = '', value = '', hint = '', placeholder = '', min = 0, step = 0.5 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const { el, close } = openDialog({
      title,
      body: `
        ${label ? `<label class="small muted" style="display:block;margin-bottom:6px">${esc(label)}</label>` : ''}
        <input class="input" id="num-in" type="number" min="${min}" step="${step}"
               value="${esc(String(value))}" placeholder="${esc(placeholder)}" />
        ${hint ? `<div class="small muted" style="margin-top:8px;line-height:1.7">${esc(hint)}</div>` : ''}`,
      footer: `<div class="left"></div>
        <button class="btn" data-no>取消</button>
        <button class="btn primary" data-ok>保存</button>`,
      onMount: (dlg) => {
        const input = $('#num-in', dlg);
        input.focus();
        input.select();
      },
    });
    const finish = (v) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    const read = () => {
      const raw = String($('#num-in', el).value || '').trim();
      if (!raw) return finish(0);      // 清空 = 取消期望薪资
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) { toast('填个正常数字，比如 15', 'warn'); return; }
      finish(n);
    };
    $('[data-no]', el).onclick = () => finish(null);
    $('[data-ok]', el).onclick = read;
    $('#num-in', el).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') read();
      if (e.key === 'Escape') finish(null);
    });
  });
}

/* ---------------- 岗位详情 / 打开原岗位 ---------------- *//**
 * 打开原岗位页。
 *
 * 优先用内置浏览器：招聘站的原岗位页要登录态才看得到正文，系统浏览器里是未登录
 * 状态，打开常常只有登录墙甚至空白。内置窗口带着该平台 persist 分区里的 cookie，
 * 打开即是真正的岗位页。内置失败再退回系统浏览器，并且无论成败都给提示，
 * 不再出现「点了没反应」。
 */
async function openOriginalUrl(url, opts = {}) {
  const u = String(url || '').trim();
  if (!/^https?:/i.test(u)) {
    toast('这条岗位没抓到原链接，去原网站搜岗位名吧', 'warn');
    return false;
  }
  const source = opts.source || 'boss';
  const title = opts.title ? `${opts.title.slice(0, 24)} · 原岗位` : '岗位详情';

  if (window.desktop?.scrape?.openUrl) {
    const r = await window.desktop.scrape
      .openUrl({ source, url: u, title })
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    if (r && r.ok) return true;
    // 内置窗口失败时不要直接放弃，交给系统浏览器兜底
    console.warn('[open-url] 内置浏览器打开失败：', r && r.error);
  }

  let ok = false;
  if (window.desktop?.openExternal) {
    ok = await window.desktop.openExternal(u).catch(() => false);
  } else {
    ok = !!window.open(u, '_blank');
  }
  if (!ok) toast('打开失败，可复制链接手动打开', 'err');
  return ok;
}

/**
 * 复制到剪贴板。
 *
 * 这个函数原先被定义了两遍，后一遍只有一句「链接已复制」，
 * 结果复制招呼语也弹出「链接已复制」，文案对不上。合并成一份，提示语由调用方给。
 * Electron 里 navigator.clipboard 偶尔不可用，保留 textarea 兜底。
 */
async function copyText(text, okTip = '已复制到剪贴板') {
  const done = () => toast(okTip, 'ok');
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = String(text ?? '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { toast('复制失败，请手动选中复制', 'warn'); }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(String(text ?? ''));
      done();
    } catch {
      fallback();
    }
  } else {
    fallback();
  }
}

/** 取岗位全量信息（含 JD 全文）；接口失败就退回卡片里已有的字段。 */
async function loadJobFull(id, fallback) {
  if (!id) return fallback || null;
  try {
    const j = await api(`/jobs/${encodeURIComponent(id)}`);
    return j || fallback || null;
  } catch {
    return fallback || null;
  }
}

function skillChips(list, cls) {
  return (list || []).map((s) => `<span class="${cls}">${esc(s)}</span>`).join('');
}

// ---------------------------------------------------------------- 公司调研
// 匹配上了还不够，得知道这家公司值不值得投：是不是外包、员工怎么说。
// 数据来自「公司名 + 外包 / 员工评价 / 脉脉」的搜索摘要与相关推荐词，
// 再由大模型汇总——摘要本身就来自脉脉、看准、知乎，不用登录第三方账号。

const CR_ADVICE_CLASS = { 建议投: 'good', 可以投: 'good', 谨慎: 'warn', 别投: 'bad' };

function crAdviceClass(advice) {
  return CR_ADVICE_CLASS[advice] || 'warn';
}

function crVerdictClass(verdict) {
  if (verdict === '是') return 'bad';
  if (verdict === '疑似') return 'warn';
  if (verdict === '不是') return 'good';
  return 'muted';
}

function renderCompanyResearch(host, data) {
  const a = data.analysis || {};
  const out = a.outsourcing || {};
  const verdict = out.verdict || '材料不足';
  const advice = a.advice || '谨慎';
  const cls = crAdviceClass(advice);
  const sources = data.sources || [];
  const okCount = sources.filter((s) => s.ok).length;

  const items = (arr, kind) => (arr && arr.length)
    ? `<ul class="cr-list ${kind}">${arr.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
    : '<div class="small muted" style="padding:6px 0">没查到相关说法</div>';

  const signals = (a.signals || []).map((s) => `<span class="chip amber">${esc(s)}</span>`).join('');
  const related = (data.related || []).map((s) => `<span class="chip">${esc(s)}</span>`).join('');

  host.innerHTML = `
    <div class="cr-top">
      <div class="cr-verdict ${cls}">
        <b>${esc(advice)}</b>
        <span>${esc(a.confidence || '')}置信度</span>
      </div>
      <div class="cr-facts">
        <div class="cr-line">
          <span class="lbl">是不是外包</span>
          <b class="${crVerdictClass(verdict)}">${esc(verdict)}</b>
        </div>
        ${out.reason ? `<div class="cr-sub">依据：${esc(out.reason)}</div>` : ''}
        ${a.advice_reason ? `<div class="cr-reason">${esc(a.advice_reason)}</div>` : ''}
      </div>
    </div>
    ${signals ? `<div class="cr-block"><div class="cr-h">关键信号</div><div class="row wrap" style="gap:6px">${signals}</div></div>` : ''}
    <div class="cr-grid">
      <div class="cr-block"><div class="cr-h good">正面评价</div>${items(a.pros, 'pros')}</div>
      <div class="cr-block"><div class="cr-h bad">负面评价</div>${items(a.cons, 'cons')}</div>
    </div>
    <details class="cr-details">
      <summary>看搜索依据（${okCount}/${sources.length} 个查询成功）</summary>
      ${related ? `<div class="cr-block"><div class="cr-h">相关推荐词</div><div class="row wrap" style="gap:6px">${related}</div></div>` : ''}
      ${(data.materials || []).map((m) => `
        <div class="cr-src">
          <div class="cr-h">${esc(m.query)}${m.ok ? '' : ' <span class="bad">没抓到</span>'}</div>
          <div class="cr-snippet">${esc((m.snippet || m.error || '').slice(0, 800))}</div>
        </div>`).join('')}
    </details>
    ${data.cached ? `<div class="small muted" style="margin-top:10px">来自 ${esc(data.cached_at || '')} 的缓存 · 点「重新查」可刷新</div>` : ''}
  `;
}

/**
 * 公司调研弹窗。
 * @param {string} company 公司名
 * @param {{refresh?:boolean}} opts
 */
async function openCompanyDialog(company, opts = {}) {
  const name = String(company || '').trim();
  if (!name) {
    toast('这条岗位没有公司名，查不了', 'err');
    return;
  }

  const { el } = openDialog({
    title: name,
    subtitle: '第三方评价 · 判断是不是外包',
    wide: true,
    body: '<div data-cr-host></div>',
    footer: `<div class="left"><button class="btn ghost sm" data-cr-refresh>重新查</button></div>
      <button class="btn" data-close>关闭</button>`,
  });

  const host = el.querySelector('[data-cr-host]');
  const refreshBtn = el.querySelector('[data-cr-refresh]');

  async function load(refresh) {
    host.innerHTML = `<div class="cr-loading">
      <b>正在查第三方信息…</b>
      <span class="small muted">公司名 + 外包 / 员工评价 / 脉脉，三个查询，约 5~10 秒</span>
    </div>`;
    refreshBtn.disabled = true;
    try {
      const data = await api('/company/research', { method: 'POST', body: { name, refresh: !!refresh } });
      renderCompanyResearch(host, data);
    } catch (e) {
      host.innerHTML = `<div class="cr-loading">
        <b class="bad">没查到</b>
        <span class="small muted">${esc(e.message || '未知错误')}</span>
        <span class="small muted">可能是网络问题或搜索接口临时被拦，稍后再试</span>
      </div>`;
    } finally {
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.onclick = () => load(true);
  await load(!!opts.refresh);
}


// ---------------------------------------------------------------- 打招呼语
// 看到一条岗位能不能「马上发一句话过去」，决定了他究竟会不会真的去投。
// 三版一起给（逐条对标 / 项目切入 / 极简），外加「我拿什么对上」「还缺什么」。
// 「还缺什么」故意留在明面上，不是泼冷水：那条缺口不提前知道，
// 等 HR 一追问就当场穿帮，比不发更糟。

function grLoading() {
  return `<div class="gr-loading">
    <b>正在对着 JD 写…</b>
    <span class="small muted">先读一遍岗位职责和任职要求，再从简历里挑能对上的事，约 3~8 秒</span>
  </div>`;
}

/**
 * 打招呼语弹窗。
 * @param {string|object} jobInput 岗位 id 或岗位对象
 */
async function openGreetingDialog(jobInput, opts = {}) {
  const job = typeof jobInput === 'string' ? { id: jobInput } : { ...(jobInput || {}) };
  const st = { data: null, idx: 0, edits: {}, extra: '' };

  const { el } = openDialog({
    title: '写打招呼语',
    subtitle: [job.company, job.title].filter(Boolean).map((s) => String(s)).join(' · '),
    wide: true,
    body: '<div data-gr-host></div>',
    footer: `<div class="left" style="gap:6px">
        <button class="btn ghost sm" data-gr-regen>重新生成</button>
        <button class="btn ghost sm" data-gr-orig>去原岗位发</button>
      </div>
      <button class="btn" data-close>关闭</button>`,
  });

  const host = el.querySelector('[data-gr-host]');
  const regenBtn = el.querySelector('[data-gr-regen]');
  const origBtn = el.querySelector('[data-gr-orig]');
  if (!job.url) origBtn.classList.add('hidden');
  origBtn.onclick = () => openOriginalUrl(job.url, { source: job.source, title: job.title });

  const keyOf = (v) => v.style || v.label || 'v';
  const cur = () => (st.data && st.data.variants ? st.data.variants[st.idx] : null);

  function paint() {
    const data = st.data;
    const list = (data && data.variants) || [];
    if (!list.length) {
      host.innerHTML = `<div class="gr-empty">
        <b>没能生成</b>
        <span class="small muted">${esc((data && (data.tip || data.note)) || '再点一次「重新生成」试试')}</span>
      </div>`;
      return;
    }

    const v = list[Math.min(st.idx, list.length - 1)];
    const text = st.edits[keyOf(v)] ?? v.text;

    host.innerHTML = `
      <div class="gr-tabs">
        ${list.map((x, i) => `<button class="gr-tab${i === st.idx ? ' on' : ''}" data-gr-tab="${i}">
          ${esc(x.label)}<i>${(st.edits[keyOf(x)] ?? x.text).length} 字</i>
        </button>`).join('')}
      </div>
      ${v.use ? `<div class="gr-use">${esc(v.use)}</div>` : ''}
      <textarea class="gr-text" data-gr-text spellcheck="false">${esc(text)}</textarea>
      <div class="gr-bar">
        <span class="small muted" data-gr-count>${text.length} 字</span>
        <div style="flex:1"></div>
        <button class="btn sm" data-gr-copy>复制这条</button>
      </div>
      <div class="gr-tweak">
        <input class="input" data-gr-extra value="${esc(st.extra)}"
               placeholder="想怎么改？比如：再口语一点 / 别提我做过前端 / 强调 MCP" />
        <button class="btn sm" data-gr-rewrite>按这个改</button>
      </div>
      ${(data.matched || []).length ? `<details class="gr-more">
        <summary>我拿什么对上（${data.matched.length} 条）</summary>
        <ul class="gr-list good">${data.matched.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
      </details>` : ''}
      ${(data.gaps || []).length ? `<details class="gr-more" open>
        <summary>这几条要求你没有直接经验（${data.gaps.length} 条）</summary>
        <ul class="gr-list warn">${data.gaps.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
      </details>` : ''}
      ${data.tip ? `<div class="gr-tip">${esc(data.tip)}</div>` : ''}
      ${data.cached ? '<div class="small muted" style="margin-top:8px">这是上次生成的结果 · 点「重新生成」可以重写</div>' : ''}`;

    // 切换版本：编辑过的内容存在 edits 里，来回切不丢
    $$('[data-gr-tab]', host).forEach((b) => {
      b.onclick = () => {
        const ta = $('[data-gr-text]', host);
        const c = cur();
        if (ta && c) st.edits[keyOf(c)] = ta.value;
        st.idx = Number(b.dataset.grTab);
        paint();
      };
    });

    const ta = $('[data-gr-text]', host);
    const count = $('[data-gr-count]', host);
    ta.oninput = () => {
      st.edits[keyOf(v)] = ta.value;
      count.textContent = `${ta.value.length} 字`;
      const tabI = host.querySelector(`[data-gr-tab="${st.idx}"] i`);
      if (tabI) tabI.textContent = `${ta.value.length} 字`;
    };
    ta.onfocus = () => ta.select();

    $('[data-gr-copy]', host).onclick = () => copyText(ta.value, '招呼语已复制，去原岗位粘贴发出去');

    const extraIn = $('[data-gr-extra]', host);
    $('[data-gr-rewrite]', host).onclick = () => {
      const val = extraIn.value.trim();
      if (!val) { toast('先写一句想怎么改', 'warn'); extraIn.focus(); return; }
      st.extra = val;
      load(true);
    };
    extraIn.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('[data-gr-rewrite]', host).click(); }
    };
  }

  async function load(refresh) {
    host.innerHTML = grLoading();
    regenBtn.disabled = true;
    try {
      const body = { refresh: !!refresh };
      if (st.extra) body.extra = st.extra;
      if (job.id) body.job_id = job.id;
      else body.job = job;
      st.data = await api('/greeting', { method: 'POST', body });
      st.idx = 0;
      st.edits = {};
      paint();
    } catch (e) {
      st.data = null;
      host.innerHTML = `<div class="gr-empty">
        <b class="bad">没写出来</b>
        <span class="small muted">${esc(e.message || '未知错误')}</span>
      </div>`;
    } finally {
      regenBtn.disabled = false;
    }
  }

  regenBtn.onclick = () => load(true);
  await load(!!opts.refresh);
}


/**
 * 岗位详情弹窗：卡片 / 列表点击都走这里。
 *
 * @param {string|object} input 岗位 id 或岗位对象
 * @param {{score?:number, item?:object, onMatch?:Function}} opts
 *        item 是技能匹配的整条结果，传了就把命中 / 缺失技能一并展示
 */
async function openJobDialog(input, opts = {}) {
  const id = typeof input === 'string' ? input : (input && input.id) || '';
  // 取不到详情接口时用调用方给的岗位对象兜底（比如列表里的摘要数据）
  const fallback = (typeof input === 'object' && input) || (opts.item && opts.item.job) || null;
  const x = opts.item || null;
  const job = (await loadJobFull(id, fallback)) || {};
  const score = typeof opts.score === 'number' ? opts.score : (x && x.score);

  const jd = String(job.jd_text || '').trim();

  // 薪资提示：匹配结果里后端已经算好带过来了；岗位库点进来时只有一条岗位，
  // 就现问后端一句（同一套解析逻辑，不在前端重写一份）
  let sh = x && x.salary_hint;
  const myExp = x && x.expected_k ? x.expected_k
    : Number((state.resume && state.resume.expected_salary) || 0);
  if ((!sh || !sh.text) && myExp > 0 && job.salary) {
    try {
      sh = await api(`/salary/hint?salary=${encodeURIComponent(job.salary)}&expected=${myExp}`);
    } catch { sh = null; }
  }
  const shLevel = sh && sh.text ? sh.level : '';
  const salHintBlock = shLevel === 'low'
    ? `<div class="jd-salhint">${esc(sh.text)}</div>`
    : '';
  const chips = [
    job.city ? `<span class="chip line">${esc(job.city)}</span>` : '',
    job.experience_req ? `<span class="chip line">经验 ${esc(job.experience_req)}</span>` : '',
    job.education_req ? `<span class="chip line">学历 ${esc(job.education_req)}</span>` : '',
    job.source ? `<span class="chip line">来源 ${esc(sourceLabel(job.source))}</span>` : '',
  ].filter(Boolean).join('');

  const scoreBlock = (x || typeof score === 'number')
    ? `<div class="jd-score">
        <div class="jd-score-num" style="color:${typeof score === 'number' ? scoreColor(score) : 'var(--text-3)'}">
          ${typeof score === 'number' ? `${score}%` : '—'}
        </div>
        <div class="jd-score-txt">
          <div class="jd-score-line">
            <span class="lbl">命中</span>${x && x.hit && x.hit.length ? skillChips(x.hit, 'k') : '<span class="small muted">无</span>'}
          </div>
          <div class="jd-score-line">
            <span class="lbl">还缺</span>${x && x.miss && x.miss.length ? skillChips(x.miss, 'm') : '<span class="small muted">无</span>'}
          </div>
          ${x && x.bonus_miss && x.bonus_miss.length
            ? `<div class="jd-score-line"><span class="lbl">加分项(不扣分)</span>${skillChips(x.bonus_miss, 'b')}</div>`
            : ''}
        </div>
      </div>`
    : '';

  const { el, close } = openDialog({
    title: job.title || '岗位详情',
    subtitle: [job.company, job.city, job.salary || '薪资面议'].filter(Boolean).join(' · '),
    wide: true,
    body: `
      <div class="row wrap" style="gap:6px;align-items:center">
        ${chips}
        <div style="flex:1"></div>
        <span class="small muted">JD ${jd.length} 字</span>
      </div>
      ${salHintBlock}
      ${scoreBlock}
      <div class="panel-soft jd-body">${jd ? esc(jd) : '<span class="muted">这条岗位没抓到 JD 正文，点下面的「看原岗位」到原网页看</span>'}</div>
      ${job.url ? `<div class="small muted mono jd-url">${esc(job.url)}</div>` : ''}`,
    footer: `<div class="left row" style="gap:6px">
        <button class="btn ghost sm" id="jd-greet" title="照着这份 JD 和你的简历，写一条直接发给 HR 的话">写打招呼语</button>
        ${job.url ? '<button class="btn ghost sm" id="jd-orig">看原岗位（内置浏览器）</button>' : ''}
        ${job.url ? '<button class="btn ghost sm" id="jd-sys">用系统浏览器打开</button>' : ''}
        ${job.url ? '<button class="btn ghost sm" id="jd-copy">复制链接</button>' : ''}
      </div>
      <button class="btn" data-close>关闭</button>
      <button class="btn primary" id="jd-match">用这条去匹配</button>`,
  });

  if (job.url) {
    const origBtn = $('#jd-orig', el);
    if (origBtn) origBtn.onclick = () => openOriginalUrl(job.url, { source: job.source, title: job.title });
    const sysBtn = $('#jd-sys', el);
    if (sysBtn) sysBtn.onclick = async () => {
      const ok = await (window.desktop?.openExternal
        ? window.desktop.openExternal(job.url).catch(() => false)
        : Promise.resolve(!!window.open(job.url, '_blank')));
      if (!ok) toast('系统浏览器打开失败', 'err');
    };
    const copyBtn = $('#jd-copy', el);
    if (copyBtn) copyBtn.onclick = () => copyText(job.url, '链接已复制');
  }

  const greetBtn = $('#jd-greet', el);
  if (greetBtn) greetBtn.onclick = () => openGreetingDialog(job);

  const matchBtn = $('#jd-match', el);
  if (matchBtn) {
    matchBtn.onclick = () => {
      if (typeof opts.onMatch === 'function') { opts.onMatch(job); close(); return; }
      close();
      state.selected = new Set([job.id]);
      navigate('match');
    };
  }
  return { el, close, job };
}


/* ---------------- 全局状态 ---------------- */

const state = {
  status: null,
  settings: null,
  resume: null,
  jobs: [],
  matches: [],
  jobQuery: '',
  selected: new Set(),
  matchResults: [],
  applications: {},   // job_id -> { status, applied_at }，已投过的不再重复发
  applying: false,
  route: 'dashboard',
};

const SAMPLE_RESUME = `张三 · 前端工程师 / AI 应用落地
广州 · 8 年经验 · 自考本科 · 目标岗位：AI 应用工程师（落地/解决方案方向）

技能
- 前端：HTML / CSS / Sass / JavaScript / TypeScript / Vue / Vue3
- 桌面与工程化：Electron、Vite、Node.js 基础
- AI 应用：大模型 API 接入、Prompt 工程、Agent 编排概念、RAG 基本链路
- 做过：类 Coze 的 AI Agent 平台（简历解析 + JD 匹配 + 多维度打分）

工作经历
某互联网公司 · 前端工程师（2018.07 - 至今）
- 负责多个 B 端管理系统的前端架构与迭代，长期对接产品与后端
- 独立完成招聘数据爬取与匹配工具（Playwright + FastAPI + 大模型）
- 推动团队组件库与工程规范落地，交付效率提升明显

教育背景
某大学 · 计算机应用 · 本科（自考）`;

/* ---------------- 状态栏 ---------------- */

async function refreshStatus() {
  const line = $('#status-line');
  const text = $('#status-text');
  try {
    const s = await api('/status');
    state.status = s;
    if (s.demo_mode) {
      line.className = 'status-line warn';
      text.textContent = '演示模式（未调用真实模型）';
    } else if (!s.has_api_key) {
      line.className = 'status-line err';
      text.textContent = '未配置 API Key';
    } else {
      line.className = 'status-line ok';
      text.textContent = `已连接 · ${s.model}`;
    }
    $('#nav-jobs-count').textContent = s.stats?.jobs ?? 0;
    $('#app-version').textContent = 'v' + s.version;
  } catch (e) {
    line.className = 'status-line err';
    text.textContent = '后端未就绪';
  }
}

/* ---------------- 路由 ---------------- */

const ROUTES = [
  { key: 'dashboard', title: '工作台', subtitle: '简历 × JD 智能匹配，一屏看全' },
  { key: 'resume', title: '我的简历', subtitle: '上传或粘贴简历，解析成结构化数据' },
  { key: 'jobs', title: '岗位库', subtitle: '抓取或手工录入目标岗位 JD' },
  { key: 'match', title: '智能匹配', subtitle: '多维度打分 + 定制打招呼语 + 简历优化建议' },
  { key: 'history', title: '匹配历史', subtitle: '所有历史匹配记录' },
  { key: 'settings', title: '设置', subtitle: '模型、抓取默认值与数据目录' },
];

function navigate(route) {
  if (!ROUTES.find((r) => r.key === route)) route = 'dashboard';
  state.route = route;
  const meta = ROUTES.find((r) => r.key === route);
  $('#view-title').textContent = meta.title;
  $('#view-subtitle').textContent = meta.subtitle;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.route === route));
  $('#topbar-actions').innerHTML = '';
  const view = $('#view');
  view.innerHTML = '<div class="skeleton" style="height:180px"></div>';
  renderers[route](view);
}

/* ---------------- 视图：工作台 ---------------- */

async function viewDashboard(root) {
  root.innerHTML = `
    <div class="grid grid-4" id="dash-stats">
      ${[0, 1, 2, 3].map(() => '<div class="skeleton" style="height:96px"></div>').join('')}
    </div>
    <div class="grid grid-2 mt-16" style="align-items:start">
      <div class="card">
        <div class="card-head"><h3>最近匹配</h3><button class="btn ghost sm" id="go-history">查看全部</button></div>
        <div class="card-pad" id="dash-recent"><div class="skeleton" style="height:120px"></div></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>运行状态</h3></div>
        <div class="card-pad" id="dash-status"><div class="skeleton" style="height:120px"></div></div>
      </div>
    </div>`;

  $('#go-history').onclick = () => navigate('history');

  const [status, matches] = await Promise.all([
    api('/status').catch(() => null),
    api('/matches?limit=5').catch(() => []),
  ]);
  state.status = status;
  state.matches = matches;

  const st = status?.stats || {};
  const srcFoot = Object.entries(st.by_source || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '暂无数据';
  const cards = [
    { label: '岗位总数', value: st.jobs ?? 0, unit: '条', foot: srcFoot },
    { label: '匹配次数', value: st.matches ?? 0, unit: '次', foot: '已持久化到本地数据库' },
    { label: '最高匹配分', value: st.best_score ?? '—', unit: st.best_score != null ? '分' : '', foot: '来自历史最佳记录' },
    { label: '平均匹配分', value: st.avg_score ?? '—', unit: st.avg_score != null ? '分' : '', foot: '分数越高越值得投' },
  ];
  $('#dash-stats').innerHTML = cards.map((c) => `
    <div class="stat">
      <div class="label">${esc(c.label)}</div>
      <div class="value">${esc(c.value)}<small>${esc(c.unit)}</small></div>
      <div class="foot">${esc(c.foot)}</div>
    </div>`).join('');

  const recent = $('#dash-recent');
  if (!matches.length) {
    recent.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>
      <div>还没有匹配记录</div>
      <button class="btn primary sm mt-8" id="dash-start">去匹配</button></div>`;
    $('#dash-start').onclick = () => navigate('match');
  } else {
    const jobTitle = {};
    (state.jobs || []).forEach((j) => { jobTitle[j.id] = j.title; });
    recent.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">` + matches.map((m) => `
      <div class="row between" style="gap:12px">
        <div style="min-width:0">
          <div style="font-size:12.8px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${esc(jobTitle[m.job_id] || m.job_id)}
          </div>
          <div class="small muted">${esc(fmtTime(m.created_at))}</div>
        </div>
        <span class="chip ${scoreClass(m.overall_score)}">${esc(m.overall_score ?? '—')} 分</span>
      </div>`).join('') + '</div>';
  }

  const ds = $('#dash-status');
  const model = status?.model || '—';
  const keyState = status?.has_api_key
    ? `<span class="chip green">已配置</span>`
    : `<span class="chip red">未配置</span>`;
  const demo = status?.demo_mode ? `<span class="chip amber">演示模式</span>` : `<span class="chip green">真实调用</span>`;
  ds.innerHTML = `
    <div class="kv-list">
      <div class="kv-row"><span class="k">模型</span><span class="v">${esc(model)}</span></div>
      <div class="kv-row"><span class="k">API Key</span><span class="v">${keyState}</span></div>
      <div class="kv-row"><span class="k">运行模式</span><span class="v">${demo}</span></div>
      <div class="kv-row"><span class="k">数据目录</span><span class="v mono">${esc(status?.data_dir || '—')}</span></div>
    </div>
    <div class="divider mt-12"></div>
    <div class="row mt-12" style="gap:8px;flex-wrap:wrap">
      <button class="btn sm" id="dash-jobs">管理岗位</button>
      <button class="btn sm" id="dash-settings">检查配置</button>
    </div>`;
  $('#dash-jobs').onclick = () => navigate('jobs');
  $('#dash-settings').onclick = () => navigate('settings');

  if (!status?.has_api_key && !status?.demo_mode) {
    toast('还没有配置 API Key，去「设置」里填一个，或开启演示模式先跑通流程', 'warn', '提示');
  }
}

/* ---------------- 视图：简历 ---------------- */

async function viewResume(root) {
  root.innerHTML = `
    <div class="resume-layout">
      <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
        <div class="card">
          <div class="card-head">
            <h3>简历原文<span class="hint-inline">粘贴文本，或拖入 PDF / DOCX / MD / TXT</span></h3>
            <button class="btn ghost sm" id="load-sample">载入示例</button>
          </div>
          <div class="card-pad">
            <div class="drop-zone" id="drop-zone">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5-5 5 5"/><path d="M12 5v12"/></svg>
              <div>把简历文件拖到这里，或 <b>点击选择文件</b></div>
              <div class="small" style="margin-top:2px">支持 PDF · DOCX · Markdown · TXT，最大 10MB</div>
            </div>
            <input type="file" id="file-input" accept=".pdf,.docx,.md,.txt,.markdown" class="hidden" />
            <textarea class="textarea mt-12" id="resume-text" rows="12" spellcheck="false"
              placeholder="也可以直接粘贴简历文本…"></textarea>
            <div class="row mt-12">
              <button class="btn primary" id="parse-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg>
                解析简历
              </button>
              <span class="small muted" id="resume-hint">解析后会调用大模型抽取结构化信息</span>
            </div>
          </div>
        </div>
      </div>
      <div class="card" style="min-width:0">
        <div class="card-head"><h3>结构化简历</h3><span class="chip" id="resume-state">未解析</span></div>
        <div class="card-pad" id="resume-view">
          <div class="empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2.5h8.5L19 7v14.5H6z"/><path d="M14 2.5V7h5"/></svg>
            <div>左侧粘贴或上传简历后点「解析简历」</div>
          </div>
        </div>
      </div>
    </div>`;

  const fileInput = $('#file-input');
  const dropZone = $('#drop-zone');
  const btn = $('#parse-btn');

  const existing = await api('/resume').catch(() => null);
  if (existing) {
    state.resume = existing;
    renderResume(existing);
  }

  $('#load-sample').onclick = () => {
    $('#resume-text').value = SAMPLE_RESUME;
    toast('已填入示例简历，点「解析简历」试试', 'info');
  };

  dropZone.onclick = () => fileInput.click();
  fileInput.onchange = () => { if (fileInput.files[0]) uploadFile(fileInput.files[0]); };
  ['dragenter', 'dragover'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); dropZone.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); dropZone.classList.remove('drag');
  }));
  dropZone.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) uploadFile(f);
  });

  async function uploadFile(file) {
    if (file.size > 10 * 1024 * 1024) { toast('文件超过 10MB', 'err'); return; }
    const fd = new FormData();
    fd.append('file', file);
    setBtn(btn, true, '解析中…');
    try {
      const r = await api('/resume/upload', { method: 'POST', form: fd });
      state.resume = r;
      renderResume(r);
      toast(`已解析：${file.name}`, 'ok');
    } catch (e) {
      toast(e.message, 'err', '解析失败');
    } finally {
      setBtn(btn, false);
      fileInput.value = '';
    }
  }

  btn.onclick = async () => {
    const text = $('#resume-text').value.trim();
    if (!text) { toast('先粘贴简历文本，或拖入文件', 'warn'); return; }
    setBtn(btn, true, '解析中…');
    try {
      const r = await api('/resume/parse', { method: 'POST', body: { text } });
      state.resume = r;
      renderResume(r);
      toast('简历解析完成', 'ok');
    } catch (e) {
      toast(e.message, 'err', '解析失败');
    } finally {
      setBtn(btn, false);
    }
  };
}

function setBtn(btn, loading, label) {
  if (!btn) return;
  if (loading) {
    btn.dataset.html = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span>${esc(label || '处理中…')}`;
    btn.disabled = true;
  } else {
    if (btn.dataset.html) btn.innerHTML = btn.dataset.html;
    btn.disabled = false;
  }
}

function renderResume(r) {
  const el = $('#resume-view');
  if (!el || !r) return;
  const stateChip = $('#resume-state');
  if (stateChip) { stateChip.className = 'chip green'; stateChip.textContent = '已解析'; }

  const skills = (r.skills || []).map((s) => `<span class="chip line">${esc(s)}</span>`).join('');
  const exp = (r.experience || []).map((x) => `
    <div class="tl-item">
      <div class="tl-h">${esc(x.company || '—')}${x.role ? ` · ${esc(x.role)}` : ''}</div>
      ${x.period ? `<div class="tl-s">${esc(x.period)}</div>` : ''}
      ${(x.achievements || []).length ? `<ul>${x.achievements.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
    </div>`).join('');
  const edu = (r.education || []).map((x) => `
    <div class="tl-item">
      <div class="tl-h">${esc(x.school || '—')}${x.degree ? ` · ${esc(x.degree)}` : ''}</div>
      <div class="tl-s">${esc([x.major, x.period].filter(Boolean).join(' · ') || '')}</div>
    </div>`).join('');

  el.innerHTML = `
    <div class="row" style="gap:12px;align-items:center">
      <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(140deg,#6366f1,#8b5cf6);color:#fff;display:grid;place-items:center;font-weight:600;font-size:16px">
        ${esc((r.name || '?').slice(0, 1))}
      </div>
      <div style="min-width:0">
        <div style="font-size:15px;font-weight:600">${esc(r.name || '未命名')}</div>
        <div class="small muted">${esc(r.title || r.target_role || '未填写头衔')}</div>
      </div>
    </div>
    <div class="divider mt-12"></div>
    <div class="kv-list mt-12">
      <div class="kv-row"><span class="k">工作年限</span><span class="v">${r.years_exp ?? '—'} 年</span></div>
      <div class="kv-row"><span class="k">目标岗位</span><span class="v">${esc(r.target_role || '—')}</span></div>
      <div class="kv-row"><span class="k">期望月薪</span><span class="v">
        ${r.expected_salary ? `${esc(r.expected_salary)}K` : '<span class="muted">未填写</span>'}
        <button class="btn ghost sm" id="edit-exp" style="margin-left:6px" title="低于期望的岗位只做提示，不会被筛掉">${r.expected_salary ? '改' : '填'}</button>
      </span></div>
      <div class="kv-row"><span class="k">自我总结</span><span class="v">${esc(r.summary || '—')}</span></div>
    </div>
    ${skills ? `<div class="section-title mt-16">技能</div><div class="skill-cloud">${skills}</div>` : ''}
    ${exp ? `<div class="section-title mt-16">工作经历</div><div class="timeline">${exp}</div>` : ''}
    ${edu ? `<div class="section-title mt-16">教育背景</div><div class="timeline">${edu}</div>` : ''}
    <div class="row mt-16" style="gap:8px">
      <button class="btn primary sm" id="resume-to-match">用这份简历去匹配</button>
    </div>`;
  $('#resume-to-match').onclick = () => navigate('match');
  const expBtn = $('#edit-exp');
  if (expBtn) {
    expBtn.onclick = async () => {
      const val = await askNumber('期望月薪', {
        label: '期望月薪（单位 K，比如 15）',
        value: r.expected_salary || '',
        hint: '只用来在匹配结果上提示「低于期望」，不会把岗位筛掉。大环境不好，低一点的岗位照样值得聊。',
        placeholder: '15',
      });
      if (val === null) return;
      try {
        const next = { ...r, expected_salary: val };
        await api('/resume', { method: 'POST', body: next });
        state.resume = next;
        toast(val > 0 ? `期望月薪已设为 ${val}K` : '已清空期望月薪');
        renderResume(next);
      } catch (e) { toast(e.message, 'err'); }
    };
  }
}

/* ---------------- 视图：岗位库 ---------------- */

async function viewJobs(root) {
  let sources = [];
  try { sources = await api('/scrape/sources'); } catch { sources = [{ key: 'boss', name: 'BOSS直聘' }]; }

  const curSource = (state.settings && state.settings.match_source) || 'boss';
  const sourceOpts = sources.map((s) =>
    `<option value="${esc(s.key)}" ${s.key === curSource ? 'selected' : ''}>${esc(s.name)}${s.builtin ? ' (内置)' : ''}</option>`
  ).join('');

  root.innerHTML = `
    <div class="toolbar">
      <div class="search-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input class="input" id="job-search" placeholder="搜索岗位 / 公司 / JD 关键词" />
      </div>
      <div class="grow"></div>
      <button class="btn" id="add-job">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        手工新增
      </button>
      <button class="btn" id="add-platform" title="添加招聘平台（智联 / 51job / 拉勾 / 鱼泡）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        添加平台
      </button>
      <select class="select" id="scrape-source" style="max-width:160px">${sourceOpts}</select>
      <button class="btn primary" id="scrape-job">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l7 16 2.5-6.5L20 11z"/></svg>
        抓取
      </button>
    </div>
    <div id="job-list-wrap"><div class="skeleton" style="height:220px"></div></div>`;

  const search = $('#job-search');
  search.value = state.jobQuery;
  let timer = null;
  search.oninput = () => {
    state.jobQuery = search.value;
    clearTimeout(timer);
    timer = setTimeout(loadJobs, 220);
  };
  $('#add-job').onclick = openAddJobDialog;
  $('#add-platform').onclick = openAddPlatformDialog;

  // 岗位库选的平台同步到「智能匹配」，两处保持一致
  function rememberSource(k) {
    state.settings = { ...(state.settings || {}), match_source: k };
    api('/settings', { method: 'POST', body: { match_source: k } })
      .then((s) => { state.settings = s; })
      .catch(() => {});
  }
  $('#scrape-source').addEventListener('change', (e) => rememberSource(e.target.value));

  $('#scrape-job').onclick = () => {
    const sel = $('#scrape-source');
    const source = sel.value;
    const name = sel.options[sel.selectedIndex].text.replace(' (内置)', '');
    rememberSource(source);
    openScrapeDialog(source, name);
  };

  async function loadJobs() {
    state.reloadJobs = loadJobs;
    const wrap = $('#job-list-wrap');
    if (!wrap) return; // 视图已切换走，避免在别的页面上抓取完成后报错
    try {
      const q = state.jobQuery.trim();
      const jobs = await api('/jobs' + (q ? `?q=${encodeURIComponent(q)}` : ''));
      state.jobs = jobs;
      const total = state.status?.stats?.jobs ?? jobs.length;
      $('#nav-jobs-count').textContent = total;
      if (!jobs.length) {
        wrap.innerHTML = `<div class="card"><div class="empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="7" width="19" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/></svg>
          <div>${q ? '没有匹配的岗位' : '岗位库是空的'}</div>
          <div class="row mt-8" style="gap:8px">
            <button class="btn sm" id="empty-add">手工新增</button>
            <button class="btn primary sm" id="empty-scrape">去抓取</button>
          </div></div></div>`;
        $('#empty-add').onclick = openAddJobDialog;
        $('#empty-scrape').onclick = () => {
          const sel = $('#scrape-source');
          openScrapeDialog(sel.value, sel.options[sel.selectedIndex].text.replace(' (内置)', ''));
        };
        return;
      }
      wrap.innerHTML = `<div class="job-list">` + jobs.map((j) => `
        <div class="job-item" data-id="${esc(j.id)}">
          <div style="min-width:0">
            <div class="t">${esc(j.title)}<span class="src">${esc(sourceLabel(j.source))}</span></div>
            <div class="m">
              <span>${esc(j.company || '未知公司')}</span>
              ${j.city ? `<span>· ${esc(j.city)}</span>` : ''}
              ${j.experience_req ? `<span>· ${esc(j.experience_req)}</span>` : ''}
              ${j.education_req ? `<span>· ${esc(j.education_req)}</span>` : ''}
              <span>· JD ${(j.jd_text || '').length} 字</span>
            </div>
          </div>
          <div class="salary">${esc(j.salary || '—')}</div>
          <div class="row-actions">
            <button class="btn sm" data-act="match">匹配</button>
            <button class="btn sm danger" data-act="del">删除</button>
          </div>
        </div>`).join('') + '</div>';

      $$('.job-item', wrap).forEach((node) => {
        const id = node.dataset.id;
        node.addEventListener('click', (e) => {
          const act = e.target.closest('[data-act]');
          if (act) {
            e.stopPropagation();
            if (act.dataset.act === 'match') { state.selected = new Set([id]); navigate('match'); }
            if (act.dataset.act === 'del') deleteJob(id);
            return;
          }
          openJobDetail(id);
        });
      });
    } catch (e) {
      wrap.innerHTML = `<div class="card"><div class="empty">加载失败：${esc(e.message)}</div></div>`;
    }
  }

  async function deleteJob(id) {
    const ok = await confirmBox('删除岗位', '删除后不可恢复，历史匹配记录仍会保留。确定删除这条岗位？', '删除');
    if (!ok) return;
    try {
      await api(`/jobs/${id}`, { method: 'DELETE' });
      toast('已删除', 'ok');
      refreshStatus();
      loadJobs();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function openJobDetail(id) {
    // 统一走全局的岗位详情弹窗：内置浏览器看原岗位、复制链接、用这条去匹配都在里面
    await openJobDialog(id);
  }

  await loadJobs();
}

function openAddJobDialog() {
  const { el, close } = openDialog({
    title: '手工新增岗位',
    subtitle: '把 JD 原文粘进来，匹配时模型会读全文',
    wide: true,
    body: `
      <div class="form-grid">
        <div class="field"><label>岗位名称 *</label><input class="input" id="f-title" placeholder="如：AI 应用工程师（Agent 方向）" /></div>
        <div class="field"><label>公司</label><input class="input" id="f-company" placeholder="如：某智能科技" /></div>
        <div class="field"><label>城市</label><input class="input" id="f-city" placeholder="如：广州" /></div>
        <div class="field"><label>薪资</label><input class="input" id="f-salary" placeholder="如：20-30K" /></div>
        <div class="field"><label>经验要求</label><input class="input" id="f-exp" placeholder="如：3-5年" /></div>
        <div class="field"><label>学历要求</label><input class="input" id="f-edu" placeholder="如：本科及以上" /></div>
      </div>
      <div class="field"><label>JD 正文 *</label>
        <textarea class="textarea" id="f-jd" rows="10" placeholder="岗位职责 / 任职要求…"></textarea>
      </div>`,
    footer: `<div class="left"></div><button class="btn" data-close>取消</button><button class="btn primary" id="f-save">保存</button>`,
  });
  $('#f-save', el).onclick = async () => {
    const title = $('#f-title', el).value.trim();
    const jd = $('#f-jd', el).value.trim();
    if (!title) { toast('岗位名称必填', 'warn'); return; }
    if (!jd) { toast('JD 正文必填', 'warn'); return; }
    try {
      await api('/jobs', {
        method: 'POST',
        body: {
          title,
          company: $('#f-company', el).value.trim(),
          city: $('#f-city', el).value.trim(),
          salary: $('#f-salary', el).value.trim(),
          experience_req: $('#f-exp', el).value.trim(),
          education_req: $('#f-edu', el).value.trim(),
          jd_text: jd,
        },
      });
      close();
      toast('岗位已保存', 'ok');
      refreshStatus();
      navigate('jobs');
    } catch (e) { toast(e.message, 'err', '保存失败'); }
  };
}

/* 数据来源角标：手工新增的岗位 source 为空或 manual */
const SOURCE_LABELS = {
  boss: 'BOSS', zhaopin: '智联', job51: '51job', lagou: '拉勾', yupao: '鱼泡', manual: '手工',
};
const sourceLabel = (k) => SOURCE_LABELS[k] || (k ? String(k).slice(0, 5) : '手工');

/* ---------------- 添加平台弹窗（下拉选择） ---------------- */

/* 预设平台：选中即自动填好全部配置，普通用户完全不用碰 CSS 选择器。
   BOSS直聘已在后端内置，不在此列表里。
   智联 / 51job / 拉勾 / 鱼泡 的页面结构与反爬策略变动频繁，这里给的是
   「能直接跑」的起点；抓不到时展开「高级设置」，按 F12 里的真实 DOM 调。 */
const PLATFORM_PRESETS = [
  {
    key: 'zhaopin',
    name: '智联招聘',
    login_url: 'https://passport.zhaopin.com/login',
    search_url: 'https://sou.zhaopin.com/?kw={kw}&jl={city}',
    login_cookie_hints: ['zp_token', 'zhaopin_token', 'loginToken', 'x-zp-client-id'],
    city_codes: {
      '全国': '489', '北京': '530', '上海': '538', '广州': '763', '深圳': '765',
      '杭州': '653', '成都': '801', '武汉': '736', '南京': '635', '苏州': '639',
      '西安': '854', '长沙': '749', '郑州': '719', '重庆': '551', '天津': '531',
      '厦门': '682', '东莞': '768', '佛山': '769',
    },
    card_selectors: ['div.joblist-box__item', 'li.joblist-box__itemclear', 'div.iteminfo__line1'],
    title_selectors: ['a.jobinfo__name', '.iteminfo__line1__jobname', '.jobinfo__name'],
    company_selectors: ['a.companyinfo__name', '.iteminfo__line2__jobname__company', '.companyinfo__name'],
    salary_selectors: ['p.jobinfo__salary', '.jobinfo__salary', '.iteminfo__line1__salary'],
    area_selectors: ['.jobinfo__other-info-item', '.iteminfo__line2__jobname__addr'],
    link_selectors: ['a.jobinfo__name', "a[href*='jobdetail']", "a[href*='/job/']"],
    jd_selectors: ['div.describtion__detail-content', '.describtion__detail-content', 'div.job-detail'],
    next_selectors: ['button.soupager__btn--next', '.soupager__btn--next', '.btn-next'],
    detail_experience_selectors: ['.summary-plane__info li', '.job-detail__info--item'],
    detail_education_selectors: ['.summary-plane__info li', '.job-detail__info--item'],
    note: '智联搜索页是前端渲染，抓到 0 条多半是登录态失效或被验证码拦了，重开浏览器扫码登录一次再抓。',
  },
  {
    key: 'job51',
    name: '51job 前程无忧',
    login_url: 'https://login.51job.com/login.php',
    search_url: 'https://we.51job.com/pc/search?keyword={kw}&jobArea={city}&searchType=2',
    login_cookie_hints: ['guid', '51job', 'jsessionid', 'acw_tc'],
    city_codes: {
      '全国': '000000', '北京': '010000', '上海': '020000', '广州': '030200', '深圳': '040000',
      '天津': '050000', '重庆': '060000', '南京': '070200', '苏州': '070300', '杭州': '080200',
      '成都': '090200', '厦门': '110300', '武汉': '180200', '长沙': '190200', '西安': '200200',
      '东莞': '030800', '佛山': '030600',
    },
    card_selectors: ['div.joblist-item', '.joblist-item', 'div.e.joblist-item'],
    title_selectors: ['span.jobname', '.joblist-item-job .jobtitle', 'a.jobtitle'],
    company_selectors: ['a.cname', '.joblist-item-compname a', '.compname'],
    salary_selectors: ['span.salary', '.joblist-item-job .jobsalary', '.job_salary'],
    area_selectors: ['span.area', '.joblist-item-job .jobarea', '.joblist-item-job .t2'],
    link_selectors: ["a[href*='jobs.51job.com']", "a[href*='/pc/jobdetail']", 'a.jobtitle'],
    jd_selectors: ['div.job-item-2', '.tCompany_main', '.job_msg', 'div.bmsg'],
    next_selectors: ['button.btn-next', '.btn-next', 'li.btn-next a'],
    detail_experience_selectors: ['.jobitem .t1 span', '.jtag .sp4'],
    detail_education_selectors: ['.jobitem .t1 span', '.jtag .sp4'],
    note: '51job 用自家地区编码（广州 030200、深圳 040000）。换城市抓不到时，去高级设置里改「城市编码表」。',
  },
  {
    key: 'lagou',
    name: '拉勾网',
    login_url: 'https://www.lagou.com/',
    search_url: 'https://www.lagou.com/wn/jobs?kd={kw}&city={city}',
    login_cookie_hints: ['user_trace_token', 'gate_login_token', 'LGUID', 'lagou_session'],
    city_codes: {
      '全国': '全国', '北京': '北京', '上海': '上海', '广州': '广州', '深圳': '深圳',
      '杭州': '杭州', '成都': '成都', '武汉': '武汉', '南京': '南京', '西安': '西安',
      '长沙': '长沙', '厦门': '厦门', '苏州': '苏州', '重庆': '重庆', '东莞': '东莞',
    },
    card_selectors: ['li.con-search-item', 'div.item__10RTO', '.position-list .item'],
    title_selectors: ['a.position_link h3', '.position__name', '.position_link h3'],
    company_selectors: ['div.company_name a', '.company__name', '.company_name'],
    salary_selectors: ['span.money', '.position__salary', '.money'],
    area_selectors: ['span.address', '.position__addr', '.address'],
    link_selectors: ["a[href*='/wn/jobs/']", 'a.position_link', "a[href*='jobs/']"],
    jd_selectors: ['div.job_bt', '.position-content', '.job-detail'],
    next_selectors: ['div.pager_next', '.pager_next', '.pager__next'],
    detail_experience_selectors: ['.job_request span', '.position__info span'],
    detail_education_selectors: ['.job_request span', '.position__info span'],
    note: '拉勾反爬最紧，且类名常带随机后缀。抓不到就按 F12 重新取一次卡片/标题选择器填进高级设置。',
  },
  {
    key: 'yupao',
    name: '鱼泡网',
    login_url: 'https://www.yupao.com/user/login/',
    search_url: 'https://www.yupao.com/zhaogong/?kw={kw}&city={city}',
    login_cookie_hints: ['token', 'yupao_token', 'uid', 'SESSION'],
    city_codes: {
      '全国': '全国', '北京': '北京', '上海': '上海', '广州': '广州', '深圳': '深圳',
      '成都': '成都', '杭州': '杭州', '武汉': '武汉', '重庆': '重庆', '西安': '西安',
      '长沙': '长沙', '郑州': '郑州', '南京': '南京', '苏州': '苏州', '东莞': '东莞', '佛山': '佛山',
    },
    card_selectors: ['div.job-item', '.search-item', 'li.job-item'],
    title_selectors: ['.job-title', 'a.title', '.item-title'],
    company_selectors: ['.company-name', '.company', '.item-company'],
    salary_selectors: ['.job-salary', '.salary', '.item-salary'],
    area_selectors: ['.job-area', '.area', '.item-area'],
    link_selectors: ["a[href*='/zhaogong/']", "a[href*='/job/']", 'a.title'],
    jd_selectors: ['.job-desc', '.detail-content', '.job-detail'],
    next_selectors: ['.pagination .next', '.next', 'a.next'],
    detail_experience_selectors: ['.job-require', '.item-tag'],
    detail_education_selectors: ['.job-require', '.item-tag'],
    note: '鱼泡以蓝领/建筑工种为主，部分城市走子域名（如 gz.yupao.com）。要精确城市就改搜索页模板。',
  },
];

/* 自定义平台的兜底选择器 */
const CUSTOM_BASE = {
  key: '', name: '', login_url: '', search_url: '',
  login_cookie_hints: [], city_codes: {},
  card_selectors: ['div.job-card-wrapper'],
  title_selectors: ['span.job-name'],
  company_selectors: ['h3.company-name a'],
  salary_selectors: ['span.salary'],
  area_selectors: ['span.job-area'],
  link_selectors: ["a[href*='/job/']"],
  jd_selectors: ['div.job-detail'],
  next_selectors: ['a.next'],
  detail_experience_selectors: ['.job-info .text'],
  detail_education_selectors: ['.job-info .text'],
};

const SELECTOR_FIELDS = [
  ['card_selectors', '岗位卡片'],
  ['title_selectors', '岗位标题'],
  ['company_selectors', '公司名'],
  ['salary_selectors', '薪资'],
  ['area_selectors', '地区'],
  ['link_selectors', '链接'],
  ['jd_selectors', 'JD 正文'],
  ['next_selectors', '下一页按钮'],
  ['detail_experience_selectors', '详情-经验要求'],
  ['detail_education_selectors', '详情-学历要求'],
];

function openAddPlatformDialog() {
  const joinList = (v) => (Array.isArray(v) ? v.join(', ') : (v || ''));
  const joinCity = (m) => Object.entries(m || {}).map(([k, v]) => `${k}:${v}`).join(', ');

  const selFields = SELECTOR_FIELDS
    .map(([id, label]) => `<div class="field"><label>${esc(label)}</label><input class="input" id="${id}" /></div>`)
    .join('');

  const { el, close } = openDialog({
    title: '添加招聘平台',
    subtitle: '从下拉里挑一个平台，其余配置自动填好',
    wide: true,
    body: `
      <div class="field" style="margin-top:0">
        <label>招聘平台</label>
        <select class="select" id="p-preset">
          <option value="">— 请选择一个平台 —</option>
          ${PLATFORM_PRESETS.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('')}
          <option value="__custom">自定义平台（手动填写）</option>
        </select>
        <div class="desc" id="p-hint">选中后会自动填好登录地址、搜索地址和解析规则，直接点「添加平台」即可</div>
      </div>

      <div id="p-summary" class="panel-soft hidden" style="margin-top:12px"></div>

      <div class="section-title" style="margin-top:16px">已添加的平台</div>
      <div id="p-added" class="chip-row"><span class="desc">读取中…</span></div>

      <details class="adv" id="p-adv">
        <summary>高级设置 · 登录地址 / Cookie / CSS 选择器（一般不用改）</summary>
        <div class="adv-body">
          <div class="form-grid">
            <div class="field"><label>平台 Key（唯一标识）</label><input class="input" id="key" /></div>
            <div class="field"><label>平台名称</label><input class="input" id="name" /></div>
          </div>
          <div class="field"><label>登录页地址</label><input class="input" id="login_url" /></div>
          <div class="field"><label>搜索页模板（{kw}=关键词，{city}=城市编码）</label><input class="input" id="search_url" /></div>
          <div class="field"><label>登录 Cookie 名（逗号分隔，用于判断登录态）</label><input class="input" id="login_cookie_hints" /></div>
          <div class="field"><label>城市编码表（格式：深圳:040000, 北京:010000）</label><textarea class="textarea" id="city_codes" rows="2"></textarea></div>
          <div class="form-grid">${selFields}</div>
        </div>
      </details>`,
    footer: `<div class="left" id="p-status">未选择平台</div>
      <button class="btn" data-close>取消</button>
      <button class="btn primary" id="p-save">添加平台</button>`,
  });

  const presetSel = $('#p-preset', el);
  const summaryEl = $('#p-summary', el);
  const statusEl = $('#p-status', el);

  const setVal = (id, v) => { const n = $('#' + id, el); if (n) n.value = v == null ? '' : v; };

  function fill(cfg) {
    setVal('key', cfg.key);
    setVal('name', cfg.name);
    setVal('login_url', cfg.login_url);
    setVal('search_url', cfg.search_url);
    setVal('login_cookie_hints', joinList(cfg.login_cookie_hints));
    setVal('city_codes', joinCity(cfg.city_codes));
    SELECTOR_FIELDS.forEach(([id]) => setVal(id, joinList(cfg[id])));
  }

  function showSummary(p) {
    if (!p) {
      summaryEl.classList.add('hidden');
      summaryEl.innerHTML = '';
      return;
    }
    const cities = Object.keys(p.city_codes || {});
    summaryEl.classList.remove('hidden');
    summaryEl.innerHTML = `
      <div class="kv-list">
        <div class="kv-row"><span class="k">登录页</span><span class="v">${esc(p.login_url)}</span></div>
        <div class="kv-row"><span class="k">搜索页</span><span class="v">${esc(p.search_url)}</span></div>
        <div class="kv-row"><span class="k">城市</span><span class="v">${cities.length} 个：${esc(cities.slice(0, 9).join('、'))}${cities.length > 9 ? ' …' : ''}</span></div>
      </div>
      ${p.note ? `<div class="desc" style="margin-top:10px">${esc(p.note)}</div>` : ''}`;
  }

  presetSel.onchange = () => {
    const key = presetSel.value;
    if (!key) {
      fill(CUSTOM_BASE);
      showSummary(null);
      statusEl.textContent = '未选择平台';
      return;
    }
    if (key === '__custom') {
      fill(CUSTOM_BASE);
      showSummary(null);
      $('#p-adv', el).open = true;
      statusEl.textContent = '自定义平台：请填登录页和搜索页';
      return;
    }
    const p = PLATFORM_PRESETS.find((x) => x.key === key);
    if (!p) return;
    fill(p);
    showSummary(p);
    statusEl.textContent = `已选择 ${p.name}`;
  };

  async function loadAdded() {
    const box = $('#p-added', el);
    try {
      const sources = await api('/scrape/sources');
      if (!sources.length) {
        box.innerHTML = '<span class="desc">还没有平台</span>';
        return;
      }
      box.innerHTML = sources.map((s) => `
        <span class="chip ${s.builtin ? 'line' : 'accent'}">${esc(s.name)}${s.builtin ? ' · 内置' : ''}${s.builtin ? '' : `<button class="chip-x" data-del="${esc(s.key)}" title="移除这个平台">×</button>`}</span>
      `).join('');

      const added = new Set(sources.map((s) => s.key));
      Array.from(presetSel.options).forEach((opt) => {
        const p = PLATFORM_PRESETS.find((x) => x.key === opt.value);
        if (p) opt.textContent = p.name + (added.has(p.key) ? '（已添加，再选一次可覆盖）' : '');
      });

      $$('[data-del]', box).forEach((btn) => {
        btn.onclick = async () => {
          const key = btn.dataset.del;
          const yes = await confirmBox('移除平台', `确定移除「${key}」？已抓到的岗位不会被删除。`, '移除');
          if (!yes) return;
          try {
            await api('/scrape/sources/' + encodeURIComponent(key), { method: 'DELETE' });
            toast('已移除', 'ok');
            loadAdded();
          } catch (e) {
            toast(e.message, 'err', '移除失败');
          }
        };
      });
    } catch (e) {
      box.innerHTML = `<span class="desc">读取平台列表失败：${esc(e.message)}</span>`;
    }
  }

  $('#p-save', el).onclick = async () => {
    const parseList = (id) => {
      const node = $('#' + id, el);
      if (!node) return [];
      return node.value.split(',').map((s) => s.trim()).filter(Boolean);
    };
    const parseCity = (raw) => {
      const m = {};
      String(raw || '').split(',').forEach((pair) => {
        const i = pair.indexOf(':');
        if (i <= 0) return;
        const n = pair.slice(0, i).trim();
        const c = pair.slice(i + 1).trim();
        if (n && c) m[n] = c;
      });
      return m;
    };

    const cfg = {
      key: $('#key', el).value.trim(),
      name: $('#name', el).value.trim(),
      login_url: $('#login_url', el).value.trim(),
      search_url: $('#search_url', el).value.trim(),
      login_cookie_hints: parseList('login_cookie_hints'),
      city_codes: parseCity($('#city_codes', el).value),
    };
    SELECTOR_FIELDS.forEach(([id]) => { cfg[id] = parseList(id); });
    SELECTOR_FIELDS.forEach(([id]) => { if (!cfg[id].length) cfg[id] = CUSTOM_BASE[id]; });

    if (!cfg.key) { toast('请先在下拉里选一个平台', 'warn'); return; }
    if (!cfg.name) { toast('平台名称不能为空', 'warn'); return; }
    if (!cfg.login_url) { toast('登录页地址不能为空', 'warn'); return; }
    if (!cfg.search_url) { toast('搜索页地址不能为空', 'warn'); return; }
    if (!cfg.login_cookie_hints.length) { toast('登录 Cookie 名至少填一个', 'warn'); return; }

    try {
      await api('/scrape/sources', { method: 'POST', body: cfg });
      toast(`平台「${cfg.name}」已添加，回到岗位库就能选了`, 'ok');
      close();
      navigate('jobs');
    } catch (e) {
      toast(e.message, 'err', '添加失败');
    }
  };

  fill(CUSTOM_BASE);
  loadAdded();
}

/* ---------------- 内置浏览器抓取（唯一可用方式） ---------------- */
// 招聘站（尤其 BOSS）会识别 Playwright 自动化环境并把页面清成 about:blank，
// 所以「外部 Edge」那条路已经删除，登录和抓取都在应用内的 Chromium 里跑。

function builtinApi() {
  return (window.desktop && window.desktop.scrape) || null;
}

async function loadScrapeSpec(source) {
  return api(`/scrape/spec?source=${encodeURIComponent(source)}`);
}

async function importJobs(jobs) {
  if (!jobs || !jobs.length) return 0;
  const r = await api('/jobs/import', { method: 'POST', body: { jobs } });
  return (r && r.imported) || 0;
}

/**
 * 用 Electron 内置浏览器登录 + 抓取。
 *
 * 为什么不用 Playwright + Edge：招聘站的反自动化检测会把 Playwright 控制的页面
 * 重定向到 about:blank（用户看到的就是「页面一直刷新 / 白屏」）。内置浏览器是
 * 真实 Chromium 环境，登录页能稳定渲染，登录态也按平台持久化。
 */
async function scrapeWithBuiltin({ source, spec, keywords, city, pages, detailLimit, onLog, onTaskId }) {
  const d = builtinApi();
  if (!d) return { ok: false, error: '内置浏览器不可用（请从桌面应用启动）' };
  const taskId = `scrape-${Date.now()}`;
  if (onTaskId) onTaskId(taskId);
  const off = d.onLog((p) => { if (p && p.taskId === taskId) onLog(p.level, p.msg); });
  try {
    const logged = await d.checkLogin(source, spec.cookie_hints || []);
    if (!logged) {
      onLog('info', `尚未登录 ${spec.name || source}，正在打开内置浏览器…`);
      const r = await d.login({
        source,
        name: spec.name,
        loginUrl: spec.login_url,
        hints: spec.cookie_hints || [],
        taskId,
      });
      if (!r || !r.ok) {
        const cancelled = r && (r.reason === 'cancelled' || r.reason === 'closed');
        return { ok: false, cancelled, error: cancelled ? '已取消登录' : ((r && r.error) || '登录未完成') };
      }
    }
    onLog('info', '登录态正常，开始抓取…');
    const out = await d.run({ source, spec, keywords, city, pages, detailLimit, taskId });
    return out || { ok: false, error: '抓取未返回结果' };
  } finally {
    off();
  }
}

/* ---------------- 抓取弹窗 ---------------- */

const CITIES = ['广州', '深圳', '北京', '上海', '杭州', '成都', '武汉', '南京', '苏州', '西安', '长沙', '重庆', '厦门', '东莞', '佛山', '全国'];

/* ---------------- 抓取 → 技能匹配（一条龙） ---------------- */

const SKILL_THRESHOLD_KEY = 'jm.match.threshold';
const SCRAPE_COUNT_KEY = 'jm.scrape.count';

function savedSkillThreshold() {
  const v = Number(localStorage.getItem(SKILL_THRESHOLD_KEY));
  // 默认 80：实测真实前端 JD 最高也就 83%，卡 90% 会一条都不出
  return Number.isFinite(v) && v >= 30 && v <= 100 ? v : 80;
}

function saveSkillThreshold(v) {
  try { localStorage.setItem(SKILL_THRESHOLD_KEY, String(v)); } catch { /* 忽略 */ }
}

function savedScrapeCount() {
  const v = Number(localStorage.getItem(SCRAPE_COUNT_KEY));
  return [10, 20, 30, 50].includes(v) ? v : 20;
}

function saveScrapeCount(v) {
  try { localStorage.setItem(SCRAPE_COUNT_KEY, String(v)); } catch { /* 忽略 */ }
}

/** 单条岗位的技能匹配卡片。 */
function skillCardHtml(x, threshold, forceDim, picked) {
  const job = x.job || {};
  const id = job.id || '';
  const isPicked = !!(picked && picked.has(id));
  const score = typeof x.score === 'number' ? x.score : null;
  const dim = forceDim || (score !== null && score < threshold);
  const color = score === null ? 'var(--text-3)' : scoreColor(score);

  const hit = (x.hit || []).map((s) => `<span class="k">${esc(s)}</span>`).join('');
  const miss = (x.miss || []).map((s) => `<span class="m">${esc(s)}</span>`).join('');
  const extra = (x.extra || []).map((s) => `<span class="k">${esc(s)}</span>`).join('');
  const soft = (x.soft_hit || []).map((s) => `<span class="k">${esc(s)}</span>`).join('');
  // 「优先 / 加分」类技能单独一栏：缺了也不扣分，不该和硬要求混在一起制造焦虑
  const bonusMiss = (x.bonus_miss || []).map((s) => `<span class="b">${esc(s)}</span>`).join('');

  const meta = [job.company, job.city, job.experience_req, job.education_req, x.jd_len ? `JD ${x.jd_len} 字` : '']
    .filter(Boolean).map(esc).join(' · ');

  // 薪资低于期望：只把薪资标红，不弹徽标不写一句话。
  // 差多少放在悬停提示里，够不够看用户自己判断，投不投也是用户自己勾。
  const sh = x.salary_hint || null;
  const lowSalary = !!(sh && sh.text && sh.level === 'low');
  const salaryCls = `s${lowSalary ? ' low' : ''}`;
  const salaryTitle = lowSalary ? ` title="${esc(sh.text)}"` : '';

  const skillsRow = (hit || miss)
    ? `${hit ? `<span class="lbl">命中</span>${hit}` : ''}${miss ? `<span class="lbl">还缺</span>${miss}` : ''}`
    : `<span class="lbl">${esc(x.note || 'JD 里没识别到技术技能词')}</span>`;

  const extraRow = (extra || soft || bonusMiss)
    ? `<div class="sm-skills"><span class="lbl">另外</span>${extra}${soft}${
        bonusMiss ? `<span class="lbl">加分项(不扣分)</span>${bonusMiss}` : ''
      }</div>`
    : '';

  const applied = state.applications[id] && state.applications[id].status === 'sent'
    ? state.applications[id]
    : null;

  return `<div class="sm-card${dim ? ' dim' : ''}${isPicked ? ' picked' : ''}${applied ? ' applied' : ''}" data-job="${esc(id)}" title="点击查看岗位详情">
    <label class="sm-pick" title="勾选这条岗位">
      <input type="checkbox" data-pick="${esc(id)}"${isPicked ? ' checked' : ''} />
    </label>
    <div class="sm-score">
      <b style="color:${color}">${score === null ? '—' : score}</b>
      <i>${score === null ? '未识别' : '匹配度'}</i>
    </div>
    <div class="sm-main">
      <div class="sm-title">
        <span class="t">${esc(job.title || '未命名岗位')}</span>
        ${job.salary ? `<span class="${salaryCls}"${salaryTitle}>${esc(job.salary)}</span>` : ''}
        ${applied ? `<span class="sm-applied" title="已经发过招呼语（${esc(applied.applied_at || '')}），再次勾选会重投">已投</span>` : ''}
      </div>
      ${meta ? `<div class="sm-sub">${meta}</div>` : ''}
      <div class="sm-skills">${skillsRow}</div>
      ${extraRow}
      ${x.note && (hit || miss) ? `<div class="sm-note">${esc(x.note)}</div>` : ''}
    </div>
    <div class="sm-actions">
      ${job.company ? `<button class="btn sm ghosts" data-company="${esc(job.company)}" title="查这家公司是不是外包、口碑如何">查公司</button>` : ''}
      <button class="btn sm ghosts" data-greet="${esc(id)}" title="照着这份 JD 和你的简历，写一条直接发给 HR 的话">打招呼</button>
      ${job.url
        ? `<button class="btn sm" data-orig="${esc(job.url)}" data-orig-src="${esc(job.source || '')}" data-orig-title="${esc(job.title || '')}">看原岗位</button>`
        : ''}
    </div>
  </div>`;
}

/**
 * 技能匹配结果：阈值滑动即时重筛（本地过滤，不重新请求）。
 * 只重绘列表区，滑块本身不重建，拖动才跟手。
 */
function renderSkillMatches(wrap, data, opts = {}) {
  const st = wrap.__sm || { threshold: savedSkillThreshold(), showAll: false, picked: new Set(), onlyPicked: false };
  if (!(st.picked instanceof Set)) st.picked = new Set();
  st.data = data;
  if (typeof opts.threshold === 'number') st.threshold = opts.threshold;
  if (typeof opts.showAll === 'boolean') st.showAll = opts.showAll;
  wrap.__sm = st;

  if (!wrap.querySelector('[data-sm-head]')) {
    wrap.innerHTML = `
      <div class="sm-head" data-sm-head>
        <div class="sm-stat"><b data-sm-total>0</b><span>条抓到 JD</span></div>
        <div class="sm-sep"></div>
        <div class="sm-stat hit"><b data-sm-pass>0</b><span>达到阈值</span></div>
        <div class="sm-sep"></div>
        <div class="sm-stat top"><b data-sm-best>—</b><span>最高匹配</span></div>
        <div class="sm-grow"></div>
        <div class="sm-range">
          <label>匹配阈值</label>
          <input type="range" class="sm-slider" data-sm-slider min="30" max="100" step="5" />
          <output data-sm-out>80%</output>
        </div>
        <button class="btn ghost sm hidden" data-sm-only>只看勾选</button>
        <button class="btn ghost sm" data-sm-all>显示全部</button>
      </div>
      <div class="sm-tip" data-sm-tip>点卡片看岗位详情和 JD 全文，左边的方框只负责勾选</div>      <div class="sm-list" data-sm-list></div>`;

    const slider = wrap.querySelector('[data-sm-slider]');
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      wrap.__sm.threshold = v;
      wrap.querySelector('[data-sm-out]').textContent = `${v}%`;
      slider.style.setProperty('--p', `${((v - 30) / 70) * 100}%`);
      saveSkillThreshold(v);
      paint();
    });
    wrap.querySelector('[data-sm-all]').addEventListener('click', () => {
      wrap.__sm.showAll = !wrap.__sm.showAll;
      paint();
    });
    wrap.querySelector('[data-sm-only]').addEventListener('click', () => {
      wrap.__sm.onlyPicked = !wrap.__sm.onlyPicked;
      paint();
    });

    // 勾选只改选中状态，不要连带打开详情（卡片主体才是打开详情）
    wrap.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-pick]');
      if (!cb) return;
      const id = cb.dataset.pick;
      if (!id) return;
      if (cb.checked) wrap.__sm.picked.add(id);
      else wrap.__sm.picked.delete(id);
      const card = cb.closest('.sm-card');
      if (card) card.classList.toggle('picked', cb.checked);
      syncPickedUi();
    });

    wrap.addEventListener('click', (e) => {
      // 勾选框：交给上面的 change 事件，别往下走
      if (e.target.closest('.sm-pick')) return;

      const orig = e.target.closest('[data-orig]');
      if (orig && orig.dataset.orig) {
        e.stopPropagation();
        openOriginalUrl(orig.dataset.orig, {
          source: orig.dataset.origSrc || 'boss',
          title: orig.dataset.origTitle || '',
        });
        return;
      }

      const comp = e.target.closest('[data-company]');
      if (comp && comp.dataset.company) {
        e.stopPropagation();
        openCompanyDialog(comp.dataset.company);
        return;
      }

      const gre = e.target.closest('[data-greet]');
      if (gre && gre.dataset.greet) {
        e.stopPropagation();
        const items = (wrap.__sm.data && wrap.__sm.data.items) || [];
        const hitItem = items.find((x) => x.job && x.job.id === gre.dataset.greet);
        openGreetingDialog((hitItem && hitItem.job) || { id: gre.dataset.greet });
        return;
      }

      const card = e.target.closest('[data-job]');
      if (!card || !card.dataset.job) return;
      const items = (wrap.__sm.data && wrap.__sm.data.items) || [];
      const item = items.find((x) => x.job && x.job.id === card.dataset.job);
      openJobDialog(card.dataset.job, { item, score: item && item.score });
    });
  }

  const slider = wrap.querySelector('[data-sm-slider]');
  const out = wrap.querySelector('[data-sm-out]');
  const allBtn = wrap.querySelector('[data-sm-all]');
  const onlyBtn = wrap.querySelector('[data-sm-only]');
  const listEl = wrap.querySelector('[data-sm-list]');

  function syncPickedUi() {
    const n = wrap.__sm.picked.size;
    if (!onlyBtn) return;
    onlyBtn.textContent = `只看勾选 ${n}`;
    onlyBtn.classList.toggle('hidden', n === 0 && !wrap.__sm.onlyPicked);
    onlyBtn.classList.toggle('primary', !!wrap.__sm.onlyPicked);
  }

  function paint() {
    const d = wrap.__sm.data || {};
    const items = d.items || [];
    const th = wrap.__sm.threshold;
    const scored = items.filter((x) => typeof x.score === 'number');
    const passed = scored.filter((x) => x.score >= th);

    slider.value = String(th);
    slider.style.setProperty('--p', `${((th - 30) / 70) * 100}%`);
    out.textContent = `${th}%`;
    wrap.querySelector('[data-sm-total]').textContent = String(items.length);
    wrap.querySelector('[data-sm-pass]').textContent = String(passed.length);
    wrap.querySelector('[data-sm-best]').textContent =
      scored.length ? `${scored[0].score}%` : '—';

    allBtn.textContent = wrap.__sm.showAll ? '只看命中' : `显示全部 ${items.length} 条`;
    allBtn.classList.toggle('primary', wrap.__sm.showAll);

    let list;
    let forceDim = false;
    if (wrap.__sm.onlyPicked) {
      // 只看勾选：优先在「达到阈值」的范围里找，没有就退到全部条目
      const pool = passed.length ? passed : items;
      list = pool.filter((x) => x.job && wrap.__sm.picked.has(x.job.id));
      forceDim = !passed.length;
    } else if (wrap.__sm.showAll) {
      list = items;
    } else if (passed.length) {
      list = passed;
    } else {
      // 一条都没到阈值时，把最接近的几条摆出来，让用户看到差在哪
      list = scored.slice(0, 3);
      forceDim = true;
    }

    if (typeof opts.onFilter === 'function') {
      try { opts.onFilter({ threshold: th, passed: passed.length, total: items.length }); } catch { /* 忽略 */ }
    }

    if (!items.length) {
      listEl.innerHTML = `<div class="sm-empty">没有可匹配的岗位（JD 都没抓到正文）</div>`;
      syncPickedUi();
      return;
    }
    if (!list.length) {
      listEl.innerHTML = wrap.__sm.onlyPicked
        ? `<div class="sm-empty">勾选的岗位不在当前阈值范围内。点「只看勾选」取消筛选，或把阈值调低。</div>`
        : `<div class="sm-empty">
        抓到 ${items.length} 条岗位，但按 <b>${th}%</b> 一条都没命中。<br>
        把上面的阈值往左拖（比如 50%），或者点「显示全部」看看每条差在哪几个技能。
      </div>`;
      syncPickedUi();
      return;
    }

    const tip = (forceDim && !wrap.__sm.showAll && !passed.length)
      ? `<div class="range-hint" style="margin-bottom:8px">按 ${th}% 没有岗位命中，下面是分数最接近的 ${list.length} 条（灰色是未达线）</div>`
      : '';

    listEl.innerHTML = tip + list.map((x) => skillCardHtml(x, th, forceDim, wrap.__sm.picked)).join('');
    syncPickedUi();
  }

  paint();
}

/* ---------------- 抓取弹窗（后台抓取 → 技能匹配 → 直接出结果） ---------------- */

function openScrapeDialog(source, sourceName) {
  source = source || 'boss';
  sourceName = sourceName || 'BOSS直聘';
  const s = state.settings || {};
  const resume = state.resume || {};
  const hasBuiltin = !!builtinApi();

  const positions = Array.isArray(s.match_positions) ? s.match_positions : [];
  const defaultKw = resume.target_role || positions[0] || s.scrape_keyword || '前端开发';
  const count = savedScrapeCount();
  const threshold = savedSkillThreshold();
  const skillCount = (resume.skills || []).length;

  const { el, close } = openDialog({
    title: `抓取并匹配 ${esc(sourceName)} 岗位`,
    subtitle: '后台静默抓取，不打开招聘网站页面；抓完用简历技能比对 JD，只返回达到阈值的岗位',
    wide: true,
    body: `
      <div id="sc-form">
        <div class="form-grid">
          <div class="field"><label>搜索关键词</label>
            <input class="input" id="s-kw" value="${esc(defaultKw)}" /></div>
          <div class="field"><label>城市</label>
            <select class="select" id="s-city">
              ${CITIES.map((c) => `<option value="${c}" ${c === (s.scrape_city || '广州') ? 'selected' : ''}>${c}</option>`).join('')}
            </select></div>
          <div class="field"><label>翻几页找岗位</label>
            <select class="select" id="s-pages">
              ${[1, 2, 3, 5].map((n) => `<option value="${n}" ${n === (s.scrape_pages || 1) ? 'selected' : ''}>前 ${n} 页</option>`).join('')}
            </select></div>
          <div class="field"><label>抓多少条完整 JD</label>
            <select class="select" id="s-count">
              ${[10, 20, 30, 50].map((n) => `<option value="${n}" ${n === count ? 'selected' : ''}>${n} 条</option>`).join('')}
            </select>
            <span class="desc">凑够这么多条带正文的 JD 就停</span></div>
        </div>

        <div class="field" style="margin-top:4px">
          <label>匹配阈值</label>
          <div class="sm-range">
            <input type="range" class="sm-slider" id="s-th" min="30" max="100" step="5" value="${threshold}" />
            <output id="s-th-v">${threshold}%</output>
          </div>
          <span class="desc">JD 里要求的技能，简历覆盖到这个比例才返回（默认 80%；「优先/加分」项不扣分）</span>
        </div>

        <div class="row" style="gap:8px;margin-top:14px;align-items:center">
          <span class="chip line" id="s-login-state">检查中…</span>
          <button class="btn ghost sm" id="s-login">登录 / 换账号</button>
          <div style="flex:1"></div>
          <button class="btn ghost" id="s-cancel" disabled>取消</button>
          <button class="btn primary" id="s-run">开始抓取并匹配</button>
        </div>
        <div class="small muted" id="s-resume-hint" style="margin-top:10px">
          ${skillCount
            ? `用简历里的 <b>${skillCount}</b> 个技能去比对 JD 正文`
            : '<span style="color:var(--amber)">简历还没解析出技能，先去「我的简历」解析一次</span>'}
        </div>
      </div>
      <div id="sc-summary" class="hidden sm-summary"></div>
      <div id="sc-result" class="hidden" style="margin-top:14px"></div>
      <div class="console hidden" id="s-console"></div>`,
    footer: `<div class="left" id="s-status">准备就绪</div><button class="btn" data-close>关闭</button>`,
  });

  const formEl = $('#sc-form', el);
  const summaryEl = $('#sc-summary', el);
  const resultEl = $('#sc-result', el);
  const consoleEl = $('#s-console', el);
  const statusEl = $('#s-status', el);
  const runBtn = $('#s-run', el);
  const loginBtn = $('#s-login', el);
  const stateChip = $('#s-login-state', el);
  const thInput = $('#s-th', el);
  const thOut = $('#s-th-v', el);
  const cancelBtn = $('#s-cancel', el);

  let busy = false;
  let spec = null;
  let localTaskId = null;
  let t0 = Date.now();

  thInput.style.setProperty('--p', `${((threshold - 30) / 70) * 100}%`);
  thInput.addEventListener('input', () => {
    thOut.textContent = `${thInput.value}%`;
    thInput.style.setProperty('--p', `${((Number(thInput.value) - 30) / 70) * 100}%`);
  });

  function appendLine(level, msg) {
    const div = document.createElement('div');
    div.className = 'ln';
    const tm = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
    div.innerHTML = `<span class="tm">${tm}</span><span class="lv ${esc(level)}">${esc(String(level).toUpperCase())}</span><span class="tx">${esc(msg)}</span>`;
    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function setBusy(v) {
    busy = v;
    runBtn.disabled = v;
    loginBtn.disabled = v;
    cancelBtn.disabled = !v;
    setBtn(runBtn, v, v ? '抓取中…' : '');
  }

  async function refreshLoginState() {
    if (!hasBuiltin) {
      stateChip.className = 'chip red';
      stateChip.textContent = '内置浏览器不可用';
      return;
    }
    stateChip.className = 'chip line';
    stateChip.textContent = '检查中…';
    try {
      spec = spec || await loadScrapeSpec(source);
      const ok = await builtinApi().checkLogin(source, spec.cookie_hints || []);
      stateChip.className = ok ? 'chip green' : 'chip amber';
      stateChip.textContent = ok ? '已登录' : '未登录';
    } catch {
      stateChip.className = 'chip red';
      stateChip.textContent = '检查失败';
    }
  }

  /** 抓取 → 入库 → 技能匹配 → 渲染结果。全程只有一个「开始」按钮。 */
  async function runAll() {
    const skills = (state.resume && state.resume.skills) || [];
    if (!skills.length) {
      toast('简历里还没有技能，先去「我的简历」解析一次', 'warn', '缺少简历技能');
      navigate('resume');
      return;
    }
    const kw = $('#s-kw', el).value.trim();
    if (!kw) { toast('请填写搜索关键词', 'warn'); return; }
    const city = $('#s-city', el).value;
    const pages = Number($('#s-pages', el).value) || 1;
    const want = Number($('#s-count', el).value) || 20;
    const th = Number(thInput.value) || 90;

    if (!hasBuiltin) {
      toast('内置浏览器不可用，请从桌面应用启动', 'err');
      return;
    }

    saveScrapeCount(want);
    saveSkillThreshold(th);

    t0 = Date.now();
    consoleEl.innerHTML = '';
    consoleEl.classList.remove('hidden');
    resultEl.classList.add('hidden');
    setBusy(true);
    statusEl.textContent = '准备中…';

    try {
      spec = spec || await loadScrapeSpec(source);

      // 没登录时只会弹这一次窗口，登录完自动收起，之后全程后台
      const logged = await builtinApi().checkLogin(source, spec.cookie_hints || []);
      if (!logged) {
        toast('需要扫码登录一次：登录成功后窗口会自动收起，接着后台抓取', 'warn', '还没登录');
        statusEl.textContent = '等待扫码登录…';
      }

      const out = await scrapeWithBuiltin({
        source,
        spec,
        keywords: [kw],
        city,
        pages,
        detailLimit: want,
        onLog: (level, msg) => appendLine(level, msg),
        onTaskId: (id) => { localTaskId = id; },
      });

      if (!out.ok) {
        statusEl.textContent = out.cancelled ? '已取消' : '未完成';
        toast(out.cancelled ? '已取消抓取' : (out.error || '抓取失败'), out.cancelled ? 'warn' : 'err');
        return;
      }

      const jobs = out.jobs || [];
      const jdJobs = out.jd_jobs || [];
      if (!jobs.length) {
        statusEl.textContent = '没抓到岗位';
        toast('没抓到岗位：可能选择器失效或触发风控，先点「登录」确认登录态', 'warn');
        return;
      }

      const added = await importJobs(jobs);
      appendLine('ok', `已入库 ${added} 条岗位，其中 ${jdJobs.length} 条有完整 JD`);

      const ids = jdJobs.map((j) => j.id);
      if (!ids.length) {
        statusEl.textContent = 'JD 没抓到';
        toast('岗位卡片抓到了，但详情 JD 都是空的，无法匹配', 'warn');
        return;
      }

      appendLine('info', `正在用简历的 ${skills.length} 个技能比对 ${ids.length} 条 JD…`);
      const data = await api('/match/skills', {
        method: 'POST',
        body: { job_ids: ids, threshold: th },
      });

      resultEl.classList.remove('hidden');
      // 结果出来后把表单收起来，避免「两个阈值」打架
      formEl.classList.add('hidden');
      summaryEl.classList.remove('hidden');
      summaryEl.innerHTML = `<div>${esc(kw)} · ${esc(city)} · 目标 <b>${want}</b> 条 JD · 实抓 <b>${jdJobs.length}</b> 条</div>
        <button class="btn ghost sm" id="sc-again">再抓一次</button>`;
      $('#sc-again', el).onclick = () => {
        summaryEl.classList.add('hidden');
        formEl.classList.remove('hidden');
        resultEl.classList.add('hidden');
      };

      renderSkillMatches(resultEl, data, {
        threshold: th,
        onFilter: ({ passed, total, threshold: t2 }) => {
          statusEl.innerHTML = `完成 · 抓 ${jdJobs.length} 条 · 当前 <b>${passed}</b> / ${total} 条 ≥ ${t2}%`;
        },
      });
      appendLine('ok', `匹配完成：${data.passed} / ${data.total} 条达到 ${th}%，最高 ${data.best ?? '—'}%`);
      toast(`抓到 ${jdJobs.length} 条 JD，命中 ${data.passed} 条`, data.passed ? 'ok' : 'warn');
      refreshStatus();
      if (typeof state.reloadJobs === 'function') state.reloadJobs();
    } catch (e) {
      statusEl.textContent = '失败';
      appendLine('error', e.message);
      toast(e.message, 'err', '出错了');
    } finally {
      setBusy(false);
      localTaskId = null;
      refreshLoginState();
    }
  }

  runBtn.onclick = runAll;

  cancelBtn.onclick = async () => {
    if (localTaskId && builtinApi()) {
      statusEl.textContent = '正在取消…';
      await builtinApi().cancel(localTaskId);
    }
  };

  loginBtn.onclick = async () => {
    if (!hasBuiltin) return;
    const d = builtinApi();
    try {
      spec = spec || await loadScrapeSpec(source);
      const logged = await d.checkLogin(source, spec.cookie_hints || []);
      if (logged) {
        const go = await confirmBox(
          '重新登录',
          `${spec.name || source} 当前已是登录状态。重新登录会清空本地登录态并打开登录页，确定吗？`,
          '重新登录'
        );
        if (!go) return;
        await d.logout(source);
      }
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
    const taskId = `login-${Date.now()}`;
    t0 = Date.now();
    consoleEl.innerHTML = '';
    consoleEl.classList.remove('hidden');
    setBusy(true);
    statusEl.textContent = '等待登录…（登录完成后窗口会自动收起）';
    const off = d.onLog((p) => {
      if (p && p.taskId === taskId) appendLine(p.level, p.msg);
    });
    try {
      spec = spec || await loadScrapeSpec(source);
      const r = await d.login({
        source,
        name: spec.name,
        loginUrl: spec.login_url,
        hints: spec.cookie_hints || [],
        taskId,
      });
      if (r && r.ok) toast(r.already ? '已是登录状态' : '登录成功，可以开始抓取了', 'ok');
      else if (r && (r.reason === 'cancelled' || r.reason === 'closed')) toast('已取消登录', 'warn');
      else toast((r && r.error) || '登录未完成', 'err', '登录失败');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      off();
      setBusy(false);
      refreshLoginState();
    }
  };

  refreshLoginState();

  const observer = new MutationObserver(() => {
    if (!document.body.contains(el)) {
      // 关掉弹窗等于放弃这次抓取，别让后台一直跑
      if (busy && localTaskId && builtinApi()) builtinApi().cancel(localTaskId);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}


/* ---------------- 视图：智能匹配（按平台 + 期望职位动态抓取） ---------------- */

const MATCH_PAGE_OPTS = [1, 2, 3, 5];

async function viewMatch(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>求职意向<span class="hint-inline" id="intent-sum">选平台 → 挑期望职位 → 抓该平台的岗位</span></h3>
        <div class="row" style="gap:6px">
          <button class="btn ghost sm" id="in-login">只登录</button>
          <button class="btn primary sm" id="in-fetch">按意向抓取岗位</button>
        </div>
      </div>
      <div class="card-pad">
        <div class="intent-grid">
          <div class="field"><label>招聘平台</label><select class="select" id="in-source"></select></div>
          <div class="field"><label>工作城市</label><select class="select" id="in-city"></select></div>
          <div class="field"><label>每个职位抓几页</label>
            <select class="select" id="in-pages">
              ${MATCH_PAGE_OPTS.map((n) => `<option value="${n}">前 ${n} 页</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="field mt-12">
          <label>期望职位<span class="hint-inline" id="in-count">还没选</span></label>
          <div class="chip-row" id="in-chips"></div>
          <div class="row" style="gap:6px;margin-top:8px">
            <input class="input" id="in-input" placeholder="自己输入职位关键词，回车添加（如 Electron / 大模型应用）" />
            <button class="btn" id="in-add">添加</button>
          </div>
          <div class="intent-groups" id="in-groups"></div>
          <div class="small muted" id="in-note" style="margin-top:8px"></div>
          <div class="small muted" style="margin-top:4px;opacity:.8">后台静默抓取，不会打开招聘网站。凑够设定条数的完整 JD 就停，抓到后立刻用简历技能比对，达到阈值的岗位直接列出来。</div>
        </div>
      </div>
      <div class="console hidden" id="in-console" style="margin:0 20px 18px"></div>
    </div>

    <div class="card mt-16">
      <div class="card-head">
        <h3>候选岗位<span class="hint-inline" id="sel-count">0 个已选</span>
          <span class="small muted" style="font-weight:400;margin-left:8px">点卡片看详情和 JD 全文，左边方框只负责勾选</span>
        </h3>
        <div class="row" style="gap:6px">
          <label class="switch" title="只显示当前平台的岗位">
            <input type="checkbox" id="only-current" /><span class="track"></span>
          </label>
          <span class="small muted" id="only-label">只看当前平台</span>
          <button class="btn ghost sm" id="sel-all">全选</button>
          <button class="btn ghost sm" id="sel-none">清空</button>
          <button class="btn ghost sm" id="job-refresh">刷新</button>
          <button class="btn ghost sm" id="run-deep" title="逐条调用大模型，慢且花钱，但能给出匹配亮点、差距点和打招呼语">深度分析</button>
          <button class="btn primary sm" id="run-match">技能匹配</button>
          <button class="btn ghost sm" id="run-apply" title="给勾选的岗位逐条发招呼语（在内置浏览器里自动点「立即沟通」并发送）">一键投递</button>
        </div>
      </div>
      <div class="card-pad" id="job-picker"><div class="skeleton" style="height:120px"></div></div>
    </div>
    <div class="mt-16" id="match-progress"></div>
    <div class="mt-16" id="match-results"></div>`;

  const picker = $('#job-picker');
  const resultsEl = $('#match-results');
  const progressEl = $('#match-progress');
  const runBtn = $('#run-match');
  const consoleEl = $('#in-console');
  const sourceSel = $('#in-source');
  const citySel = $('#in-city');
  const pagesSel = $('#in-pages');
  const chipsEl = $('#in-chips');
  const groupsEl = $('#in-groups');
  const noteEl = $('#in-note');
  const inputEl = $('#in-input');
  const fetchBtn = $('#in-fetch');
  const loginBtn = $('#in-login');

  const resume = state.resume || await api('/resume').catch(() => null);
  state.resume = resume;

  const settings = state.settings || await api('/settings').catch(() => ({}));
  state.settings = settings;

  let sources = [];
  try {
    sources = await api('/scrape/sources');
  } catch (e) {
    picker.innerHTML = `<div class="empty">加载平台列表失败：${esc(e.message)}</div>`;
    return;
  }
  if (!sources.length) {
    picker.innerHTML = `<div class="empty">还没有可用的招聘平台，先去「岗位库」添加一个</div>`;
    fetchBtn.disabled = true;
    loginBtn.disabled = true;
    return;
  }

  const savedSource = sources.find((s) => s.key === settings.match_source);
  let curSource = savedSource ? savedSource.key : sources[0].key;
  let positions = Array.isArray(settings.match_positions) ? settings.match_positions.slice() : [];
  let intents = null;
  let jobs = [];
  let onlyCurrent = localStorage.getItem('jm.match.onlyCurrent') !== '0';
  let pollTimer = null;
  let currentTask = null;
  let seq = 0;
  let localTaskId = null;
  let logT0 = Date.now();

  sourceSel.innerHTML = sources
    .map((s) => `<option value="${esc(s.key)}"${s.key === curSource ? ' selected' : ''}>${esc(s.name)}${s.builtin ? '' : '（自定义）'}</option>`)
    .join('');
  pagesSel.value = String(MATCH_PAGE_OPTS.includes(Number(settings.scrape_pages)) ? Number(settings.scrape_pages) : 1);
  $('#only-current').checked = onlyCurrent;

  /* ---------- 期望职位 ---------- */

  function renderChips() {
    chipsEl.innerHTML = positions.length
      ? positions.map((p) => `<span class="chip accent">${esc(p)}<button class="chip-x" data-rm="${esc(p)}" title="移除">×</button></span>`).join('')
      : `<span class="small muted">点下面的分类标签，或自己输入后回车</span>`;
    $('#in-count').textContent = positions.length ? `${positions.length} 个` : '还没选';
  }

  function renderGroups() {
    const groups = (intents && intents.groups) || [];
    groupsEl.innerHTML = groups.map((g) => `<div class="intent-group">
        <span class="g-name">${esc(g.name)}</span>
        <div class="chip-row">${g.items.map((it) => `<button class="tag${positions.includes(it) ? ' on' : ''}" data-tag="${esc(it)}">${esc(it)}</button>`).join('')}</div>
      </div>`).join('');
  }

  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api('/settings', { method: 'POST', body: { match_source: curSource, match_positions: positions } })
        .then((s) => { state.settings = s; })
        .catch(() => {});
    }, 400);
  }

  function addPosition(raw) {
    const p = String(raw || '').trim();
    if (!p) return;
    if (positions.includes(p)) { toast(`「${p}」已经在期望职位里了`, 'warn'); return; }
    if (positions.length >= 8) { toast('一次最多 8 个期望职位，太多了会抓很久', 'warn'); return; }
    positions.push(p);
    renderChips();
    renderGroups();
    persist();
  }

  function removePosition(p) {
    positions = positions.filter((x) => x !== p);
    renderChips();
    renderGroups();
    persist();
  }

  chipsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]');
    if (b) removePosition(b.dataset.rm);
  });

  groupsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    const p = b.dataset.tag;
    if (positions.includes(p)) removePosition(p);
    else addPosition(p);
  });

  const commitInput = () => {
    addPosition(inputEl.value);
    inputEl.value = '';
  };
  $('#in-add').onclick = commitInput;
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitInput(); }
  });

  /* ---------- 平台意向 ---------- */

  async function loadIntents(source) {
    try {
      intents = await api(`/match/intents?source=${encodeURIComponent(source)}`);
    } catch (e) {
      noteEl.textContent = `加载该平台的职位分类失败：${e.message}（仍可手动输入职位关键词）`;
      return;
    }
    const cities = (intents.cities && intents.cities.length) ? intents.cities : ['全国'];
    const prefer = cities.includes(settings.scrape_city) ? settings.scrape_city : cities[0];
    const keep = cities.includes(citySel.value) ? citySel.value : prefer;
    citySel.innerHTML = cities.map((c) => `<option value="${esc(c)}"${c === keep ? ' selected' : ''}>${esc(c)}</option>`).join('');
    noteEl.textContent = [
      `${intents.name} · 岗位库已有 ${intents.jobs_count || 0} 条`,
      intents.note || '',
    ].filter(Boolean).join(' · ');
    renderGroups();
  }

  async function changeSource() {
    curSource = sourceSel.value;
    persist();
    await loadIntents(curSource);
    await loadJobs();
  }

  sourceSel.addEventListener('change', changeSource);

  /* ---------- 候选岗位 ---------- */

  function syncCount() {
    const cbs = $$('[data-cb]', picker);
    state.selected = new Set(cbs.filter((c) => c.checked).map((c) => c.dataset.cb));
    const total = cbs.length;
    $('#sel-count').textContent = total ? `${state.selected.size} 个已选 / 共 ${total} 个` : '0 个已选';
    $$('.job-item', picker).forEach((n) => n.classList.toggle('selected', state.selected.has(n.dataset.id)));
    syncApplyBtn();
  }

  /** 「一键投递」按钮跟着勾选数走：没勾就是灰的，勾了就把条数写在按钮上。 */
  function syncApplyBtn() {
    const btn = $('#run-apply');
    if (!btn) return;
    const n = state.selected.size;
    btn.disabled = n === 0 || state.applying;
    btn.textContent = state.applying
      ? '投递中…'
      : n ? `一键投递（${n}）` : '一键投递';
  }

  function renderJobs() {
    if (!jobs.length) {
      picker.innerHTML = `<div class="empty">
        <div>岗位库里还没有${onlyCurrent ? esc(intents?.name || '该平台') + ' ' : ''}的岗位 —— 上面选好期望职位，点「按意向抓取岗位」</div>
        <div class="row mt-8" style="gap:8px;justify-content:center">
          <button class="btn sm" id="empty-fetch">按意向抓取</button>
          <button class="btn ghost sm" id="empty-all">看全部平台</button>
        </div></div>`;
      $('#empty-fetch').onclick = () => fetchBtn.click();
      $('#empty-all').onclick = () => {
        onlyCurrent = false;
        $('#only-current').checked = false;
        localStorage.setItem('jm.match.onlyCurrent', '0');
        syncOnlyLabel();
        loadJobs();
      };
      $('#sel-count').textContent = '0 个已选';
      state.selected = new Set();
      return;
    }
    // 卡片不再用 <label> 包住多选框：以前整张卡片都是 label，点哪儿都只会切换勾选，
    // 想看一眼 JD 正文根本没入口。现在多选框只管勾选，卡片主体点开详情。
    picker.innerHTML = `<div class="job-grid">` + jobs.map((j) => {
      const ap = state.applications[j.id];
      const applied = ap && ap.status === 'sent';
      return `
        <div class="job-item job-pick${state.selected.has(j.id) ? ' selected' : ''}${applied ? ' applied' : ''}" data-id="${esc(j.id)}" title="点击查看岗位详情">
          <input type="checkbox" class="cb" data-cb="${esc(j.id)}" ${state.selected.has(j.id) ? 'checked' : ''} title="勾选 / 取消勾选" />
          <div class="jp-main">
            <div class="t"><span class="nm">${esc(j.title)}</span><span class="src">${esc(sourceLabel(j.source))}</span>${applied ? '<span class="sm-applied" title="已经发过招呼语">已投</span>' : ''}</div>
            <div class="m">${esc(j.company || '未知公司')}${j.city ? ' · ' + esc(j.city) : ''}${j.experience_req ? ' · ' + esc(j.experience_req) : ''}</div>
            <div class="salary${j.salary ? '' : ' none'}">${esc(j.salary || '薪资未抓到')}</div>
          </div>
        </div>`;
    }).join('') + '</div>';
    syncCount();
  }

  async function loadJobs(selectAll = false) {
    picker.innerHTML = `<div class="skeleton" style="height:120px"></div>`;
    try {
      const qs = onlyCurrent ? `?source=${encodeURIComponent(curSource)}` : '';
      jobs = await api('/jobs' + qs);
    } catch (e) {
      picker.innerHTML = `<div class="empty">加载岗位失败：${esc(e.message)}</div>`;
      return;
    }
    state.jobs = jobs;
    await loadApplications(); // 卡片上的「已投」标记要用
    if (selectAll) state.selected = new Set(jobs.map((j) => j.id));
    renderJobs();
  }

  picker.addEventListener('change', (e) => {
    if (e.target.matches('[data-cb]')) syncCount();
  });

  // 点卡片主体 → 看详情；点多选框只切换勾选（change 事件已处理，这里直接跳过）
  picker.addEventListener('click', (e) => {
    if (e.target.matches('[data-cb]')) return;
    const card = e.target.closest('.job-item');
    if (!card || !card.dataset.id) return;
    const job = jobs.find((j) => j.id === card.dataset.id) || { id: card.dataset.id };
    openJobDialog(job);
  });

  const syncOnlyLabel = () => {
    $('#only-label').textContent = onlyCurrent ? '只看当前平台' : '显示全部平台';
  };
  syncOnlyLabel();

  $('#only-current').addEventListener('change', (e) => {
    onlyCurrent = e.target.checked;
    localStorage.setItem('jm.match.onlyCurrent', onlyCurrent ? '1' : '0');
    syncOnlyLabel();
    loadJobs();
  });

  $('#sel-all').onclick = () => {
    $$('[data-cb]', picker).forEach((c) => { c.checked = true; });
    syncCount();
  };
  $('#sel-none').onclick = () => {
    $$('[data-cb]', picker).forEach((c) => { c.checked = false; });
    syncCount();
  };
  $('#job-refresh').onclick = () => loadJobs();

  /* ---------- 抓取任务 ---------- */

  function appendLogs(logs) {
    const frag = document.createDocumentFragment();
    logs.forEach((l) => {
      const div = document.createElement('div');
      div.className = 'ln';
      div.innerHTML = `<span class="tm">${l.t.toFixed(1)}s</span><span class="lv ${esc(l.level)}">${esc(l.level.toUpperCase())}</span><span class="tx">${esc(l.msg)}</span>`;
      frag.appendChild(div);
    });
    consoleEl.appendChild(frag);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function appendLine(level, msg, t) {
    const div = document.createElement('div');
    div.className = 'ln';
    const tm = typeof t === 'number' ? `${t.toFixed(1)}s` : '';
    div.innerHTML = `<span class="tm">${tm}</span><span class="lv ${esc(level)}">${esc(String(level).toUpperCase())}</span><span class="tx">${esc(msg)}</span>`;
    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function setBusy(busy) {
    fetchBtn.disabled = busy;
    loginBtn.disabled = busy;
    if (busy) setBtn(fetchBtn, true, '抓取中…');
    else setBtn(fetchBtn, false);
  }

  async function poll() {
    if (!currentTask) return;
    try {
      const t = await api(`/tasks/${currentTask}?since=${seq}`);
      appendLogs(t.logs || []);
      seq = t.next_seq ?? seq;
      if (t.status === 'running') {
        pollTimer = setTimeout(poll, 700);
        return;
      }
      setBusy(false);
      currentTask = null;
      if (t.status === 'done') {
        if (t.kind === 'login') {
          toast('登录完成，登录态已保存', 'ok');
        } else {
          toast(`抓取完成，入库 ${t.result?.fetched ?? 0} 条`, 'ok');
          await loadIntents(curSource);
          await loadJobs(true);
          refreshStatus();
        }
      } else if (t.status === 'error') {
        toast(t.error || '任务失败', 'err', '抓取失败');
      } else {
        toast('任务已取消', 'warn');
      }
    } catch (e) {
      setBusy(false);
      currentTask = null;
      toast(e.message, 'err');
    }
  }

  function startTask(promise) {
    consoleEl.classList.remove('hidden');
    consoleEl.innerHTML = '';
    seq = 0;
    setBusy(true);
    return promise.then((t) => {
      currentTask = t.id;
      pollTimer = setTimeout(poll, 400);
    }).catch((e) => {
      setBusy(false);
      toast(e.message, 'err');
    });
  }

  async function runBuiltinFetch(city, pages) {
    consoleEl.classList.remove('hidden');
    consoleEl.innerHTML = '';
    logT0 = Date.now();
    setBusy(true);
    try {
      const spec = await loadScrapeSpec(curSource);
      const out = await scrapeWithBuiltin({
        source: curSource,
        spec,
        keywords: positions,
        city,
        pages,
        detailLimit: savedScrapeCount(),
        onLog: (level, msg) => appendLine(level, msg, (Date.now() - logT0) / 1000),
        onTaskId: (id) => { localTaskId = id; },
      });
      if (!out.ok) {
        if (out.cancelled) toast('已取消抓取', 'warn');
        else toast(out.error || '抓取失败', 'err', '抓取失败');
        return;
      }
      const list = out.jobs || [];
      if (!list.length) {
        toast('没抓到岗位：可能选择器失效，或需要先在窗口里完成验证', 'warn');
        return;
      }
      const added = await importJobs(list);
      const jdJobs = out.jd_jobs || [];
      appendLine('ok', `已入库 ${added} 条岗位，其中 ${jdJobs.length} 条有完整 JD`, (Date.now() - logT0) / 1000);
      toast(`抓取完成：${added} 条岗位，${jdJobs.length} 条带完整 JD`, 'ok');
      await loadIntents(curSource);
      await loadJobs(true);
      refreshStatus();

      // 抓完立刻按技能匹配一遍，用户不用再点一次
      if (jdJobs.length) {
        await runSkillMatch(jdJobs.map((j) => j.id));
      }
    } catch (e) {
      toast(e.message, 'err', '抓取失败');
    } finally {
      setBusy(false);
      localTaskId = null;
    }
  }

  fetchBtn.onclick = () => {
    if (!positions.length) {
      toast('先选一个期望职位（点标签或自己输入）', 'warn');
      inputEl.focus();
      return;
    }
    const city = citySel.value;
    const pages = Number(pagesSel.value) || 1;
    if (!builtinApi()) {
      toast('内置浏览器不可用，请从桌面应用启动', 'err');
      return;
    }
    return runBuiltinFetch(city, pages);
  };

  loginBtn.onclick = async () => {
    if (!builtinApi()) {
      toast('内置浏览器不可用，请从桌面应用启动', 'err');
      return;
    }
    const d = builtinApi();
    let spec = null;
    try {
      spec = await loadScrapeSpec(curSource);
      const logged = await d.checkLogin(curSource, spec.cookie_hints || []);
      if (logged) {
        const go = await confirmBox(
          '重新登录',
          `${spec.name || curSource} 当前已是登录状态。重新登录会清空本地登录态并打开登录页，确定吗？`,
          '重新登录'
        );
        if (!go) return;
        await d.logout(curSource);
      }
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
    consoleEl.classList.remove('hidden');
    consoleEl.innerHTML = '';
    logT0 = Date.now();
    setBusy(true);
    const taskId = `login-${Date.now()}`;
    localTaskId = taskId;
    const off = d.onLog((p) => {
      if (p && p.taskId === taskId) appendLine(p.level, p.msg, (Date.now() - logT0) / 1000);
    });
    try {
      const r = await d.login({
        source: curSource,
        name: spec.name,
        loginUrl: spec.login_url,
        hints: spec.cookie_hints || [],
        taskId,
      });
      if (r && r.ok) toast(r.already ? '已是登录状态，无需重复登录' : '登录成功，登录态已保存', 'ok');
      else if (r && (r.reason === 'cancelled' || r.reason === 'closed')) toast('已取消登录', 'warn');
      else toast((r && r.error) || '登录未完成', 'err', '登录失败');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      off();
      localTaskId = null;
      setBusy(false);
    }
  };

  /* ---------- 技能匹配（本地规则，秒出） ---------- */

  async function runSkillMatch(jobIds) {
    const ids = (jobIds && jobIds.length) ? jobIds : [...state.selected];
    if (!ids.length) { toast('先勾选至少一个岗位', 'warn'); return; }
    const skills = (state.resume && state.resume.skills) || [];
    if (!skills.length) {
      toast('简历里没有技能字段，先去「我的简历」解析一次', 'warn');
      navigate('resume');
      return;
    }
    const th = savedSkillThreshold();
    resultsEl.innerHTML = '';
    progressEl.innerHTML = `<div class="card card-pad"><span class="small muted">正在用简历的 ${skills.length} 个技能比对 ${ids.length} 条 JD…</span></div>`;
    try {
      const data = await api('/match/skills', {
        method: 'POST',
        body: { job_ids: ids, threshold: th },
      });
      progressEl.innerHTML = `<div class="card card-pad row between">
        <span style="font-size:12.5px">技能匹配：<b>${data.passed}</b> / ${data.total} 条达到 ${th}%，最高 <b>${data.best ?? '—'}%</b></span>
        <span class="small muted">拖阈值即时重筛，不用重新抓取</span></div>`;
      state.matchResults = data.items || [];
      await loadApplications(); // 卡片上的「已投」标记要用
      renderSkillMatches(resultsEl, data, { threshold: th });
      refreshStatus();
    } catch (e) {
      progressEl.innerHTML = '';
      toast(e.message, 'err', '匹配失败');
    }
  }

  runBtn.onclick = () => runSkillMatch();

  /* ---------- 一键投递 ---------- */

  const APPLY_INTERVAL = 30; // 秒。真人投简历就是这个节奏，设太小反而像机器

  async function loadApplications() {
    try {
      state.applications = (await api('/applications')) || {};
    } catch {
      state.applications = {};
    }
    return state.applications;
  }

  function appliedInfo(jobId) {
    const a = state.applications[jobId];
    return a && a.status === 'sent' ? a : null;
  }

  async function recordApply(jobId, status, message, note) {
    try {
      await api('/apply/record', {
        method: 'POST',
        body: { job_id: jobId, status, message: message || '', note: note || '' },
      });
      if (status === 'sent') state.applications[jobId] = { status, applied_at: '刚刚' };
    } catch {
      /* 写库失败不该打断投递，日志里已经有一条成功记录了 */
    }
  }

  /** 取这条岗位要发的话：逐条对标版，后端有缓存就秒回。 */
  async function greetingFor(jobId) {
    const d = await api('/greeting', { method: 'POST', body: { job_id: jobId } });
    const vs = (d && d.variants) || [];
    const pick = vs.find((v) => /对标/.test(v.label || '')) || vs[0];
    const text = pick && pick.text ? String(pick.text).trim() : '';
    if (!text) throw new Error((d && d.tip) || '没生成出招呼语');
    return { text, noJd: !!d.no_jd };
  }

  async function runApply() {
    if (state.applying) return;
    const desktopApply = window.desktop && window.desktop.apply;
    if (!desktopApply) {
      toast('一键投递只能在桌面应用里用，浏览器预览没有内置浏览器', 'err');
      return;
    }

    const ids = [...state.selected];
    if (!ids.length) { toast('先勾选要投的岗位', 'warn'); return; }

    await loadApplications();
    const alreadyN = ids.filter((id) => appliedInfo(id)).length;
    const fresh = ids.filter((id) => !appliedInfo(id));
    const noUrl = fresh.filter((id) => {
      const j = jobs.find((x) => x.id === id);
      return !j || !j.url;
    });
    // 有链接但没抓到 JD 正文的：投递前先去原岗位页把正文补回来，补不到再发通用招呼语
    const noJd = fresh.filter((id) => {
      const j = jobs.find((x) => x.id === id);
      return j && j.url && String(j.jd_text || '').trim().length < 20;
    });
    const targets = fresh.filter((id) => {
      const j = jobs.find((x) => x.id === id);
      return j && j.url;
    });

    if (!targets.length) {
      const why = alreadyN
        ? `这 ${alreadyN} 条都投过了`
        : '勾选的岗位都没有原岗位链接';
      toast(why, 'warn');
      return;
    }

    const eta = Math.max(1, Math.round((targets.length * (APPLY_INTERVAL + 14)) / 60));
    const source = curSource;

    const { el, close } = openDialog({
      title: '一键投递',
      subtitle: '照着每条岗位的 JD 各写一句话，逐条发过去',
      wide: true,
      body: `
        <div class="ap-facts">
          <div><b>${targets.length}</b><span>条要投</span></div>
          <div><b>${APPLY_INTERVAL}s</b><span>每条间隔</span></div>
          <div><b>${eta}</b><span>分钟预计</span></div>
        </div>
        <div class="ap-notes">
          <div>✓ 招呼语按每家 JD 现写（逐条对标版），不是群发给所有人同一句</div>
          ${alreadyN ? `<div>· 已投过的 ${alreadyN} 条会跳过，不会重复发</div>` : ''}
          ${noUrl.length ? `<div>· 没有原岗位链接的 ${noUrl.length} 条投不了，已跳过</div>` : ''}
          ${noJd.length ? `<div>· 有 ${noJd.length} 条没抓到 JD 正文：会先去原岗位页补抓，补不到就发一条通用招呼语</div>` : ''}
          <div>· 浏览器在后台自动点「立即沟通」并发送，中途别关那个窗口</div>
          <div class="warn">撞到验证码会立刻停下、把窗口调到你面前；处理完再点一次就行，不会漏投</div>
        </div>
        <div id="ap-log" class="console hidden" style="margin-top:10px"></div>`,
      footer: `<div class="left row" style="gap:8px">
          <button class="btn ghost sm" data-close>取消</button>
          <button class="btn primary sm" id="ap-start">开始投递</button>
        </div>`,
      onMount: (dlg, doClose) => {
        const logEl = $('#ap-log', dlg);
        const startBtn = $('#ap-start', dlg);
        const t0 = Date.now();
        let taskId = null;
        let running = false;

        const push = (level, msg) => {
          logEl.classList.remove('hidden');
          const div = document.createElement('div');
          div.className = 'ln';
          const tm = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
          div.innerHTML = `<span class="tm">${tm}</span><span class="lv ${esc(level)}">${esc(String(level).toUpperCase())}</span><span class="tx">${esc(msg)}</span>`;
          logEl.appendChild(div);
          logEl.scrollTop = logEl.scrollHeight;
        };

        startBtn.onclick = async () => {
          if (running) return;
          running = true;
          state.applying = true;
          syncApplyBtn();
          startBtn.disabled = true;
          setBtn(startBtn, true, '投递中…');

          // ---- 0. 没抓到 JD 正文的，先去原岗位页补抓一遍 ----
          const spec = await loadScrapeSpec(source);
          const noJdJobs = noJd.map((id) => jobs.find((x) => x.id === id)).filter(Boolean);
          if (noJdJobs.length && builtinApi() && builtinApi().fetchJd) {
            push('info', `${noJdJobs.length} 条没抓到 JD 正文，先去原岗位页补抓…`);
            let back = null;
            try {
              back = await builtinApi().fetchJd({
                source, spec, taskId: `jd-${Date.now()}`,
                items: noJdJobs.map((j) => ({ job_id: j.id, url: j.url, title: j.title })),
              });
            } catch (e) {
              push('error', `补抓 JD 出错：${e.message}，改发通用招呼语`);
            }
            const fetched = ((back && back.jobs) || []).filter((o) => o && o.ok);
            if (fetched.length) {
              // 回写后端，下次对着真实要求生成；本地 jobs 数组也同步，卡片「JD 字数」会跟着变
              await api('/jobs/jd-backfill', { method: 'POST', body: { items: fetched } }).catch(() => {});
              const byId = new Map(fetched.map((o) => [o.job_id, o]));
              jobs.forEach((j) => {
                const o = byId.get(j.id);
                if (o && o.jd_text) {
                  j.jd_text = o.jd_text;
                  if (o.experience_req) j.experience_req = o.experience_req;
                  if (o.education_req) j.education_req = o.education_req;
                }
              });
              push('ok', `补到 ${fetched.length} 条正文，其余 ${noJdJobs.length - fetched.length} 条发通用招呼语`);
            } else {
              push('warn', `正文一条都没补到，${noJdJobs.length} 条全发通用招呼语`);
            }
          }

          // ---- 1. 逐条把招呼语写出来 ----
          const tasks = [];
          for (let i = 0; i < targets.length; i += 1) {
            const id = targets[i];
            const job = jobs.find((x) => x.id === id) || { id };
            push('info', `正在写第 ${i + 1}/${targets.length} 条：${job.title || id}`);
            try {
              const { text: msg, noJd: isGeneric } = await greetingFor(id);
              tasks.push({
                job_id: id, title: job.title, company: job.company,
                url: job.url, message: msg,
              });
              push(isGeneric ? 'warn' : 'ok',
                `${job.title || id} · ${msg.length} 字${isGeneric ? '（通用招呼语）' : ''}`);
            } catch (e) {
              push('error', `${job.title || id} · 招呼语没写出来（${e.message}）`);
              await recordApply(id, 'failed', '', `生成招呼语失败：${e.message}`);
            }
          }

          if (!tasks.length) {
            push('error', '一条招呼语都没写出来，这次不投了');
            running = false;
            state.applying = false;
            syncApplyBtn();
            setBtn(startBtn, false);
            startBtn.disabled = false;
            return;
          }

          // ---- 2. 交给内置浏览器逐条点「立即沟通」并发送 ----
          taskId = `apply-${Date.now()}`;
          // 投递中把底部的「取消」换成真正的停止：关窗不会停任务，得显式告诉主进程
          const stopBtn = dlg.querySelector('.dialog-foot [data-close]');
          if (stopBtn) {
            stopBtn.textContent = '停止投递';
            stopBtn.classList.add('danger');
            stopBtn.addEventListener('click', () => desktopApply.cancel(taskId));
          }
          const offLog = builtinApi().onLog((p) => {
            if (p && p.taskId === taskId) push(p.level, p.msg);
          });
          const offRes = desktopApply.onResult(async (p) => {
            if (!p || p.taskId !== taskId) return;
            await recordApply(p.job_id, p.ok ? 'sent' : 'failed', p.message || '', p.note || '');
          });

          let out = null;
          try {
            out = await desktopApply.run({
              source, spec, tasks, interval: APPLY_INTERVAL, taskId,
            });
          } catch (e) {
            push('error', `投递出错：${e.message}`);
          } finally {
            offLog();
            offRes();
          }

          running = false;
          state.applying = false;
          syncApplyBtn();

          const sent = (out && out.sent) || 0;
          const failed = (out && out.failed) || 0;
          const err = out && out.error;

          if (err) {
            push('error', err);
            setBtn(startBtn, false, '再试一次');
            startBtn.disabled = false;
            startBtn.onclick = () => { doClose(); setTimeout(runApply, 60); };
            return;
          }

          push(sent ? 'ok' : 'warn', `结束：成功 ${sent} 条，失败 ${failed} 条`);
          if (failed) push('warn', '失败的没记成已投，下次勾选会重新投');
          setBtn(startBtn, false, '完成');
          startBtn.disabled = true;

          await loadApplications();
          // 两处视图都刷一遍：候选岗位区的已投标记 + 匹配结果里的已投标记
          setTimeout(async () => {
            doClose();
            await loadJobs();
            if (state.matchResults && state.matchResults.length) runSkillMatch();
          }, 900);
        };
      },
    });

    // 弹窗关掉时如果还在投，问一下要不要停
    el.querySelectorAll('[data-close]').forEach((b) => {
      b.addEventListener('click', () => {
        if (state.applying) toast('投递还在跑，关掉弹窗不会停；要停请点窗口里的取消', 'warn');
      });
    });
  }

  $('#run-apply').onclick = () => runApply();
  syncApplyBtn();

  $('#run-deep').onclick = async () => {
    if (!state.resume) {
      toast('请先在「我的简历」里解析简历', 'warn');
      navigate('resume');
      return;
    }
    if (!state.selected.size) { toast('先勾选至少一个岗位', 'warn'); return; }

    const deepBtn = $('#run-deep');
    const list = jobs.filter((j) => state.selected.has(j.id));
    resultsEl.innerHTML = `<div class="section-title">匹配结果</div><div class="match-list" style="display:flex;flex-direction:column;gap:14px"></div>`;
    const listEl = $('.match-list', resultsEl);
    let done = 0;
    progressEl.innerHTML = `<div class="card card-pad">
      <div class="row between" style="margin-bottom:8px">
        <span style="font-size:12.5px">正在匹配 <b id="pg-done">0</b> / ${list.length}</span>
        <span class="small muted" id="pg-cur">准备中…</span>
      </div>
      <div class="progress"><i style="width:0%"></i></div></div>`;
    deepBtn.disabled = true;
    setBtn(deepBtn, true, '匹配中…');

    const cards = new Map();
    list.forEach((job) => {
      const wrap = document.createElement('div');
      wrap.className = 'match-card';
      wrap.innerHTML = `<div class="match-head">
        <div class="score-ring"><svg width="62" height="62"><circle class="bgc" cx="31" cy="31" r="26" fill="none" stroke-width="6"/></svg></div>
        <div style="min-width:0"><div class="title">${esc(job.title)}</div><div class="sub">${esc(job.company || '')} ${job.city ? '· ' + esc(job.city) : ''}</div></div>
        <span class="chip"><span class="spinner dark"></span>&nbsp;排队中</span>
      </div>`;
      listEl.appendChild(wrap);
      cards.set(job.id, wrap);
    });

    const results = [];
    for (const job of list) {
      const wrap = cards.get(job.id);
      const cur = $('#pg-cur');
      if (cur) cur.textContent = `${job.title}`;
      wrap.querySelector('.chip').innerHTML = `<span class="spinner dark"></span>&nbsp;分析中`;
      try {
        const r = await api(`/match/${job.id}`, { method: 'POST', body: { resume: state.resume } });
        const flat = {
          job: { id: job.id, title: job.title, company: job.company, city: job.city, salary: job.salary },
          overall_score: r.evaluation?.overall_score,
          dimensions: r.evaluation?.dimensions,
          matched_points: r.evaluation?.matched_points,
          gaps: r.evaluation?.gaps,
          tailored_message: r.tailored_message,
          resume_suggestions: r.resume_suggestions,
        };
        results.push(flat);
        wrap.outerHTML = renderMatchCard(flat, true);
      } catch (e) {
        wrap.outerHTML = `<div class="match-card"><div class="match-head">
          <div class="score-ring"><svg width="62" height="62"><circle class="bgc" cx="31" cy="31" r="26" fill="none" stroke-width="6"/></svg></div>
          <div><div class="title">${esc(job.title)}</div><div class="sub" style="color:var(--red)">匹配失败：${esc(e.message)}</div></div>
          <span class="chip red">失败</span></div></div>`;
      }
      done += 1;
      const pgDone = $('#pg-done');
      if (pgDone) pgDone.textContent = String(done);
      const bar = $('.progress > i', progressEl);
      if (bar) bar.style.width = `${Math.round((done / list.length) * 100)}%`;
    }

    state.matchResults = results.sort((a, b) => (b.overall_score || 0) - (a.overall_score || 0));
    progressEl.innerHTML = `<div class="card card-pad row between">
      <span style="font-size:12.5px">完成 ${results.length} 条匹配${results.length ? `，最高分 <b>${Math.max(...results.map((x) => x.overall_score || 0))}</b>` : ''}</span>
      <button class="btn sm" id="to-history">查看历史</button></div>`;
    $('#to-history').onclick = () => navigate('history');
    setBtn(deepBtn, false);
    deepBtn.disabled = false;
    refreshStatus();
    bindMatchCardEvents(resultsEl);
  };

  /* ---------- 初始化 ---------- */

  renderChips();
  await loadIntents(curSource);
  await loadJobs();
}

function ringSvg(score) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Number(score) || 0));
  const off = c - (c * pct) / 100;
  const color = scoreColor(score);
  return `<svg width="62" height="62">
    <circle class="bgc" cx="31" cy="31" r="${r}" fill="none" stroke-width="6"/>
    <circle class="fgc" cx="31" cy="31" r="${r}" fill="none" stroke-width="6" stroke="${color}"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
  </svg>
  <span class="num"><b style="color:${color}">${score ?? '—'}</b><i>匹配度</i></span>`;
}

function renderMatchCard(r, expand) {
  const dims = (r.dimensions || []).map((d) => `
    <div class="dim-row">
      <span class="nm">${esc(d.name)}</span>
      <span class="bar"><i style="width:${Math.max(0, Math.min(100, d.score))}%;background:${scoreColor(d.score)}"></i></span>
      <span class="vl">${esc(d.score)}</span>
    </div>`).join('');

  const li = (arr) => (arr || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li>—</li>';
  const mid = 'm-' + Math.random().toString(36).slice(2, 8);

  return `<div class="match-card" data-mid="${mid}">
    <div class="match-head">
      <div class="score-ring">${ringSvg(r.overall_score)}</div>
      <div style="min-width:0">
        <div class="title">${esc(r.job.title)}
          ${r.job.salary ? `<span class="chip ${scoreClass(r.overall_score)}">${esc(r.job.salary)}</span>` : ''}
        </div>
        <div class="sub">${esc(r.job.company || '')} ${r.job.city ? '· ' + esc(r.job.city) : ''}</div>
      </div>
      <button class="btn ghost sm" data-toggle>${expand ? '收起' : '展开'}</button>
    </div>
    <div class="match-body ${expand ? '' : 'hidden'}" data-body>
      ${dims ? `<div class="dims">${dims}</div>` : ''}
      <div class="match-cols">
        <div class="panel-soft good"><h5>匹配亮点</h5><ul>${li(r.matched_points)}</ul></div>
        <div class="panel-soft bad"><h5>差距 / 风险点</h5><ul>${li(r.gaps)}</ul></div>
      </div>
      ${r.tailored_message ? `<div class="msg-box">
        <div class="msg-tag">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-4-.9L3 21l1.9-4.9A8.4 8.4 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>
          定制打招呼语
        </div>
        <button class="btn sm copy" data-copy="${esc(r.tailored_message)}">复制</button>
        ${esc(r.tailored_message)}
      </div>` : ''}
      <div class="panel-soft"><h5>简历优化建议</h5><ul>${li(r.resume_suggestions)}</ul></div>
    </div>
  </div>`;
}

function bindMatchCardEvents(root) {
  $$('[data-toggle]', root).forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = '1';
    b.onclick = () => {
      const card = b.closest('.match-card');
      const body = $('[data-body]', card);
      const hidden = body.classList.toggle('hidden');
      b.textContent = hidden ? '展开' : '收起';
    };
  });
  $$('[data-copy]', root).forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = '1';
    b.onclick = (e) => { e.stopPropagation(); copyText(b.dataset.copy); };
  });
}

/* ---------------- 视图：历史 ---------------- */

async function viewHistory(root) {
  root.innerHTML = `<div class="card"><div id="history-wrap" class="card-pad"><div class="skeleton" style="height:200px"></div></div></div>`;
  const wrap = $('#history-wrap');
  let matches = [];
  try {
    matches = await api('/matches?limit=200');
  } catch (e) {
    wrap.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
    return;
  }
  if (!matches.length) {
    wrap.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.5 2"/></svg>
      <div>暂无匹配历史</div>
      <button class="btn primary sm mt-8" id="h-go">去匹配</button></div>`;
    $('#h-go').onclick = () => navigate('match');
    return;
  }

  const jobs = state.jobs.length ? state.jobs : await api('/jobs').catch(() => []);
  state.jobs = jobs;
  const jobById = Object.fromEntries(jobs.map((j) => [j.id, j]));

  wrap.innerHTML = `<table class="table">
    <thead><tr><th style="width:150px">时间</th><th>岗位</th><th style="width:86px">匹配分</th><th>打招呼语</th><th style="width:110px"></th></tr></thead>
    <tbody>${matches.map((m) => {
      const job = jobById[m.job_id];
      return `<tr data-id="${m.id}">
        <td class="small muted">${esc(fmtTime(m.created_at))}</td>
        <td><div style="font-weight:600">${esc(job?.title || m.job_id)}</div>
            <div class="small muted">${esc(job?.company || '')}</div></td>
        <td><span class="chip ${scoreClass(m.overall_score)}">${esc(m.overall_score ?? '—')}</span></td>
        <td class="small muted" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.tailored_message || '—')}</td>
        <td><div class="row" style="gap:4px;justify-content:flex-end">
          <button class="btn sm" data-act="view">详情</button>
          <button class="btn sm danger" data-act="del">删除</button>
        </div></td>
      </tr>`;
    }).join('')}</tbody></table>`;

  $$('tbody tr', wrap).forEach((tr) => {
    const m = matches.find((x) => String(x.id) === tr.dataset.id);
    tr.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]');
      if (act?.dataset.act === 'del') {
        e.stopPropagation();
        const ok = await confirmBox('删除记录', '确定删除这条匹配记录？', '删除');
        if (!ok) return;
        try { await api(`/matches/${m.id}`, { method: 'DELETE' }); toast('已删除', 'ok'); navigate('history'); }
        catch (err) { toast(err.message, 'err'); }
        return;
      }
      const job = jobById[m.job_id];
      const flat = {
        job: { id: m.job_id, title: job?.title || m.job_id, company: job?.company || '', city: job?.city || '', salary: job?.salary || '' },
        overall_score: m.overall_score,
        dimensions: m.dimensions,
        matched_points: m.matched_points,
        gaps: m.gaps,
        tailored_message: m.tailored_message,
        resume_suggestions: m.resume_suggestions,
      };
      const html = renderMatchCard(flat, true);
      const holder = document.createElement('div');
      holder.innerHTML = html;
      const { el } = openDialog({
        title: flat.job.title,
        subtitle: `${flat.job.company} · ${fmtTime(m.created_at)}`,
        wide: true,
        body: '',
      });
      $('.dialog-body', el).appendChild(holder.firstElementChild);
      $('.match-card', el).style.border = '0';
      $('.match-card', el).style.boxShadow = 'none';
      $('[data-toggle]', el).style.display = 'none';
      bindMatchCardEvents(el);
    });
  });
}

/* ---------------- 视图：设置 ---------------- */

async function viewSettings(root) {
  let s;
  try { s = await api('/settings'); } catch (e) {
    root.innerHTML = `<div class="card card-pad">加载失败：${esc(e.message)}</div>`;
    return;
  }
  state.settings = s;

  root.innerHTML = `
    <div class="settings-layout">
      <div class="card">
        <div class="card-head"><h3>大模型</h3><span class="chip ${s.demo_mode ? 'amber' : s.has_api_key ? 'green' : 'red'}">
          ${s.demo_mode ? '演示模式' : s.has_api_key ? '已配置' : '未配置 Key'}</span></div>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:14px">
          <div class="field">
            <label>API Key</label>
            <input class="input" id="set-key" type="password" placeholder="${s.has_api_key ? esc(s.openai_api_key_masked) : 'sk-…'}" autocomplete="off" />
            <span class="desc">留空表示不修改。支持任何 OpenAI 兼容接口（DeepSeek / 通义 / 智谱 / 本地 Ollama）。</span>
          </div>
          <div class="form-grid">
            <div class="field"><label>接口地址 Base URL</label>
              <input class="input" id="set-base" value="${esc(s.openai_base_url)}" /></div>
            <div class="field"><label>模型名称</label>
              <input class="input" id="set-model" value="${esc(s.openai_model)}" /></div>
          </div>
          <div class="row between" style="padding-top:4px">
            <div>
              <div style="font-size:12.8px;font-weight:500">演示模式</div>
              <div class="small muted">开启后不调用真实模型，用固定结果跑通界面，适合无 Key 时演示</div>
            </div>
            <label class="switch"><input type="checkbox" id="set-demo" ${s.demo_mode ? 'checked' : ''} /><span class="track"></span></label>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>抓取默认值</h3></div>
        <div class="card-pad">
          <div class="form-grid">
            <div class="field"><label>默认关键词</label><input class="input" id="set-kw" value="${esc(s.scrape_keyword)}" /></div>
            <div class="field"><label>默认城市</label><input class="input" id="set-city" value="${esc(s.scrape_city)}" /></div>
            <div class="field"><label>默认页数</label><input class="input" id="set-pages" type="number" min="1" max="10" value="${esc(s.scrape_pages)}" /></div>
            <div class="field"><label>抓多少条完整 JD</label>
              <input class="input" id="set-count" type="number" min="5" max="60" value="${savedScrapeCount()}" />
              <span class="desc">凑够这么多条带正文的 JD 就停止抓取</span></div>
            <div class="field"><label>默认匹配阈值</label>
              <input class="input" id="set-threshold" type="number" min="30" max="100" step="5" value="${savedSkillThreshold()}" />
              <span class="desc">JD 要求的技能，简历覆盖到这个比例才返回（默认 80%；「优先/加分」项不扣分）</span></div>
          </div>
          <div class="small muted" style="margin-top:10px">
            抓取固定使用内置浏览器：招聘站会识别 Playwright 环境并把页面清成空白，外部 Edge 那条路已经走不通了。
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>数据</h3></div>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:12px">
          <div class="field"><label>数据目录</label><div class="mono" style="color:var(--text-2)">${esc(s.data_dir)}</div>
            <span class="desc">数据库、登录态、简历与配置都保存在这里</span></div>
          <div class="row" style="gap:8px">
            <button class="btn sm" id="open-dir">打开数据目录</button>
            <button class="btn sm" id="reload-status">刷新状态</button>
          </div>
        </div>
      </div>

      <div class="row" style="gap:8px">
        <button class="btn primary" id="save-settings">保存设置</button>
        <span class="small muted" id="save-hint">保存后立即生效，无需重启</span>
      </div>
    </div>`;

  $('#open-dir').onclick = () => {
    if (window.desktop?.openPath) window.desktop.openPath(s.data_dir);
    else toast('浏览器模式不支持打开目录', 'warn');
  };
  $('#reload-status').onclick = async () => { await refreshStatus(); toast('状态已刷新', 'ok'); };

  $('#save-settings').onclick = async () => {
    const countInput = Number($('#set-count').value);
    if (Number.isFinite(countInput) && countInput >= 5) saveScrapeCount(Math.min(60, countInput));
    const thInput = Number($('#set-threshold').value);
    if (Number.isFinite(thInput) && thInput >= 30 && thInput <= 100) saveSkillThreshold(thInput);

    const patch = {
      openai_base_url: $('#set-base').value.trim(),
      openai_model: $('#set-model').value.trim(),
      demo_mode: $('#set-demo').checked,
      scrape_keyword: $('#set-kw').value.trim(),
      scrape_city: $('#set-city').value.trim(),
      scrape_pages: Number($('#set-pages').value) || 1,
    };
    const key = $('#set-key').value.trim();
    if (key) patch.openai_api_key = key;
    const btn = $('#save-settings');
    setBtn(btn, true, '保存中…');
    try {
      const r = await api('/settings', { method: 'POST', body: patch });
      state.settings = r;
      $('#set-key').value = '';
      $('#set-key').placeholder = r.has_api_key ? r.openai_api_key_masked : 'sk-…';
      toast('设置已保存', 'ok');
      refreshStatus();
      navigate('settings');
    } catch (e) {
      toast(e.message, 'err', '保存失败');
    } finally {
      setBtn(btn, false);
    }
  };
}

/* ---------------- 渲染器与启动 ---------------- */

const renderers = {
  dashboard: viewDashboard,
  resume: viewResume,
  jobs: viewJobs,
  match: viewMatch,
  history: viewHistory,
  settings: viewSettings,
};

document.addEventListener('DOMContentLoaded', async () => {
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.route)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const overlays = $$('.overlay');
      if (overlays.length) overlays[overlays.length - 1].remove();
    }
  });
  await refreshStatus();
  state.settings = await api('/settings').catch(() => null);
  state.resume = await api('/resume').catch(() => null);
  state.jobs = await api('/jobs').catch(() => []);
  navigate('dashboard');
});