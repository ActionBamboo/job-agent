"""SQLite 持久化：岗位、匹配历史、元信息。"""
import json
import sqlite3
from pathlib import Path

from .config import settings

DB_PATH = Path(settings.data_dir) / "jobmatch.db"


def get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_conn()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            company TEXT,
            city TEXT,
            salary TEXT,
            experience_req TEXT,
            education_req TEXT,
            jd_text TEXT,
            url TEXT,
            source TEXT
        );
        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL,
            overall_score INTEGER,
            dimensions TEXT,
            matched_points TEXT,
            gaps TEXT,
            tailored_message TEXT,
            resume_suggestions TEXT,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        );
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS company_research (
            company TEXT PRIMARY KEY,
            data TEXT,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        );
        CREATE TABLE IF NOT EXISTS greetings (
            job_id TEXT PRIMARY KEY,
            sig TEXT,
            data TEXT,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        );
        CREATE TABLE IF NOT EXISTS applications (
            job_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            greeting TEXT,
            note TEXT,
            applied_at TEXT DEFAULT (datetime('now', 'localtime'))
        );
        """
    )
    conn.commit()
    conn.close()


def get_meta(key: str) -> str | None:
    conn = get_conn()
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else None


def set_meta(key: str, value: str) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
    conn.commit()
    conn.close()


JOB_COLS = [
    "id",
    "title",
    "company",
    "city",
    "salary",
    "experience_req",
    "education_req",
    "jd_text",
    "url",
    "source",
]


def upsert_jobs(jobs: list[dict]) -> None:
    conn = get_conn()
    for j in jobs:
        conn.execute(
            f"""
            INSERT INTO jobs ({','.join(JOB_COLS)})
            VALUES ({','.join(':' + c for c in JOB_COLS)})
            ON CONFLICT(id) DO UPDATE SET
                title=excluded.title, company=excluded.company, city=excluded.city,
                salary=excluded.salary, experience_req=excluded.experience_req,
                education_req=excluded.education_req, jd_text=excluded.jd_text,
                url=excluded.url, source=excluded.source
            """,
            {c: j.get(c, "") or "" for c in JOB_COLS},
        )
    conn.commit()
    conn.close()


def list_jobs(source: str | None = None) -> list[dict]:
    conn = get_conn()
    if source:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE source=? ORDER BY rowid DESC", (source,)
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM jobs ORDER BY rowid DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def count_jobs_by_source() -> dict[str, int]:
    """各来源的岗位数量，用于 UI 显示「该平台已有 N 条」。"""
    conn = get_conn()
    rows = conn.execute(
        "SELECT COALESCE(NULLIF(source, ''), 'manual') AS s, COUNT(*) AS n "
        "FROM jobs GROUP BY s"
    ).fetchall()
    conn.close()
    return {r["s"]: r["n"] for r in rows}


def get_job(job_id: str) -> dict | None:
    conn = get_conn()
    row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def update_job_jd(job_id: str, jd_text: str, experience_req: str = "", education_req: str = "") -> bool:
    """投递前补抓到 JD 正文后回写，让下次生成招呼语能对着真实要求写。"""
    conn = get_conn()
    cur = conn.execute(
        "UPDATE jobs SET jd_text=?, experience_req=CASE WHEN experience_req='' THEN ? ELSE experience_req END, "
        "education_req=CASE WHEN education_req='' THEN ? ELSE education_req END WHERE id=?",
        (jd_text, experience_req, education_req, job_id),
    )
    conn.commit()
    conn.close()
    return cur.rowcount > 0


def delete_job(job_id: str) -> bool:
    conn = get_conn()
    cur = conn.execute("DELETE FROM jobs WHERE id=?", (job_id,))
    conn.commit()
    conn.close()
    return cur.rowcount > 0


def clear_jobs(source: str | None = None) -> int:
    conn = get_conn()
    if source:
        cur = conn.execute("DELETE FROM jobs WHERE source=?", (source,))
    else:
        cur = conn.execute("DELETE FROM jobs")
    conn.commit()
    conn.close()
    return cur.rowcount


def save_match(job_id: str, result: dict) -> None:
    ev = result.get("evaluation") or {}
    conn = get_conn()
    conn.execute(
        """
        INSERT INTO matches
            (job_id, overall_score, dimensions, matched_points, gaps, tailored_message, resume_suggestions)
        VALUES (?,?,?,?,?,?,?)
        """,
        (
            job_id,
            ev.get("overall_score"),
            json.dumps(ev.get("dimensions", []), ensure_ascii=False),
            json.dumps(ev.get("matched_points", []), ensure_ascii=False),
            json.dumps(ev.get("gaps", []), ensure_ascii=False),
            result.get("tailored_message", ""),
            json.dumps(result.get("resume_suggestions", []), ensure_ascii=False),
        ),
    )
    conn.commit()
    conn.close()


def list_matches(limit: int = 100) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM matches ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        for k in ("dimensions", "matched_points", "gaps", "resume_suggestions"):
            try:
                d[k] = json.loads(d[k] or "[]")
            except json.JSONDecodeError:
                d[k] = []
        out.append(d)
    return out


def delete_match(match_id: int) -> bool:
    conn = get_conn()
    cur = conn.execute("DELETE FROM matches WHERE id=?", (match_id,))
    conn.commit()
    conn.close()
    return cur.rowcount > 0


# ----------------------------- 公司调研缓存 -----------------------------
# 一次调研要跑三个搜索 + 一次大模型，十几秒。同一家公司反复查没意义，
# 缓存 7 天；用户也可以主动要求刷新。

COMPANY_TTL_DAYS = 7


def get_company_research(company: str, ttl_days: int = COMPANY_TTL_DAYS) -> dict | None:
    """取缓存。超过 TTL 视为过期，返回 None 让上层重新查。"""
    conn = get_conn()
    row = conn.execute(
        "SELECT data, created_at, "
        "(julianday('now', 'localtime') - julianday(created_at)) AS age_days "
        "FROM company_research WHERE company=?",
        (company,),
    ).fetchone()
    conn.close()
    if not row:
        return None
    if ttl_days and (row["age_days"] or 0) > ttl_days:
        return None
    try:
        data = json.loads(row["data"] or "{}")
    except json.JSONDecodeError:
        return None
    data["cached"] = True
    data["cached_at"] = row["created_at"]
    return data


def save_company_research(company: str, data: dict) -> None:
    payload = {k: v for k, v in data.items() if k not in ("cached", "cached_at")}
    conn = get_conn()
    conn.execute(
        "INSERT INTO company_research (company, data) VALUES (?,?) "
        "ON CONFLICT(company) DO UPDATE SET data=excluded.data, "
        "created_at=datetime('now', 'localtime')",
        (company, json.dumps(payload, ensure_ascii=False)),
    )
    conn.commit()
    conn.close()


def list_company_research() -> list[dict]:
    """已调研过的公司，界面用来标「查过了」。"""
    conn = get_conn()
    rows = conn.execute(
        "SELECT company, created_at FROM company_research ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return [{"company": r["company"], "created_at": r["created_at"]} for r in rows]



# ----------------------------- 打招呼语缓存 -----------------------------
# 一次生成要 3~8 秒。sig 里带上 JD 和简历的指纹，
# 这样换了简历、或者岗位 JD 重新抓过，旧文案会自动失效而不是错发出去。

def get_greeting(job_id: str, sig: str) -> dict | None:
    conn = get_conn()
    row = conn.execute(
        "SELECT data, sig, created_at FROM greetings WHERE job_id=?", (job_id,)
    ).fetchone()
    conn.close()
    if not row or row["sig"] != sig:
        return None
    try:
        data = json.loads(row["data"] or "{}")
    except json.JSONDecodeError:
        return None
    data["cached"] = True
    data["cached_at"] = row["created_at"]
    return data


def save_greeting(job_id: str, sig: str, data: dict) -> None:
    payload = {k: v for k, v in data.items() if k not in ("cached", "cached_at")}
    conn = get_conn()
    conn.execute(
        "INSERT INTO greetings (job_id, sig, data) VALUES (?,?,?) "
        "ON CONFLICT(job_id) DO UPDATE SET sig=excluded.sig, data=excluded.data, "
        "created_at=datetime('now', 'localtime')",
        (job_id, sig, json.dumps(payload, ensure_ascii=False)),
    )
    conn.commit()
    conn.close()


# ----------------------------- 投递记录 -----------------------------
# 一键投递最怕的是「同一家投两遍」。一条岗位一行，job_id 做主键，
# 投过的直接查得到，重复勾选时会被跳过而不是再发一次。

def get_application(job_id: str) -> dict | None:
    conn = get_conn()
    row = conn.execute(
        "SELECT job_id, status, greeting, note, applied_at FROM applications WHERE job_id=?",
        (job_id,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def list_applications() -> dict[str, dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT job_id, status, greeting, note, applied_at FROM applications"
    ).fetchall()
    conn.close()
    return {r["job_id"]: dict(r) for r in rows}


def save_application(job_id: str, status: str, greeting: str = "", note: str = "") -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO applications (job_id, status, greeting, note) VALUES (?,?,?,?) "
        "ON CONFLICT(job_id) DO UPDATE SET status=excluded.status, "
        "greeting=excluded.greeting, note=excluded.note, "
        "applied_at=datetime('now', 'localtime')",
        (job_id, status, greeting, note),
    )
    conn.commit()
    conn.close()


def stats() -> dict:
    conn = get_conn()
    jobs = conn.execute("SELECT COUNT(*) c FROM jobs").fetchone()["c"]
    matches = conn.execute("SELECT COUNT(*) c FROM matches").fetchone()["c"]
    applied = conn.execute(
        "SELECT COUNT(*) c FROM applications WHERE status='sent'"
    ).fetchone()["c"]
    best = conn.execute("SELECT MAX(overall_score) m FROM matches").fetchone()["m"]
    avg = conn.execute("SELECT AVG(overall_score) a FROM matches").fetchone()["a"]
    sources = conn.execute(
        "SELECT source, COUNT(*) c FROM jobs GROUP BY source"
    ).fetchall()
    conn.close()
    return {
        "jobs": jobs,
        "matches": matches,
        "applied": applied,
        "best_score": best,
        "avg_score": round(avg, 1) if avg is not None else None,
        "by_source": {r["source"] or "manual": r["c"] for r in sources},
    }
