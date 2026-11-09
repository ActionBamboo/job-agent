"""抓取器注册表。

- 内置平台（如 BOSS直聘）：代码中定义类，discover() 时自动注册
- 自定义平台：用户在 UI 弹窗填写配置，后端保存 JSON，动态生成 DynamicScraper
"""
import json
import os
from pathlib import Path

from ..config import DATA_DIR

CONFIG_FILE = Path(DATA_DIR) / "scraper_configs.json"

from .base import BaseScraper, DynamicScraper, ScraperConfig  # noqa: E402


class ScraperRegistry:
    """可插拔抓取器注册中心。"""

    def __init__(self) -> None:
        self._scrapers: dict[str, BaseScraper] = {}
        self._builtin_keys: set[str] = set()

    def register(self, scraper: BaseScraper) -> None:
        if not isinstance(scraper, BaseScraper):
            raise TypeError(f"期望 BaseScraper 子类，收到 {type(scraper)}")
        key = scraper.key
        if not key:
            raise ValueError("scraper.key 不能为空")
        self._scrapers[key] = scraper

    def register_builtin(self, scraper: BaseScraper) -> None:
        self._builtin_keys.add(scraper.key)
        self.register(scraper)

    def get(self, key: str) -> BaseScraper | None:
        return self._scrapers.get(key)

    def require(self, key: str) -> BaseScraper:
        s = self._scrapers.get(key)
        if s is None:
            available = ", ".join(sorted(self._scrapers.keys())) or "(无)"
            raise KeyError(f"未找到抓取器 '{key}'，可用: {available}")
        return s

    def list_all(self) -> list[dict]:
        return [
            {
                "key": s.key,
                "name": s.name,
                "login_url": s.login_url,
                "builtin": s.key in self._builtin_keys,
            }
            for s in self._scrapers.values()
        ]

    def keys(self) -> list[str]:
        return sorted(self._scrapers.keys())

    def is_builtin(self, key: str) -> bool:
        return key in self._builtin_keys

    def __contains__(self, key: str) -> bool:
        return key in self._scrapers

    def __len__(self) -> int:
        return len(self._scrapers)

    # ---- 自定义平台（动态）管理 ----

    def _load_configs(self) -> dict[str, ScraperConfig]:
        if not CONFIG_FILE.exists():
            return {}
        try:
            raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
        result: dict[str, ScraperConfig] = {}
        for item in raw if isinstance(raw, list) else []:
            try:
                cfg = ScraperConfig(**item)
                result[cfg.key] = cfg
            except Exception:
                pass
        return result

    def _save_configs(self, configs: dict[str, ScraperConfig]) -> None:
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        data = [cfg.model_dump() for cfg in configs.values()]
        CONFIG_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def load_dynamic(self) -> None:
        """从 JSON 文件加载所有自定义平台并注册。"""
        configs = self._load_configs()
        for cfg in configs.values():
            self.register(DynamicScraper(cfg))

    def save_dynamic(self, cfg: ScraperConfig) -> None:
        """新增或更新一个自定义平台配置。"""
        if cfg.key in self._builtin_keys:
            raise ValueError(f"'{cfg.key}' 是内置平台，不可覆盖")
        configs = self._load_configs()
        configs[cfg.key] = cfg
        self._save_configs(configs)
        self.register(DynamicScraper(cfg))

    def delete_dynamic(self, key: str) -> bool:
        """删除一个自定义平台配置。"""
        if key in self._builtin_keys:
            raise ValueError(f"'{key}' 是内置平台，不可删除")
        configs = self._load_configs()
        if key not in configs:
            return False
        del configs[key]
        self._save_configs(configs)
        self._scrapers.pop(key, None)
        return True


registry = ScraperRegistry()


def discover() -> None:
    """导入所有内置抓取器 + 加载动态配置。"""
    from . import boss  # noqa: F401
    registry.load_dynamic()