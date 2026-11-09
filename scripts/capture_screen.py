"""用 Win32 GDI 截取当前桌面（验证 Electron 窗口渲染，纯 ctypes 实现）。"""
import ctypes
import ctypes.wintypes as wt
import struct
import zlib
from pathlib import Path

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
user32.SetProcessDPIAware()

SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
        ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG),
        ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
    ]


def capture(out: Path) -> tuple[int, int]:
    w = user32.GetSystemMetrics(78) or 1920   # SM_CXVIRTUALSCREEN
    h = user32.GetSystemMetrics(79) or 1080
    x = user32.GetSystemMetrics(76)
    y = user32.GetSystemMetrics(77)
    if w <= 0 or h <= 0:
        w, h, x, y = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1), 0, 0

    hdc = user32.GetDC(0)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mem, bmp)
    gdi32.BitBlt(mem, 0, 0, w, h, hdc, x, y, SRCCOPY)

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = w
    bi.biHeight = -h  # 自上而下
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0

    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), DIB_RGB_COLORS)

    raw = bytearray(buf.raw)
    # BGRA -> RGBA
    raw[0::4], raw[2::4] = raw[2::4], raw[0::4]
    raw[3::4] = b"\xff" * (w * h)

    stride = w * 4
    lines = b"".join(b"\x00" + bytes(raw[i * stride:(i + 1) * stride]) for i in range(h))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(lines, 6))
           + chunk(b"IEND", b""))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(png)

    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(0, hdc)
    return w, h


if __name__ == "__main__":
    import sys
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "data/tmp/screen.png")
    print("saved", target, capture(target))
