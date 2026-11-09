"""根据「岗位 JD + 我的简历」生成发给 HR 的第一条打招呼语。

为什么单独做一个模块，不复用 agent_graph 里那条 tailored_message：
那条是「深度分析」链路的副产物，要先跑完 5 维打分（30 秒往上）才拿得到一句话。
这里的场景是「翻到一条岗位，当场就想发一句话过去」，所以必须是一个轻接口，
一次大模型调用直接出结果。

写提示词时的三条硬约束（也是这个功能能不能用的关键）：
1. **只准用简历里真实存在的经历**。大模型为了「显得匹配」会顺手编项目、编技术栈、
   编量化数字，而 HR 一追问就露馅，比不打招呼更糟。
2. **简历里没有的能力不许说「精通」**，只能退一步说「做过相邻的事、能快速上手」。
3. **第一句必须给硬信息**。BOSS 这类平台 HR 在手机通知栏只看到前 40 个字，
   「您好，我对该职位很感兴趣」这种开场等于把最贵的位置浪费掉了。
"""
import re
import time

from .config import settings
from .llm import get_llm
from .utils import extract_json, text_of

# 各平台的说话方式不一样，不能一套文案打天下
_PLATFORM = {
    "boss": (
        "BOSS直聘，消息会出现在即时聊天里。HR 在手机通知栏只看得到前 40 个字，"
        "第一句必须是硬信息；整条别超过 130 字，太长对方不一定看完。"
    ),
    "zhaopin": "智联招聘，作为投递附言发送。比聊天稍正式一点，100~170 字合适。",
    "job51": "51job 前程无忧，作为投递附言发送。比聊天稍正式一点，100~170 字合适。",
    "lagou": "拉勾网，互联网公司居多。技术细节可以写实一点，100~160 字。",
    "yupao": "鱼泡网，工程/蓝领类岗位居多。说人话，别堆技术名词，80~120 字。",
    "manual": "通用场景（还不确定发在哪个平台）。按 100~150 字写，两边都不会太违和。",
}

_LENGTH_BOSS = (
    "逐条对标版 80~130 字；项目切入版 80~130 字；"
    "极简版 50~70 字（超过 80 字就削）。宁短勿长。"
)
_LENGTH_NORMAL = (
    "逐条对标版 100~160 字；项目切入版 100~160 字；极简版 50~80 字。宁短勿长。"
)

_PROMPT = """你在帮一位求职者写招聘平台上的第一条打招呼消息，写完会被直接发给 HR。请当成真人打字聊天来写，不要写成求职信、不要写成自我评价。

【岗位】
公司：{company}
岗位：{title}
城市：{city}　薪资：{salary}　经验要求：{experience}　学历要求：{education}

【岗位职责与任职要求原文】
{jd}

【我的简历】
{resume}

【发布平台】
{platform}

【五条硬规矩，违反了这条消息就废了】
1. 事实纪律：只能使用上面简历里真实写着的公司、项目、技术、年限。不许编造任何项目名、技术栈、数字、成果。简历里没有的能力，不许写「精通」「熟悉」「深耕」「多年经验」。
2. 第一句就给硬信息：几年经验 + 干什么方向 + 和这个岗位最直接相关的一件事。不许用「您好，我对该职位很感兴趣」「感谢您在百忙之中查看我的简历」这类开场——HR 手机通知栏只露前 40 个字，废话占住了就等于没发。
3. 每一句话都要能对应上 JD 里的某一条要求。对不上的内容不要写进去，宁可短。
4. 年限只准照抄简历里写明的数字（例如「8 年经验」），或者直接引用括号里已经算好的时长。不许自己把时间段折成「近两年」「三年多」「深耕五年」这类模糊说法——折算错一次，面试第一轮就会被追问穿。方向不对口的那几年，不要含糊成「做过很多年 AI」。
5. 招呼语正文里禁止自我否定：不许出现「没做过」「没写过」「不会」「不熟」「缺乏」「欠缺」这类话，也不要主动交待自己的短板。短板全部写进 gaps 字段，正文只写能对上的部分。某条要求确实绕不开、对方一定会问，最多写「这块能快速上手」，绝不许写成「没做过」。

【语气】
- 礼貌，但不谄媚。不用「贵公司」「非常荣幸」「期待您的回复」这类模板词。
- 不用 emoji，不堆感叹号，不说「求个机会」「给个面试机会」这种低声下气的说法。
- 结尾留一个轻量的下一步动作（方便的话聊十分钟 / 作品和代码可以发您看看 / 本周可到岗面试），不要逼对方立刻回复。

【长度】
{length}
{extra}
【输出】只返回 JSON，不要任何解释，不要 markdown 代码块：

{{
  "variants": [
    {{"style": "match", "label": "逐条对标版", "use": "技术是硬门槛、简历会转到技术负责人手上的岗位", "text": "招呼语正文"}},
    {{"style": "case", "label": "项目切入版", "use": "看重落地经验、关心你做过什么产品的岗位", "text": "招呼语正文"}},
    {{"style": "brief", "label": "极简版", "use": "海投试探，先确认对方有没有 HC", "text": "招呼语正文"}}
  ],
  "matched": ["JD 里的某条要求 → 我拿什么对上，最多 5 条，每条一行"],
  "gaps": ["JD 明确要求、但我简历里确实没有对应经验的点，最多 3 条。如实写，不要美化"],
  "tip": "发这条之前值得提醒求职者的一句话：这条 JD 有什么特殊信号、要不要先补个材料"
}}"""

