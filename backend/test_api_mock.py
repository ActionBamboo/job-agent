"""Mock LLM 下的完整 HTTP 流程测试（静态页 + parse + batch match）。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import agent_graph, parser


class FakeResp:
    def __init__(self, c):
        self.content = c


class FakeLLM:
    def __init__(self, temperature=0.0):
        pass

    def invoke(self, prompt):
        if "5 个维度" in prompt:
            return FakeResp(json.dumps({
                "overall_score": 77,
                "dimensions": [{"name": "技能匹配", "score": 85, "comment": "ok"}],
                "matched_points": ["亮点1"], "gaps": ["差距1"],
            }, ensure_ascii=False))
        if "打招呼语" in prompt:
            return FakeResp(json.dumps({"tailored_message": "你好，我匹配这个岗位"}, ensure_ascii=False))
        if "简历优化建议" in prompt:
            return FakeResp(json.dumps({"resume_suggestions": ["建议1"]}, ensure_ascii=False))
        return FakeResp(json.dumps({
            "name": "张三", "title": "AI 应用工程师", "years_exp": 3, "skills": ["Python"],
            "experience": [], "education": [], "summary": "", "target_role": "AI",
        }, ensure_ascii=False))


agent_graph.get_llm = lambda *a, **k: FakeLLM()
parser.get_llm = lambda *a, **k: FakeLLM()

from fastapi.testclient import TestClient
from app.main import app

c = TestClient(app)


def main() -> int:
    # 静态页
    r = c.get("/ui/")
    assert r.status_code == 200 and "JobMatch Agent" in r.text, "index.html 未返回"
    assert c.get("/ui/app.js").status_code == 200
    assert c.get("/ui/style.css").status_code == 200
    print("static ok")

    # 简历解析
    r3 = c.post("/resume/parse", json={"text": "张三 AI 工程师"})
    assert r3.status_code == 200, r3.text
    resume = r3.json()
    print("parse ok:", resume["name"], resume["title"])

    # 批量匹配
    r4 = c.post("/match/batch", json={"resume": resume})
    assert r4.status_code == 200, r4.text
    results = r4.json()
    job_count = len(c.get("/jobs").json())
    assert len(results) == job_count, f"应返回 {job_count} 条，实际 {len(results)}"
    print("batch ok, top:", results[0]["overall_score"], results[0]["job"]["title"])
    print("API_FLOW_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
