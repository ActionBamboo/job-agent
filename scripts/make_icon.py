"""生成应用图标（纯标准库绘制，无需 Pillow）。

产物：
    desktop/assets/icon.png    512x512  （窗口/关于页）
    desktop/assets/icon.ico    含 256/64/32 多尺寸（Windows 安装包与任务栏）
    desktop/assets/tray.png    32x32   （托盘）
"""
import math
import struct
import zlib
from pathlib import Path

ASSETS = Path(__file__).resolve().parents[1] / "desktop" / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)

GRAD_TOP = (99, 102, 241)     # #6366f1
GRAD_BOTTOM = (139, 92, 246)  # #8b5cf6


def _mix(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def render(size: int) -> bytes:
    """返回 RGBA 像素数据（逐行）。"""
    ss = 4  # 超采样倍数
    n = size * ss
    rows = []
    cx = cy = n / 2.0
    half = n / 2.0
    corner = n * 0.22
    ring1 = n * 0.305     # 外环半径
    w1 = n * 0.082        # 外环线宽
    ring2 = n * 0.135     # 内环半径
    w2 = n * 0.072
    dot = n * 0.055

    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc_r = acc_g = acc_b = acc_a = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    px = (x * ss + sx + 0.5) - cx
                    py = (y * ss + sy + 0.5) - cy
                    # 圆角矩形
                    qx = abs(px) - (half - corner)
                    qy = abs(py) - (half - corner)
                    d = math.hypot(max(qx, 0.0), max(qy, 0.0)) - corner
                    if d > 0:
                        continue
                    t = (y * ss + sy) / n
                    bg = _mix(GRAD_TOP, GRAD_BOTTOM, min(1.0, max(0.0, t)))
                    r = math.hypot(px, py)
                    on_white = (
                        abs(r - ring1) <= w1 / 2
                        or abs(r - ring2) <= w2 / 2
                        or r <= dot
                    )
                    if on_white:
                        acc_r += 255; acc_g += 255; acc_b += 255
                    else:
                        acc_r += bg[0]; acc_g += bg[1]; acc_b += bg[2]
                    acc_a += 1.0
            total = ss * ss
            if acc_a == 0:
                row += bytes((0, 0, 0, 0))
            else:
                a = acc_a / total
                row += bytes((
                    int(acc_r / acc_a),
                    int(acc_g / acc_a),
                    int(acc_b / acc_a),
                    int(round(a * 255)),
                ))
        rows.append(bytes(row))
    return b"".join(rows)


def png_bytes(size: int) -> bytes:
    raw = render(size)
    stride = size * 4
    lines = b"".join(b"\x00" + raw[i * stride:(i + 1) * stride] for i in range(size))

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(lines, 9))
        + chunk(b"IEND", b"")
    )


def ico_bytes(pngs: list[tuple[int, bytes]]) -> bytes:
    """多尺寸 ICO（内嵌 PNG，Vista+ 支持）。"""
    header = struct.pack("<HHH", 0, 1, len(pngs))
    entries = b""
    offset = 6 + 16 * len(pngs)
    blobs = b""
    for size, data in pngs:
        dim = 0 if size >= 256 else size
        entries += struct.pack(
            "<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset
        )
        offset += len(data)
        blobs += data
    return header + entries + blobs


def main() -> None:
    big = png_bytes(512)
    (ASSETS / "icon.png").write_bytes(big)
    print("icon.png", len(big))

    sizes = [256, 64, 32, 16]
    pngs = [(s, png_bytes(s)) for s in sizes]
    (ASSETS / "icon.ico").write_bytes(ico_bytes(pngs))
    print("icon.ico", sum(len(d) for _, d in pngs))

    (ASSETS / "tray.png").write_bytes(png_bytes(32))
    print("tray.png ok")


if __name__ == "__main__":
    main()
