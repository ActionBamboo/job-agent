"""在真实安装版上跑一遍：真实简历 + 真实岗位库 + 真实匹配接口，只看薪资标红。

用法：.venv/Scripts/python.exe scripts/shot_salary_real.py <base_url> <out_dir>
"""
import asyncio
import sys
from pathlib import Path

MOCK_PRELOAD = """
window.desktop = {
  apiBase: '__BASE__',
  platform: 'win32',
  versions: { electron: 'test', chrome: 'test', node: 'test' },
  openExternal: async () => true,
  scrape: {
    onLog: () => () => {},
    checkLogin: async () => true,
    login: async () => ({ ok: true, already: true }),
    logout: async () => ({ ok: true }),
    cancel: async () => true,
    closeWindow: async () => true,
    openUrl: async () => ({ ok: true }),
    run: async () => ({ ok: true, jobs: [], jd_jobs: [], fetched: 0 }),
  },
};
"""


async def main(base: str, out_dir: str) -> None:
    from playwright.async_api import async_playwright

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    errors = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        await page.add_init_script(MOCK_PRELOAD.replace("__BASE__", base))
        await page.goto(f"{base}/ui/", wait_until="networkidle")
        await page.wait_for_timeout(800)

        exp = await page.evaluate(
            """async () => {
                const r = await fetch((window.desktop?.apiBase || '') + '/resume').catch(() => null);
                return r && r.ok ? Number((await r.json()).expected_salary || 0) : 0;
            }"""
        )
        print("真实简历期望月薪:", exp or "未填")

        await page.click("text=我的简历")
        await page.wait_for_timeout(1200)
        kv = [t.replace("\n", " ") for t in await page.locator(".kv-row").all_inner_texts()]
        print("简历页行:", next((t for t in kv if "期望月薪" in t), "!! 没找到"))
        await page.screenshot(path=str(out / "01-resume-expected.png"))

        await page.click("text=智能匹配")
        await page.wait_for_timeout(1500)
        cbs = page.locator(".job-pick input[type=checkbox]")
        n = min(6, await cbs.count())
        for i in range(n):
            await cbs.nth(i).click()
            await page.wait_for_timeout(100)
        print("勾选候选岗位:", n)
        run_btn = page.locator("#run-match")
        if await run_btn.count():
            await run_btn.first.click()
            await page.wait_for_timeout(3000)

        cards = await page.locator(".sm-card").count()
        red = await page.locator(".sm-title .s.low").count()
        red_texts = [t.strip() for t in await page.locator(".sm-title .s.low").all_inner_texts()]
        all_sal = [t.strip() for t in await page.locator(".sm-title .s").all_inner_texts()]
        print(f"结果卡片 {cards} 条 | 薪资标红 {red} 条")
        print("全部薪资:", all_sal)
        print("标红的:", red_texts)

        # 详情弹窗
        if red:
            low = page.locator(".sm-card", has=page.locator(".s.low")).first
            await low.click()
            dlg = page.locator(".overlay .dialog")
            await dlg.wait_for(state="visible", timeout=8000)
            await page.wait_for_timeout(600)
            h = dlg.locator(".jd-salhint")
            print("详情说明:", (await h.inner_text()).strip() if await h.count() else "无")
            await page.screenshot(path=str(out / "03-job-detail.png"))
            await dlg.locator("[data-close]").first.click()
            await page.wait_for_timeout(400)

        await page.locator("#match-results").scroll_into_view_if_needed()
        await page.wait_for_timeout(500)
        await page.screenshot(path=str(out / "02-match-real.png"))

        real_err = [e for e in errors if "404" not in e and "Failed to load" not in e]
        print("控制台错误:", real_err or "无")
        await browser.close()


if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "docs/shots-salary-real"
    asyncio.run(main(base, out_dir))
