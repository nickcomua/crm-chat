#!/usr/bin/env python3
"""Compare web integration screenshots with Telegram Web K references.

Prints layout measurements only. Never prints pixels, chat text, or secrets.
A QR shot fails closed when a barcode decoder can still read it.
"""

import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

LIST_SHOTS = (
    "02-chat-list.png",
    "04-after-reload.png",
    "05-reopened.png",
    "06-after-redeploy.png",
)
THREAD_SHOT = "03-open-chat.png"
QR_SHOTS = ("01-qr-blurred.png", "redeploy-qr.png")
REF_LIST = "k-03-chat-list.png"
REF_THREAD = "k-04-open-chat.png"
REF_QR = "k-02-qr-blurred.png"
SEAM_TOLERANCE = 0.04
QR_SHARP_LIMIT = 0.02
REF_QR_SHARP_LIMIT = 0.01


def _paeth(a: int, b: int, c: int) -> int:
    estimate = a + b - c
    da = abs(estimate - a)
    db = abs(estimate - b)
    dc = abs(estimate - c)
    if da <= db and da <= dc:
        return a
    if db <= dc:
        return b
    return c


def load_luma(path: Path) -> tuple[int, int, list[bytearray]]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path.name} is not a PNG")
    pos = 8
    width = height = color = None
    idat = b""
    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        kind = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            width, height, _bit, color = struct.unpack(">IIBB", chunk[:10])
        elif kind == b"IDAT":
            idat += chunk
        elif kind == b"IEND":
            break
    if width is None or height is None or color not in (2, 6):
        raise ValueError(f"{path.name} is not an RGB PNG")
    raw = zlib.decompress(idat)
    channels = 3 if color == 2 else 4
    rows: list[bytearray] = []
    cursor = 0
    previous = bytearray(width * channels)
    for _y in range(height):
        filt = raw[cursor]
        cursor += 1
        row = bytearray(raw[cursor : cursor + width * channels])
        cursor += width * channels
        if filt == 1:
            for index in range(len(row)):
                left = row[index - channels] if index >= channels else 0
                row[index] = (row[index] + left) & 255
        elif filt == 2:
            for index in range(len(row)):
                row[index] = (row[index] + previous[index]) & 255
        elif filt == 3:
            for index in range(len(row)):
                left = row[index - channels] if index >= channels else 0
                row[index] = (row[index] + ((left + previous[index]) // 2)) & 255
        elif filt == 4:
            for index in range(len(row)):
                left = row[index - channels] if index >= channels else 0
                up = previous[index]
                up_left = previous[index - channels] if index >= channels else 0
                row[index] = (row[index] + _paeth(left, up, up_left)) & 255
        elif filt != 0:
            raise ValueError(f"{path.name} uses PNG filter {filt}")
        previous = row
        luma = bytearray(width)
        for x in range(width):
            luma[x] = (
                row[x * channels] * 3
                + row[x * channels + 1] * 6
                + row[x * channels + 2]
            ) // 10
        rows.append(luma)
    return width, height, rows


def column_seam(rows: list[bytearray], width: int, height: int) -> float:
    y0 = int(height * 0.15)
    y1 = int(height * 0.85)
    best_x = int(width * 0.08)
    best = -1.0
    for x in range(int(width * 0.08), int(width * 0.55)):
        total = 0
        for y in range(y0, y1):
            total += abs(rows[y][x] - rows[y][x - 1])
        score = total / max(y1 - y0, 1)
        if score > best:
            best = score
            best_x = x
    return best_x / width


def composer_delta(rows: list[bytearray], width: int, height: int) -> float:
    x0 = int(width * 0.35)

    def mean(y0: int, y1: int) -> float:
        total = 0
        count = 0
        for y in range(y0, y1):
            row = rows[y]
            for x in range(x0, width):
                total += row[x]
                count += 1
        return total / max(count, 1)

    bottom = mean(int(height * 0.92), height - 1)
    middle = mean(int(height * 0.70), int(height * 0.88))
    return abs(bottom - middle)


def qr_sharp_fraction(rows: list[bytearray], width: int, height: int) -> float:
    x0 = int(width * 0.40)
    x1 = int(width * 0.60)
    y0 = int(height * 0.28)
    y1 = int(height * 0.58)
    sharp = 0
    total = 0
    for y in range(y0, y1):
        row = rows[y]
        for x in range(x0, x1 - 1):
            total += 1
            if abs(row[x + 1] - row[x]) >= 160:
                sharp += 1
    return sharp / max(total, 1)


def barcode_readable(path: Path) -> bool:
    try:
        result = subprocess.run(
            ["zbarimg", "-q", "--raw", str(path)],
            check=False,
            capture_output=True,
        )
    except FileNotFoundError:
        return False
    return result.stdout.strip() != b""


def _measure(path: Path) -> tuple[float, float, float]:
    width, height, rows = load_luma(path)
    return (
        column_seam(rows, width, height),
        composer_delta(rows, width, height),
        qr_sharp_fraction(rows, width, height),
    )


def compare(shot_dir: Path, webk_dir: Path) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    lines = ["webk-compare:"]
    for name in (*LIST_SHOTS, THREAD_SHOT, *QR_SHOTS):
        if not (shot_dir / name).is_file():
            errors.append(f"missing {name}")
    for name in (REF_LIST, REF_THREAD, REF_QR):
        if not (webk_dir / name).is_file():
            errors.append(f"missing Telegram Web K reference {name}")
    if errors:
        return errors, lines

    ref_seam, ref_list_delta, _ref_list_sharp = _measure(webk_dir / REF_LIST)
    _thread_seam, ref_thread_delta, _ref_thread_sharp = _measure(webk_dir / REF_THREAD)
    _qr_seam, _qr_delta, ref_qr_sharp = _measure(webk_dir / REF_QR)
    lines.append(
        f"reference list_seam={ref_seam:.3f} list_delta={ref_list_delta:.1f} "
        f"thread_delta={ref_thread_delta:.1f} qr_sharp={ref_qr_sharp:.4f}"
    )
    if ref_qr_sharp >= REF_QR_SHARP_LIMIT:
        errors.append("Telegram Web K QR reference is not blurred")
    if ref_thread_delta <= ref_list_delta:
        errors.append("Telegram Web K open-chat reference has no composer band")
    # Half the measured Web K open-chat composer. That reference is about 7.8,
    # so a fixed floor of 12 would reject Web K itself.
    composer_line = ref_thread_delta * 0.5

    for name in LIST_SHOTS:
        seam, delta, _sharp = _measure(shot_dir / name)
        lines.append(f"{name} seam={seam:.3f} delta={delta:.1f}")
        if abs(seam - ref_seam) > SEAM_TOLERANCE:
            errors.append(f"{name} chat column is not aligned with Telegram Web K")
        if delta >= composer_line:
            errors.append(f"{name} shows a composer on the chat list")

    seam, delta, _sharp = _measure(shot_dir / THREAD_SHOT)
    lines.append(f"{THREAD_SHOT} seam={seam:.3f} delta={delta:.1f}")
    if abs(seam - ref_seam) > SEAM_TOLERANCE:
        errors.append(f"{THREAD_SHOT} chat column is not aligned with Telegram Web K")
    if delta < composer_line:
        errors.append(f"{THREAD_SHOT} has no composer band like Telegram Web K")

    for name in QR_SHOTS:
        _seam, _delta, sharp = _measure(shot_dir / name)
        lines.append(f"{name} qr_sharp={sharp:.4f}")
        if sharp >= QR_SHARP_LIMIT:
            errors.append(f"{name} QR is sharp enough to read")
        if barcode_readable(shot_dir / name):
            errors.append(f"{name} QR still decodes")

    return errors, lines


def _write_png(path: Path, width: int, height: int, pixel) -> None:
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            value = pixel(x, y) & 255
            raw.extend((value, value, value))
    compressed = zlib.compress(bytes(raw))

    def chunk(tag: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body))
            + tag
            + body
            + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", compressed)
        + chunk(b"IEND", b"")
    )


