"""用 Playwright 截图验证桌面端 UI 渲染（开发辅助脚本）。"""
import asyncio
import sys
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8124/ui/"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("data/tmp/shots")
OUT.mkdir(parents=True, exist_ok=True)

VIEWS = ["dashboard", "resume", "jobs", "match", "history", "settings"]


async def main() -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
        errors = []
        page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(1200)

        for v in VIEWS:
            await page.click(f'.nav-item[data-route="{v}"]')
            await page.wait_for_timeout(1100)
            await page.screenshot(path=str(OUT / f"{v}.png"))
            print(f"shot -> {OUT / (v + '.png')}")

        if errors:
            print("\n=== 控制台问题 ===")
            for e in errors[:40]:
                print(e)
        else:
            print("\n控制台无报错")
        await browser.close()


asyncio.run(main())
