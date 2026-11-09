"""招聘文本清洗：主要处理 BOSS 直聘的字体反爬。

BOSS 把薪资里的数字换成私有区字符（U+E031 ~ U+E03A），再用 @font-face 把这些
码位渲染成数字的样子 —— 页面上看着是「15-25K·14薪」，抓下来的文本却是
「\\ue032\\ue036-\\ue033\\ue036K·\\ue032\\ue035薪」。前端没有那份字体，
这串字符就没有字形可画，于是界面上薪资是空的 —— 这就是「薪资看不到」的根因。

对照关系（用岗位库里 60 条真实数据反推验证，59 条解出的都是正常薪资写法，
剩下 1 条原文是"面议"）：
    U+E031 → 0, U+E032 → 1, … U+E03A → 9
即 charCode - 0xE031 就是数字本身。
若 BOSS 以后换字体导致这个顺序变了，这里解出来的薪资会明显不合常理
（比如出现 99-99K），届时需要改成解析 font 文件的 cmap 来做映射。
"""
from __future__ import annotations

_PUA_ZERO = 0xE031
_PUA_NINE = 0xE03A


def decode_boss_digits(text: str) -> str:
    """把字体加密的私有区数字还原成 0-9。"""
    s = str(text or "")
    if not s:
        return ""
    out: list[str] = []
    for ch in s:
        cp = ord(ch)
        if _PUA_ZERO <= cp <= _PUA_NINE:
            out.append(chr(ord("0") + cp - _PUA_ZERO))
        elif 0xE000 <= cp <= 0xF8FF:
            # 其他私有区字符没有对照关系，直接丢掉，别让它在界面上变成一串方块
            continue
        else:
            out.append(ch)
    return "".join(out)


def clean_salary(text: str) -> str:
    """薪资字段清洗：解字体加密 + 收掉多余空白。"""
    return " ".join(decode_boss_digits(text).split())
