// 真实端到端：登录（必要时）→ 后台抓 N 条 JD → 落盘给 Python 算分
// 用法: electron scripts/boss_e2e.js [关键词] [城市码] [要几条]
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { BrowserAgent } = require('../desktop/src/browser-agent.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'tmp', 'e2e-jobs.json');

const KW = process.argv[2] || '前端开发';
const CITY = process.argv[3] || '101280100';
const WANT = Number(process.argv[4] || 12);

// 必须复用安装版的 userData，否则 persist:src-boss 分区里的登录态读不到
const REAL_USER_DATA = 'C:/Users/PC/AppData/Roaming/JobMatch Agent';
app.setPath('userData', REAL_USER_DATA);
app.setPath('sessionData', REAL_USER_DATA);

const SPEC = {
  key: 'boss',
  name: 'BOSS直聘',
  login_url: 'https://www.zhipin.com/web/user/',
  search_url: 'https://www.zhipin.com/web/geek/jobs?query={kw}&city={city}',
  page_url: 'https://www.zhipin.com/web/geek/jobs?query={kw}&city={city}&page={page}',
  cookie_hints: ['zp_at', 'wt2', 'bst', 'geek_zp_token', 'zp_token'],
  city_codes: { 全国: '100010000', 广州: '101280100', 深圳: '101280600' },
  selectors: {
    card: ['li.job-card-box', 'div.job-card-wrap'],
    title: ['a.job-name', 'span.job-name', '.job-name'],
    company: ['span.boss-name', '.boss-name', '.company-text', '.company-name'],
    salary: ['span.job-salary', '.job-salary'],
    area: ['span.company-location', '.company-location', '.job-area'],
    link: ['a.job-name', 'a[href*="/job_detail/"]'],
    next: ['.options-pages a:last-child', '.pagination a:last-child'],
    jd: ['.job-sec-text', '.job-detail-section .text', '.job-detail'],
    experience: ['.job-banner .info-primary p', '.job-info .text'],
    education: ['.job-banner .info-primary p', '.job-info .text'],
  },
};

const log = (p) => {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] ${p.level || 'info'} ${p.msg}`);
};

app.whenReady().then(async () => {
  const agent = new BrowserAgent(log);
  // 复用真实 userData（含 src-boss 分区），登录态才在
  console.log('userData:', app.getPath('userData'));

  try {
    const out = await agent.run({
      source: 'boss',
      spec: SPEC,
      keywords: [KW],
      city: CITY,
      pages: 3,
      detailLimit: WANT,
      taskId: 'e2e',
    });

    const jobs = out.jd_jobs || [];
    console.log(`\n卡片 ${(out.jobs || []).length} 条，带 JD ${jobs.length} 条`);
    fs.writeFileSync(OUT, JSON.stringify({ keyword: KW, city: CITY, jobs }, null, 2), 'utf-8');
    console.log('已写入:', OUT);

    if (jobs.length) {
      console.log('\n=== 前 3 条 JD 预览 ===');
      jobs.slice(0, 3).forEach((j, i) => {
        console.log(`\n--- ${i + 1}. ${j.title} | ${j.company} | ${j.salary} ---`);
        console.log(j.jd_text.slice(0, 300));
      });
    }
  } catch (e) {
    console.log('\n抓取失败:', e.message);
  } finally {
    agent.closeAll();
    app.exit(0);
  }
});
