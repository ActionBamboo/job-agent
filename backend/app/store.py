"""业务存取层：岗位、简历、匹配历史。"""
import json
import uuid
from pathlib import Path

from . import db
from .config import DATA_DIR, ROOT
from .textutil import clean_salary

SAMPLE_JOBS = ROOT / "sample_data" / "jobs.json"
RESUME_FILE = Path(DATA_DIR) / "resume.json"
SEED_FLAG = "sample_jobs_seeded"


def _fix_job(job: dict) -> dict:
    """读出 / 写入时统一清洗字段。

    历史数据里存的是 BOSS 字体加密后的薪资（\\ue032\\ue036-\\ue033\\ue036K…），
    这里在存取边界上一次性还原，既修好老数据，也不用改抓取侧。
    """
    if not isinstance(job, dict):
        return job
    salary = clean_salary(job.get("salary") or "")
    if salary != (job.get("salary") or ""):
        job = {**job, "salary": salary}
    return job


def _seed_samples() -> None:
    """首次运行播种样例 JD；只播一次，避免用户删掉的样例又冒出来。"""
    db.init_db()
    if db.get_meta(SEED_FLAG):
        return
    try:
        jobs = json.loads(SAMPLE_JOBS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        jobs = []
    if jobs:
        db.upsert_jobs(jobs)
    db.set_meta(SEED_FLAG, "1")


# ---------------- 岗位 ----------------

def load_jobs(source: str | None = None) -> list[dict]:
    _seed_samples()
    return [_fix_job(j) for j in db.list_jobs(source)]


def count_jobs_by_source() -> dict[str, int]:
    _seed_samples()
    return db.count_jobs_by_source()


def get_job(job_id: str) -> dict | None:
    _seed_samples()
    job = db.get_job(job_id)
    return _fix_job(job) if job else None


def upsert_jobs(jobs: list[dict]) -> None:
    db.init_db()
    db.upsert_jobs([_fix_job(j) for j in jobs])


def add_job(data: dict) -> dict:
    """手工新增一条 JD。"""
    db.init_db()
    job = {
        "id": data.get("id") or f"manual-{uuid.uuid4().hex[:8]}",
        "title": (data.get("title") or "未命名岗位").strip(),
        "company": (data.get("company") or "").strip(),
        "city": (data.get("city") or "").strip(),
        "salary": clean_salary(data.get("salary") or ""),
        "experience_req": (data.get("experience_req") or "").strip(),
        "education_req": (data.get("education_req") or "").strip(),
        "jd_text": (data.get("jd_text") or "").strip(),
        "url": (data.get("url") or "").strip(),
        "source": (data.get("source") or "manual").strip(),
    }
    db.upsert_jobs([job])
    return job


def delete_job(job_id: str) -> bool:
    db.init_db()
    return db.delete_job(job_id)


def clear_jobs(source: str | None = None) -> int:
    db.init_db()
    return db.clear_jobs(source)


def save_match(job_id: str, result: dict) -> None:
    db.init_db()
    db.save_match(job_id, result)


def list_matches(limit: int = 100) -> list[dict]:
    db.init_db()
    return db.list_matches(limit)


def delete_match(match_id: int) -> bool:
    db.init_db()
    return db.delete_match(match_id)


def stats() -> dict:
    _seed_samples()
    return db.stats()


# ---------------- 当前简历 ----------------

def load_resume() -> dict | None:
    if not RESUME_FILE.exists():
        return None
    try:
        data = json.loads(RESUME_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def save_resume(resume: dict) -> dict:
    RESUME_FILE.parent.mkdir(parents=True, exist_ok=True)
    RESUME_FILE.write_text(
        json.dumps(resume, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return resume
