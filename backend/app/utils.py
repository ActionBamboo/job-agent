"""小工具：取 LLM 文本、解析 JSON。"""
import json
import re


def text_of(resp) -> str:
    """兼容 langchain AIMessage 及其他返回结构，取出纯文本。"""
    content = getattr(resp, "content", resp)
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict):
                parts.append(p.get("text", "") or "")
            else:
                parts.append(str(p))
        return "".join(parts)
    return str(content)


def extract_json(text: str):
    """从 LLM 输出中稳健提取 JSON 对象。"""
    text = text.strip()
    # 去掉 markdown 代码围栏
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE).strip()
    # 取第一个 { 到最后一个 } 的区间
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        return json.loads(m.group(0))
    raise ValueError(f"无法解析 LLM 输出为 JSON：{text[:200]}")
