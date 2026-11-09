"""截图验证「抓取并匹配」弹窗：后台静默抓取 → 技能匹配 → 直接出结果。

用 Playwright 打开后端的 /ui/ 页面，注入一份 mock 的 window.desktop.scrape
（模拟 Electron preload），并拦截 /jobs/import 与 /match/skills，避免污染真实库。

用法：.venv/Scripts/python.exe scripts/shot_skill_match.py <base_url> <out_dir>
"""
import asyncio
import json
import sys
from pathlib import Path

MOCK = """
window.desktop = {
  apiBase: '__BASE__',
  platform: 'win32',
  versions: { electron: 'test', chrome: 'test', node: 'test' },
  openExternal: async () => true,
  scrape: {
    onLog: (cb) => { window.__scrapeCbs = window.__scrapeCbs || []; window.__scrapeCbs.push(cb);
                     return () => { window.__scrapeCbs = (window.__scrapeCbs||[]).filter(x => x !== cb); }; },
    checkLogin: async () => true,
    login: async () => ({ ok: true, already: true }),
    logout: async () => ({ ok: true }),
    cancel: async () => true,
    closeWindow: async () => true,
    run: async (p) => {
      const push = (level, msg) => (window.__scrapeCbs||[]).forEach(cb => cb({taskId: p.taskId, level, msg}));
      const want = p.detailLimit || 20;
      push('ok', `开始后台抓取 BOSS直聘，目标 ${want} 条带 JD 的岗位`);
      push('info', '前端开发 · 第 1 页加载中…');
      await new Promise(r => setTimeout(r, 320));
      push('ok', '前端开发 · 第 1 页 15 张卡片，新增 15 条（累计 15 条待补 JD）');
      push('info', '前端开发 · 第 2 页加载中…');
      await new Promise(r => setTimeout(r, 320));
      push('ok', '前端开发 · 第 2 页 15 张卡片，新增 12 条（累计 27 条待补 JD）');
      push('info', `开始补 JD 详情，目标 ${want} 条…`);
      const jobs = [];
      const titles = [
        ['前端开发工程师（Vue）', '广州某某科技', '15-22K'],
        ['Web 前端工程师', '某某网络', '14-20K'],
        ['Vue3 前端开发', '广州某某信息', '16-24K'],
        ['AI 应用前端工程师', '广州某某智能', '18-25K'],
        ['前端工程师（可视化）', '佛山某某软件', '13-18K'],
        ['高级前端开发（Vue/TS）', '广州某某云', '20-28K'],
        ['前端开发（小程序方向）', '东莞某某科技', '12-16K'],
        ['AI 产品前端', '某某智能', '17-23K'],
      ];
      for (let i = 0; i < want; i += 1) {
        const t = titles[i % titles.length];
        await new Promise(r => setTimeout(r, 40));
        push('ok', `[${i+1}/${want}] ${t[0]} · JD ${380 + i * 17} 字`);
        jobs.push({
          id: 'mock-' + i, title: t[0], company: t[1], city: '广州', salary: t[2],
          experience_req: '3-5年', education_req: '本科', jd_text: 'x'.repeat(380 + i * 17),
          url: 'https://www.zhipin.com/job_detail/mock' + i + '.html', source: 'boss',
        });
      }
      push('ok', `抓取结束：${jobs.length} 条岗位，其中 ${jobs.length} 条有完整 JD`);
      return { ok: true, jobs, jd_jobs: jobs, fetched: jobs.length };
    },
  },
};
"""


