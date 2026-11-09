"""验证智能匹配页「按意向抓取」的完整交互（抓取请求被拦截，不真的开浏览器）。

用法：.venv/Scripts/python.exe scripts/shot_match_flow.py http://127.0.0.1:8151/ui/ data/tmp/shots-match2
"""
import asyncio
import json
import sys
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8151/ui/"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("data/tmp/shots-match2")
OUT.mkdir(parents=True, exist_ok=True)

FAKE_LOGS = [
    (0.4, "info", "[BOSS直聘] 第 1/2 个期望职位：前端开发 · 广州 · 前 1 页"),
    (2.1, "info", "[BOSS直聘] 打开搜索页：前端开发 @ 广州"),
    (6.8, "info", "第 1 页解析到 15 张岗位卡片"),
    (7.0, "info", "开始抓取 7 条岗位详情…"),
    (7.9, "ok", "[1/7] 前端开发工程师 · 某智能科技（JD 486 字）"),
    (9.4, "ok", "[2/7] Web 前端（AI 应用方向） · 某 SaaS（JD 512 字）"),
    (11.2, "info", "[BOSS直聘] 第 2/2 个期望职位：AI应用开发 · 广州 · 前 1 页"),
    (15.6, "info", "第 1 页解析到 12 张岗位卡片"),
    (18.3, "ok", "「AI应用开发」抓到 12 条，去重累计 21 条"),
    (18.6, "ok", "已入库 21 条岗位，岗位库现有 28 条"),
]


async def main() -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=2)
        problems = []
        page.on("console", lambda m: problems.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: problems.append(f"[pageerror] {e}"))

        posted = {}
        state = {"polls": 0}

        async def on_run(route):
            posted.update(json.loads(route.request.post_data or "{}"))
            await route.fulfill(
                status=200, content_type="application/json",
                body=json.dumps({
                    "id": "fake-task", "kind": "scrape", "status": "running", "params": posted,
                    "logs": [], "next_seq": 0, "result": None, "error": None, "elapsed": 0.0,
                }),
            )

        async def on_task(route):
            state["polls"] += 1
            if state["polls"] < 3:
                logs = [{"seq": i, "t": t, "level": lv, "msg": m}
                        for i, (t, lv, m) in enumerate(FAKE_LOGS[: state["polls"] * 4])]
                body = {"id": "fake-task", "kind": "scrape", "status": "running", "params": posted,
                        "logs": logs, "next_seq": len(logs), "result": None, "error": None, "elapsed": 3.0}
            else:
                logs = [{"seq": i, "t": t, "level": lv, "msg": m}
                        for i, (t, lv, m) in enumerate(FAKE_LOGS)]
                body = {"id": "fake-task", "kind": "scrape", "status": "done", "params": posted,
                        "logs": logs, "next_seq": len(logs),
                        "result": {"fetched": 21, "total": 28, "source": posted.get("source")},
                        "error": None, "elapsed": 18.6}
            await route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

        await page.route("**/scrape/run", on_run)
        await page.route("**/tasks/*", on_task)

        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(600)
        await page.click('.nav-item[data-route="match"]')
        await page.wait_for_timeout(1300)

        await page.click('#in-groups .tag:has-text("前端开发")')
        await page.click('#in-groups .tag:has-text("AI应用开发")')
        await page.wait_for_timeout(300)
        await page.select_option("#in-city", "广州")
        await page.wait_for_timeout(200)

        await page.click("#in-fetch")
        await page.wait_for_timeout(700)
        await page.screenshot(path=str(OUT / "flow-1-running.png"))
        print("shot ->", OUT / "flow-1-running.png")

        await page.wait_for_timeout(2600)
        lines = await page.eval_on_selector_all("#in-console .ln .tx", "els => els.map(e => e.textContent)")
        print("日志行数:", len(lines))
        print("末行:", lines[-1] if lines else "(无)")
        toasts = await page.eval_on_selector_all("#toast-root .toast", "els => els.map(e => e.textContent.trim())")
        print("提示:", toasts)
        await page.screenshot(path=str(OUT / "flow-2-done.png"))
        print("shot ->", OUT / "flow-2-done.png")

        print("\n提交的抓取参数:", json.dumps(posted, ensure_ascii=False))
        checked = await page.eval_on_selector_all("#job-picker [data-cb]", "els => els.filter(e => e.checked).length")
        print("抓完自动勾选的岗位数:", checked)

        if problems:
            print("\n=== 控制台报错 ===")
            for x in problems[:20]:
                print(x)
        else:
            print("\n控制台无报错")

        await browser.close()


asyncio.run(main())
