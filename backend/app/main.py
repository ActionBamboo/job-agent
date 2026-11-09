"""FastAPI 接口层（桌面端与浏览器共用）。"""
import hashlib
import json
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import company_research, greeting, runner, salary, skill_match, store
from .agent_graph import match_job
from .config import settings, web_dir
from .parser import extract_resume_text, parse_resume

VERSION = "1.0.0"
STARTED_AT = time.time()

app = FastAPI(title="JobMatch Agent", version=VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

WEB = web_dir()
if WEB.is_dir():
    app.mount("/ui", StaticFiles(directory=str(WEB), html=True), name="ui")


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"detail": str(exc)})


# ----------------------------- 数据模型 -----------------------------

class ResumeText(BaseModel):
    text: str


class MatchRequest(BaseModel):
    resume: dict | None = None


class JobIn(BaseModel):
    id: str | None = None
    title: str
    company: str = ""
    city: str = ""
    salary: str = ""
    experience_req: str = ""
    education_req: str = ""
    jd_text: str = ""
    url: str = ""
    source: str = "manual"


class SettingsPatch(BaseModel):
    openai_api_key: str | None = None
    openai_base_url: str | None = None
    openai_model: str | None = None
    demo_mode: bool | None = None
    scrape_city: str | None = None
    scrape_keyword: str | None = None
    scrape_pages: int | None = None
    match_source: str | None = None
    match_positions: list[str] | None = None


class ScrapeReq(BaseModel):
    keyword: str = Field(default="AI Agent")
    keywords: list[str] = Field(default_factory=list, description="期望职位列表（可多选）")
    city: str = Field(default="深圳")
    pages: int = 1
    detail_limit: int = 20
    source: str = Field(default="boss", description="抓取器 key，如 boss / job51")


class ApplyRecordReq(BaseModel):
    """投递结果回写。

    投递本身在 Electron 内置浏览器里跑（Playwright 会被招聘站清成 about:blank），
    后端只接收每一条的结果。失败的不记为已投，下次勾选还能重投。
    """

    job_id: str
    status: str = Field(default="sent", description="sent / failed / skipped")
    message: str = ""
    note: str = ""


class SkillMatchReq(BaseModel):
    """技能级规则匹配入参。

    job_ids 为空时匹配整库（或 source 过滤后的库）。
    threshold 只用于统计「命中多少条」，明细全量返回，前端滑阈值时本地重筛，不必重新请求。
    """

    job_ids: list[str] | None = None
    source: str = ""
    threshold: int = 90
    resume: dict | None = None


class CompanyReq(BaseModel):
    """公司调研入参。refresh=True 时忽略缓存重新查。"""

    name: str
    refresh: bool = False


class GreetingReq(BaseModel):
    """打招呼语入参。

    job_id 优先（从库里取最新 JD）；也可以直接传 job 对象（还没入库的岗位）。
    extra 是临时追加的要求，比如「再口语一点」「别提我是前端」。
    """

    job_id: str | None = None
    job: dict | None = None
    resume: dict | None = None
    refresh: bool = False
    extra: str = ""


# ----------------------------- 基础 -----------------------------

@app.get("/")
def root():
    return RedirectResponse("/ui/") if (WEB / "index.html").exists() else {
        "name": "JobMatch Agent",
        "version": VERSION,
    }


@app.get("/health")
def health():
    """桌面端外壳用它判断后端是否就绪。"""
    return {"ok": True, "version": VERSION, "uptime": round(time.time() - STARTED_AT, 1)}


@app.get("/status")
def status():
    s = settings.as_dict()
    return {
        "version": VERSION,
        "demo_mode": settings.demo_mode,
        "model": settings.openai_model,
        "has_api_key": bool(settings.openai_api_key),
        "api_key_masked": s["openai_api_key_masked"],
        "data_dir": settings.data_dir,
        "stats": store.stats(),
    }


@app.get("/stats")
def stats():
    return store.stats()


# ----------------------------- 设置 -----------------------------

@app.get("/settings")
def get_settings():
    return settings.as_dict()


@app.post("/settings")
def update_settings(patch: SettingsPatch):
    data = {k: v for k, v in patch.model_dump().items() if v is not None}
    if not data:
        return settings.as_dict()
    settings.save(data)
    return settings.as_dict()


# ----------------------------- 简历 -----------------------------

def _remember(resume: dict) -> dict:
    store.save_resume(resume)
    return resume


@app.get("/resume")
def get_resume():
    r = store.load_resume()
    if not r:
        raise HTTPException(status_code=404, detail="还没有解析过简历")
    return r


@app.post("/resume")
def put_resume(resume: dict):
    if not resume:
        raise HTTPException(status_code=400, detail="简历内容为空")
    return _remember(resume)


@app.post("/resume/parse")
def resume_parse(body: ResumeText):
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="简历文本为空")
    return _remember(parse_resume(body.text))


