"""入库测试：验证 upsert_jobs 幂等写入 SQLite（测试后清理，不污染库）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import store
from app.db import DB_PATH


def main() -> int:
    fake = [
        {
            "id": "boss-test-999",
            "title": "测试岗位",
            "company": "测试公司",
            "city": "深圳",
            "salary": "20-30K",
            "experience_req": "",
            "education_req": "",
            "jd_text": "需要 Python LangGraph",
            "url": "",
            "source": "boss",
        }
    ]

    before = len(store.load_jobs())
    store.upsert_jobs(fake)
    assert store.get_job("boss-test-999") is not None, "upsert 后应能查到"
    after = len(store.load_jobs())
    assert after == before + 1, f"应新增 1 条：before={before} after={after}"

    # 幂等：重复导入同 id 不新增
    store.upsert_jobs(fake)
    assert len(store.load_jobs()) == after, "upsert 应幂等"

    # 清理测试数据
    import sqlite3
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM jobs WHERE id='boss-test-999'")
    conn.commit()
    conn.close()
    assert store.get_job("boss-test-999") is None, "清理后应查不到"

    print(f"ingest ok: {before} -> {after} -> 清理后 {len(store.load_jobs())}")
    print("INGEST_TEST_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
