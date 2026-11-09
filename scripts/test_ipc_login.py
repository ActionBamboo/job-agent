"""通过 CDP 连到运行中的应用，验证 preload → main → 内置浏览器的 IPC 链路。

用法：.venv/Scripts/python.exe scripts/test_ipc_login.py [cdp_port]
"""
import asyncio
import sys

LOOP = """
(async () => {
  const d = window.desktop && window.desktop.scrape;
  if (!d) return { error: 'window.desktop.scrape 不存在（preload 未生效）' };
  const before = await d.checkLogin('boss', ['geek_zp_token', 'zp_token', 'bst', 'wt2']);
  window.__ipcLog = [];
  const off = d.onLog((p) => window.__ipcLog.push(`${p.level}: ${p.msg}`));
  // 不 await：让登录窗口一直开着，便于截图确认
  window.__loginPromise = d.login({
    source: 'boss',
    name: 'BOSS直聘',
    loginUrl: 'https://www.zhipin.com/web/user/',
    hints: ['geek_zp_token', 'zp_token', 'bst', 'wt2'],
    taskId: 'ipc-test',
  }).then((r) => { window.__loginResult = r; return r; });
  return { hasApi: true, loggedBefore: before };
})()
"""


async def main(port: int) -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
        ctx = browser.contexts[0]
        page = next((pg for pg in ctx.pages if pg.url.startswith("app://")), None)
        if not page:
            print("没找到主窗口，当前页面：", [pg.url for pg in ctx.pages])
            return
        print("主窗口:", page.url)

        out = await page.evaluate(LOOP)
        print("IPC 调用结果:", out)

        await asyncio.sleep(12)
        logs = await page.evaluate("window.__ipcLog || []")
        print("主进程推送的日志:")
        for line in logs:
            print("  -", line)

        done = await page.evaluate("window.__loginResult || null")
        print("登录是否已结束（应仍在等待，因为没有真的扫码）:", done)
        # 不调用 browser.close()：connectOverCDP 下 close 会直接结束整个 Electron 应用，
        # 这里要让窗口留着，便于外部截屏确认。
        print("保持应用运行，请外部截屏确认登录窗口")


asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 9333))
