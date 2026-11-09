"""核心 Agent：LangGraph 状态机。

流程：START → evaluate → (tailor ∥ advise) → END
"""
import json
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

from . import prompts
from .llm import get_llm
from .utils import extract_json, text_of


class AgentState(TypedDict):
    resume: dict
    job: dict
    evaluation: dict | None
    tailored_message: str | None
    resume_suggestions: list | None
    error: str | None


def _evaluate(state: AgentState) -> AgentState:
    llm = get_llm(temperature=0.1)
    prompt = prompts.EVALUATE_PROMPT.format(
        resume=json.dumps(state["resume"], ensure_ascii=False),
        job=json.dumps(state["job"], ensure_ascii=False),
    )
    resp = llm.invoke(prompt)
    return {"evaluation": extract_json(text_of(resp))}


def _tailor(state: AgentState) -> AgentState:
    llm = get_llm(temperature=0.7)
    prompt = prompts.TAILOR_MESSAGE_PROMPT.format(
        resume=json.dumps(state["resume"], ensure_ascii=False),
        job=json.dumps(state["job"], ensure_ascii=False),
        evaluation=json.dumps(state["evaluation"], ensure_ascii=False),
    )
    resp = llm.invoke(prompt)
    data = extract_json(text_of(resp))
    return {"tailored_message": data.get("tailored_message", "")}


def _advise(state: AgentState) -> AgentState:
    llm = get_llm(temperature=0.3)
    prompt = prompts.RESUME_ADVICE_PROMPT.format(
        resume=json.dumps(state["resume"], ensure_ascii=False),
        job=json.dumps(state["job"], ensure_ascii=False),
        evaluation=json.dumps(state["evaluation"], ensure_ascii=False),
    )
    resp = llm.invoke(prompt)
    data = extract_json(text_of(resp))
    return {"resume_suggestions": data.get("resume_suggestions", [])}


def _build_graph():
    g = StateGraph(AgentState)
    g.add_node("evaluate", _evaluate)
    g.add_node("tailor", _tailor)
    g.add_node("advise", _advise)
    g.add_edge(START, "evaluate")
    g.add_edge("evaluate", "tailor")
    g.add_edge("evaluate", "advise")
    g.add_edge("tailor", END)
    g.add_edge("advise", END)
    return g.compile()


_graph = _build_graph()


def match_job(resume: dict, job: dict) -> dict:
    """简历 × 单条 JD，返回完整匹配结果。"""
    return _graph.invoke({"resume": resume, "job": job})
