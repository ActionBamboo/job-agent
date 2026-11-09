"""公司背景调研：搜第三方评价，判断是不是外包、口碑如何。

为什么不去直抓脉脉 / 看准的页面：
- 那两家的点评详情基本要登录才看得到，用户未必有账号；
- 页面结构改版频繁，选择器维护成本高。
改为搜「公司名 + 外包 / 员工评价 / 脉脉」，从**搜索结果摘要**和**相关推荐**里取信号。
这些摘要本身就来自脉脉、看准、知乎、雪球，等于间接拿到了内容，而且不需要登录。
"""
import html
import re
import time

import requests

from .config import settings
from .llm import get_llm
from .utils import extract_json, text_of

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
_ENGINE = "https://www.sogou.com/web"
_TIMEOUT = 12

# 三个角度各搜一次：是不是外包、员工怎么说、脉脉上怎么评
_QUERIES = ("{name} 外包", "{name} 怎么样 员工评价", "{name} 脉脉")

_PROMPT = """你是求职者的顾问，帮他判断一家公司值不值得投递。

下面是搜索引擎抓到的公开材料。注意：摘要可能残缺，可能夹带外包广告，自己甄别。

公司：{name}

{materials}

要求：
1. 只依据材料判断，材料里没提到的不要编；
2. 材料互相矛盾就如实说，并在 confidence 里给「低」；
3. 输出严格 JSON：

{{
  "outsourcing": {{"verdict": "是|疑似|不是|材料不足", "reason": "一句话依据"}},
  "pros": ["正面评价，最多 4 条"],
  "cons": ["负面评价与风险，最多 4 条"],
  "advice": "建议投|可以投|谨慎|别投",
  "advice_reason": "一句话",
  "confidence": "高|中|低",
  "signals": ["材料里的关键可疑词，最多 6 个，例如「外派到腾讯」「驻场」「千万别来」"]
}}"""


def _clean_html(raw: str) -> str:
    """去掉脚本样式和标签，只留可见文本。"""
    raw = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", raw)
    text = re.sub(r"(?s)<[^>]+>", " ", raw)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _related_terms(text: str, name: str) -> list[str]:
    """搜狗的「相关推荐」是整页信息密度最高的地方。

    「XX外包网易」「XX千万别来」「XX外包靠谱吗」这类词本身就是结论，
    比结果正文更直接。链接被清洗后是空格分隔的，按空格切再按公司名过滤。
    """
    head = name[:2]
    terms: list[str] = []
    for m in re.finditer("相关推荐", text):
        for w in re.split(r"\s+", text[m.end(): m.end() + 600]):
            w = w.strip()
            if 2 <= len(w) <= 22 and head in w and w not in terms:
                terms.append(w)
    return terms[:20]


def _strip_nav(text: str) -> str:
    """砍掉搜索结果页的头尾噪音。

    搜狗整页正文的开头是「高级搜索 / 搜索关键词 * / 拆分关键词…」这一大段表单说明，
    末尾是「相关搜索 / 举报」之类的固定条目，对判断公司毫无用处，还会干扰大模型。
    正文一般从「搜狗已为您找到」那一行开始。
    """
    m = re.search(r"搜狗已为您找到", text) or re.search(r"全部结果\s", text)
    if m:
        text = text[m.start():]
    cut = re.search(r"相关搜索|举报该页|意见反馈", text)
    if cut and cut.start() > 300:
        text = text[:cut.start()]
    return text.strip()


def _search(name: str, query: str) -> dict:
    """搜一次，返回摘要与相关推荐词。失败不抛错，交给上层降级。"""
    try:
        resp = requests.get(
            _ENGINE,
            params={"query": query},
            headers={
                "User-Agent": _UA,
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Accept": "text/html,application/xhtml+xml",
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        resp.encoding = "utf-8"
        text = _clean_html(resp.text)
        if len(text) < 200:
            return {"query": query, "ok": False, "error": "返回内容过短，可能被拦", "snippet": "", "related": []}
        # 相关推荐词要在砍导航之前提取（它在被砍掉的那段附近）
        related = _related_terms(text, name)
        return {
            "query": query,
            "ok": True,
            "snippet": _strip_nav(text)[:1600],
            "related": related,
        }
    except Exception as e:  # 网络问题、超时、反爬都走这里
        return {"query": query, "ok": False, "error": str(e)[:120], "snippet": "", "related": []}


def collect(name: str) -> list[dict]:
    """跑完全部查询。查询之间留间隔，别把人家搜索接口打急了。"""
    out = []
    for i, tpl in enumerate(_QUERIES):
        out.append(_search(name, tpl.format(name=name)))
        if i < len(_QUERIES) - 1:
            time.sleep(1.2)
    return out


def _materials_text(materials: list[dict]) -> str:
    blocks = []
    for i, m in enumerate(materials, 1):
        if not m["ok"]:
            blocks.append(f"【查询 {i}】{m['query']} —— 没抓到（{m.get('error', '')}）")
            continue
        block = [f"【查询 {i}】{m['query']}"]
        if m["related"]:
            block.append("相关推荐：" + "、".join(m["related"]))
        block.append("结果摘要：" + m["snippet"])
        blocks.append("\n".join(block))
    return "\n\n".join(blocks)


def _empty_analysis(note: str) -> dict:
    return {
        "outsourcing": {"verdict": "材料不足", "reason": note},
        "pros": [],
        "cons": [],
        "advice": "谨慎",
        "advice_reason": note,
        "confidence": "低",
        "signals": [],
    }


def research(name: str) -> dict:
    """调研一家公司。返回材料原文 + 结论，材料留给界面展开看。"""
    name = (name or "").strip()
    if not name:
        raise ValueError("公司名不能为空")

    materials = collect(name)
    ok_count = sum(1 for m in materials if m["ok"])
    related = []
    for m in materials:
        for t in m.get("related", []):
            if t not in related:
                related.append(t)

    result = {
        "company": name,
        "sources": [{k: m[k] for k in ("query", "ok", "related")} for m in materials],
        "related": related[:20],
        "materials": [{"query": m["query"], "ok": m["ok"], "snippet": m["snippet"], "error": m.get("error", "")} for m in materials],
        "analysis": None,
        "note": "",
    }

    if ok_count == 0:
        result["analysis"] = _empty_analysis("三个查询都没抓到内容，可能网络或搜索接口被拦")
        result["note"] = "没拿到任何第三方信息"
        return result

    if settings.demo_mode:
        result["analysis"] = _empty_analysis("演示模式不调用大模型，下面是原始材料")
        result["note"] = "演示模式：只看原始材料"
        return result

    try:
        llm = get_llm(temperature=0.1)
        prompt = _PROMPT.format(name=name, materials=_materials_text(materials))
        data = extract_json(text_of(llm.invoke(prompt)))
        # 兜底补字段，避免前端因为缺键崩掉
        data.setdefault("outsourcing", {"verdict": "材料不足", "reason": ""})
        for k in ("pros", "cons", "signals"):
            data.setdefault(k, [])
            if not isinstance(data[k], list):
                data[k] = []
        data.setdefault("advice", "谨慎")
        data.setdefault("advice_reason", "")
        data.setdefault("confidence", "中")
        result["analysis"] = data
    except Exception as e:
        result["analysis"] = _empty_analysis(f"大模型分析失败：{str(e)[:100]}")
        result["note"] = "分析失败，只保留原始材料"

    return result
