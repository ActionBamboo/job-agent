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


def stats() -> dict:
    conn = get_conn()
    jobs = conn.execute("SELECT COUNT(*) c FROM jobs").fetchone()["c"]
    matches = conn.execute("SELECT COUNT(*) c FROM matches").fetchone()["c"]
    best = conn.execute("SELECT MAX(overall_score) m FROM matches").fetchone()["m"]
    avg = conn.execute("SELECT AVG(overall_score) a FROM matches").fetchone()["a"]
    sources = conn.execute(
        "SELECT source, COUNT(*) c FROM jobs GROUP BY source"
    ).fetchall()
    conn.close()
    return {
        "jobs": jobs,
        "matches": matches,
        "best_score": best,
        "avg_score": round(avg, 1) if avg is not None else None,
        "by_source": {r["source"] or "manual": r["c"] for r in sources},
    }
