"""截图验证「智能匹配」真实流程（开发辅助脚本）。"""
import asyncio
import sys
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8124/ui/"
OUT = Path("data/tmp/shots")
OUT.mkdir(parents=True, exist_ok=True)


async def main() -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=2)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(800)
        await page.click('.nav-item[data-route="match"]')
        await page.wait_for_timeout(900)
        # 勾选前两个岗位
        cbs = await page.query_selector_all("[data-cb]")
        for cb in cbs[:2]:
            await cb.check()
        await page.wait_for_timeout(200)
        await page.screenshot(path=str(OUT / "match-selected.png"))
        await page.click("#run-match")
        # 等待结果出完（最多 150 秒）
        for _ in range(150):
            await page.wait_for_timeout(1000)
            txt = await page.inner_text("#match-progress")
            if "完成" in txt:
                break
        await page.wait_for_timeout(700)
        await page.screenshot(path=str(OUT / "match-result.png"), full_page=True)
        print("done; progress =", (await page.inner_text("#match-progress")).replace("\n", " "))
        if errs:
            print("page errors:", errs[:5])
        await browser.close()


asyncio.run(main())
