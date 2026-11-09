"""LLM 客户端封装（OpenAI 兼容，默认 DeepSeek）。"""
from langchain_openai import ChatOpenAI

from .config import settings
from .mock_llm import MockLLM


def get_llm(temperature: float = 0.2):
    if settings.demo_mode:
        return MockLLM(temperature=temperature)
    if not settings.openai_api_key:
        raise RuntimeError(
            "未配置 OPENAI_API_KEY。请在项目根目录 .env 中填写，或设置 DEMO_MODE=true 使用演示模式。"
        )
    return ChatOpenAI(
        model=settings.openai_model,
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        temperature=temperature,
        timeout=120,
        max_retries=2,
    )
