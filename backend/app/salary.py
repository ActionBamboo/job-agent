"""薪资解析与「低于期望」提示。

岗位薪资是招聘站上的一串自由文本（`15-25K·14薪`、`30-50K`、`200-300元/天`、`面议`），
没办法直接比较。这里统一拆成「月薪区间 + 薪数」，再和简历里的期望月薪对照。

注意：**只提示，不筛人**。大环境不好的时候，标着 10-13K 的岗位也可能是值得聊的，
所以这里只产出一句话提示，绝不参与过滤或排序。
"""
from __future__ import annotations

import re

# 一年按多少个月算年包（13/14/15 薪的信息在字符串里，会覆盖这个默认值）
_BASE_MONTHS = 12
# 日薪折算月薪的计薪天数（人社部口径 21.75）
_WORKDAYS = 21.75

# 中间允许带单位：`15K-25K` 里第一个数后面就跟着 K，不能让区间匹配漏掉
_RANGE_UPPER = re.compile(
    r"(\d+(?:\.\d+)?)\s*[k千]?\s*[-~—到至]\s*(\d+(?:\.\d+)?)", re.I
)
_SINGLE = re.compile(r"(\d+(?:\.\d+)?)")
_MONTHS = re.compile(r"[·\s]*(\d{1,2})\s*薪")


def parse_salary(text: str) -> dict | None:
    """把薪资文本拆成区间。解析不出来返回 None（面议、空、纯文字）。"""
    s = (text or "").strip()
    if not s or s in {"面议", "薪资面议", "保密"}:
        return None

    months = _BASE_MONTHS
    m = _MONTHS.search(s)
    if m:
        n = int(m.group(1))
        if 12 <= n <= 24:          # 「14薪」合理，「40薪」是误抓
            months = n

    # 日薪：折成月薪才比得了，否则 200 元/天会被当成 200K
    if "元/天" in s or "/天" in s or "元/日" in s:
        pair = _RANGE_UPPER.search(s)
        if pair:
            lo, hi = float(pair.group(1)), float(pair.group(2))
        else:
            one = _SINGLE.search(s)
            if not one:
                return None
            lo = hi = float(one.group(1))
        if hi > 10000:             # 明显不是日薪口径，别硬算
            return None
        return {
            "min_k": round(lo * _WORKDAYS / 1000, 1),
            "max_k": round(hi * _WORKDAYS / 1000, 1),
            "months": _BASE_MONTHS,
            "kind": "daily",
            "raw": s,
        }

    # 「万」口径：20-30万/年，或 1.5-2万/月
    if "万" in s:
        pair = _RANGE_UPPER.search(s)
        if pair:
            lo, hi = float(pair.group(1)), float(pair.group(2))
        else:
            one = _SINGLE.search(s)
            if not one:
                return None
            lo = hi = float(one.group(1))
        as_year = "/年" in s or "年" in s
        lo_k = lo * 10 / 12 if as_year else lo * 10      # 1万/月 = 10K
        hi_k = hi * 10 / 12 if as_year else hi * 10
        return {
            "min_k": round(lo_k, 1), "max_k": round(hi_k, 1),
            "months": months, "kind": "monthly", "raw": s,
        }

    # 常规 K 口径（也可能写成 15000-25000元/月）
    pair = _RANGE_UPPER.search(s)
    if pair:
        lo, hi = float(pair.group(1)), float(pair.group(2))
    else:
        one = _SINGLE.search(s)
        if not one:
            return None
        lo = hi = float(one.group(1))

    if "元" in s and lo > 1000:    # 15000-25000元/月 → 换成 K
        lo, hi = lo / 1000, hi / 1000
    if lo <= 0 or hi <= 0:
        return None
    if lo > hi:
        lo, hi = hi, lo
    return {
        "min_k": round(lo, 1), "max_k": round(hi, 1),
        "months": months, "kind": "monthly", "raw": s,
    }


def _fmt(k: float) -> str:
    """13.0 → 13，13.5 → 13.5。"""
    return f"{k:.0f}" if abs(k - round(k)) < 0.05 else f"{k:.1f}"


def parse_expected(value) -> float | None:
    """把简历里的期望薪资容错成月薪（K）。

    接受 15 / "15" / "15K" / "15k" / "15-20K" / "15K·14薪" / "1.5万"。
    写区间时取**下限**——低于下限就是真的低于期望了。
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        if v <= 0:
            return None
        # 有人会填 15000 而不是 15
        return round(v / 1000, 1) if v > 200 else round(v, 1)
    s = str(value).strip()
    if not s:
        return None
    m = re.search(r"(\d+(?:\.\d+)?)", s)
    if not m:
        return None
    v = float(m.group(1))
    if "万" in s:
        v *= 10
    elif v > 200:                  # 15000 元/月
        v /= 1000
    return round(v, 1) if v > 0 else None


def salary_hint(salary_text: str, expected_k: float | None) -> dict:
    """给出一条「这个薪资和你的期望比怎么样」的提示。

    返回 {level, text, ...}：
      level = unknown / low / near / ok / above
    level 只用来决定提示颜色，**不参与任何筛选**。
    """
    rng = parse_salary(salary_text)
    if expected_k is None or expected_k <= 0:
        return {"level": "none", "text": "", "expected_k": None}
    if not rng:
        return {
            "level": "unknown",
            "text": f"薪资没写明月薪（{salary_text or '空'}），谈的时候问清",
            "expected_k": expected_k,
        }

    lo, hi, months = rng["min_k"], rng["max_k"], rng["months"]
    exp = float(expected_k)
    # 年包口径：岗位按 13/14 薪发，实际总包可能比月薪看起来高
    pkg_max = hi * months
    pkg_exp = exp * _BASE_MONTHS
    daily = rng.get("kind") == "daily"
    suffix = "（按日薪折算月薪）" if daily else ""

    if hi < exp:
        gap = exp - hi
        text = f"低于期望：{_fmt(exp)}K 期望，这条上限 {_fmt(hi)}K，差 {_fmt(gap)}K{suffix}"
        if months > _BASE_MONTHS and pkg_max >= pkg_exp * 0.95:
            text += f"；但给 {months} 薪，年包约 {pkg_max / 10:.1f} 万，跟期望年包差不多"
        return {"level": "low", "text": text, "expected_k": exp, "max_k": hi, "months": months}

    if lo >= exp:
        return {
            "level": "ok",
            "text": f"达到期望：{_fmt(lo)}-{_fmt(hi)}K，期望 {_fmt(exp)}K{suffix}",
            "expected_k": exp, "max_k": hi, "months": months,
        }

    # 期望落在区间里：11-18K 对上 15K，能不能给到看怎么谈
    return {
        "level": "near",
        "text": f"期望 {_fmt(exp)}K 落在区间内（{_fmt(lo)}-{_fmt(hi)}K），能给到多少看谈{suffix}",
        "expected_k": exp, "max_k": hi, "months": months,
    }
