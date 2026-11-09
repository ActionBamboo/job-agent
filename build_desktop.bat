@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo   JobMatch Agent - 构建 Windows 安装包
echo ============================================
echo.

if not exist .env (
  echo [1/3] 没有 .env，从 .env.example 复制一份
  copy .env.example .env >nul
) else (
  echo [1/3] 已有 .env，跳过
)

echo [2/3] 组装便携 Python 运行时（约 450MB，首次较慢）
.venv\Scripts\python.exe scripts\build_python_runtime.py || goto :fail

echo [3/3] 打包 Electron 安装包
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "ELECTRON_CACHE=E:\build-cache\electron"
set "ELECTRON_BUILDER_CACHE=E:\build-cache\electron-builder"
set "npm_config_registry=https://registry.npmmirror.com"
cd desktop
if not exist node_modules call npm install --no-audit --no-fund
call npx electron-builder --win --config electron-builder.yml || goto :fail

echo.
echo 构建完成：build\dist\
dir /b ..\build\dist\*.exe
echo.
pause
exit /b 0

:fail
echo.
echo [x] 构建失败，请查看上面的报错
pause
exit /b 1
