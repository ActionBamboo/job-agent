"""验证匹配结果卡片上的「打招呼」入口。

和后端真实联调 /greeting，只把 /match/skills 换成固定数据（省掉跑一次抓取）。
用法：.venv/Scripts/python.exe scripts/shot_greeting_card.py <base_url> <out_dir>
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

JD = """岗位职责：
1. 负责智能体（Agent）框架的设计与开发，支持多智能体协作与任务编排；
2. 建设工具调用（Function Calling）与 MCP 协议生态；
3. 设计智能体的记忆、规划与反思机制；
4. 跟进前沿 Agent 技术并落地到产品。
任职要求：
1. 精通 Python，熟悉 LangGraph/AutoGen 等 Agent 框架；
2. 深入理解 LLM 能力边界与 Prompt 工程；
3. 有 MCP、函数调用、结构化输出实战经验；
4. 有开源项目或 Agent 产品落地经验者优先。"""


def payload() -> dict:
    items = []
    for i, (score, title, comp, salary) in enumerate([
        (78, "AI Agent 应用开发工程师", "某智能科技", "20-35K·14薪"),
        (66, "AI 应用前端工程师", "长亮科技", "18-25K"),
    ]):
        items.append({
            "job": {
                "id": "gr-test-1" if i == 0 else "gr-test-2",
                "title": title, "company": comp, "city": "广州", "salary": salary,
                "url": f"https://www.zhipin.com/job_detail/gr-test-{i + 1}.html",
                "source": "boss", "experience_req": "3-5年", "education_req": "本科",
                "jd_text": JD if i == 0 else JD[:160],
            },
            "score": score,
            "hit": ["TypeScript", "LangGraph.js", "MCP", "Agent"],
            "miss": ["Python", "AutoGen"],
            "bonus_miss": [], "soft_hit": [], "extra": [],
            "jd_skills": ["TypeScript", "LangGraph.js", "MCP", "Agent", "Python", "AutoGen"],
            "jd_len": len(JD), "note": "",
        })
    return {"resume_skills": ["TypeScript", "LangGraph.js", "MCP"], "items": items,
            "total": len(items), "threshold": 80, "passed": 0, "best": 78}


async def main(base: str, out_dir: str) -> None:
    from playwright.async_api import async_playwright

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    errors = []
    data = payload()

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
        await page.wait_for_timeout(1600)

        cbs = page.locator(".job-pick input[type=checkbox]")
        n = min(2, await cbs.count())
        for i in range(n):
            await cbs.nth(i).click()
            await page.wait_for_timeout(120)
        await page.wait_for_timeout(300)

        run_btn = page.locator("#run-match")
        if await run_btn.count():
            await run_btn.first.click()
            await page.wait_for_timeout(2500)

        print("匹配结果卡片数:", await page.locator(".sm-card").count())
        greets = page.locator("[data-greet]")
        print("卡片上的「打招呼」按钮数:", await greets.count())
        if await page.locator(".sm-card").count():
            await page.locator(".sm-card").first.scroll_into_view_if_needed()
            await page.wait_for_timeout(400)
        await page.screenshot(path=str(out / "06-card-greet-btn.png"))

        if not await greets.count():
            print("!! 卡片上没有打招呼按钮")
            print("控制台错误:", errors[:5])
            await browser.close()
            return

        await greets.first.click()
        gdlg = page.locator(".overlay .dialog").last
        await gdlg.wait_for(state="visible", timeout=10000)
        print("弹窗标题:", (await gdlg.locator("h3").inner_text()).strip())
        print("弹窗副标题:", (await gdlg.locator(".dialog-head p").inner_text()).strip())
        try:
            await gdlg.locator(".gr-text").wait_for(state="visible", timeout=60000)
            print("生成成功，字数:", (await gdlg.locator("[data-gr-count]").inner_text()).strip())
            print("正文:", (await gdlg.locator(".gr-text").input_value())[:120])
            await page.screenshot(path=str(out / "07-card-greeting.png"))
        except Exception as e:
            print("生成超时:", str(e)[:80])
            print("正文:", (await gdlg.inner_text())[:200])

        # 再点第二张卡（JD 很短的那条），确认不会把上一份结果串过来
        await gdlg.locator("[data-close]").first.click()
        await page.wait_for_timeout(400)
        await greets.nth(1).click()
        gdlg2 = page.locator(".overlay .dialog").last
        await gdlg2.wait_for(state="visible", timeout=10000)
        print("\n第二条弹窗副标题:", (await gdlg2.locator(".dialog-head p").inner_text()).strip())
        try:
            await gdlg2.locator(".gr-text").wait_for(state="visible", timeout=60000)
            print("第二条字数:", (await gdlg2.locator("[data-gr-count]").inner_text()).strip())
        except Exception as e:
            print("第二条超时:", str(e)[:80])

        print("\n控制台错误:", errors[:6] if errors else "无")
        await browser.close()


if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8176"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "docs/shots-greeting"
    asyncio.run(main(base, out_dir))
