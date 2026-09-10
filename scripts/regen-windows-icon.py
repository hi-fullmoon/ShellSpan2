#!/usr/bin/env python3
"""Regenerate the desktop icon set from the source artwork.

The source artwork (resources/icons/icon.png) is already full-bleed (see
the git history for the original padded version); this script crops the
opaque content just in case, re-centers it with a small margin (see
CONTENT_FILL), renders a 1024px master, and box-downsamples it into:

  - resources/icons/icon.ico        (16,20,24,32,40,48,64,256 PNG entries)
  - resources/icons/32x32.png
  - resources/icons/64x64.png
  - resources/icons/128x128.png
  - resources/icons/128x128@2x.png
  - resources/icons/icon.icns       (macOS, PNG entries 32..1024)

Pure stdlib (zlib/struct) so it runs anywhere Python 3 does.

Usage: python scripts/regen-windows-icon.py
"""

import math
import struct
import zlib
from pathlib import Path

ICONS_DIR = Path(__file__).resolve().parent.parent / "resources" / "icons"
SOURCE = ICONS_DIR / "icon.png"

# Fraction of the canvas the opaque artwork should occupy after cropping.
# 0.95 = the rounded square keeps ~2.5% breathing room on each side instead
# of touching the canvas edges (corners stay transparent due to the radius).
CONTENT_FILL = 0.95

# All targets are derived from a single square master of this size.
MASTER_SIDE = 1024

ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
PNG_TARGETS = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
}
# icns entry type -> pixel size (PNG payload; ic1x are the @2x retina types).
ICNS_ENTRIES = [
    (b"ic11", 32),
    (b"ic12", 64),
    (b"ic07", 128),
    (b"ic08", 256),
    (b"ic13", 256),
    (b"ic09", 512),
    (b"ic14", 512),
    (b"ic10", 1024),
]


