"""组装便携 Python 运行时（供 Electron 安装包内置）。

做法：
    1. 取 .venv/pyvenv.cfg 里记录的基础解释器目录（完整 CPython 安装）
    2. 复制解释器（去掉 tcl / idlelib / test / 基础 site-packages 等无用体积）
    3. 把 .venv 的 site-packages 覆盖进去
    4. 用组装好的解释器真实跑一次 import 自检

产物：build/python-runtime/python.exe
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENV = ROOT / ".venv"
OUT = ROOT / "build" / "python-runtime"

# 基础解释器里可以安全丢掉的目录（相对解释器根目录）
SKIP_TOP = {
    "tcl",          # tkinter 资源
    "include",      # C 头文件
    "libs",         # 链接库
    "Scripts",      # pip / 各类 exe
    "Doc",
    "Tools",
    "site-packages",  # 注意：命中 Lib/site-packages，基础环境自带的 pip 等不需要
}
SKIP_LIB = {"test", "idlelib", "turtledemo", "lib2to3", "ensurepip", "distutils-tests"}

IMPORT_CHECK = [
    "fastapi",
    "uvicorn",
    "pydantic",
    "pydantic_settings",
    "langgraph",
    "langchain_openai",
    "openai",
    "pymupdf",
    "docx",
    "playwright",
    "multipart",
]


def base_python_home() -> Path:
    cfg = VENV / "pyvenv.cfg"
    if not cfg.exists():
        sys.exit(f"[x] 找不到 {cfg}，请先创建虚拟环境")
    for line in cfg.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("home"):
            home = line.split("=", 1)[1].strip()
            p = Path(home)
            if (p / "python.exe").exists():
                return p
    sys.exit("[x] pyvenv.cfg 里没有可用的 home 路径")


def _ignore_root(dirpath, names):
    here = Path(dirpath)
    ignored = []
    for n in names:
        if n == "__pycache__":
            continue
        if n in SKIP_TOP:
            ignored.append(n)
    return ignored


def _ignore_lib(dirpath, names):
    here = Path(dirpath)
    if here.name == "Lib":
        return [n for n in names if n in SKIP_LIB]
    return []


def merge_tree(src: Path, dst: Path) -> None:
    shutil.copytree(
        src,
        dst,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("*.pyc.tmp", ".git", "*.log"),
    )


def main() -> None:
    home = base_python_home()
    site = VENV / "Lib" / "site-packages"
    if not site.is_dir():
        sys.exit(f"[x] 找不到虚拟环境依赖目录：{site}")

    if OUT.exists():
        print(f"[1/4] 清理旧产物 {OUT}")
        shutil.rmtree(OUT, ignore_errors=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)

    print(f"[2/4] 复制解释器 {home} → {OUT}")
    shutil.copytree(home, OUT, ignore=_ignore_root, dirs_exist_ok=True)

    # Lib 下再剔一遍（copytree 的 ignore 是逐层的，上面已处理 site-packages，这里补 Lib/*）
    lib = OUT / "Lib"
    if lib.is_dir():
        for name in SKIP_LIB:
            target = lib / name
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)

    print(f"[3/4] 覆盖依赖 {site} → {OUT / 'Lib' / 'site-packages'}")
    dst_site = OUT / "Lib" / "site-packages"
    dst_site.mkdir(parents=True, exist_ok=True)
    merge_tree(site, dst_site)

    # 去掉 __pycache__ 里明显的编译垃圾与残留临时文件
    for junk in OUT.rglob("*.pyc.tmp"):
        junk.unlink(missing_ok=True)

    python_exe = OUT / "python.exe"
    if not python_exe.exists():
        sys.exit("[x] 组装失败：没有生成 python.exe")

    print("[4/4] 自检：用组装好的解释器导入关键依赖")
    code = (
        "import importlib, sys\n"
        f"mods = {IMPORT_CHECK!r}\n"
        "bad = []\n"
        "for m in mods:\n"
        "    try:\n"
        "        importlib.import_module(m)\n"
        "        print('  ok  ', m)\n"
        "    except Exception as e:\n"
        "        bad.append((m, str(e)))\n"
        "        print('  FAIL', m, '->', e)\n"
        "if bad:\n"
        "    print('\\n[!] 有依赖导入失败：', [b[0] for b in bad])\n"
        "    sys.exit(1)\n"
        "print('\\n全部通过，解释器路径：', sys.executable)\n"
    )
    env = {
        "SYSTEMROOT": __import__("os").environ.get("SYSTEMROOT", r"C:\Windows"),
        "PATH": __import__("os").environ.get("PATH", ""),
    }
    r = subprocess.run([str(python_exe), "-X", "utf8", "-c", code], env=env, capture_output=True, text=True)
    print(r.stdout.strip())
    if r.returncode != 0:
        print(r.stderr.strip()[-3000:])
        sys.exit("[x] 自检未通过")

    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"\n[done] 运行时体积 {total / 1024 / 1024:.0f} MB → {OUT}")


if __name__ == "__main__":
    main()
