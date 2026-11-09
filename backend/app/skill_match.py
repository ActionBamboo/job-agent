"""技能级规则匹配：简历技能 × JD 正文。

为什么单独做一套规则匹配（而不是全交给大模型）：
- 抓完 20 条岗位要立刻出结果，大模型逐条打分要几十秒到几分钟，还要花钱；
- 「匹配度」这个数字必须可解释、可复现 —— 用户看到 92% 要知道是哪 11 个技能命中、
  哪 1 个没命中，而不是模型编一个总分。

口径（重要，避免误解）：
    匹配度 = 简历覆盖了 JD 要求的技能里多少个
           = |简历技能 ∩ JD 提到的技能| / |JD 提到的技能| × 100

以 JD 侧为分母，而不是以简历侧为分母：
- 以简历为分母时，简历技能写得越多分数越低，是一种「自我惩罚」，不符合直觉；
- 以 JD 为分母更贴近「这个岗位要求的东西，我会多少」。

JD 里一个技术词都没识别到时，score 返回 None（前端标记「JD 未识别到技能要求」），
而不是硬凑一个 0 分或 100 分。
"""
from __future__ import annotations

import re
from typing import Iterable

# 词典：canonical -> (展示名, 别名...)
# 别名会做小写 + 词边界匹配，中文别名按子串匹配。
_DICT: dict[str, tuple] = {
    # ---- 前端 ----
    "html": ("HTML", "html", "html5"),
    "css": ("CSS", "css", "css3"),
    "sass": ("Sass/SCSS", "sass", "scss", "less"),
    "javascript": ("JavaScript", "javascript", "js", "es6", "es2015", "es2020", "ecmascript"),
    "typescript": ("TypeScript", "typescript", "ts"),
    "vue": ("Vue", "vue", "vue.js", "vuejs", "vue2", "vue3", "vue 3"),
    "react": ("React", "react", "react.js", "reactjs"),
    "state_mgmt": ("状态管理", "pinia", "vuex", "redux", "mobx", "状态管理"),
    "vue_router": ("前端路由", "vue router", "vue-router", "react router", "react-router", "前端路由"),
    "component_ui": ("组件库", "element plus", "element-ui", "element ui", "element-plus", "ant design", "antd", "组件库", "ui 组件库"),
    "angular": ("Angular", "angular", "angularjs"),
    "node": ("Node.js", "node", "node.js", "nodejs", "node 环境"),
    "webpack": ("Webpack", "webpack"),
    "vite": ("Vite", "vite"),
    "rollup": ("Rollup", "rollup"),
    "babel": ("Babel", "babel"),
    "echarts": ("ECharts", "echarts"),
    "d3": ("D3", "d3.js"),
    "webgl": ("WebGL", "webgl"),
    "electron": ("Electron", "electron"),
    "bun": ("Bun", "bun", "bun.js", "bun 运行时"),
    "lowcode": ("低代码", "低代码", "low code", "lowcode", "配置驱动", "schema 驱动", "schema驱动", "json schema", "schema 协议"),
    "plugin": ("插件化", "插件化", "插件机制", "插件架构", "微前端"),
    "visual": ("数据可视化", "数据可视化", "可视化", "大屏", "可视化大屏", "图表"),
    "flutter": ("Flutter", "flutter"),
    "uniapp": ("uni-app", "uniapp", "uni-app"),
    "miniprogram": ("小程序", "小程序", "微信小程序", "小程序开发"),
    "browser_ext": ("浏览器插件", "浏览器插件", "chrome 插件", "扩展程序"),
    "hbuilder": ("HBuilder", "hbuilder"),
    "responsive": ("响应式布局", "响应式布局", "响应式设计"),
    # ---- 通用后端 / 工程化 ----
    "python": ("Python", "python"),
    "java": ("Java", "java"),
    "golang": ("Go", "golang", "go语言"),
    "rust": ("Rust", "rust"),
    "csharp": ("C#", "c#"),
    "cpp": ("C++", "c++"),
    "sql": ("SQL", "sql", "mysql", "postgres", "postgresql", "sqlite"),
    "nosql": ("NoSQL", "nosql", "mongodb", "elasticsearch"),
    "redis": ("Redis", "redis"),
    "kafka": ("消息队列", "kafka", "rabbitmq", "rocketmq", "消息队列"),
    "docker": ("Docker", "docker", "容器化"),
    "k8s": ("Kubernetes", "kubernetes", "k8s"),
    "git": ("Git", "git", "版本管理"),
    "linux": ("Linux", "linux", "shell"),
    "nginx": ("Nginx", "nginx"),
    "grpc": ("gRPC", "grpc"),
    "restful": ("RESTful", "restful", "rest api", "http 接口"),
    "fastapi": ("FastAPI", "fastapi"),
    "flask": ("Flask", "flask"),
    "django": ("Django", "django"),
    "spring": ("Spring", "spring", "springboot", "spring boot"),
    "microservice": ("微服务", "微服务", "microservice"),
    "devops": ("DevOps", "devops", "ci/cd", "持续集成"),
    "test": ("单元测试", "单元测试", "自动化测试", "pytest", "jest", "vitest"),
    "code_quality": ("代码质量", "sonarqube", "eslint", "code review", "代码规范", "代码质量"),
    "performance": ("性能优化", "性能优化", "性能调优"),
    "realtime": ("实时通信", "websocket", "websocket 长连接", "tcp", "tcp/ip", "socket", "长连接", "二进制协议"),
    "workflow_engine": ("流程编排", "dag", "拓扑排序", "有向无环图", "流程引擎", "工作流引擎"),
    "collab": ("协同编辑", "crdt", "yjs", "协同编辑", "多人协作编辑"),
    # ---- AI 应用 ----
    "llm": ("大模型", "llm", "大模型", "大语言模型", "语言模型"),
    "prompt": ("Prompt 工程", "prompt", "提示词", "提示工程"),
    "rag": ("RAG", "rag", "检索增强", "知识库检索", "向量检索", "向量库检索"),
    "agent": ("Agent 智能体", "agent", "智能体", "agentic"),
    "workflow": ("工作流编排", "工作流", "workflow", "编排"),
    "tool_call": ("工具调用", "function call", "function calling", "工具调用", "函数调用"),
    "mcp": ("MCP", "mcp"),
    "langchain": ("LangChain", "langchain"),
    "langgraph": ("LangGraph", "langgraph"),
    "dify": ("Dify", "dify"),
    "coze": ("Coze/扣子", "coze", "扣子"),
    "n8n": ("n8n", "n8n"),
    "vector_db": ("向量数据库", "向量数据库", "milvus", "faiss", "chroma", "pgvector", "qdrant", "weaviate"),
    "embedding": ("Embedding", "embedding", "向量化", "文本向量"),
    "finetune": ("模型微调", "微调", "fine-tune", "finetune", "sft", "lora", "qlora"),
    "nlp": ("NLP", "nlp", "自然语言处理"),
    "cv": ("计算机视觉", "计算机视觉", "opencv", "图像识别"),
    "pytorch": ("PyTorch", "pytorch", "torch"),
    "tensorflow": ("TensorFlow", "tensorflow"),
    "transformers": ("Transformers", "transformers", "huggingface"),
    "vllm": ("vLLM", "vllm", "推理加速", "模型部署"),
    "multimodal": ("多模态", "多模态"),
    "asr": ("语音识别", "语音识别", "asr", "tts"),
    "ai_coding": ("AI 编码工具", "codex", "trae", "cursor", "copilot", "claude code", "ai 编程"),
    # ---- 抓取 / 数据 ----
    "playwright": ("Playwright", "playwright"),
    "selenium": ("Selenium", "selenium"),
    "crawler": ("爬虫", "爬虫", "数据采集", "数据抓取", "爬取"),
    "scrapy": ("Scrapy", "scrapy"),
    "data_analysis": ("数据分析", "数据分析", "数据统计", "数据可视化"),
    "excel": ("Excel", "excel", "vba"),
    "bi": ("BI 报表", "bi", "报表开发", "数据看板"),
    # ---- 软技能 / 岗位常见要求 ----
    "product": ("产品思维", "产品思维", "需求分析", "产品设计"),
    "project": ("项目管理", "项目管理", "进度管理", "跨部门协作", "跨部门沟通"),
    "docs": ("文档能力", "技术文档", "文档编写", "方案编写"),
    "communication": ("沟通表达", "沟通能力", "表达能力", "客户沟通"),
    "solution": ("解决方案", "解决方案", "方案设计", "售前"),
    "delivery": ("交付落地", "交付", "落地", "实施"),
    "teamwork": ("团队协作", "团队协作", "团队合作"),
    "learning": ("学习能力", "学习能力", "自驱"),
}

