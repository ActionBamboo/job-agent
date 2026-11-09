"""后端启动入口。

桌面端（Electron）通过环境变量传入端口与数据目录后直接执行本文件：
    python.exe server.py
    JOBMATCH_PORT=52341  JOBMATCH_DATA_DIR=... python.exe server.py

浏览器开发模式仍可用：
    python -m uvicorn app.main:app --app-dir backend --reload --port 8000
"""
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import uvicorn  # noqa: E402


def main() -> None:
    host = os.environ.get("JOBMATCH_HOST", "127.0.0.1")
    port = int(os.environ.get("JOBMATCH_PORT", "8000"))
    log_level = os.environ.get("JOBMATCH_LOG_LEVEL", "info")
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        log_level=log_level,
        access_log=False,
        reload=False,
    )


if __name__ == "__main__":
    main()
