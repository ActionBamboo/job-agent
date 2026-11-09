"""后台任务管理：抓取 / 登录（可插拔抓取器）。

桌面端的抓取是「点一下 → 弹出浏览器 → 实时看日志」的交互，
所以调度放进独立线程，日志写入环形缓冲，前端轮询增量拉取。
"""
import asyncio
import threading
import time
import traceback
import uuid

from . import store
from .scraper import registry, discover

_MAX_LOGS = 600

discover()


class Task:
    def __init__(self, kind: str, params: dict | None = None) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind  # scrape | login
        self.params = params or {}
        self.status = "running"  # running | done | error | cancelled
        self.logs: list[dict] = []
        self.result: dict | None = None
        self.error: str | None = None
        self.started_at = time.time()
        self.finished_at: float | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

    # --- 供抓取器调用 ---
    def log(self, level: str, msg: str) -> None:
        with self._lock:
            self.logs.append(
                {
                    "seq": len(self.logs),
                    "t": round(time.time() - self.started_at, 1),
                    "level": level,
                    "msg": str(msg),
                }
            )
            if len(self.logs) > _MAX_LOGS:
                del self.logs[: len(self.logs) - _MAX_LOGS]

    def should_stop(self) -> bool:
        return self._stop.is_set()

    def stop(self) -> None:
        self._stop.set()

    # --- 供 HTTP 查询 ---
    def snapshot(self, since: int = 0) -> dict:
        with self._lock:
            logs = [dict(x) for x in self.logs if x["seq"] >= since]
            total = len(self.logs)
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "params": self.params,
            "logs": logs,
            "next_seq": total,
            "result": self.result,
            "error": self.error,
            "elapsed": round((self.finished_at or time.time()) - self.started_at, 1),
        }


_tasks: dict[str, Task] = {}
_lock = threading.Lock()


def _running_task() -> Task | None:
    for t in _tasks.values():
        if t.status == "running":
            return t
    return None


def _prune() -> None:
    finished = [t for t in _tasks.values() if t.status != "running"]
    finished.sort(key=lambda t: t.started_at)
    for t in finished[:-10]:
        _tasks.pop(t.id, None)


def get_task(task_id: str) -> Task | None:
    return _tasks.get(task_id)


def cancel(task_id: str) -> bool:
    t = _tasks.get(task_id)
    if t and t.status == "running":
        t.stop()
        t.log("warn", "已请求取消，等待当前步骤结束…")
        return True
    return False


def _spawn(kind: str, params: dict, target) -> Task:
    with _lock:
        busy = _running_task()
        if busy:
            raise RuntimeError(f"已有任务在运行（{busy.kind}），请等它结束或取消后再试")
        task = Task(kind, params)
        _tasks[task.id] = task
        _prune()
        threading.Thread(target=target, args=(task,), name=f"jobmatch-{kind}", daemon=True).start()
        return task


def start_scrape(
    keywords, city: str, pages: int, detail_limit: int = 20, source: str = "boss",
) -> Task:
    """按「一个或多个期望职位」抓取某个平台。

    多个职位时逐个搜索同一平台，结果按岗位 id 去重后合并入库；
    详情 JD 的抓取预算在几个职位之间均摊，避免总耗时爆炸。
    """
    scraper = registry.require(source)

    if isinstance(keywords, str):
        keywords = [keywords]
    kws: list[str] = []
    for k in keywords or []:
        k = str(k).strip()
        if k and k not in kws:
            kws.append(k)
    if not kws:
        kws = ["AI Agent"]

    per_detail = max(5, round(detail_limit / len(kws))) if len(kws) > 1 else detail_limit

    params = {
        "keywords": kws, "keyword": kws[0], "city": city, "pages": pages,
        "detail_limit": per_detail, "source": source,
    }

    def run(task: Task) -> None:
        try:
            merged: dict[str, dict] = {}
            for idx, kw in enumerate(kws, 1):
                if task.should_stop():
                    break
                if len(kws) > 1:
                    task.log(
                        "info",
                        f"[{scraper.name}] 第 {idx}/{len(kws)} 个期望职位：{kw} · {city} · 前 {pages} 页",
                    )
                else:
                    task.log("info", f"[{scraper.name}] 任务开始：{kw} · {city} · 前 {pages} 页")

                jobs = asyncio.run(
                    scraper.scrape(
                        kw, city, pages,
                        detail_limit=per_detail,
                        log=task.log,
                        should_stop=task.should_stop,
                    )
                )
                for j in jobs:
                    merged.setdefault(j["id"], j)
                task.log("info", f"「{kw}」抓到 {len(jobs)} 条，去重累计 {len(merged)} 条")

            if task.should_stop():
                task.status = "cancelled"

            jobs = list(merged.values())
            if jobs:
                store.upsert_jobs(jobs)
                total = len(store.load_jobs())
                task.result = {
                    "fetched": len(jobs), "total": total, "source": source,
                    "keywords": kws,
                }
                task.log("ok", f"已入库 {len(jobs)} 条岗位，岗位库现有 {total} 条")
            else:
                task.result = {
                    "fetched": 0, "total": len(store.load_jobs()),
                    "source": source, "keywords": kws,
                }
            if task.status == "running":
                task.status = "done"
        except Exception as e:
            task.status = "error"
            task.error = str(e)
            task.log("error", f"抓取失败：{e}")
            traceback.print_exc()
        finally:
            task.finished_at = time.time()

    return _spawn("scrape", params, run)


def start_login(source: str = "boss") -> Task:
    scraper = registry.require(source)
    params = {"source": source}
    def run(task: Task) -> None:
        try:
            result = asyncio.run(scraper.login(task.log, task.should_stop))
            task.result = result
            task.status = "done" if result.get("logged_in") else (
                "cancelled" if task.should_stop() else "error"
            )
        except Exception as e:
            task.status = "error"
            task.error = str(e)
            task.log("error", f"登录流程异常：{e}")
        finally:
            task.finished_at = time.time()

    return _spawn("login", params, run)