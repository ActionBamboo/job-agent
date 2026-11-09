"""检查 JobMatch Agent 主窗口是否真的对用户可见（可见性 / 坐标 / 最小化）。

窗口句柄存在但不可见，是「双击图标没反应」的典型症状，单看进程列表发现不了。
用法：python scripts/check_window.py
"""
import ctypes
import ctypes.wintypes as wt
import sys

u = ctypes.windll.user32
u.SetProcessDPIAware()

EnumWindows = u.EnumWindows
EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

found = []


def _cb(hwnd, _lparam):
    length = u.GetWindowTextLengthW(hwnd)
    if length == 0:
        return True
    buf = ctypes.create_unicode_buffer(length + 1)
    u.GetWindowTextW(hwnd, buf, length + 1)
    title = buf.value
    if "JobMatch" in title:
        rect = wt.RECT()
        u.GetWindowRect(hwnd, ctypes.byref(rect))
        found.append(
            {
                "hwnd": hwnd,
                "title": title,
                "visible": bool(u.IsWindowVisible(hwnd)),
                "minimized": bool(u.IsIconic(hwnd)),
                "rect": (rect.left, rect.top, rect.right, rect.bottom),
                "size": (rect.right - rect.left, rect.bottom - rect.top),
            }
        )
    return True


EnumWindows(EnumWindowsProc(_cb), 0)

if not found:
    print("FAIL 没有找到 JobMatch Agent 窗口")
    sys.exit(1)

screen_w = u.GetSystemMetrics(0)
screen_h = u.GetSystemMetrics(1)
print(f"屏幕 {screen_w}x{screen_h}")

ok = True
for w in found:
    l, t, r, b = w["rect"]
    on_screen = l + 80 > 0 and t + 20 > 0 and l < screen_w - 80 and t < screen_h - 40
    print(
        f"窗口 hwnd={w['hwnd']} 标题={w['title']!r} 可见={w['visible']} "
        f"最小化={w['minimized']} 位置=({l},{t}) 尺寸={w['size'][0]}x{w['size'][1]} 在屏内={on_screen}"
    )
    if not (w["visible"] and not w["minimized"] and on_screen):
        ok = False

print("RESULT", "PASS 窗口正常可见" if ok else "FAIL 窗口存在但用户看不到")
sys.exit(0 if ok else 1)