# 软性要求不计入分母：JD 里几乎必然出现「良好的沟通能力」「有责任心」，
# 算进分母会把每个人的分数都拉低一截，反而让匹配度失真。
# 命中时作为「加分项」单独展示，不参与百分比计算。
_SOFT = {
    "product", "project", "docs", "communication",
    "solution", "delivery", "teamwork", "learning",
}

# 出现这些说法时，该句里的技能算「加分项」，不计入匹配度分母。
# 例：「熟悉 Flutter，有跨端经验者优先」「了解小程序更佳」—— 本来就不该扣分，
# 但旧算法会把它当硬要求，导致每条前端 JD 都凭空多出 1-2 个缺失项。
_BONUS_HINTS = ("优先", "加分", "更佳", "加分项", "nice to have", "is a plus", "bonus", "锦上添花")

# canonical -> (展示名, [小写别名])
_ALIASES: dict[str, tuple[str, list[str]]] = {
    k: (v[0], [str(a).lower() for a in v[1:]]) for k, v in _DICT.items()
}

_CJK = re.compile(r"[\u4e00-\u9fff]")


def _norm(text: str) -> str:
    """统一小写 + 压空白，方便匹配。"""
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def _alias_hit(haystack: str, alias: str) -> bool:
    """别名是否出现在文本里。中文按子串，英文按词边界（避免 js 命中 json）。"""
    if not alias:
        return False
    if _CJK.search(alias):
        return alias in haystack
    pat = r"(?<![a-z0-9])" + re.escape(alias) + r"(?![a-z0-9])"
    return re.search(pat, haystack) is not None


