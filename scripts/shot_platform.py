"""截图验证「添加平台」弹窗改版（下拉选择）。开发辅助脚本。"""
import asyncio
import sys
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8141/ui/"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("data/tmp/shots2")
OUT.mkdir(parents=True, exist_ok=True)


async def main() -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 940}, device_scale_factor=2)
        problems = []
        page.on("console", lambda m: problems.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: problems.append(f"[pageerror] {e}"))

        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(900)

        # 进入岗位库，打开添加平台弹窗
        await page.click('.nav-item[data-route="jobs"]')
        await page.wait_for_timeout(900)
        await page.click("#add-platform")
        await page.wait_for_timeout(700)
        await page.screenshot(path=str(OUT / "dialog-empty.png"))
        print("shot ->", OUT / "dialog-empty.png")

        # 下拉选项清单
        opts = await page.eval_on_selector_all("#p-preset option", "els => els.map(e => e.textContent)")
        print("下拉选项:", opts)

        # 选智联招聘
        await page.select_option("#p-preset", "zhaopin")
        await page.wait_for_timeout(600)
        await page.screenshot(path=str(OUT / "dialog-zhaopin.png"))
        print("shot ->", OUT / "dialog-zhaopin.png")

        filled = await page.evaluate(
            """() => ({
                key: document.querySelector('#key').value,
                name: document.querySelector('#name').value,
                login_url: document.querySelector('#login_url').value,
                search_url: document.querySelector('#search_url').value,
                hints: document.querySelector('#login_cookie_hints').value,
                card: document.querySelector('#card_selectors').value,
            })"""
        )
        print("自动填充:", filled)

        # 展开高级设置
        await page.click("#p-adv > summary")
        await page.wait_for_timeout(500)
        await page.screenshot(path=str(OUT / "dialog-advanced.png"), full_page=True)
        print("shot ->", OUT / "dialog-advanced.png")

        # 选 51job 再验一次
        await page.select_option("#p-preset", "job51")
        await page.wait_for_timeout(500)
        await page.screenshot(path=str(OUT / "dialog-job51.png"))
        print("shot ->", OUT / "dialog-job51.png")

        if problems:
            print("\n=== 控制台报错 ===")
            for x in problems[:20]:
                print(x)
        else:
            print("\n控制台无报错")

        await browser.close()


asyncio.run(main())
