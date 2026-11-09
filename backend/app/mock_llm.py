"""演示/测试用假 LLM：不调用真实 API，返回固定结构结果。"""
import json


class MockResp:
    def __init__(self, content: str):
        self.content = content


class MockLLM:
    def __init__(self, temperature: float = 0.0, **kwargs):
        self.temperature = temperature

    def invoke(self, prompt: str):
        if "5 个维度" in prompt:
            return MockResp(json.dumps({
                "overall_score": 86,
                "dimensions": [
                    {"name": "技能匹配", "score": 92, "comment": "LangGraph/RAG 栈高度契合"},
                    {"name": "经验匹配", "score": 85, "comment": "3 年 AI 应用经验达标"},
                    {"name": "职级年限匹配", "score": 82, "comment": "3-5 年要求，3 年略低但可接受"},
                    {"name": "行业匹配", "score": 78, "comment": "行业略跨界"},
                    {"name": "学历匹配", "score": 90, "comment": "本科计算机符合要求"},
                ],
                "matched_points": [
                    "有 LangGraph 多 Agent 工作流实战",
                    "RAG 检索增强问答落地经验（命中率 62%→88%）",
                    "搭建过 MCP 工具层",
                ],
                "gaps": [
                    "缺少大规模生产系统调优经验",
                    "行业背景与该岗位略有差异",
                ],
            }, ensure_ascii=False))
        if "打招呼语" in prompt:
            return MockResp(json.dumps({
                "tailored_message": "您好，我有 3 年 LLM 应用经验，做过 RAG 问答系统（命中率 62%→88%）和 LangGraph Agent 工作流，也搭过 MCP 工具层，和贵岗位的 Agent/RAG 方向很契合，方便聊一下吗？",
            }, ensure_ascii=False))
        if "简历优化建议" in prompt:
            return MockResp(json.dumps({
                "resume_suggestions": [
                    "把 RAG 项目补上量化指标（命中率、延迟、日均调用量）",
                    "用 STAR 结构重写 Agent 工作流经历，突出“多工具调用 + 人工审批”",
                    "补充 MCP 协议、函数调用等关键词以对齐 JD",
                ],
            }, ensure_ascii=False))
        # 简历解析
        return MockResp(json.dumps({
            "name": "演示候选人", "title": "AI 应用工程师", "years_exp": 3,
            "skills": ["Python", "LangGraph", "RAG"],
            "experience": [{"company": "某智能科技", "role": "AI 应用工程师", "period": "2022-至今",
                            "achievements": ["RAG 命中率提升"]}],
            "education": [], "summary": "", "target_role": "AI 应用工程师",
        }, ensure_ascii=False))