def _panel(seam_at: float, composer_luma: int | None = None):
    def pixel(x: int, y: int, width: int = 400, height: int = 250) -> int:
        if x < int(width * seam_at):
            return 40
        if composer_luma is not None and y >= int(height * 0.92):
            return composer_luma
        return 210

    return pixel


def _qr(x: int, y: int, width: int = 400, height: int = 250) -> int:
    del x, y, width, height
    return 140


def self_test() -> None:
    # 202 against a field of 210 is a composer delta of 8, under the old floor
    # of 12 and in the same range as the Telegram Web K open chat (about 7.8).
    # 207 is a delta of 3, below half of that reference.
    low = 202
    faint = 207
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        shots = root / "shots"
        webk = root / "webk"
        shots.mkdir()
        webk.mkdir()
        _write_png(webk / REF_LIST, 400, 250, _panel(0.25))
        _write_png(webk / REF_THREAD, 400, 250, _panel(0.25, low))
        _write_png(webk / REF_QR, 400, 250, _qr)
        for name in LIST_SHOTS:
            _write_png(shots / name, 400, 250, _panel(0.25))
        _write_png(shots / THREAD_SHOT, 400, 250, _panel(0.25, low))
        for name in QR_SHOTS:
            _write_png(shots / name, 400, 250, _qr)
        good, _lines = compare(shots, webk)
        if good:
            raise SystemExit("self-test expected a match: " + "; ".join(good))
        _write_png(shots / THREAD_SHOT, 400, 250, _panel(0.25, faint))
        faint_band, _lines = compare(shots, webk)
        if not any(THREAD_SHOT in item for item in faint_band):
            raise SystemExit("self-test expected the faint composer to fail")
        _write_png(shots / THREAD_SHOT, 400, 250, _panel(0.25, low))
        _write_png(shots / "02-chat-list.png", 400, 250, _panel(0.25, low))
        listed, _lines = compare(shots, webk)
        if not any("02-chat-list.png" in item for item in listed):
            raise SystemExit("self-test expected a composer on the chat list to fail")
        _write_png(shots / "02-chat-list.png", 400, 250, _panel(0.5))
        bad, _lines = compare(shots, webk)
        if not any("02-chat-list.png" in item for item in bad):
            raise SystemExit("self-test expected the shifted column to fail")
    print("webk-compare: self-test pass")


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        self_test()
        return
    if len(sys.argv) != 3:
        print(
            "usage: web_shot_compare.py SHOT_DIR WEBK_DIR | --self-test",
            file=sys.stderr,
        )
        raise SystemExit(2)
    problems, lines = compare(Path(sys.argv[1]), Path(sys.argv[2]))
    print("\n".join(lines))
    if problems:
        print("webk-compare: fail")
        for problem in problems:
            print(f"webk-compare: {problem}")
        raise SystemExit(1)
    print("webk-compare: pass")


if __name__ == "__main__":
    main()