@app.post("/resume/upload")
async def resume_upload(file: UploadFile = File(...)):
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="文件是空的")
    try:
        text = extract_resume_text(file.filename or "resume.txt", content)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"文件解析失败：{e}") from e
    if not text.strip():
        raise HTTPException(status_code=400, detail="无法从该文件中提取文本（可能是扫描版 PDF）")
    return _remember(parse_resume(text))


# ----------------------------- 岗位 -----------------------------

@app.get("/jobs")
def list_jobs(q: str = "", source: str = ""):
    jobs = store.load_jobs(source.strip() or None)
    if q.strip():
        kw = q.strip().lower()
        jobs = [
            j
            for j in jobs
            if kw in (j.get("title") or "").lower()
            or kw in (j.get("company") or "").lower()
            or kw in (j.get("jd_text") or "").lower()
        ]
    return jobs


@app.post("/jobs")
def create_job(body: JobIn):
    if not body.jd_text.strip():
        raise HTTPException(status_code=400, detail="JD 正文不能为空")
    return store.add_job(body.model_dump())


@app.get("/jobs/counts")
def job_counts():
    """各平台岗位数量，供智能匹配页显示「该平台已有 N 条」。"""
    by_source = store.count_jobs_by_source()
    return {"total": sum(by_source.values()), "by_source": by_source}


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    j = store.get_job(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="岗位不存在")
    return j


@app.delete("/jobs/{job_id}")
def delete_job(job_id: str):
    if not store.delete_job(job_id):
        raise HTTPException(status_code=404, detail="岗位不存在")
    return {"deleted": job_id}


# ----------------------------- 匹配 -----------------------------

def _resolve_resume(body: MatchRequest | None = None) -> dict:
    if body and body.resume:
        return body.resume
    r = store.load_resume()
    if r:
        return r
    raise HTTPException(status_code=400, detail="请先解析简历")


def _flatten(job: dict, result: dict) -> dict:
    ev = result.get("evaluation") or {}
    return {
        "job": {
            "id": job["id"],
            "title": job["title"],
            "company": job.get("company", ""),
            "city": job.get("city", ""),
            "salary": job.get("salary", ""),
        },
        "overall_score": ev.get("overall_score"),
        "dimensions": ev.get("dimensions"),
        "matched_points": ev.get("matched_points"),
        "gaps": ev.get("gaps"),
        "tailored_message": result.get("tailored_message"),
        "resume_suggestions": result.get("resume_suggestions"),
    }


@app.post("/match/batch")
def match_batch(body: MatchRequest | None = None):
    resume = _resolve_resume(body)
    results = []
    for j in store.load_jobs():
        r = match_job(resume, j)
        store.save_match(j["id"], r)
        results.append(_flatten(j, r))
    results.sort(key=lambda x: x["overall_score"] or 0, reverse=True)
    return results


@app.post("/match/skills")
def match_skills(body: SkillMatchReq | None = None):
    """技能级规则匹配：简历技能 × JD 正文，返回每条岗位的命中/缺失技能与匹配度。

    不调用大模型，本地毫秒级出结果，抓完就能立刻筛。
    """
    body = body or SkillMatchReq()
    resume = _resolve_resume(MatchRequest(resume=body.resume) if body.resume else None)
    skills = [str(s).strip() for s in (resume.get("skills") or []) if str(s).strip()]
    if not skills:
        raise HTTPException(
            status_code=400,
            detail="简历里没有技能字段，先到「我的简历」页解析一次简历",
        )

    if body.job_ids:
        jobs = [j for j in (store.get_job(i) for i in body.job_ids) if j]
    else:
        jobs = store.load_jobs(body.source.strip() or None)

    # 把整份简历也传进去：技能块常常写不全，工作经历里的「首屏 4 秒降到 1.5 秒」
    # 这类描述同样代表能力，只看技能清单会让分数系统性偏低。
    items = [skill_match.evaluate(skills, j, resume) for j in jobs]
    # 分数为 None（JD 没识别到技能）的排最后
    items.sort(key=lambda x: (x["score"] is None, -(x["score"] or 0)))

    threshold = max(0, min(100, int(body.threshold)))
    passed = sum(1 for x in items if (x["score"] or 0) >= threshold and x["score"] is not None)
    exp = salary.parse_expected(resume.get("expected_salary"))
    below = sum(1 for x in items if (x.get("salary_hint") or {}).get("level") == "low")
    return {
        "resume_skills": skills,
        "items": items,
        "total": len(items),
        "threshold": threshold,
        "passed": passed,
        "best": items[0]["score"] if items else None,
        # 期望薪资只在界面上提示，不参与筛选
        "expected_k": exp,
        "below_expected": below,
    }