def decode_png(path):
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")
    pos = 8
    idat = b""
    width = height = None
    while pos < len(data):
        length, ctype = struct.unpack(">I4s", data[pos : pos + 8])
        body = data[pos + 8 : pos + 8 + length]
        if ctype == b"IHDR":
            width, height, bitdepth, colortype = struct.unpack(">IIBB", body[:10])
            if bitdepth != 8 or colortype != 6:
                raise ValueError(f"{path}: expected 8-bit RGBA PNG")
        elif ctype == b"IDAT":
            idat += body
        pos += 12 + length
    raw = zlib.decompress(idat)
    channels = 4
    stride = width * channels
    rows = []
    prev = bytearray(stride)
    i = 0
    for _ in range(height):
        filter_type = raw[i]
        i += 1
        line = bytearray(raw[i : i + stride])
        i += stride
        if filter_type == 1:
            for x in range(channels, stride):
                line[x] = (line[x] + line[x - channels]) & 255
        elif filter_type == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif filter_type == 3:
            for x in range(stride):
                a = line[x - channels] if x >= channels else 0
                line[x] = (line[x] + (a + prev[x]) // 2) & 255
        elif filter_type == 4:
            for x in range(stride):
                a = line[x - channels] if x >= channels else 0
                b = prev[x]
                c = prev[x - channels] if x >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        elif filter_type != 0:
            raise ValueError(f"unsupported PNG filter {filter_type}")
        rows.append(line)
        prev = line
    return width, height, rows




def encode_png(width, height, rows):
    raw = b"".join(b"\x00" + bytes(row) for row in rows)

    def chunk(ctype, body):
        return (
            struct.pack(">I", len(body))
            + ctype
            + body
            + struct.pack(">I", zlib.crc32(ctype + body) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def content_bbox(width, height, rows, threshold=128):
    min_x, min_y, max_x, max_y = width, height, -1, -1
    for y, row in enumerate(rows):
        for x in range(width):
            if row[x * 4 + 3] > threshold:
                min_x = min(min_x, x)
                max_x = max(max_x, x)
                min_y = min(min_y, y)
                max_y = max(max_y, y)
    if max_x < 0:
        raise ValueError("source image is fully transparent")
    return min_x, min_y, max_x, max_y


def render_master(width, height, rows, bbox, fill, out_side):
    """Sample the content bbox, expanded to a square with `fill` headroom,
    into an out_side x out_side master image."""
    min_x, min_y, max_x, max_y = bbox
    cw = max_x - min_x + 1
    ch = max_y - min_y + 1
    side = max(cw, ch) / fill
    cx = (min_x + max_x + 1) / 2
    cy = (min_y + max_y + 1) / 2
    left = cx - side / 2
    top = cy - side / 2

    # Sample the (possibly fractional) window with bilinear interpolation.
    # Samples outside the source canvas are transparent, so a fill < 1.0
    # produces a clean transparent margin instead of stretched edge pixels.
    def px(x, y, c):
        if x < 0 or y < 0 or x >= width or y >= height:
            return 0
        return rows[y][x * 4 + c]

    out = []
    for y in range(out_side):
        sy = top + (y + 0.5) * side / out_side - 0.5
        y0 = math.floor(sy)
        y1 = y0 + 1
        fy = sy - y0
        row = bytearray(out_side * 4)
        for x in range(out_side):
            sx = left + (x + 0.5) * side / out_side - 0.5
            x0 = math.floor(sx)
            x1 = x0 + 1
            fx = sx - x0
            for c in range(4):
                v00 = px(x0, y0, c)
                v10 = px(x1, y0, c)
                v01 = px(x0, y1, c)
                v11 = px(x1, y1, c)
                v = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy
                row[x * 4 + c] = int(round(v))
        out.append(row)
    return side, out


def downsample(src_side, src_rows, dst_side):
    """Area-average downsample from square src to dst_side x dst_side."""
    if dst_side == src_side:
        return [bytearray(row) for row in src_rows]
    ratio = src_side / dst_side
    # Precompute per-axis coverage weights: for each dst pixel, the list of
    # (src_index, weight) pairs covering it.
    axis = []
    for d in range(dst_side):
        start = d * ratio
        end = start + ratio
        entries = []
        s = int(start)
        while s < end and s < src_side:
            w = min(end, s + 1) - max(start, s)
            entries.append((s, w))
            s += 1
        axis.append(entries)
    out = []
    for dy in range(dst_side):
        row = bytearray(dst_side * 4)
        y_entries = axis[dy]
        for dx in range(dst_side):
            acc = [0.0, 0.0, 0.0, 0.0]
            total = 0.0
            for sy, wy in y_entries:
                src_row = src_rows[sy]
                for sx, wx in axis[dx]:
                    w = wx * wy
                    total += w
                    base = sx * 4
                    for c in range(4):
                        acc[c] += src_row[base + c] * w
            for c in range(4):
                row[dx * 4 + c] = int(round(acc[c] / total))
        out.append(row)
    return out






def build_ico(png_by_size):
    # Largest first: tauri-codegen (CachedIcon::new_ico) decodes only
    # entries()[0] into the runtime default_window_icon, which is what the
    # Windows tray icon uses. A 16px first entry gets upscaled by Windows on
    # high-DPI displays and looks blurry; the shell itself (taskbar,
    # explorer) picks entries by size and is unaffected by the order.
    entries = sorted(png_by_size, reverse=True)
    header = struct.pack("<HHH", 0, 1, len(entries))
    directory = b""
    offset = 6 + 16 * len(entries)
    blobs = b""
    for size in entries:
        blob = png_by_size[size]
        directory += struct.pack(
            "<BBBBHHII",
            size if size < 256 else 0,
            size if size < 256 else 0,
            0,
            0,
            1,
            32,
            len(blob),
            offset,
        )
        blobs += blob
        offset += len(blob)
    return header + directory + blobs


def build_icns(entries):
    """entries: list of (4-byte type, pixel size, PNG blob)."""
    body = b""
    for ctype, _size, blob in entries:
        body += ctype + struct.pack(">I", len(blob) + 8) + blob
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def main():
    width, height, rows = decode_png(SOURCE)
    bbox = content_bbox(width, height, rows)
    cw = bbox[2] - bbox[0] + 1
    print(f"source {width}x{height}, content {cw}px ({cw / width:.0%} of canvas)")

    side, master = render_master(width, height, rows, bbox, CONTENT_FILL, MASTER_SIDE)
    print(f"master {MASTER_SIDE}x{MASTER_SIDE} (window {side:.0f}px, content fills {CONTENT_FILL:.0%})")

    cache = {}

    def at(size):
        if size not in cache:
            cache[size] = downsample(MASTER_SIDE, master, size)
        return cache[size]

    # Windows taskbar/tray icons.
    png_by_size = {size: encode_png(size, size, at(size)) for size in ICO_SIZES}
    (ICONS_DIR / "icon.ico").write_bytes(build_ico(png_by_size))
    print(f"wrote icon.ico with sizes {ICO_SIZES}")
    for name, size in PNG_TARGETS.items():
        (ICONS_DIR / name).write_bytes(encode_png(size, size, at(size)))
        print(f"wrote {name}")

    # macOS.
    icns = build_icns([(ctype, size, encode_png(size, size, at(size))) for ctype, size in ICNS_ENTRIES])
    (ICONS_DIR / "icon.icns").write_bytes(icns)
    print(f"wrote icon.icns with entries {[t.decode() for t, _ in ICNS_ENTRIES]}")



if __name__ == "__main__":
    main()
