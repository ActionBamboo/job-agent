"""CLI 冒烟测试：解析简历 → 逐条匹配样例 JD。

用法（在 backend 目录或项目根目录均可）：
    python run_agent.py ../sample_data/resume.md
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.agent_graph import match_job
from app.parser import parse_resume
from app.store import load_jobs


ROOT = Path(__file__).resolve().parent.parent  # 项目根目录


def main() -> int:
    resume_path = sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "sample_data" / "resume.md")
    resume_text = Path(resume_path).read_text(encoding="utf-8")

    print("==> 解析简历")
    resume = parse_resume(resume_text)
    print(json.dumps(resume, ensure_ascii=False, indent=2))

    jobs = load_jobs()
    for job in jobs:
        print("\n" + "=" * 60)
        print(f"[{job['id']}] {job['title']} @ {job['company']} ({job.get('city', '')})")
        r = match_job(resume, job)
        ev = r.get("evaluation") or {}
        print("综合分:", ev.get("overall_score"))
        print("维度:", json.dumps(ev.get("dimensions", []), ensure_ascii=False))
        print("匹配亮点:", ev.get("matched_points"))
        print("差距点:", ev.get("gaps"))
        print("打招呼语:", r.get("tailored_message"))
        print("简历优化建议:", r.get("resume_suggestions"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
