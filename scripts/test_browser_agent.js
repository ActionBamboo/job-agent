'use strict';
/**
 * 验证 BrowserAgent：登录检测 → 抽卡片 → 翻页 → 详情 JD。
 * 目标站用 scripts/fake_job_site.py 起的本地假招聘站。
 *
 * 运行：electron.exe scripts/test_browser_agent.js [port]
 */
const { app } = require('electron');
const path = require('node:path');
const { BrowserAgent } = require(path.join(__dirname, '..', 'desktop', 'src', 'browser-agent.js'));

const PORT = Number(process.argv.find((a) => /^\d{4,5}$/.test(a)) || 8199);
const BASE = `http://127.0.0.1:${PORT}`;

const spec = {
  key: 'fake',
  name: '本地假招聘站',
  login_url: `${BASE}/list`,
  search_url: `${BASE}/list?kw={kw}&city={city}`,
  page_url: `${BASE}/list?kw={kw}&city={city}&page={page}`,
  city_codes: { 广州: '广州', 深圳: '深圳' },
  cookie_hints: ['fake_login'],
  selectors: {
    card: ['div.job-card-wrapper'],
    title: ['span.job-name'],
    company: ['h3.company-name a'],
    salary: ['span.salary'],
    area: ['span.job-area'],
    link: ["a[href*='/job/']"],
    jd: ['div.job-sec-text'],
    next: ['a.next'],
    experience: ['.job-info .text'],
    education: ['.job-info .text'],
  },
};

app.whenReady().then(async () => {
  const agent = new BrowserAgent(({ level, msg }) => console.log(`  [${level}] ${msg}`));
  let failed = 0;

  console.log('=== 1. 登录检测（应自动拿到 fake_login cookie） ===');
  const login = await agent.login({
    source: 'fake',
    name: spec.name,
    loginUrl: spec.login_url,
    hints: spec.cookie_hints,
    timeoutMs: 30000,
    taskId: 't-login',
  });
  console.log('login 结果:', JSON.stringify(login));
  if (!login.ok) {
    console.log('  ✗ 登录检测失败');
    failed += 1;
  }

  console.log('=== 2. 后台静默抓取：要 5 条完整 JD ===');
  const out = await agent.run({
    source: 'fake',
    spec,
    keywords: ['AI Agent'],
    city: '广州',
    pages: 2,
    detailLimit: 5,
    taskId: 't-run',
  });

  const jobs = out.jobs || [];
  const jdJobs = out.jd_jobs || [];
  console.log(`\n卡片 ${jobs.length} 条，其中带 JD ${jdJobs.length} 条（fetch=${out.fetched}）`);

  // 抓取窗口必须在屏幕外，用户不该看到任何招聘站页面
  const win = agent.windows.get('fake');
  const bounds = win && !win.isDestroyed() ? win.getBounds() : null;
  console.log('抓取窗口位置:', bounds ? `${bounds.x},${bounds.y}` : '(无)');
  jobs.slice(0, 4).forEach((j, i) => {
    console.log(`  ${i + 1}. ${j.id} | ${j.title} | ${j.company} | ${j.salary} | ${j.city} | JD ${j.jd_text.length} 字`);
  });

  const checks = [
    ['卡片抓到 3 条以上', jobs.length >= 3],
    ['JD 条数正好等于要求的 5 条', jdJobs.length === 5],
    ['每条 JD 都有正文', jdJobs.every((j) => j.jd_text.trim().length >= 20)],
    ['抓取窗口在屏幕外（用户看不到）', !!bounds && bounds.x <= -1000],
    ['标题正确', jobs.some((j) => j.title === 'AI 应用工程师')],
    ['公司正确', jobs.some((j) => j.company === '星辰科技')],
    ['薪资正确', jobs.some((j) => j.salary === '25-40K')],
    ['id 从 URL 提取', jobs.every((j) => /^fake-\d+$/.test(j.id))],
    ['详情 JD 已抓', jobs.some((j) => j.jd_text.includes('AI Agent'))],
    ['经验要求已抓', jobs.some((j) => j.experience_req)],
    ['学历要求已抓', jobs.some((j) => j.education_req)],
    ['详情页 URL 完整', jobs.every((j) => j.url.startsWith(BASE))],
    ['去重无重复', new Set(jobs.map((j) => j.id)).size === jobs.length],
  ];
  console.log('\n=== 断言 ===');
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (!ok) failed += 1;
  }

  console.log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
  agent.closeAll();
  app.quit();
});
