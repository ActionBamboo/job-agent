"""BOSS直聘 JD 抓取器。

设计要点：
- 继承 BaseScraper，实现 login / scrape / has_login 三个核心方法。
- 使用本机 Microsoft Edge（channel="msedge"），登录态持久化到数据目录 {key}_profile。
- 临时目录重定向到数据目录，避免系统 Temp 权限问题（打包后 Program Files 不可写）。
- 选择器按「多套备选」组织，仍可能需按当前页面微调。
"""
import argparse
import asyncio
import json
import os
import re
import tempfile
from pathlib import Path

from ..config import DATA_DIR

_PROJECT_TMP = Path(DATA_DIR) / "tmp"
_PROJECT_TMP.mkdir(parents=True, exist_ok=True)
os.environ["TMP"] = str(_PROJECT_TMP)
os.environ["TEMP"] = str(_PROJECT_TMP)
tempfile.tempdir = str(_PROJECT_TMP)

from playwright.async_api import async_playwright  # noqa: E402

from .base import BaseScraper, _clean, _q, _qs, _text
from . import registry

DUMP_PATH = Path(DATA_DIR) / "debug_search.html"


class BossScraper(BaseScraper):
    key = "boss"
    name = "BOSS直聘"
    login_url = "https://www.zhipin.com/web/user/"
    # 线上实际路径是 /web/geek/jobs（带 s），写 /web/geek/job 会被 301 重定向一次
    search_url = "https://www.zhipin.com/web/geek/jobs?query={kw}&city={city}"
    page_url = "https://www.zhipin.com/web/geek/jobs?query={kw}&city={city}&page={page}"
    # BOSS 的登录态体现在这几个 cookie 上：zp_at（access token）、wt2（用户标识）、
    # bst。旧版本还用过 geek_zp_token，一并留着兼容。
    # 注意：单靠 cookie 名并不可靠（站点会改名），所以抓取时还有一层「页面内容」
    # 兜底判断：页面出现「立即登录」或没有卡片，就当作未登录去弹扫码窗。
    login_cookie_hints = ("zp_at", "wt2", "bst", "geek_zp_token", "zp_token")

    city_codes = {
        "全国": "100010000",
        "北京": "101010100",
        "上海": "101020100",
        "广州": "101280100",
        "深圳": "101280600",
        "杭州": "101210100",
        "成都": "101270100",
        "武汉": "101200100",
        "南京": "101190100",
        "苏州": "101190400",
        "西安": "101110100",
        "长沙": "101250100",
        "郑州": "101180100",
        "重庆": "101040100",
        "天津": "101030100",
        "厦门": "101230200",
        "东莞": "101281600",
        "佛山": "101280800",
    }

    # 选择器按 2026-11 线上实际 DOM 校准（BOSS 改过一次结构：
    # 卡片从 div.job-card-wrapper 变成 li.job-card-box，公司改由 span.boss-name 承载）。
    # 老的 class 全部留在后面做兜底，站方再改不至于立刻全挂。
    card_selectors = ["li.job-card-box", "div.job-card-wrap", "div.job-card-wrapper", "li.job-card-wrapper"]
    title_selectors = ["a.job-name", "span.job-name", ".job-name", "span.job-title"]
    company_selectors = ["span.boss-name", ".boss-name", "h3.company-name a", ".company-text", ".company-name"]
    salary_selectors = ["span.job-salary", ".job-salary", "span.salary", ".salary"]
    area_selectors = ["span.company-location", ".company-location", "span.job-area", ".job-area"]
    link_selectors = ["a.job-name", "a[href*='/job_detail/']"]
    jd_selectors = ["div.job-sec-text", ".job-sec-text", "div.job-detail", ".detail-content", "div.job-description"]
    next_selectors = ["a.ui-icon-arrow-right", ".options-pages a.next", ".page a.next", "a[ka*='page-next']"]
    detail_experience_selectors = [".job-info .text", ".info-primary .text"]
    detail_education_selectors = [".job-info .text", ".info-primary .text"]

    def _resolve_url(self, href: str) -> str:
        if href.startswith("http"):
            return href
        if href.startswith("/"):
            return "https://www.zhipin.com" + href
        return ""

    def _make_job_id(self, title: str, company: str, href: str) -> str:
        m = re.search(r"/job_detail/([^./?]+)", href or "")
        if m:
            return f"{self.key}-{m.group(1)}"
        return f"{self.key}-{abs(hash(title + company)) % 10**10}"

    async def _login(self, page, log, should_stop, timeout: int) -> bool:
        waited = 0
        while waited < timeout:
            if should_stop():
                return False
            if await self.has_login(page.context):
                return True
            await asyncio.sleep(2)
            waited += 2
            if waited % 20 == 0:
                log("info", f"仍在等待登录…（已等待 {waited}s）")
        return False

    async def _scrape(
        self, page, context, keyword: str, city_name: str, pages: int,
        detail_limit: int, log, should_stop, dump_html: bool,
    ) -> list[dict]:
        try:
            await page.wait_for_selector(self.card_selectors[0], timeout=30_000)
        except Exception:
            log("warn", "未检测到岗位列表，可能页面结构变化或需要验证码，尝试继续解析")

        if dump_html:
            try:
                DUMP_PATH.write_text(await page.content(), encoding="utf-8")
                log("info", f"页面 HTML 已保存：{DUMP_PATH}")
            except OSError as e:
                log("warn", f"保存 HTML 失败：{e}")

        jobs: list[dict] = []
        seen: set[str] = set()

        for i in range(max(1, pages)):
            if should_stop():
                log("warn", "已取消抓取")
                break
            await page.wait_for_timeout(1800)
            page_jobs = await self._parse_cards(page, city_name, seen)
            jobs.extend(page_jobs)
            log("info", f"第 {i + 1} 页解析到 {len(page_jobs)} 张岗位卡片")

            if i < pages - 1:
                if should_stop():
                    break
                if not await self._try_next_page(page):
                    log("info", "没有更多页了，提前结束翻页")
                    break
                await page.wait_for_timeout(2200)

        await self._fetch_details(context, jobs, detail_limit, log, should_stop)
        return jobs


