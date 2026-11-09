"""验证「一个或多个期望职位」抓取调度逻辑（用假抓取器，不联网、不写真实库）。

用法：.venv/Scripts/python.exe scripts/test_multi_keyword.py
"""
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("JOBMATCH_DATA_DIR", str(ROOT / "data" / "tmp" / "testdata"))

from app import runner, store  # noqa: E402
from app.scraper import registry  # noqa: E402


class FakeScraper:
    """模拟一个平台：同一个关键词里故意返回重复 id，验证去重。"""

    key = "boss"
    name = "假 BOSS"

    async def scrape(self, keyword, city="深圳", pages=1, detail_limit=20, log=None, should_stop=None):
        log("info", f"(fake) 搜索「{keyword}」@ {city}，detail_limit={detail_limit}")
        rows = [
            {"id": f"boss-{keyword}-1", "title": f"{keyword}工程师", "company": "某公司",
             "city": city, "salary": "20-30K", "experience_req": "3-5年",
             "education_req": "本科", "jd_text": "JD 正文", "url": "", "source": "boss"},
            {"id": "boss-shared-1", "title": "跨关键词重复岗", "company": "某公司",
             "city": city, "salary": "15-25K", "experience_req": "",
             "education_req": "", "jd_text": "JD", "url": "", "source": "boss"},
        ]
        return rows


def main() -> None:
    registry._scrapers["boss"] = FakeScraper()

    saved = []
    store.upsert_jobs = lambda jobs: saved.extend(jobs)
    store.load_jobs = lambda source=None: saved

    task = runner.start_scrape(["前端开发", "AI应用开发", "Vue"], "深圳", 1, 20, source="boss")
    print("task:", task.id, "params:", task.params)

    while task.status == "running":
        time.sleep(0.2)

    print("\n=== 日志 ===")
    for x in task.logs:
        print(f"  {x['t']:>4}s [{x['level']}] {x['msg']}")
    print("\n=== 结果 ===")
    print(" status:", task.status)
    print(" result:", task.result)
    print(" 入库条数(去重后):", len(saved))
    for j in saved:
        print("   -", j["id"], j["title"])

    ok = (
        task.status == "done"
        and len(saved) == 4  # 3 个关键词各 1 条 + 1 条跨关键词重复被合并
        and task.result["fetched"] == 4
    )
    print("\n判定:", "通过" if ok else "失败")


if __name__ == "__main__":
    main()