@app.get("/salary/hint")
def salary_hint_api(salary: str = "", expected: float = 0):
    """单个岗位的薪资提示。岗位库等没有走匹配接口的地方用它补提示。

    只返回一句话，不参与任何筛选。
    """
    # 参数名就叫 salary，会把模块名遮蔽掉，所以这里单独把函数引进来
    from .salary import salary_hint as _hint

    return _hint(salary, expected if expected > 0 else None)


@app.post("/company/research")
def company_research_api(body: CompanyReq):
    """调研一家公司：是不是外包、员工/求职者怎么评价。

    走搜索引擎摘要（脉脉、看准、知乎、雪球的片段都在里面），不用登录第三方账号。
    结果缓存 7 天，refresh=true 可强制重查。
    """
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="公司名不能为空")
    if not body.refresh:
        cached = store.get_company_research(name)
        if cached:
            return cached
    try:
        data = company_research.research(name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"调研失败：{e}")
    store.save_company_research(name, data)
    return data


@app.get("/company/researched")
def company_researched():
    """已调研过的公司列表，界面用来标「查过了」。"""
    return store.list_company_research()


@app.post("/greeting")
def greeting_api(body: GreetingReq):
    """根据岗位 JD + 当前简历，生成发给 HR 的第一条打招呼语。

    一次给三个版本（逐条对标 / 项目切入 / 极简），另外附上
    「我拿什么对上」「还缺什么」——让用户自己判断发哪条、要不要先补材料。
    同一岗位同一份简历会走缓存，refresh=true 强制重写。
    """
    job: dict | None = None
    if body.job_id:
        job = store.get_job(body.job_id)
        if not job:
            raise HTTPException(status_code=404, detail="岗位不存在")
    elif body.job:
        job = body.job
    else:
        raise HTTPException(status_code=400, detail="需要 job_id 或 job")

    resume = body.resume or store.load_resume()
    if not resume:
        raise HTTPException(status_code=400, detail="还没上传简历，先去「我的简历」传一份")
    no_jd = len(str(job.get("jd_text") or "").strip()) < 20

    job_id = str(job.get("id") or "")
    # 缓存指纹：简历改了、JD 重新抓过、或者追加了额外要求，都应该重新生成
    sig = hashlib.sha1(
        "\n".join(
            [
                str(job.get("jd_text") or ""),
                json.dumps(resume, ensure_ascii=False, sort_keys=True),
                body.extra.strip(),
                str(job.get("source") or ""),
            ]
        ).encode("utf-8")
    ).hexdigest()[:16]

    if job_id and not body.refresh:
        cached = store.get_greeting(job_id, sig)
        if cached:
            return cached

    try:
        data = greeting.build(job, resume, refresh=body.refresh, extra=body.extra)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if no_jd:
        data["no_jd"] = True

    if job_id and data.get("variants"):
        store.save_greeting(job_id, sig, data)
    return data


@app.post("/match/{job_id}")
def match(job_id: str, body: MatchRequest | None = None):
    resume = _resolve_resume(body)
    j = store.get_job(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="岗位不存在")
    r = match_job(resume, j)
    store.save_match(job_id, r)
    return r


@app.get("/match/intents")
def match_intents(source: str = "boss"):
    """某个平台的求职意向目录：期望职位分类 + 城市 + 已有岗位数。"""
    from . import platforms
    from .scraper import registry

    scr = registry.get(source)
    codes = list(getattr(scr, "city_codes", {}) or {}) if scr is not None else []
    data = platforms.catalog(source, codes or None)
    if scr is not None:
        data["name"] = scr.name
    data["available"] = scr is not None
    data["jobs_count"] = store.count_jobs_by_source().get(source, 0)
    return data


@app.get("/matches")
def list_matches(limit: int = 100):
    return store.list_matches(limit)


@app.delete("/matches/{match_id}")
def delete_match(match_id: int):
    if not store.delete_match(match_id):
        raise HTTPException(status_code=404, detail="记录不存在")
    return {"deleted": match_id}


# ----------------------------- 抓取任务 -----------------------------

@app.get("/scrape/sources")
def scrape_sources():
    """返回已注册的抓取平台列表（内置 + 自定义）。"""
    from .scraper import registry

    return registry.list_all()


@app.post("/scrape/sources")
def scrape_source_add(config: dict):
    """新增或更新一个自定义抓取平台。"""
    from .scraper import registry
    from .scraper.base import ScraperConfig

    try:
        cfg = ScraperConfig(**config)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"配置校验失败：{e}") from e

    try:
        registry.save_dynamic(cfg)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    return {"ok": True, "key": cfg.key, "name": cfg.name}


@app.delete("/scrape/sources/{key}")
def scrape_source_delete(key: str):
    """删除一个自定义抓取平台（内置平台不可删除）。"""
    from .scraper import registry

    try:
        if not registry.delete_dynamic(key):
            raise HTTPException(status_code=404, detail=f"未找到 '{key}'")
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    return {"deleted": key}