# ---------- 自注册 ----------
registry.register_builtin(BossScraper())


# ---------- CLI（保留命令行用法） ----------

def main() -> None:
    ap = argparse.ArgumentParser(description="BOSS直聘 JD 抓取")
    ap.add_argument("--keyword", "-k", help="搜索关键词，如 'AI Agent'")
    ap.add_argument("--city", "-c", default="深圳", help="城市名或编码（默认深圳）")
    ap.add_argument("--pages", "-p", type=int, default=1)
    ap.add_argument("--out", "-o", default="scraped_jobs.json")
    ap.add_argument("--login-only", action="store_true", help="只打开浏览器登录一次")
    ap.add_argument("--ingest", action="store_true", help="抓取后直接导入 SQLite")
    ap.add_argument("--dump-html", action="store_true", help="额外保存搜索页 HTML")
    args = ap.parse_args()

    def log(level, msg):
        print(f"[{level}] {msg}", flush=True)

    scraper = registry.get("boss")

    if args.login_only:
        asyncio.run(scraper.login(log, lambda: False))
        return

    if not args.keyword:
        ap.error("请提供 --keyword，或使用 --login-only")

    jobs = asyncio.run(
        scraper.scrape(args.keyword, args.city, args.pages, log=log, dump_html=args.dump_html)
    )
    if not jobs:
        return

    Path(args.out).write_text(json.dumps(jobs, ensure_ascii=False, indent=2), encoding="utf-8")
    log("ok", f"抓取 {len(jobs)} 条，已写入 {args.out}")

    if args.ingest:
        from .. import store

        store.upsert_jobs(jobs)
        log("ok", f"已导入 SQLite，当前库中共 {len(store.load_jobs())} 条岗位")


if __name__ == "__main__":
    main()