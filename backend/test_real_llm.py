"""真实 LLM 端到端测试：调用 DeepSeek，解析简历 + 匹配 1 条 JD。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.agent_graph import match_job
from app.parser import parse_resume
from app.store import load_jobs

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    resume_text = (ROOT / "sample_data" / "resume.md").read_text(encoding="utf-8")
    print("==> 真实 LLM 解析简历")
    resume = parse_resume(resume_text)
    print(json.dumps(resume, ensure_ascii=False, indent=2))

    job = load_jobs()[0]
    print(f"\n==> 匹配: {job['title']} @ {job['company']}")
    r = match_job(resume, job)
    ev = r.get("evaluation") or {}
    print("综合分:", ev.get("overall_score"))
    print("维度:", json.dumps(ev.get("dimensions", []), ensure_ascii=False, indent=2))
    print("亮点:", ev.get("matched_points"))
    print("差距:", ev.get("gaps"))
    print("话术:", r.get("tailored_message"))
    print("建议:", r.get("resume_suggestions"))
    print("REAL_LLM_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
