"""验证候选岗位卡片的「勾选 / 看详情」分离，以及看原岗位真的会打开。

用 Playwright 打开后端 /ui/，注入 mock 的 window.desktop（模拟 Electron preload），
记录 scrape.openUrl 与 openExternal 的调用，确认按钮不再是「点了没反应」。

用法：.venv/Scripts/python.exe scripts/shot_job_detail.py <base_url> <out_dir>
"""
import asyncio
import json
import sys
from pathlib import Path

MOCK = """
window.__calls = { openUrl: [], openExternal: [] };
window.desktop = {
  apiBase: '__BASE__',
  platform: 'win32',
  versions: { electron: 'test', chrome: 'test', node: 'test' },
  openExternal: async (u) => { window.__calls.openExternal.push(u); return true; },
  scrape: {
    onLog: (cb) => { window.__scrapeCbs = window.__scrapeCbs || []; window.__scrapeCbs.push(cb);
                     return () => { window.__scrapeCbs = (window.__scrapeCbs||[]).filter(x => x !== cb); }; },
    checkLogin: async () => true,
    login: async () => ({ ok: true, already: true }),
    logout: async () => ({ ok: true }),
    cancel: async () => true,
    closeWindow: async () => true,
    openUrl: async (p) => { window.__calls.openUrl.push(p); return { ok: true }; },
    run: async (p) => {
      const jobs = [];
      for (let i = 0; i < (p.detailLimit || 6); i += 1) {
        jobs.push({
          id: 'mock-' + i, title: '前端开发工程师 ' + i, company: '示例公司 ' + i,
          city: '广州', salary: ['15-25K·14薪', '18-30K', '12-18K·13薪'][i % 3],
          experience_req: '3-5年', education_req: '本科',
          jd_text: '岗位职责\\n1. 负责前端开发，熟悉 Vue、JavaScript、CSS\\n2. 会用 TypeScript 优先\\n' + 'x'.repeat(60),
          url: 'https://www.zhipin.com/job_detail/mock' + i + '.html', source: 'boss',
        });
      }
      return { ok: true, jobs, jd_jobs: jobs, fetched: jobs.length };
    },
  },
};
"""


