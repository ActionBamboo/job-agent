"""应用配置。

配置来源优先级（低 → 高）：
    内置默认值 → 项目内 .env / 系统环境变量 → 数据目录 settings.json

打包成桌面应用后，代码目录（Program Files 下）是只读的，
所以一切可写内容（数据库、登录态、settings.json）都放在 JOBMATCH_DATA_DIR。
"""
import json
import os
from pathlib import Path

# 项目根目录 = backend/app/config.py 向上两级
ROOT = Path(__file__).resolve().parents[2]


def _resolve_data_dir() -> Path:
    raw = os.environ.get("JOBMATCH_DATA_DIR", "").strip()
    if raw:
        p = Path(raw).expanduser()
        if not p.is_absolute():
            p = (ROOT / p).resolve()
    else:
        p = ROOT / "data"
    p.mkdir(parents=True, exist_ok=True)
    return p


DATA_DIR = _resolve_data_dir()
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULTS: dict = {
    "openai_api_key": "",
    "openai_base_url": "https://api.deepseek.com",
    "openai_model": "deepseek-chat",
    "demo_mode": False,
    # 抓取默认值（UI 里可临时改，这里记上次使用值）
    "scrape_city": "深圳",
    "scrape_keyword": "AI Agent",
    "scrape_pages": 1,
    # 智能匹配页的求职意向（记住上次选的平台与期望职位）
    "match_source": "boss",
    "match_positions": [],
}

_TRUE = {"1", "true", "yes", "on", "y", "t"}
_FALSE = {"0", "false", "no", "off", "n", "f", ""}


def _as_bool(v) -> bool:
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in _TRUE:
        return True
    if s in _FALSE:
        return False
    return bool(v)


def _as_int(v, fallback: int) -> int:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return fallback


def _read_env_file(path: Path) -> dict:
    """极简 .env 解析（KEY=VALUE，忽略注释；去掉引号与首尾空白）。"""
    out: dict = {}
    if not path.exists():
        return out
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[k.strip().upper()] = v
    return out


class Settings:
    """可变配置对象：设置页保存后立即生效，无需重启应用。"""

    def __init__(self) -> None:
        self.data_dir = str(DATA_DIR)
        self.reload()

    def reload(self) -> None:
        vals = dict(DEFAULTS)

        for k, v in _read_env_file(ROOT / ".env").items():
            key = k.lower()
            if key in vals:
                vals[key] = v

        for key in DEFAULTS:
            env_key = key.upper()
            if env_key in os.environ:
                vals[key] = os.environ[env_key]

        if SETTINGS_FILE.exists():
            try:
                saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
                if isinstance(saved, dict):
                    for key in DEFAULTS:
                        if key in saved:
                            vals[key] = saved[key]
            except (OSError, json.JSONDecodeError):
                pass

        # 归一化
        self.openai_api_key = str(vals["openai_api_key"] or "").strip()
        self.openai_base_url = str(vals["openai_base_url"] or "").strip().rstrip("/")
        self.openai_model = str(vals["openai_model"] or "").strip()
        self.demo_mode = _as_bool(vals["demo_mode"])
        self.scrape_city = str(vals["scrape_city"] or "深圳").strip()
        self.scrape_keyword = str(vals["scrape_keyword"] or "AI Agent").strip()
        self.scrape_pages = max(1, _as_int(vals["scrape_pages"], 1))
        self.match_source = str(vals["match_source"] or "boss").strip()
        raw_pos = vals.get("match_positions") or []
        if isinstance(raw_pos, str):
            raw_pos = [x.strip() for x in raw_pos.split(",") if x.strip()]
        self.match_positions = [str(x).strip() for x in raw_pos if str(x).strip()][:12]
        self.data_dir = str(DATA_DIR)

    def as_dict(self) -> dict:
        return {
            "openai_api_key_masked": mask(self.openai_api_key),
            "has_api_key": bool(self.openai_api_key),
            "openai_base_url": self.openai_base_url,
            "openai_model": self.openai_model,
            "demo_mode": self.demo_mode,
            "scrape_city": self.scrape_city,
            "scrape_keyword": self.scrape_keyword,
            "scrape_pages": self.scrape_pages,
            "match_source": self.match_source,
            "match_positions": self.match_positions,
            "data_dir": self.data_dir,
        }

    def save(self, patch: dict) -> None:
        """把 UI 提交的改动合并进 settings.json 并立即生效。"""
        current: dict = {}
        if SETTINGS_FILE.exists():
            try:
                current = json.loads(SETTINGS_FILE.read_text(encoding="utf-8")) or {}
            except (OSError, json.JSONDecodeError):
                current = {}
        if not isinstance(current, dict):
            current = {}

        for key in DEFAULTS:
            if key not in patch:
                continue
            v = patch[key]
            if key == "openai_api_key":
                v = "" if v is None else str(v).strip()
                # 空字符串表示"不修改"，避免 UI 里的掩码值把真 Key 抹掉
                if v == "":
                    continue
            current[key] = v

        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(
            json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        self.reload()


def mask(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return f"{key[:5]}{'*' * 8}{key[-4:]}"


def web_dir() -> Path:
    """前端静态目录：桌面端由 Electron 传入，开发时回退到仓库内路径。"""
    raw = os.environ.get("JOBMATCH_WEB_DIR", "").strip()
    if raw:
        p = Path(raw)
        if p.is_dir():
            return p
    for cand in (ROOT / "desktop" / "renderer", Path(__file__).parent / "static"):
        if cand.is_dir():
            return cand
    return Path(__file__).parent / "static"


settings = Settings()
