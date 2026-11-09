@echo off
rem 开发模式：直接用 Electron 外壳跑（复用仓库内的 .venv 后端，改代码即时生效）
setlocal
cd /d "%~dp0desktop"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_CACHE=E:\build-cache\electron"
if not exist node_modules (
  echo 首次运行，先安装 Electron 依赖…
  call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
)
call npx electron .
