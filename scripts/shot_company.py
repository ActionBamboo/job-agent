"""验证「查公司」这条链路：匹配结果卡片 → 调研弹窗 → 好评/差评/外包判定。

和后端真实联调（不 mock /company/research），只是把 /match/skills 换成固定数据，
免得还要跑一遍抓取。公司名用真实的，调研才查得到东西。

用法：.venv/Scripts/python.exe scripts/shot_company.py <base_url> <out_dir>
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
    onLog: () => () => {},
    checkLogin: async () => true,
    login: async () => ({ ok: true, already: true }),
    logout: async () => ({ ok: true }),
    cancel: async () => true,
    closeWindow: async () => true,
    openUrl: async (p) => { window.__calls.openUrl.push(p); return { ok: true }; },
    run: async () => ({ ok: true, jobs: [], jd_jobs: [], fetched: 0 }),
  },
};
"""


def match_items() -> dict:
    rows = [
        (92, "前端研发工程师", "博彦科技", "15-22K·13薪"),
        (81, "AI 应用前端工程师", "长亮科技", "18-25K"),
        (74, "Web 前端工程师", "酷麦计算机", "14-20K"),
    ]
    items = []
    for i, (score, title, comp, salary) in enumerate(rows):
        items.append({
            "job": {
                "id": f"mock-{i}", "title": title, "company": comp, "city": "广州",
                "salary": salary, "url": f"https://www.zhipin.com/job_detail/mock{i}.html",
                "source": "boss", "experience_req": "3-5年", "education_req": "本科",
            },
            "score": score,
            "hit": ["HTML", "CSS", "JavaScript", "Vue"], "miss": ["React"],
            "bonus_miss": ["TypeScript"], "soft_hit": [], "extra": [],
            "jd_skills": ["HTML", "CSS", "JavaScript", "Vue", "React"],
            "jd_len": 420 + i * 30, "note": "",
        })
    return {"resume_skills": ["HTML", "CSS", "Vue"], "items": items, "total": len(items),
            "threshold": 80, "passed": 3, "best": 92}


async def main(base: str, out_dir: str) -> None:
    from playwright.async_api import async_playwright

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    errors = []
    data = match_items()

    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 980})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        await page.add_init_script(MOCK.replace("__BASE__", base))
        await page.route("**/match/skills", lambda r: r.fulfill(
            status=200, content_type="application/json", body=json.dumps(data, ensure_ascii=False)))

        await page.goto(f"{base}/ui/", wait_until="networkidle")
        await page.wait_for_timeout(700)

        await page.click("text=智能匹配")
        await page.wait_for_timeout(1500)

        # 「技能匹配」按钮在没勾选岗位时是禁用的，先勾几条候选岗位
        cbs = page.locator(".job-pick input[type=checkbox]")
        pick_n = min(3, await cbs.count())
        print("候选岗位数:", await page.locator(".job-pick").count(), "| 勾选", pick_n, "条")
        for i in range(pick_n):
            await cbs.nth(i).click()
            await page.wait_for_timeout(150)
        await page.wait_for_timeout(400)

        # 跑一次技能匹配，拿到带「查公司」按钮的结果卡
        run_btn = page.locator("#run-match")
        print("技能匹配按钮数:", await run_btn.count(), "| 可用:", await run_btn.first.is_enabled() if await run_btn.count() else False)
        if await run_btn.count():
            await run_btn.first.click()
            await page.wait_for_timeout(3000)

        cards = page.locator(".sm-card")
        print("匹配结果卡片数:", await cards.count())
        comp_btns = page.locator("[data-company]")
        print("「查公司」按钮数:", await comp_btns.count())
        await page.screenshot(path=str(out / "01-match-with-company-btn.png"))

        if not await comp_btns.count():
            print("!! 没找到查公司按钮，后面跳过")
            print("控制台错误:", errors[:5])
            await browser.close()
            return

        # ---- 点第一条（博彦科技）：真调研 ----
        await comp_btns.first.click()
        dlg = page.locator(".overlay .dialog")
        await dlg.wait_for(state="visible", timeout=8000)
        print("弹窗标题:", (await dlg.locator("h3").inner_text()).strip())
        # 等调研出结果（三个搜索 + 大模型，给足时间）
        try:
            await dlg.locator(".cr-top").wait_for(state="visible", timeout=45000)
        except Exception as e:
            print("调研超时:", str(e)[:80])
            print("弹窗正文:", (await dlg.inner_text())[:300])
            await page.screenshot(path=str(out / "02-company-timeout.png"))
            await browser.close()
            return

        print("--- 调研结论 ---")
        print("建议:", (await dlg.locator(".cr-verdict b").inner_text()).strip())
        print("置信度:", (await dlg.locator(".cr-verdict span").inner_text()).strip())
        print("外包判定行:", (await dlg.locator(".cr-line").inner_text()).strip().replace("\n", " "))
        print("正面评价条数:", await dlg.locator(".cr-list.pros li").count())
        print("负面评价条数:", await dlg.locator(".cr-list.cons li").count())
        print("信号词:", (await dlg.locator(".cr-block .chip").all_inner_texts())[:6])
        print("依据折叠标题:", (await dlg.locator(".cr-details summary").inner_text()).strip())
        await page.screenshot(path=str(out / "02-company-research.png"))

        # 展开依据
        await dlg.locator(".cr-details summary").click()
        await page.wait_for_timeout(500)
        print("展开后搜索来源块数:", await dlg.locator(".cr-src").count())
        await page.screenshot(path=str(out / "03-company-evidence.png"))

        await dlg.locator("[data-close]").first.click()
        await page.wait_for_timeout(400)

        # ---- 第二条（长亮科技）：真实抓取，验证不同公司结果不同 ----
        await comp_btns.nth(1).click()
        dlg = page.locator(".overlay .dialog")
        await dlg.wait_for(state="visible", timeout=8000)
        print("第二条弹窗标题:", (await dlg.locator("h3").inner_text()).strip())
        try:
            await dlg.locator(".cr-top").wait_for(state="visible", timeout=45000)
            print("第二条建议:", (await dlg.locator(".cr-verdict b").inner_text()).strip())
            print("第二条外包判定:", (await dlg.locator(".cr-line").inner_text()).strip().replace("\n", " "))
            print("第二条正面条数:", await dlg.locator(".cr-list.pros li").count())
            print("第二条负面条数:", await dlg.locator(".cr-list.cons li").count())
            await page.screenshot(path=str(out / "04-company-second.png"))
        except Exception as e:
            print("第二条超时:", str(e)[:60])

        print("控制台错误:", errors[:6] if errors else "无")
        await browser.close()


if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8170"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "docs/shots-company"
    asyncio.run(main(base, out_dir))