def canonicalize_skill(skill: str) -> str | None:
    """把简历里的一个技能串归一化成词典 key；认不出来返回 None。"""
    s = _norm(skill)
    if not s:
        return None
    # 先试精确（含复数/空格差异）
    for key, (_, aliases) in _ALIASES.items():
        if s in aliases:
            return key
    # 再试包含（简历里常写成「Node.js 基础」「大模型 API 接入」）
    for key, (_, aliases) in _ALIASES.items():
        if any(_alias_hit(s, a) for a in aliases):
            return key
    return None


def _display(key: str) -> str:
    return _ALIASES[key][0] if key in _ALIASES else key


def resume_skill_keys(skills: Iterable[str]) -> tuple[set[str], list[str]]:
    """简历技能 -> 归一化 key 集合 + 认不出的原始技能（仍参与 JD 文本搜索）。"""
    keys: set[str] = set()
    custom: list[str] = []
    for raw in skills or []:
        s = str(raw or "").strip()
        if not s:
            continue
        key = canonicalize_skill(s)
        if key:
            keys.add(key)
        elif len(s) <= 24:
            custom.append(s)
    return keys, custom


def jd_skill_keys(jd_text: str) -> set[str]:
    """扫 JD 正文，收集里面出现的所有词典技能。"""
    text = _norm(jd_text)
    if not text:
        return set()
    return {key for key, (_, aliases) in _ALIASES.items() if any(_alias_hit(text, a) for a in aliases)}


