@echo off
rem ============================================================
rem  注意：本文件必须保存为 GBK(936) 编码 + CRLF 行尾。
rem  存成 UTF-8 会让 cmd 逐行解析时把中文注释的字节和后面的
rem  命令粘连，出现 "opy"、"evel" 这种诡异报错。
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ============================================================
rem  清掉会毒害 Electron 的继承环境变量（关键，不要删）
rem  ELECTRON_RUN_AS_NODE=1 -> electron.exe 退化成纯 node，
rem                             require('electron') 只返回路径字符串，
rem                             app 变成 undefined，主进程启动即崩
rem  NODE_OPTIONS=--require=xxx -> 宿主编辑器的预加载钩子会被注入
rem                             Electron，同样会导致崩溃
rem ============================================================
set "ORIG_RUN_AS_NODE=%ELECTRON_RUN_AS_NODE%"
set "ORIG_NODE_OPTIONS=%NODE_OPTIONS%"
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
set "ELECTRON_NO_ATTACH_CONSOLE="
set "ELECTRON_ENABLE_LOGGING="

set "TMP=%~dp0data\tmp"
set "TEMP=%~dp0data\tmp"
if not exist "%TMP%" mkdir "%TMP%" >nul 2>nul
if not exist ".env" if exist ".env.example" copy ".env.example" ".env" >nul

echo ============================================
echo   JobMatch Agent - Desktop (dev)
echo ============================================

echo [1] 检查 Node.js...
where node >nul 2>nul
if errorlevel 1 goto no_node
echo     OK

echo [2] 检查 .venv...
if not exist ".venv\Scripts\python.exe" goto make_venv
echo     OK
goto after_venv

:make_venv
echo     [*] 未找到 .venv，正在创建...
python -m venv .venv
if errorlevel 1 goto venv_fail
echo     [*] 安装 Python 依赖...
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto venv_fail
echo     OK

:after_venv
echo [3] 检查 desktop\node_modules...
if not exist "desktop\node_modules\electron\dist\electron.exe" goto npm_install
echo     OK
goto launch

:npm_install
echo     [*] 未找到 Electron，正在安装（走国内镜像）...
pushd desktop
call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
if errorlevel 1 (
    popd
    goto npm_fail
)
popd
echo     OK

rem ============================================================
rem  启动
rem ============================================================
:launch
set "ELECTRON=%~dp0desktop\node_modules\electron\dist\electron.exe"
echo [4] 启动 Electron...
echo     程序：%ELECTRON%
echo.
pushd desktop
"%ELECTRON%" .
set "ERRC=!errorlevel!"
popd

if "!ERRC!"=="0" goto done

echo.
echo [警告] 启动失败，退出码 !ERRC!，加上 --no-sandbox 重试一次
echo         （Chromium 沙盒在你的终端或安全软件下可能无法初始化）
echo.
pushd desktop
"%ELECTRON%" . --no-sandbox
set "ERRC=!errorlevel!"
popd

:done
echo.
if not "!ERRC!"=="0" goto report_error
echo [OK] 程序已退出，退出码 0
goto end

:report_error
echo [X] 仍然失败，退出码 !ERRC!
if "!ERRC!"=="-2147483645" echo     含义：0x80000003，Chromium 层 CHECK 崩溃，通常是沙盒或显卡驱动问题
if "!ERRC!"=="3"           echo     含义：Chromium 沙盒初始化失败
if "!ERRC!"=="1"           echo     含义：主进程 JS 报错，请把上面滚动的堆栈发出来
echo     排查顺序：
echo       1) 本次被清掉的 ELECTRON_RUN_AS_NODE 原值 = [%ORIG_RUN_AS_NODE%]
echo       2) 本次被清掉的 NODE_OPTIONS 原值 = [%ORIG_NODE_OPTIONS%]
echo       3) 后端日志：%APPDATA%\JobMatch Agent\data\logs\backend.log
goto end

:no_node
echo     [X] 没有找到 Node.js，请先安装 Node 18+ 并加入 PATH
pause
exit /b 1

:venv_fail
echo     [X] Python 虚拟环境创建或依赖安装失败
pause
exit /b 1

:npm_fail
echo     [X] npm install 失败，请手动在 desktop 目录执行：
echo         npm install --registry=https://registry.npmmirror.com
pause
exit /b 1

:end
echo.
pause
exit /b !ERRC!