_MAX_JD = 3200

# 招呼语正文里的自我否定。实测大模型会在正文里写「Go/Java 后端没写过」这种话，
# 看着「坦诚」，实际是主动送一条淘汰理由——短板只该出现在 gaps 里。
_NEGATIVE = re.compile(r"没做过|没写过|没用过|没接触|不熟悉|不熟|不会|缺乏|欠缺|不懂")

_RETRY_HINT = """

【上一次生成被否决了】正文里出现了自我否定的话（比如「没做过」「不熟」「缺乏」）。
重写：正文只写能对上的部分，绝对不能出现否定句；短板只写进 gaps 字段。
"""

# 时间段：2025.12—2026.10 / 2021.06-2022.08 / 2018.11—至今
_PERIOD = re.compile(
    r"(\d{4})\s*[.\-/年]\s*(\d{1,2})?\s*[^\d至]{0,4}"
    r"(\d{4}|至今|现在|今)?\s*[.\-/年]?\s*(\d{1,2})?"
)


def _span_months(period: str) -> int | None:
    """把时间段折成月数。

    为什么要在后端算：大模型自己折算年限必翻车（实测把 11 个月写成「近两年」），
    而招呼语里一句夸大的年限，面试第一轮就会被追问穿。
    算好直接喂给它，让它没机会算错。
    """
    m = _PERIOD.search(period or "")
    if not m:
        return None
    y1, m1, y2, m2 = m.groups()
    try:
        start = int(y1) * 12 + (int(m1) if m1 else 1)
    except ValueError:
        return None
    if y2 in (None, "", "至今", "现在", "今"):
        now = time.localtime()
        end = now.tm_year * 12 + now.tm_mon
    else:
        try:
            end = int(y2) * 12 + (int(m2) if m2 else 1)
        except ValueError:
            return None
    months = end - start
    return months if 0 < months < 600 else None


def _span_note(period: str) -> str:
    months = _span_months(period)
    if not months:
        return ""
    if months < 12:
        return f"（约 {months} 个月）"
    y, mo = divmod(months, 12)
    return f"（约 {y} 年）" if mo == 0 else f"（约 {y} 年 {mo} 个月）"


def _resume_text(resume: dict) -> str:
    """把结构化简历压成一段紧凑文本。

    重点给经历里的 achievements —— 打招呼语里的「依据」基本都来自那里，
    技能列表只是关键词，撑不起一句有说服力的话。
    """
    lines: list[str] = []
    head = "｜".join(
        x for x in [
            str(resume.get("name") or ""),
            str(resume.get("title") or ""),
            f"{resume['years_exp']} 年经验" if resume.get("years_exp") else "",
        ] if x
    )
    if head:
        lines.append(head)
    if resume.get("summary"):
        lines.append("自我总结：" + str(resume["summary"]))
    skills = resume.get("skills") or []
    if skills:
        lines.append("技能：" + "、".join(str(s) for s in skills[:40]))

    for exp in (resume.get("experience") or [])[:6]:
        if not isinstance(exp, dict):
            continue
        period = str(exp.get("period") or "")
        title = " ".join(
            x for x in [
                str(exp.get("company") or ""),
                str(exp.get("role") or ""),
                period + _span_note(period),
            ] if x
        )
        lines.append("经历：" + title)
        for a in (exp.get("achievements") or [])[:6]:
            lines.append("  - " + str(a))

    edu = resume.get("education") or []
    if edu and isinstance(edu[0], dict):
        e = edu[0]
        lines.append("学历：" + " ".join(
            str(x) for x in [e.get("school"), e.get("degree"), e.get("major"), e.get("period")] if x
        ))
    return "\n".join(lines)