def jd_skill_split(jd_text: str) -> tuple[set[str], set[str]]:
    """把 JD 里的技能拆成「硬要求」和「加分项」。

    逐句判断：句子里带「优先 / 加分 / 更佳 / is a plus」等字样的，该句技能记为加分项。
    同一个技能只要在任意一句里作为硬要求出现，就算硬要求。
    """
    text = str(jd_text or "")
    if not text.strip():
        return set(), set()
    hard: set[str] = set()
    bonus: set[str] = set()
    for sent in re.split(r"[。；;！!\n]", text):
        s = _norm(sent)
        if not s:
            continue
        is_bonus = any(h in s for h in _BONUS_HINTS)
        for key, (_, aliases) in _ALIASES.items():
            if key in _SOFT:
                continue
            if any(_alias_hit(s, a) for a in aliases):
                (bonus if is_bonus else hard).add(key)
    return hard, bonus - hard


def resume_text_skill_keys(resume: dict | None) -> set[str]:
    """从简历「正文」里扫技能，而不只是技能清单。

    起因：简历的技能块常常只列一部分，真正干过的活写在项目/工作经历里
    （比如「首屏由 4 秒降到 1.5 秒」＝ 性能优化、「引入 SonarQube 检查」＝ 代码质量）。
    只看技能块会把这些能力白白丢掉，导致分数虚低。
    """
    if not resume:
        return set()
    parts: list[str] = [
        str(resume.get("summary") or ""),
        str(resume.get("title") or ""),
        str(resume.get("target_role") or ""),
    ]
    for exp in resume.get("experience") or []:
        if not isinstance(exp, dict):
            continue
        parts += [str(exp.get("company") or ""), str(exp.get("role") or "")]
        parts += [str(a) for a in (exp.get("achievements") or [])]
    for edu in resume.get("education") or []:
        if isinstance(edu, dict):
            parts += [str(edu.get("major") or ""), str(edu.get("school") or "")]
    return jd_skill_keys(" ".join(parts))


def evaluate(skills: Iterable[str], job: dict, resume: dict | None = None) -> dict:
    """给一条岗位打技能匹配分。

    resume 传进来时，会把简历正文里的技能一并算作「我具备的能力」。
    """
    jd = job.get("jd_text") or ""
    # 分母只算「硬要求」；「优先 / 加分」类的技能单独展示，不扣分
    hard_keys, bonus_keys = jd_skill_split(jd)
    if not hard_keys:
        hard_keys = set(bonus_keys)   # 整段都是加分项时（少见），退回用加分项打分
    all_jd_keys = jd_skill_keys(jd)
    my_keys, custom = resume_skill_keys(skills)
    from_text = set()
    if resume:
        from_text = resume_text_skill_keys(resume) - my_keys
        my_keys |= from_text

    # 简历里词典认不出的技能，直接在 JD 原文里找
    custom_hit = [s for s in custom if _alias_hit(_norm(jd), _norm(s))]

    hit = sorted(hard_keys & my_keys)
    miss = sorted(hard_keys - my_keys)
    bonus_hit = sorted(bonus_keys & my_keys)
    bonus_miss = sorted(bonus_keys - my_keys)
    soft_hit = sorted((all_jd_keys & my_keys) - hard_keys - bonus_keys)
    score = round(100 * len(hit) / len(hard_keys)) if hard_keys else None

    note = ""
    if len(jd.strip()) < 80:
        note = "JD 正文没抓全，分数仅供参考"
    elif not hard_keys:
        note = "JD 里没识别到技术技能词"

    return {
        "job": {
            "id": job.get("id", ""),
            "title": job.get("title", ""),
            "company": job.get("company", ""),
            "city": job.get("city", ""),
            "salary": job.get("salary", ""),
            "url": job.get("url", ""),
            "source": job.get("source", ""),
            "experience_req": job.get("experience_req", ""),
            "education_req": job.get("education_req", ""),
        },
        "score": score,
        "hit": [_display(k) for k in hit],
        "miss": [_display(k) for k in miss],
        "bonus_hit": [_display(k) for k in bonus_hit],
        "bonus_miss": [_display(k) for k in bonus_miss],
        "soft_hit": [_display(k) for k in soft_hit],
        "extra": custom_hit,          # 简历里有、词典没收录但 JD 也提到的
        "jd_skills": [_display(k) for k in sorted(hard_keys)],
        "jd_len": len(jd.strip()),
        "note": note,
    }