def fake_match_items() -> dict:
    rows = [
        (100, "前端开发工程师（Vue）", "广州某某科技", "15-22K·13薪", ["HTML", "CSS", "JavaScript", "Vue"], []),
        (86, "AI 应用前端工程师", "广州某某智能", "18-25K", ["HTML", "JavaScript", "Vue"], ["React", "Node.js"]),
        (67, "Web 前端工程师", "某某网络", "14-20K", ["HTML", "CSS"], ["React", "TypeScript"]),
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
            "hit": hit, "miss": miss, "bonus_miss": ["React"], "soft_hit": [], "extra": [],
            "jd_skills": hit + miss, "jd_len": 380 + i * 17, "note": "",
        })
    return {"resume_skills": ["HTML", "CSS", "Vue"], "items": items, "total": len(items),
            "threshold": 80, "passed": 2, "best": 100}


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
        await page.route("**/jobs/import", lambda r: r.fulfill(
            status=200, content_type="application/json", body=json.dumps({"imported": 3})))
        await page.route("**/match/skills", lambda r: r.fulfill(
            status=200, content_type="application/json", body=json.dumps(data, ensure_ascii=False)))

        await page.goto(f"{base}/ui/", wait_until="networkidle")
        await page.wait_for_timeout(800)

        # ---- 1. 智能匹配页：候选岗位卡片 ----
        await page.click("text=智能匹配")
        await page.wait_for_timeout(1600)
        await page.screenshot(path=str(out / "01-candidates.png"))

        first = page.locator(".job-pick").first
        print("候选卡片数:", await page.locator(".job-pick").count())
        print("第一张卡片薪资:", (await first.locator(".salary").inner_text()).strip())
        print("空薪资的卡片数:", await page.locator(".job-pick .salary.none").count())

        # 点勾选框：应该只勾选，不弹详情
        await first.locator("input[type=checkbox]").click()
        await page.wait_for_timeout(400)
        print("勾选后详情弹窗数:", await page.locator(".overlay .dialog").count())
        print("已选计数:", (await page.locator("#sel-count").inner_text()).strip())
        await page.screenshot(path=str(out / "02-candidate-picked.png"))

        # 再点一次 = 取消
        await first.locator("input[type=checkbox]").click()
        await page.wait_for_timeout(300)
        print("取消勾选后计数:", (await page.locator("#sel-count").inner_text()).strip())

        # 点卡片主体：应该弹详情
        await first.locator(".t .nm").click()
        await page.wait_for_timeout(1200)
        dlg = page.locator(".overlay .dialog")
        print("点卡片后详情弹窗数:", await dlg.count())
        if await dlg.count():
            print("详情标题:", (await dlg.locator("h3").inner_text()).strip())
            print("详情副标题:", (await dlg.locator(".dialog-head p").inner_text()).strip())
            print("JD 字数提示:", (await dlg.locator(".jd-body").inner_text())[:40].replace("\n", " "))
            await page.screenshot(path=str(out / "03-job-detail.png"))

            # 看原岗位（内置浏览器）
            await dlg.locator("#jd-orig").click()
            await page.wait_for_timeout(500)
            calls = await page.evaluate("() => window.__calls")
            print("openUrl 调用:", json.dumps(calls["openUrl"], ensure_ascii=False))
            await dlg.locator("[data-close]").first.click()
            await page.wait_for_timeout(300)

        # ---- 2. 抓取弹窗里的结果卡：勾选 + 看原岗位 ----
        await page.click("text=岗位库")
        await page.wait_for_timeout(1400)
        await page.click("#scrape-job")
        await page.wait_for_timeout(1000)
        run = page.locator("#s-run")
        if await run.count():
            await run.click()
            await page.wait_for_timeout(2600)
            print("结果卡片数:", await page.locator(".sm-card").count())
            print("结果卡薪资样例:", (await page.locator(".sm-card .sm-title").first.inner_text()).replace("\n", " "))
            await page.screenshot(path=str(out / "04-scrape-result.png"))

            # 勾选第一条结果卡
            await page.locator(".sm-card .sm-pick input").first.click()
            await page.wait_for_timeout(400)
            print("勾选后仍为结果卡（无详情弹窗）:", await page.locator(".overlay .dialog").count())
            print("只看勾选按钮:", (await page.locator("[data-sm-only]").inner_text()).strip())
            await page.screenshot(path=str(out / "05-scrape-picked.png"))

            # 点「看原岗位」
            await page.locator(".sm-card [data-orig]").first.click()
            await page.wait_for_timeout(600)
            calls = await page.evaluate("() => window.__calls")
            print("看原岗位后 openUrl 调用数:", len(calls["openUrl"]),
                  "最后一条:", json.dumps(calls["openUrl"][-1], ensure_ascii=False) if calls["openUrl"] else None)

            # 点卡片正文 → 详情
            await page.locator(".sm-card .sm-title .t").first.click()
            await page.wait_for_timeout(900)
            print("点结果卡后详情弹窗数:", await page.locator(".overlay .dialog").count())

        print("控制台错误:", errors[:6] if errors else "无")

        # ---- 3. 岗位库列表点卡片 → 详情；智能匹配页技能匹配结果点卡片 → 详情 ----
        await page.evaluate("() => document.querySelectorAll('.overlay').forEach((o) => o.remove())")
        await page.wait_for_timeout(300)
        await page.click("text=岗位库")
        await page.wait_for_timeout(1200)
        await page.locator("#job-list-wrap .job-item").first.click()
        await page.wait_for_timeout(900)
        lib = page.locator(".overlay .dialog")
        print("岗位库点卡片详情数:", await lib.count())
        if await lib.count():
            print("岗位库详情标题:", (await lib.locator("h3").inner_text()).strip()[:30])
            await lib.locator("[data-close]").first.click()
            await page.wait_for_timeout(300)

        await page.click("text=智能匹配")
        await page.wait_for_timeout(1200)
        # 技能匹配要先勾一条，否则会提示「先勾选至少一个岗位」
        await page.locator(".job-pick input[type=checkbox]").first.click()
        await page.wait_for_timeout(300)
        await page.click("#run-match")
        await page.wait_for_timeout(1600)
        print("匹配页结果卡数:", await page.locator("#match-results .sm-card").count())
        await page.screenshot(path=str(out / "06-match-results.png"))
        if await page.locator("#match-results .sm-card").count():
            await page.locator("#match-results .sm-card .sm-title .t").first.click()
            await page.wait_for_timeout(900)
            d2 = page.locator(".overlay .dialog")
            print("匹配结果点卡片详情数:", await d2.count())
            if await d2.count():
                print("详情里有匹配度块:", await d2.locator(".jd-score").count())
                await page.screenshot(path=str(out / "07-match-detail.png"))

        await browser.close()


asyncio.run(main(sys.argv[1], sys.argv[2]))
