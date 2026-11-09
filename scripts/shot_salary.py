"""验证「薪资低于期望 → 标红」这条链路。

只做一件事：低于期望的岗位把薪资标红，其余什么都不加。
/matched/skills 用固定数据（要覆盖低/不低两种情况才好断言），其他走真实后端。

用法：.venv/Scripts/python.exe scripts/shot_salary.py <base_url> <out_dir>
"""
import asyncio
import json
import sys
from pathlib import Path

MOCK_PRELOAD = """
window.__desktop_calls = { openUrl: [], openExternal: [] };
window.desktop = {
  apiBase: '__BASE__',
  platform: 'win32',
  versions: { electron: 'test', chrome: 'test', node: 'test' },
  openExternal: async (u) => { window.__desktop_calls.openExternal.push(u); return true; },
  scrape: {
    onLog: () => () => {},
    checkLogin: async () => true,
    login: async () => ({ ok: true, already: true }),
    logout: async () => ({ ok: true }),
    cancel: async () => true,
    closeWindow: async () => true,
    openUrl: async (p) => { window.__desktop_calls.openUrl.push(p); return { ok: true }; },
    run: async () => ({ ok: true, jobs: [], jd_jobs: [], fetched: 0 }),
  },
};
"""

# (分数, 岗位, 公司, 薪资, 提示等级, 提示文案)
ROWS = [
    (100, "前端开发工程师", "博彦科技", "18-25K", "ok", "达到期望：18-25K，期望 15K"),
    (92, "Vue 前端工程师", "长亮科技", "12-18K", "near", "期望 15K 落在区间内（12-18K），能给到多少看谈"),
    (85, "Web 前端开发", "酷麦计算机", "10-13K", "low", "低于期望：15K 期望，这条上限 13K，差 2K"),
    (80, "高级前端工程师", "中软国际", "8-12K", "low", "低于期望：15K 期望，这条上限 12K，差 3K"),
    (76, "前端（React）", "软通动力", "12-14K·16薪", "low",
     "低于期望：15K 期望，这条上限 14K，差 1K；但给 16 薪，年包约 22.4 万，跟期望年包差不多"),
]


def match_payload(exp, with_hint=True) -> dict:
    items = []
    for i, (score, title, comp, salary, level, text) in enumerate(ROWS):
        hint = {"level": level, "text": text, "expected_k": exp} if with_hint \
            else {"level": "none", "text": "", "expected_k": None}
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
            "expected_k": exp if with_hint else None,
            "salary_hint": hint,
        })
    low = sum(1 for x in items if x["salary_hint"]["level"] == "low")
    return {
        "resume_skills": ["HTML", "CSS", "Vue"], "items": items, "total": len(items),
        "threshold": 80, "passed": len(items), "best": 100,
        "expected_k": exp if with_hint else None, "below_expected": low,
    }


async def main(base: str, out_dir: str) -> None:
    from playwright.async_api import async_playwright

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    errors = []
    ok_all = True

    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 980})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        await page.add_init_script(MOCK_PRELOAD.replace("__BASE__", base))
        await page.goto(f"{base}/ui/", wait_until="networkidle")
        await page.wait_for_timeout(600)

        # 后端真读简历里的期望薪资
        exp = await page.evaluate(
            """async () => {
                const r = await fetch((window.desktop?.apiBase || '') + '/resume').catch(() => null);
                if (!r || !r.ok) return 0;
                return Number((await r.json()).expected_salary || 0);
            }"""
        )
        print("简历期望月薪:", exp or "未填")

        # ---- 1. 简历页那一行 ----
        await page.click("text=我的简历")
        await page.wait_for_timeout(1200)
        kv = await page.locator(".kv-row").all_inner_texts()
        exp_row = next((t.replace("\n", " ") for t in kv if "期望月薪" in t), "")
        print("简历页期望月薪行:", exp_row or "!! 没找到")
        await page.screenshot(path=str(out / "01-resume-expected.png"))

        # ---- 2. 匹配结果：只有 low 的薪资标红 ----
        payload = match_payload(exp or 15)
        await page.route("**/match/skills", lambda r: r.fulfill(
            status=200, content_type="application/json",
            body=json.dumps(payload, ensure_ascii=False)))

        await page.click("text=智能匹配")
        await page.wait_for_timeout(1200)
        cbs = page.locator(".job-pick input[type=checkbox]")
        n = min(3, await cbs.count())
        for i in range(n):
            await cbs.nth(i).click()
            await page.wait_for_timeout(120)
        run_btn = page.locator("#run-match")
        if await run_btn.count():
            await run_btn.first.click()
            await page.wait_for_timeout(2500)

        cards = await page.locator(".sm-card").count()
        red = await page.locator(".sm-title .s.low").count()
        green = await page.locator(".sm-title .s").count() - red
        red_texts = await page.locator(".sm-title .s.low").all_inner_texts()
        print(f"结果卡片 {cards} 条 | 薪资标红 {red} 条（应为 2，76 分那条被阈值挡掉）| 正常 {green} 条")
        print("标红的薪资:", [t.strip() for t in red_texts])
        if red != 2:
            ok_all = False
            print("!! 标红数量不对")

        # 确认没有徽标 / 说明行这类多余元素
        extra_cnt = await page.locator(".sal-badge, .sm-hint").count()
        print("多余徽标/说明元素:", extra_cnt, "(应为 0)")
        if extra_cnt:
            ok_all = False

        await page.locator("#match-results").scroll_into_view_if_needed()
        await page.wait_for_timeout(500)
        await page.screenshot(path=str(out / "02-match-salary-red.png"))

        # ---- 3. 详情弹窗仍给一句话说明 ----
        low_card = page.locator(".sm-card", has=page.locator(".s.low")).first
        if await low_card.count():
            await low_card.click()
            dlg = page.locator(".overlay .dialog")
            await dlg.wait_for(state="visible", timeout=8000)
            await page.wait_for_timeout(600)
            hint = dlg.locator(".jd-salhint")
            print("详情弹窗说明:", (await hint.inner_text()).strip() if await hint.count() else "无")
            await page.screenshot(path=str(out / "03-job-detail-hint.png"))
            await dlg.locator("[data-close]").first.click()
            await page.wait_for_timeout(400)

        # ---- 4. 没填期望薪资：全部不标红 ----
        await page.unroute("**/match/skills")
        await page.route("**/match/skills", lambda r: r.fulfill(
            status=200, content_type="application/json",
            body=json.dumps(match_payload(0, with_hint=False), ensure_ascii=False)))
        await page.click("#run-match")
        await page.wait_for_timeout(1800)
        red2 = await page.locator(".sm-title .s.low").count()
        print("无期望薪资时标红数:", red2, "(应为 0)")
        if red2:
            ok_all = False
        await page.screenshot(path=str(out / "04-no-expected.png"))

        print("控制台错误:", [e for e in errors if "404" not in e and "Failed to load" not in e] or "无")
        await browser.close()

    print("结果:", "全部通过" if ok_all else "有断言失败")


if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8175"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "docs/shots-salary"
    asyncio.run(main(base, out_dir))