def _platform_note(source: str) -> tuple[str, str]:
    key = (source or "manual").strip().lower()
    note = _PLATFORM.get(key, _PLATFORM["manual"])
    length = _LENGTH_BOSS if key == "boss" else _LENGTH_NORMAL
    return note, length


def _clean_text(t: str) -> str:
    """收拾大模型爱犯的小毛病：包裹引号、多余空行、句首的「打招呼语：」。"""
    t = str(t or "").strip()
    t = re.sub(r"^```[a-z]*\s*|\s*```$", "", t, flags=re.MULTILINE).strip()
    t = re.sub(r"^(打招呼语|招呼语|消息)\s*[:：]\s*", "", t)
    t = t.strip().strip('"').strip("「」").strip()
    return re.sub(r"[ \t]+", " ", t).strip()


def _strip_negative(text: str) -> str:
    """最后一道保险：把含自我否定的那一句整句删掉。

    只在「重写一遍还是违规」时才用。少一句，好过让他复制一条
    「Go/Java 后端没写过」直接发给 HR。
    """
    parts = re.split(r"(?<=[。！？；\n])", text)
    kept = [p for p in parts if p.strip() and not _NEGATIVE.search(p)]
    out = "".join(kept).strip()
    return out if len(out) >= 12 else text


def _fallback(note: str) -> dict:
    return {"variants": [], "matched": [], "gaps": [], "tip": note, "note": note}


def sig_of(job: dict, resume: dict, extra: str = "") -> str:
    """缓存指纹：JD、简历、额外要求、平台任一变化都会让旧文案失效。

    投递会一次跑十几条，指纹算错就等于把上一条岗位的招呼语发给下一家，
    所以这里单独抽出来给 /greeting 和批量投递共用。
    """
    import hashlib
    import json as _json

    return hashlib.sha1(
        "\n".join(
            [
                str(job.get("jd_text") or ""),
                _json.dumps(resume, ensure_ascii=False, sort_keys=True),
                (extra or "").strip(),
                str(job.get("source") or ""),
            ]
        ).encode("utf-8")
    ).hexdigest()[:16]


def pick_variant(data: dict, prefer: str = "对标") -> str:
    """从三版里挑一版要发出去的。

    prefer 按 label 匹配，匹配不到就退回第一版 —— 不能因为文案标签改名就发空消息。
    """
    variants = [v for v in (data.get("variants") or []) if isinstance(v, dict) and v.get("text")]
    if not variants:
        return ""
    # 没抓到 JD 时生成的是「通用版」，没有「对标」标签，直接取第一版
    if data.get("no_jd"):
        return str(variants[0]["text"]).strip()
    for v in variants:
        if prefer and prefer in str(v.get("label") or ""):
            return str(v["text"]).strip()
    return str(variants[0]["text"]).strip()


# 没抓到 JD 正文时的兜底提示词：只能写「通用有诚意的开场」，
# 绝不许假装读懂了岗位要求——没读过 JD 还硬说「看到您的要求」，HR 一眼戳穿。
_PROMPT_NO_JD = """你在帮一位求职者写招聘平台上的第一条打招呼消息。注意：这条岗位的职责和任职要求**没抓到原文**，所以你不能假装读懂了它。

【岗位（仅有的信息）】
公司：{company}
岗位：{title}
城市：{city}　薪资：{salary}　经验要求：{experience}　学历要求：{education}

【我的简历】
{resume}

【发布平台】
{platform}

【五条硬规矩，违反了这条消息就废了】
1. 事实纪律：只能使用上面简历里真实写着的公司、项目、技术、年限。不许编造任何项目名、技术栈、数字、成果。
2. 因为岗位要求原文缺失，正文里**严禁出现**「看到您的要求」「符合贵司的要求」「和岗位要求很匹配」「您要的 X 我都有」这类话——你根本不知道对方要什么，这么说等于撒谎。只能按岗位标题的方向，讲清楚自己是干什么的、能带来什么。
3. 第一句就给硬信息：几年经验 + 干什么方向。不许用「您好，我对该职位很感兴趣」这类开场。
4. 年限只准照抄简历里写明的数字，或者直接引用括号里已经算好的时长，不许自己折算。
5. 正文里禁止自我否定：不许出现「没做过」「没写过」「不会」「不熟」「缺乏」这类话，也不许主动交待短板。

【语气】礼貌但不谄媚，不用 emoji，不堆感叹号，不说「求个机会」这类低声下气的话。结尾留一个轻量的下一步动作。

【长度】{length}

【输出】只返回 JSON，不要任何解释：
{{
  "variants": [
    {{"style": "match", "label": "通用版", "use": "没抓到 JD 原文时，讲清楚自己的方向与诚意", "text": "招呼语正文"}},
    {{"style": "brief", "label": "极简版", "use": "先确认对方有没有 HC", "text": "招呼语正文"}}
  ],
  "matched": [],
  "gaps": ["这条岗位的职责与任职要求原文没抓到，建议先点「看原岗位」核对再决定是否投递"],
  "tip": "本条 JD 正文缺失，是通用招呼语；发出后建议尽快在聊天里向 HR 要一份岗位职责说明"
}}"""


