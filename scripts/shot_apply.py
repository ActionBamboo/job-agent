"""验证「一键投递」的界面流程。

浏览器预览里没有 Electron 的 window.desktop，所以这里注入一份假的 apply/scrape 通道，
把整条链路（勾选 → 技能匹配 → 确认弹窗 → 逐条写招呼语 → 逐条发送 → 卡片标已投）跑通并截图。
真正点「立即沟通」那一步只能在桌面应用里验证，这里只验证前端编排。

用法：
    .venv/Scripts/python.exe scripts/shot_apply.py http://127.0.0.1:8177 docs/shots-apply
"""
import asyncio
import sys
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8177"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/shots-apply")
OUT.mkdir(parents=True, exist_ok=True)

MOCK = """
window.__applied = [];
window.desktop = {
  apiBase: '',
  scrape: {
    checkLogin: async () => true,
    login: async () => ({ ok: true }),
    run: async () => ({ ok: true, jobs: [] }),
    cancel: async () => true,
    openUrl: async () => ({ ok: true }),
    closeWindow: async () => true,
    onLog: (cb) => { window.__pushLog = cb; return () => {}; },
  },
  apply: {
    run: async (payload) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let sent = 0;
      for (let i = 0; i < payload.tasks.length; i += 1) {
        const t = payload.tasks[i];
        await sleep(2600);
        const ok = i !== 1;            // 故意让第二条失败，看失败样式
        if (window.__pushLog) {
          window.__pushLog({ taskId: payload.taskId, level: 'info',
            msg: `[${i + 1}/${payload.tasks.length}] ${t.title} · ${t.company || ''}` });
        }
        await sleep(1400);
        if (window.__pushLog) {
          window.__pushLog({ taskId: payload.taskId, level: ok ? 'ok' : 'error',
            msg: ok ? `${t.title} · 已发送（${t.message.length} 字）` : `${t.title} · 没找到「立即沟通」按钮` });
        }
        window.__applied.push({ job_id: t.job_id, ok });
        if (ok) sent += 1;
        if (window.__pushResult) {
          window.__pushResult({ taskId: payload.taskId, job_id: t.job_id, ok,
            note: ok ? `已发送（${t.message.length} 字）` : '没找到「立即沟通」按钮',
            message: t.message });
        }
      }
      return { ok: true, sent, failed: payload.tasks.length - sent, results: [] };
    },
    cancel: async () => true,
    onResult: (cb) => { window.__pushResult = cb; return () => {}; },
  },
};
"""


async def main() -> None:
    from playwright.async_api import async_playwright

    errors: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        page = await browser.new_page(viewport={"width": 1360, "height": 940})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.add_init_script(MOCK)
        await page.goto(f"{BASE}/ui/", wait_until="domcontentloaded")
        await page.wait_for_timeout(2500)

        await page.get_by_text("智能匹配", exact=True).first.click()
        await page.wait_for_timeout(2200)

        # 只挑「有 JD 正文 + 有原链接」的岗位：没 JD 写不出招呼语，那是另一条分支
        picked = await page.evaluate(
            """async (base) => {
              const r = await fetch(base + '/jobs?source=boss');
              const list = await r.json();
              const ok = list.filter(j => (j.jd_text || '').trim().length >= 20 && j.url);
              const chosen = [];
              for (const j of ok) {
                const cb = document.querySelector(`[data-cb="${j.id}"]`);
                if (!cb) continue;
                cb.click();
                chosen.push(j.title);
                if (chosen.length >= 2) break;
              }
              return chosen;
            }""",
            BASE,
        )
        print("勾选:", picked)
        if not picked:
            print("没有可投的岗位")
            await page.screenshot(path=str(OUT / "00-no-jobs.png"))
            await browser.close()
            return
        await page.wait_for_timeout(500)

        # 技能匹配（先勾选才有结果），让结果区也有卡片，方便看「已投」标记
        await page.locator("#run-match").click()
        await page.wait_for_timeout(4500)
        print("匹配结果卡片:", await page.locator(".sm-card").count())

        btn = page.locator("#run-apply")
        print("投递按钮文案:", (await btn.inner_text()).strip(), "| disabled:", await btn.is_disabled())
        await page.screenshot(path=str(OUT / "01-button.png"))

        await btn.click()
        await page.wait_for_timeout(900)
        print("确认弹窗已打开:", await page.locator("#ap-start").count() > 0)
        await page.screenshot(path=str(OUT / "02-confirm.png"))

        await page.locator("#ap-start").click()
        # 第一条没缓存时要调模型 4~8 秒；mock 投递很快，所以在弹窗自动关闭前先采样日志
        await page.wait_for_timeout(3500)
        await page.screenshot(path=str(OUT / "03-running.png"))

        logs = await page.locator("#ap-log .ln").all_inner_texts()
        print(f"\n日志 {len(logs)} 行:")
        for line in logs:
            print("  ", line.replace("\n", " ").strip()[:120])

        # 投完后弹窗会自己关掉并刷新视图
        await page.wait_for_timeout(8000)
        await page.screenshot(path=str(OUT / "05-cards-applied.png"))

        applied_match = await page.locator(".sm-card .sm-applied").count()
        applied_pick = await page.locator(".job-item .sm-applied").count()
        print("\n匹配结果卡片「已投」:", applied_match, "| 候选岗位卡片「已投」:", applied_pick)
        print("控制台错误:", errors[:6] if errors else "无")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
