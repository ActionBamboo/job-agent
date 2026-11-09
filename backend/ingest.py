"""把抓取/导出的 JD JSON 导入 SQLite。

用法（在 backend 目录或项目根目录均可）：
    python ingest.py ../scraped_jobs.json
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import store


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python ingest.py <jobs.json>")
        return 1
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    jobs = data if isinstance(data, list) else data.get("jobs", [])
    if not jobs:
        print("文件中没有岗位数据")
        return 1
    store.upsert_jobs(jobs)
    print(f"导入 {len(jobs)} 条，当前库中共 {len(store.load_jobs())} 条岗位")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