@app.get("/scrape/spec")
def scrape_spec(source: str = "boss"):
    """返回某平台的抓取规格，供桌面端内置浏览器执行抓取。

    Python 侧不完全负责抓取：Electron 内置浏览器也是真实 Chromium，
    且不会被招聘站的反自动化检测踢成白屏，因此把「登录 + 抓取」交给它执行，
    这里只提供 URL 模板与选择器。
    """
    from .scraper import registry

    try:
        scraper = registry.require(source)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=f"未找到平台 '{source}'") from e
    return scraper.spec()


@app.post("/jobs/import")
def jobs_import(payload: dict):
    """批量导入桌面端内置浏览器抓到的岗位。"""
    raw = payload.get("jobs") or []
    if not isinstance(raw, list) or not raw:
        raise HTTPException(status_code=400, detail="没有可导入的岗位")

    cleaned: list[dict] = []
    for item in raw[:500]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        cleaned.append({
            "id": str(item.get("id") or "").strip() or f"import-{uuid.uuid4().hex[:8]}",
            "title": title[:200],
            "company": str(item.get("company") or "").strip()[:200],
            "city": str(item.get("city") or "").strip()[:100],
            "salary": str(item.get("salary") or "").strip()[:100],
            "experience_req": str(item.get("experience_req") or "").strip()[:100],
            "education_req": str(item.get("education_req") or "").strip()[:100],
            "jd_text": str(item.get("jd_text") or "").strip()[:20000],
            "url": str(item.get("url") or "").strip()[:500],
            "source": str(item.get("source") or "boss").strip()[:50],
        })

    if not cleaned:
        raise HTTPException(status_code=400, detail="岗位数据不完整（标题为空）")

    store.upsert_jobs(cleaned)
    total = len(store.load_jobs())
    return {"received": len(raw), "imported": len(cleaned), "total": total}


@app.post("/scrape/run")
def scrape_run(req: ScrapeReq):
    kws = [k.strip() for k in (req.keywords or []) if k and k.strip()]
    if not kws:
        kw = req.keyword.strip()
        if kw:
            kws = [kw]
    if not kws:
        raise HTTPException(status_code=400, detail="至少选一个期望职位")
    if len(kws) > 8:
        raise HTTPException(status_code=400, detail="一次最多抓取 8 个期望职位，请减少后重试")
    try:
        task = runner.start_scrape(
            kws, req.city, max(1, min(req.pages, 10)),
            req.detail_limit, source=req.source,
        )
    except (RuntimeError, KeyError) as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return task.snapshot(0)


@app.post("/scrape/login")
def scrape_login(source: str = "boss"):
    try:
        task = runner.start_login(source)
    except (RuntimeError, KeyError) as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return task.snapshot(0)


@app.post("/apply/record")
def apply_record(body: ApplyRecordReq):
    """记一条投递结果。

    投递动作本身在内置浏览器里完成（Electron），后端只负责落库：
    哪条投成功了、发的是哪句话、失败原因是什么。失败的不标成已投，
    下次勾选还会自动重投。
    """
    if body.status not in ("sent", "failed", "skipped"):
        raise HTTPException(status_code=400, detail="status 只能是 sent / failed / skipped")
    store.save_application(body.job_id, body.status, body.message or "", body.note or "")
    return store.get_application(body.job_id)


@app.get("/applications")
def applications():
    """投递记录：job_id → 状态，前端用来标「已投」。"""
    return store.list_applications()


@app.post("/jobs/jd-backfill")
def jobs_jd_backfill(payload: dict):
    """投递前补抓到的 JD 正文回写：把这些岗位的 jd_text 补上，下次就能对着要求写。"""
    items = payload.get("items") or []
    if not isinstance(items, list):
        raise HTTPException(status_code=400, detail="items 必须是数组")
    ok = 0
    for it in items:
        if not isinstance(it, dict):
            continue
        jid = str(it.get("job_id") or "").strip()
        jd = str(it.get("jd_text") or "").strip()
        if not jid or len(jd) < 20:
            continue
        if store.update_job_jd(
            jid, jd,
            str(it.get("experience_req") or "").strip(),
            str(it.get("education_req") or "").strip(),
        ):
            ok += 1
    return {"updated": ok}


@app.get("/tasks/{task_id}")
def task_status(task_id: str, since: int = 0):
    t = runner.get_task(task_id)
    if not t:
        raise HTTPException(status_code=404, detail="任务不存在")
    return t.snapshot(since)


@app.post("/tasks/{task_id}/cancel")
def task_cancel(task_id: str):
    if not runner.cancel(task_id):
        raise HTTPException(status_code=400, detail="任务已结束或不存在")
    return {"cancelled": task_id}