def build(job: dict, resume: dict, refresh: bool = False, extra: str = "") -> dict:
    """生成打招呼语。返回 variants / matched / gaps / tip。

    refresh 只是给上层做缓存判断用，本函数自己不做缓存。
    extra 是用户临时追加的要求（比如「再口语一点」「别提前端」），直接拼进提示词。

    JD 正文为空时不再直接报错，改走 _PROMPT_NO_JD 生成一份「不假装读懂要求」
    的通用招呼语——这样有链接但没抓到正文的岗位也能投，不会整批卡死。
    """
    jd = str(job.get("jd_text") or "").strip()
    no_jd = len(jd) < 20

    platform, length = _platform_note(job.get("source") or "manual")
    extra_block = f"\n【额外要求（优先满足这条）】\n{extra.strip()}\n" if extra.strip() else ""

    if no_jd:
        prompt = _PROMPT_NO_JD.format(
            company=job.get("company") or "（未写公司名）",
            title=job.get("title") or "（未写岗位名）",
            city=job.get("city") or "不限",
            salary=job.get("salary") or "未写",
            experience=job.get("experience_req") or "未写",
            education=job.get("education_req") or "未写",
            resume=_resume_text(resume),
            platform=platform,
            length=length,
        )
    else:
        prompt = _PROMPT.format(
            company=job.get("company") or "（未写公司名）",
            title=job.get("title") or "（未写岗位名）",
            city=job.get("city") or "不限",
            salary=job.get("salary") or "未写",
            experience=job.get("experience_req") or "未写",
            education=job.get("education_req") or "未写",
            jd=jd[:_MAX_JD],
            resume=_resume_text(resume),
            platform=platform,
            length=length,
            extra=extra_block,
        )

    if settings.demo_mode:
        return _fallback("演示模式不调用大模型，没法生成招呼语。配置好 API Key 再来。")

    # 略带变化，三版之间才不会读起来像复制粘贴
    llm = get_llm(temperature=0.55)
    data: dict | None = None
    last_err = ""
    # 最多两次：第一次不合格就带着纠正提示重写一遍。
    # 宁可多花 5 秒，也不能让他复制一条自曝短板的招呼语发出去。
    for attempt in range(2):
        try:
            data = extract_json(text_of(llm.invoke(prompt if attempt == 0 else prompt + _RETRY_HINT)))
        except Exception as e:  # 网络、超时、JSON 解析失败都归到这里
            last_err = str(e)[:120]
            data = None
            continue
        texts = [str(v.get("text") or "") for v in (data.get("variants") or []) if isinstance(v, dict)]
        if not any(_NEGATIVE.search(t) for t in texts):
            break

    if data is None:
        return _fallback(f"生成失败：{last_err or '大模型没有返回内容'}")

    variants = []
    for v in data.get("variants") or []:
        if not isinstance(v, dict):
            continue
        text = _clean_text(v.get("text"))
        if not text:
            continue
        if _NEGATIVE.search(text):
            text = _strip_negative(text)
        variants.append({
            "style": str(v.get("style") or f"v{len(variants) + 1}"),
            "label": str(v.get("label") or "招呼语"),
            "use": str(v.get("use") or ""),
            "text": text,
            "chars": len(text),
        })
    if not variants:
        return _fallback("大模型没返回可用的招呼语，再点一次试试。")

    def _list(key: str, limit: int) -> list[str]:
        out = []
        for x in data.get(key) or []:
            s = str(x).strip()
            if s:
                out.append(s)
        return out[:limit]

    return {
        "variants": variants,
        "matched": _list("matched", 5),
        "gaps": _list("gaps", 3),
        "tip": str(data.get("tip") or "").strip(),
        "job": {"id": job.get("id") or "", "title": job.get("title") or "",
                "company": job.get("company") or ""},
    }
