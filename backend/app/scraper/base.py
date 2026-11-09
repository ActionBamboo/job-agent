"""抓取器抽象基类 + 通用 Playwright 工具。

- BaseScraper: 内置平台继承此类（如 BossScraper）
- DynamicScraper: 用户在 UI 弹窗填写配置后动态生成，无需写代码
"""
import asyncio
import json
import re
from abc import ABC, abstractmethod
from pathlib import Path

from pydantic import BaseModel as PydanticBaseModel

from ..config import DATA_DIR

_PROJECT_TMP = Path(DATA_DIR) / "tmp"
_PROJECT_TMP.mkdir(parents=True, exist_ok=True)


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


async def _q(scope, selectors: list[str]):
    for s in selectors:
        el = await scope.query_selector(s)
        if el:
            return el
    return None


async def _qs(scope, selectors: list[str]):
    for s in selectors:
        els = await scope.query_selector_all(s)
        if els:
            return els
    return []


async def _text(el) -> str:
    try:
        return _clean(await el.inner_text()) if el else ""
    except Exception:
        return ""


class BaseScraper(ABC):
    """抓取器基类。

    子类必须实现:
        key          → str  唯一键（如 "boss"）
        name         → str  展示名（如 "BOSS直聘"）
        login_url    → str  登录页地址
        search_url   → str  搜索页模板（{kw} {city} 占位）
        login_cookie_hints → tuple[str]  判定已登录的 cookie 名
        _login(...)
        _scrape(...)
        _has_login(context) -> bool

    子类可选覆写:
        city_codes   → dict  城市名→编码映射（默认空）
        profile_dir  → Path  浏览器持久化目录（默认 data/{key}_profile）
        card/title/company/... selectors
    """

    # ---------- 子类必须提供 ----------
    @property
    @abstractmethod
    def key(self) -> str:
        """唯一键，如 'boss' / 'job51'，用于 API 参数 & 数据目录命名。"""
        ...

    @property
    @abstractmethod
    def name(self) -> str:
        """展示名，如 'BOSS直聘' / '51job'。"""
        ...

    @property
    @abstractmethod
    def login_url(self) -> str:
        """登录页完整 URL。"""
        ...

    @property
    @abstractmethod
    def search_url(self) -> str:
        """搜索页模板，含 {kw} 和 {city} 占位符。"""
        ...

    @property
    @abstractmethod
    def login_cookie_hints(self) -> tuple[str, ...]:
        """判定已登录的 cookie 名称元组。"""
        ...

    @abstractmethod
    async def _login(self, page, log, should_stop, timeout: int) -> bool:
        """执行登录流程（已打开 login_url），返回是否成功。"""
        ...

    @abstractmethod
    async def _scrape(
        self, page, context, keyword: str, city: str, pages: int,
        detail_limit: int, log, should_stop, dump_html: bool,
    ) -> list[dict]:
        """执行抓取流程，返回岗位列表（不含详情时可先返回基本信息，基类会补抓详情）。"""
        ...

    # ---------- 子类可选覆写 ----------
    city_codes: dict[str, str] = {}
    # 翻页模板（含 {kw} {city} {page}）。留空表示翻页靠点击「下一页」按钮。
    page_url: str = ""

    @property
    def profile_dir(self) -> Path:
        return Path(DATA_DIR) / f"{self.key}_profile"

    card_selectors: list[str] = ["div.job-card-wrapper", "li.job-card-wrapper"]
    title_selectors: list[str] = ["span.job-name", ".job-name"]
    company_selectors: list[str] = ["h3.company-name a", ".company-text"]
    salary_selectors: list[str] = ["span.salary", ".salary"]
    area_selectors: list[str] = ["span.job-area", ".job-area"]
    link_selectors: list[str] = ["a[href*='/job/']"]
    jd_selectors: list[str] = ["div.job-detail", ".detail-content"]
    next_selectors: list[str] = ["a.next", ".page a.next"]
    detail_experience_selectors: list[str] = [".job-info .text"]
    detail_education_selectors: list[str] = [".job-info .text"]

    # ---------- 通用方法 ----------
    def resolve_city(self, city: str) -> tuple[str, str]:
        raw = str(city or "").strip()
        if not self.city_codes:
            return raw, raw
        if raw.isdigit() and len(raw) >= 6:
            for name, code in self.city_codes.items():
                if code == raw:
                    return name, raw
            return raw, raw
        name = raw or list(self.city_codes.keys())[0]
        return name, self.city_codes.get(name, list(self.city_codes.values())[0])

    def build_search_url(self, keyword: str, city_code: str) -> str:
        return self.search_url.format(kw=keyword, city=city_code)

    def spec(self) -> dict:
        """抓取规格：交给桌面端内置浏览器执行抓取用（无需 Python 参与）。"""
        return {
            "key": self.key,
            "name": self.name,
            "login_url": self.login_url,
            "search_url": self.search_url,
            "page_url": self.page_url,
            "city_codes": dict(self.city_codes or {}),
            "cookie_hints": list(self.login_cookie_hints),
            "selectors": {
                "card": list(self.card_selectors),
                "title": list(self.title_selectors),
                "company": list(self.company_selectors),
                "salary": list(self.salary_selectors),
                "area": list(self.area_selectors),
                "link": list(self.link_selectors),
                "jd": list(self.jd_selectors),
                "next": list(self.next_selectors),
                "experience": list(self.detail_experience_selectors),
                "education": list(self.detail_education_selectors),
            },
        }

    async def has_login(self, context) -> bool:
        try:
            cookies = await context.cookies()
        except Exception:
            return False
        names = {c.get("name", "") for c in cookies}
        return any(n in names for n in self.login_cookie_hints)

    async def new_context(self, p, log):
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        base = dict(
            user_data_dir=str(self.profile_dir),
            headless=False,
            viewport={"width": 1366, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        last_err = None
        for channel in ("msedge", None):
            try:
                if channel:
                    return await p.chromium.launch_persistent_context(channel=channel, **base)
                return await p.chromium.launch_persistent_context(**base)
            except Exception as e:
                last_err = e
                log("warn", f"{'Edge' if channel else 'Chromium'} 启动失败：{str(e)[:140]}")
        raise RuntimeError(
            "无法启动浏览器。请确认已安装 Microsoft Edge；若未安装，执行 "
            "`python -m playwright install chromium` 安装自带浏览器。原始错误：" + str(last_err)
        )

    # ---------- 对外接口（模板方法） ----------
    async def login(self, log, should_stop, timeout: int = 600) -> dict:
        from playwright.async_api import async_playwright

        async with async_playwright() as p:
            context = await self.new_context(p, log)
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(self.login_url, wait_until="domcontentloaded")
            log("info", f"已打开浏览器，请扫码登录 {self.name}（登录成功后会自动关闭窗口）")

            logged_in = await self._login(page, log, should_stop, timeout)
            try:
                await context.close()
            except Exception:
                pass

            if logged_in:
                log("ok", "登录态已保存，后续抓取无需重复登录")
            elif should_stop():
                log("warn", "登录流程被取消")
            else:
                log("error", f"等待登录超时（{timeout} 秒）。可重新点一次「登录 {self.name}」")
            return {"logged_in": logged_in, "source": self.key}

    async def scrape(
        self, keyword: str, city: str = "深圳", pages: int = 1,
        detail_limit: int = 20, log=None, should_stop=None, dump_html: bool = False,
    ) -> list[dict]:
        from playwright.async_api import async_playwright

        log = log or (lambda level, msg: None)
        should_stop = should_stop or (lambda: False)
        city_name, city_code = self.resolve_city(city)

        async with async_playwright() as p:
            context = await self.new_context(p, log)
            page = context.pages[0] if context.pages else await context.new_page()
            url = self.build_search_url(keyword, city_code)
            log("info", f"[{self.name}] 打开搜索页：{keyword} @ {city_name}")
            await page.goto(url, wait_until="domcontentloaded")

            if not await self.has_login(context):
                log("warn", "检测到未登录，请在弹出的浏览器里扫码登录（最多等 5 分钟）")
                waited = 0
                while waited < 300 and not should_stop():
                    await page.wait_for_timeout(2000)
                    waited += 2
                    if await self.has_login(context):
                        log("ok", "登录成功，继续抓取")
                        await page.goto(url, wait_until="domcontentloaded")
                        break

            jobs = await self._scrape(
                page, context, keyword, city_name, pages,
                detail_limit, log, should_stop, dump_html,
            )

            try:
                await context.close()
            except Exception:
                pass

        if not jobs:
            log("warn", "未抓到任何岗位，可能是选择器变化或触发风控")
        return jobs

    # ---------- 详情抓取模板方法 ----------
    async def _fetch_details(
        self, context, jobs: list[dict], detail_limit: int, log, should_stop,
    ) -> None:
        targets = [j for j in jobs if j.get("url")][: max(0, detail_limit)]
        if not targets:
            return
        log("info", f"开始抓取 {len(targets)} 条岗位详情…")
        for idx, job in enumerate(targets, 1):
            if should_stop():
                log("warn", "已取消详情抓取")
                break
            try:
                dp = await context.new_page()
                await dp.goto(job["url"], wait_until="domcontentloaded")
                try:
                    await dp.wait_for_selector(self.jd_selectors[0], timeout=12_000)
                except Exception:
                    pass
                job["jd_text"] = await _text(await _q(dp, self.jd_selectors))
                for label, key, sels in (
                    ("经验", "experience_req", self.detail_experience_selectors),
                    ("学历", "education_req", self.detail_education_selectors),
                ):
                    els = await _qs(dp, sels)
                    texts = [await _text(e) for e in els]
                    for t in texts:
                        if label == "经验" and re.search(r"年|经验不限", t) and not job.get("experience_req"):
                            job["experience_req"] = t
                        if label == "学历" and re.search(r"本科|大专|硕士|博士|学历不限", t) and not job.get("education_req"):
                            job["education_req"] = t
                await dp.close()
                log("ok", f"[{idx}/{len(targets)}] {job['title']} · {job.get('company', '')}（JD {len(job.get('jd_text', ''))} 字）")
                await dp.wait_for_timeout(800)
            except Exception as e:
                log("warn", f"[{idx}/{len(targets)}] 详情抓取失败：{str(e)[:100]}")

    # ---------- 卡片解析模板方法 ----------
    async def _parse_cards(
        self, page, city_name: str, seen: set[str],
    ) -> list[dict]:
        cards = await _qs(page, self.card_selectors)
        jobs: list[dict] = []
        for card in cards:
            title = await _text(await _q(card, self.title_selectors))
            company = await _text(await _q(card, self.company_selectors))
            salary = await _text(await _q(card, self.salary_selectors))
            area = await _text(await _q(card, self.area_selectors))
            link_el = await _q(card, self.link_selectors)
            href = ""
            if link_el:
                try:
                    href = await link_el.get_attribute("href") or ""
                except Exception:
                    href = ""
            if not title:
                continue
            job_id = self._make_job_id(title, company, href)
            if job_id in seen:
                continue
            seen.add(job_id)
            jobs.append({
                "id": job_id,
                "title": title,
                "company": company,
                "city": area or city_name,
                "salary": salary,
                "experience_req": "",
                "education_req": "",
                "jd_text": "",
                "url": self._resolve_url(href),
                "source": self.key,
            })
        return jobs

    def _make_job_id(self, title: str, company: str, href: str) -> str:
        m = re.search(r"/job(?:detail)?[\_/]([^./?]+)", href or "")
        if m:
            return f"{self.key}-{m.group(1)}"
        return f"{self.key}-{abs(hash(title + company)) % 10**10}"

    def _resolve_url(self, href: str) -> str:
        return href if href.startswith("http") else ""

    async def _try_next_page(self, page) -> bool:
        next_btn = await _q(page, self.next_selectors)
        if not next_btn:
            return False
        try:
            await next_btn.click()
            return True
        except Exception:
            return False


# ========== 动态抓取器：用户在 UI 弹窗填写配置 ==========

class ScraperConfig(PydanticBaseModel):
    """用户通过弹窗填写的抓取器配置，持久化到 JSON 文件。"""
    key: str
    name: str
    login_url: str
    search_url: str
    login_cookie_hints: list[str]
    city_codes: dict[str, str] = {}
    page_url: str = ""
    card_selectors: list[str] = ["div.job-card-wrapper"]
    title_selectors: list[str] = ["span.job-name"]
    company_selectors: list[str] = ["h3.company-name a"]
    salary_selectors: list[str] = ["span.salary"]
    area_selectors: list[str] = ["span.job-area"]
    link_selectors: list[str] = ["a[href*='/job/']"]
    jd_selectors: list[str] = ["div.job-detail"]
    next_selectors: list[str] = ["a.next"]
    detail_experience_selectors: list[str] = [".job-info .text"]
    detail_education_selectors: list[str] = [".job-info .text"]


class DynamicScraper(BaseScraper):
    """从配置 dict 动态生成的抓取器，所有属性在构造时注入。

    用户不需要写 Python 文件 —— 在 UI 弹窗填好 key / name / url / 选择器，
    后端保存为 JSON，重启后由 discover_dynamic() 加载注册。
    """

    def __init__(self, config: ScraperConfig) -> None:
        self._cfg = config

    # ---- 抽象属性实现 ----
    @property
    def key(self) -> str:
        return self._cfg.key

    @property
    def name(self) -> str:
        return self._cfg.name

    @property
    def login_url(self) -> str:
        return self._cfg.login_url

    @property
    def search_url(self) -> str:
        return self._cfg.search_url

    @property
    def login_cookie_hints(self) -> tuple[str, ...]:
        return tuple(self._cfg.login_cookie_hints)

    @property
    def city_codes(self) -> dict[str, str]:
        return self._cfg.city_codes

    @property
    def page_url(self) -> str:
        return self._cfg.page_url

    # ---- 选择器覆写 ----
    @property
    def card_selectors(self) -> list[str]:
        return self._cfg.card_selectors

    @property
    def title_selectors(self) -> list[str]:
        return self._cfg.title_selectors

    @property
    def company_selectors(self) -> list[str]:
        return self._cfg.company_selectors

    @property
    def salary_selectors(self) -> list[str]:
        return self._cfg.salary_selectors

    @property
    def area_selectors(self) -> list[str]:
        return self._cfg.area_selectors

    @property
    def link_selectors(self) -> list[str]:
        return self._cfg.link_selectors

    @property
    def jd_selectors(self) -> list[str]:
        return self._cfg.jd_selectors

    @property
    def next_selectors(self) -> list[str]:
        return self._cfg.next_selectors

    @property
    def detail_experience_selectors(self) -> list[str]:
        return self._cfg.detail_experience_selectors

    @property
    def detail_education_selectors(self) -> list[str]:
        return self._cfg.detail_education_selectors

    # ---- 通用登录 / 抓取实现 ----
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
            log("warn", "未检测到岗位列表，可能选择器不匹配，尝试继续解析")

        if dump_html:
            _dump = Path(DATA_DIR) / "debug_search.html"
            try:
                _dump.write_text(await page.content(), encoding="utf-8")
                log("info", f"页面 HTML 已保存：{_dump}")
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