def fake_match_items() -> dict:
    """一批分数分布真实的匹配结果，用来检查阈值筛选与配色。"""
    rows = [
        (100, "前端开发工程师（Vue）", "广州某某科技", "15-22K", ["HTML", "CSS", "JavaScript", "Vue", "TypeScript"], []),
        (100, "Vue3 前端开发", "广州某某信息", "16-24K", ["Vue", "JavaScript", "Sass"], []),
        (100, "高级前端开发（Vue/TS）", "广州某某云", "20-28K", ["Vue", "TypeScript", "JavaScript", "CSS"], []),
        (86, "AI 应用前端工程师", "广州某某智能", "18-25K", ["HTML", "JavaScript", "Vue", "大模型", "Prompt 工程"], ["React"]),
        (75, "Web 前端工程师", "某某网络", "14-20K", ["HTML", "CSS", "JavaScript", "Vite"], ["Node.js"]),
        (67, "AI 产品前端", "某某智能", "17-23K", ["Vue", "Agent 智能体", "RAG"], ["React", "Python"]),
        (50, "前端工程师（可视化）", "佛山某某软件", "13-18K", ["JavaScript", "ECharts"], ["React", "WebGL"]),
        (33, "前端开发（小程序方向）", "东莞某某科技", "12-16K", ["JavaScript"], ["小程序", "React", "Node.js"]),
        (None, "AI 应用后端工程师", "广州某某数字", "18-26K", [], []),
    ]
    items = []
    for i, (score, title, comp, salary, hit, miss) in enumerate(rows):
        items.append({
            "job": {
                "id": f"mock-{i}", "title": title, "company": comp, "city": "广州",
                "salary": salary, "url": f"https://www.zhipin.com/job_detail/mock{i}.html",
                "source": "boss", "experience_req": "3-5年", "education_req": "本科",
            },
            "score": score,
            "hit": hit,
            "miss": miss,
            "soft_hit": ["交付落地"] if score and score >= 67 else [],
            "extra": [],
            "jd_skills": hit + miss,
            "jd_len": 380 + i * 17,
            "note": "JD 里没识别到技术技能词" if score is None else "",
        })
    return {
        "resume_skills": ["HTML", "CSS", "Sass", "JavaScript", "TypeScript", "Vue", "Vue3"],
        "items": items,
        "total": len(items),
        "threshold": 90,
        "passed": sum(1 for x in items if (x["score"] or 0) >= 90),
        "best": 100,
    }


async def main(base: str, out_dir: str) -> None:
    from playwright.async_api import async_playwright

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    errors = []
    data = fake_match_items()

    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 980})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        await page.add_init_script(MOCK.replace("__BASE__", base))

        # 不往真实库写数据，两个写接口都拦掉
        await page.route("**/jobs/import", lambda route: route.fulfill(
            status=200, content_type="application/json",
            body=json.dumps({"imported": 20}),
        ))
        await page.route("**/match/skills", lambda route: route.fulfill(
            status=200, content_type="application/json",
            body=json.dumps(data, ensure_ascii=False),
        ))

        await page.goto(f"{base}/ui/", wait_until="networkidle")
        await page.wait_for_timeout(1000)

        await page.click("text=岗位库")
        await page.wait_for_timeout(1400)

        opener = page.locator("#scrape-job")
        if await opener.count():
            await opener.click()
        else:
            await page.click("text=抓取岗位")
        await page.wait_for_timeout(1200)
        await page.screenshot(path=str(out / "01-dialog-form.png"))

        await page.click("#s-run")
        await page.wait_for_timeout(3400)
        await page.screenshot(path=str(out / "02-result-90.png"))

        # 阈值拖到 50%，验证即时重筛
        await page.evaluate(
            """() => {
                const s = document.querySelector('[data-sm-slider]');
                s.value = '50';
                s.dispatchEvent(new Event('input', { bubbles: true }));
            }"""
        )
        await page.wait_for_timeout(700)
        await page.screenshot(path=str(out / "03-result-50.png"))

        print("50% 时卡片数:", await page.locator(".sm-card").count())

        await page.click("[data-sm-all]")
        await page.wait_for_timeout(600)
        await page.screenshot(path=str(out / "04-result-all.png"))
        print("显示全部卡片数:", await page.locator(".sm-card").count())
        print("头部统计:", (await page.locator("[data-sm-head]").inner_text()).replace("\n", " | "))
        print("控制台错误:", errors[:5] if errors else "无")
        await browser.close()


asyncio.run(main(sys.argv[1], sys.argv[2]))
