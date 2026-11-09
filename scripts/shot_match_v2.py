"""截图验证「智能匹配」改版：平台 + 期望职位动态选择。开发辅助脚本。"""
import asyncio
import sys
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8151/ui/"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("data/tmp/shots-match")
OUT.mkdir(parents=True, exist_ok=True)


async def main() -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=2)
        problems = []
        page.on("console", lambda m: problems.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: problems.append(f"[pageerror] {e}"))

        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(800)

        await page.click('.nav-item[data-route="match"]')
        await page.wait_for_timeout(1400)
        await page.screenshot(path=str(OUT / "match-1-empty.png"))
        print("shot ->", OUT / "match-1-empty.png")

        info = await page.evaluate(
            """() => ({
                platforms: Array.from(document.querySelectorAll('#in-source option')).map(o => o.textContent),
                cities: Array.from(document.querySelectorAll('#in-city option')).map(o => o.textContent),
                groups: Array.from(document.querySelectorAll('#in-groups .intent-group')).map(g => ({
                    name: g.querySelector('.g-name').textContent,
                    count: g.querySelectorAll('.tag').length,
                })),
                note: document.querySelector('#in-note').textContent,
            })"""
        )
        print("平台:", info["platforms"])
        print("城市前 6:", info["cities"][:6], "共", len(info["cities"]))
        print("职位分组:", info["groups"])
        print("提示:", info["note"])

        # 点选两个期望职位
        await page.click('#in-groups .tag:has-text("前端开发")')
        await page.wait_for_timeout(250)
        await page.click('#in-groups .tag:has-text("AI应用开发")')
        await page.wait_for_timeout(250)
        # 手输一个自定义职位
        await page.fill("#in-input", "Electron")
        await page.press("#in-input", "Enter")
        await page.wait_for_timeout(500)
        chips = await page.eval_on_selector_all("#in-chips .chip", "els => els.map(e => e.textContent.replace('×','').trim())")
        print("已选期望职位:", chips)
        await page.screenshot(path=str(OUT / "match-2-picked.png"))
        print("shot ->", OUT / "match-2-picked.png")

        # 切到智联（未添加时应给出提示）
        await page.select_option("#in-source", "boss")
        await page.wait_for_timeout(900)

        # 看候选岗位区
        jobs = await page.eval_on_selector_all("#job-picker .job-item .t", "els => els.map(e => e.textContent.trim())")
        print("候选岗位(当前平台):", jobs[:6], "共", len(jobs))
        await page.screenshot(path=str(OUT / "match-3-jobs.png"))
        print("shot ->", OUT / "match-3-jobs.png")

        # 关闭「只看当前平台」看全部
        await page.click("#only-current + .track")
        await page.wait_for_timeout(900)
        all_jobs = await page.eval_on_selector_all("#job-picker .job-item", "els => els.length")
        print("关闭只看当前平台后的岗位数:", all_jobs)
        await page.click("#only-current + .track")
        await page.wait_for_timeout(800)

        if problems:
            print("\n=== 控制台报错 ===")
            for x in problems[:20]:
                print(x)
        else:
            print("\n控制台无报错")

        await browser.close()


asyncio.run(main())
