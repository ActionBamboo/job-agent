"""Mock LLM 冒烟测试：不调用真实 API，验证 LangGraph 编排 + JSON 解析 + 节点并行。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import agent_graph, parser


class FakeResp:
    def __init__(self, content: str):
        self.content = content


class FakeLLM:
    def __init__(self, temperature: float = 0.0):
        self.temperature = temperature

    def invoke(self, prompt: str):
        if "5 个维度" in prompt:
            return FakeResp(json.dumps({
                "overall_score": 82,
                "dimensions": [
                    {"name": "技能匹配", "score": 88, "comment": "Python/LangGraph 高度匹配"},
                    {"name": "经验匹配", "score": 80, "comment": "3 年经验基本达标"},
                ],
                "matched_points": ["精通 LangGraph", "有 RAG 落地经验"],
                "gaps": ["缺少大厂背景"],
            }, ensure_ascii=False))
        if "打招呼语" in prompt:
            return FakeResp(json.dumps(
                {"tailored_message": "你好，我有 3 年 LLM 应用经验，做过 RAG 和 Agent 工作流。"},
                ensure_ascii=False))
        if "简历优化建议" in prompt:
            return FakeResp(json.dumps(
                {"resume_suggestions": ["把 RAG 项目加上量化指标", "补充 MCP 工具层描述"]},
                ensure_ascii=False))
        # 简历解析
        return FakeResp(json.dumps({
            "name": "张三", "title": "AI 应用工程师", "years_exp": 3,
            "skills": ["Python", "LangGraph"],
            "experience": [{"company": "某司", "role": "AI 应用工程师", "period": "2022-至今",
                            "achievements": ["RAG 命中率提升"]}],
            "education": [], "summary": "", "target_role": "AI 应用工程师",
        }, ensure_ascii=False))


# 替换 LLM 为 FakeLLM
agent_graph.get_llm = lambda *a, **k: FakeLLM()
parser.get_llm = lambda *a, **k: FakeLLM()


def main() -> int:
    resume = parser.parse_resume("张三 AI 应用工程师")
    print("简历解析:", json.dumps(resume, ensure_ascii=False))

    job = {"id": "t1", "title": "AI Agent 应用工程师", "company": "某司", "jd_text": "需要 LangGraph、RAG"}
    result = agent_graph.match_job(resume, job)
    print("评估:", json.dumps(result.get("evaluation"), ensure_ascii=False))
    print("话术:", result.get("tailored_message"))
    print("建议:", result.get("resume_suggestions"))

    assert result.get("evaluation", {}).get("overall_score") == 82
    assert result.get("tailored_message")
    assert result.get("resume_suggestions")
    print("MOCK_SMOKE_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
