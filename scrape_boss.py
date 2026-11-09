r"""BOSS 抓取器启动器：在项目根目录直接运行，无需 cd backend。

用法（在 job-agent 目录）：
    .\.venv\Scripts\python.exe scrape_boss.py --login-only
    .\.venv\Scripts\python.exe scrape_boss.py --keyword "AI Agent" --city 101280600 --pages 2 --ingest --dump-html

或直接用 scrape_boss.bat：
    scrape_boss.bat --login-only
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

from app.scraper.boss import main  # noqa: E402

if __name__ == "__main__":
    main()
