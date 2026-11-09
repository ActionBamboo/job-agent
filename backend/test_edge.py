"""诊断：检查 Playwright 能否找到并启动本机 Edge（headless，不弹窗、不等待输入）。"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.async_api import async_playwright

PROFILE = Path(__file__).resolve().parents[1] / "data" / "_edge_test"


async def main() -> int:
    async with async_playwright() as p:
        print("chromium executable path:", p.chromium.executable_path)
        try:
            ctx = await p.chromium.launch_persistent_context(
                user_data_dir=str(PROFILE), channel="msedge", headless=True, timeout=30000,
            )
            print("EDGE_LAUNCH_OK")
            await ctx.close()
            return 0
        except Exception as e:  # noqa: BLE001
            print("EDGE_LAUNCH_FAIL:", type(e).__name__, str(e)[:400])
            return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
