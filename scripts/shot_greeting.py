"""验证「打招呼语」这条链路：岗位库 → 岗位详情 → 写打招呼语 → 三版 / 编辑 / 重写。

和后端真实联调（真调大模型），不 mock /greeting——这个功能的价值全在文案质量，
mock 出来的东西看不出好坏。

用法：.venv/Scripts/python.exe scripts/shot_greeting.py <base_url> <out_dir> [岗位关键词]
"""
import asyncio
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


async def main(base: str, out_dir: str, keyword: str) -> None:
    from playwright.async_api import async_playwright

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    errors = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 980})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        await page.add_init_script(MOCK.replace("__BASE__", base))

        await page.goto(f"{base}/ui/", wait_until="networkidle")
        await page.wait_for_timeout(700)

        await page.click("text=岗位库")
        await page.wait_for_timeout(1200)

        search = page.locator("#job-search")
        await search.fill(keyword)
        await page.wait_for_timeout(1200)
        rows = page.locator(".job-item")
        print(f"搜索「{keyword}」命中岗位数:", await rows.count())
        if not await rows.count():
            print("!! 没搜到岗位，无法继续")
            await browser.close()
            return
        await page.screenshot(path=str(out / "01-job-list.png"))

        # ---- 岗位详情 → 写打招呼语 ----
        await rows.first.click()
        dlg = page.locator(".overlay .dialog").first
        await dlg.wait_for(state="visible", timeout=8000)
        print("详情弹窗标题:", (await dlg.locator("h3").inner_text()).strip())
        greet_btn = dlg.locator("#jd-greet")
        print("「写打招呼语」按钮存在:", await greet_btn.count() > 0)
        await page.screenshot(path=str(out / "02-job-detail-with-greet-btn.png"))

        await greet_btn.click()
        page2 = 0
        # 第二个弹窗（打招呼语）在 DOM 后面，取最后一个
        gdlg = page.locator(".overlay .dialog").last
        await gdlg.wait_for(state="visible", timeout=10000)
        print("打招呼弹窗标题:", (await gdlg.locator("h3").inner_text()).strip())

        # 等生成结果：真调大模型，给足时间
        try:
            await gdlg.locator(".gr-text").wait_for(state="visible", timeout=60000)
        except Exception as e:
            print("生成超时:", str(e)[:80])
            print("弹窗正文:", (await gdlg.inner_text())[:300])
            await page.screenshot(path=str(out / "03-greeting-timeout.png"))
            await browser.close()
            return

        tabs = gdlg.locator(".gr-tab")
        print("\n--- 三个版本 ---")
        for i in range(await tabs.count()):
            print("  标签:", (await tabs.nth(i).inner_text()).replace("\n", " "))

        print("\n当前版本正文:")
        print("  " + (await gdlg.locator(".gr-text").input_value()).replace("\n", " / "))
        print("字数显示:", (await gdlg.locator("[data-gr-count]").inner_text()).strip())
        print("适用范围:", (await gdlg.locator(".gr-use").inner_text()).strip())

        print("\n我拿什么对上:", await gdlg.locator(".gr-list.good li").count(), "条")
        print("缺什么:", await gdlg.locator(".gr-list.warn li").count(), "条")
        tip = gdlg.locator(".gr-tip")
        if await tip.count():
            print("提醒:", (await tip.inner_text()).strip()[:120])
        await page.screenshot(path=str(out / "03-greeting-match.png"))

        # ---- 切到项目切入版 ----
        await tabs.nth(1).click()
        await page.wait_for_timeout(500)
        print("\n切到第二个版本后的正文:")
        print("  " + (await gdlg.locator(".gr-text").input_value()).replace("\n", " / "))
        await page.screenshot(path=str(out / "04-greeting-case.png"))

        # ---- 编辑：字数要跟着变 ----
        ta = gdlg.locator(".gr-text")
        orig = await ta.input_value()
        await ta.fill(orig + "本周可到岗面试。")
        await page.wait_for_timeout(300)
        print("\n编辑后字数显示:", (await gdlg.locator("[data-gr-count]").inner_text()).strip())
        print("编辑后标签字数:", (await gdlg.locator(".gr-tab").nth(1).inner_text()).replace("\n", " "))

        # 切走再切回来，改动不能丢
        await tabs.nth(0).click()
        await page.wait_for_timeout(300)
        await tabs.nth(1).click()
        await page.wait_for_timeout(300)
        kept = await ta.input_value()
        print("来回切换后改动还在:", "本周可到岗面试" in kept)

        # ---- 复制 ----
        await gdlg.locator("[data-gr-copy]").click()
        await page.wait_for_timeout(600)
        toasts = page.locator(".toast")
        print("复制后提示:", (await toasts.first.inner_text()).strip() if await toasts.count() else "（没出现）")

        # ---- 带追加要求重写 ----
        print("\n--- 追加要求重写 ---")
        await gdlg.locator("[data-gr-extra]").fill("再短一点，别提前端两个字")
        await gdlg.locator("[data-gr-rewrite]").click()
        try:
            await gdlg.locator(".gr-text").wait_for(state="visible", timeout=60000)
            await page.wait_for_timeout(800)
            new_text = await ta.input_value()
            print("重写后正文:")
            print("  " + new_text.replace("\n", " / "))
            print("含「前端」:", "前端" in new_text)
            print("重写后字数:", (await gdlg.locator("[data-gr-count]").inner_text()).strip())
            await page.screenshot(path=str(out / "05-greeting-rewrite.png"))
        except Exception as e:
            print("重写超时:", str(e)[:80])

        print("\n控制台错误:", errors[:6] if errors else "无")
        await browser.close()


if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8176"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "docs/shots-greeting"
    kw = sys.argv[3] if len(sys.argv) > 3 else "AI Agent"
    asyncio.run(main(base, out_dir, kw))
