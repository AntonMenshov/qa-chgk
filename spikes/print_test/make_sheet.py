"""Spike 3: one Letter page to print on the real printer(s).

Checks: print scale (1-inch rulers), smallest QR the phone scans reliably, which
grey shade is "very pale" yet visible, and Cyrillic text on a card-sized box.

    uv run python spikes/print_test/make_sheet.py   # → out/print_test.pdf
"""

import io
from pathlib import Path

import segno
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from chgk import FONTS_DIR

OUT = Path(__file__).resolve().parents[2] / "out" / "print_test.pdf"
QR_SIZES_IN = [0.5, 0.6, 0.7, 0.8, 1.0]
GREYS = [0.03, 0.05, 0.08, 0.12, 0.16, 0.20, 0.25]  # ink coverage: 0 = white, 1 = black
CARD_W, CARD_H = 8.0 / 3 * inch, 10.5 / 5 * inch  # one card of the default 3×5 grid


def qr_image(payload: str) -> ImageReader:
    png = io.BytesIO()
    segno.make(payload, error="m").save(png, kind="png", scale=10, border=4)
    png.seek(0)
    return ImageReader(png)


def ruler(c: canvas.Canvas, x: float, y: float, vertical: bool = False) -> None:
    length = 2 * inch
    c.setLineWidth(0.5)
    c.line(x, y, x, y + length) if vertical else c.line(x, y, x + length, y)
    for i in range(9):
        t = i * inch / 4
        tick = 8 if i % 4 == 0 else 4
        c.line(x, y + t, x + tick, y + t) if vertical else c.line(x + t, y, x + t, y + tick)
    c.setFont("PTSans", 7)
    c.drawString(x + 10, y + length / 2, "2 in") if vertical else c.drawString(x + length / 2, y + 10, "2 in")


def main() -> None:
    pdfmetrics.registerFont(TTFont("PTSans", FONTS_DIR / "PT_Sans-Web-Regular.ttf"))
    pdfmetrics.registerFont(TTFont("PTSans-Bold", FONTS_DIR / "PT_Sans-Web-Bold.ttf"))
    OUT.parent.mkdir(exist_ok=True)
    c = canvas.Canvas(str(OUT), pagesize=letter)
    c.setTitle("ЧГК print test")

    c.setFont("PTSans-Bold", 14)
    c.drawString(0.5 * inch, 10.4 * inch, "Тестовая страница ЧГК — print at 100% / Actual size")
    ruler(c, 0.5 * inch, 9.9 * inch)
    ruler(c, 7.5 * inch, 7.9 * inch, vertical=True)

    # QR codes at several sizes; each encodes a realistic card URL.
    c.setFont("PTSans", 9)
    x = 0.5 * inch
    for i, size in enumerate(QR_SIZES_IN):
        payload = f"https://example.github.io/chgk/s/#K7M2Q.A07.{i + 1}"
        c.drawImage(qr_image(payload), x, 7.6 * inch, size * inch, size * inch)
        c.drawString(x, 7.45 * inch, f"{size} in: Q{i + 1}")
        x += (size + 0.35) * inch

    # Grey swatches for the logo watermark.
    c.setFont("PTSans", 9)
    for i, grey in enumerate(GREYS):
        x = 0.5 * inch + i * 1.05 * inch
        c.setFillGray(1 - grey)
        c.rect(x, 6.2 * inch, 0.9 * inch, 0.9 * inch, stroke=0, fill=1)
        c.setFillGray(0)
        c.drawString(x, 6.05 * inch, f"{round(grey * 100)}% grey")

    # Three sample cards at the real 3×5 size, with a pale "logo" behind the writing area.
    for i, grey in enumerate([0.05, 0.08, 0.12]):
        x0, y0 = 0.25 * inch + i * CARD_W, 0.6 * inch
        c.setFillGray(1 - grey)
        c.circle(x0 + CARD_W / 2, y0 + CARD_H / 2 - 6, 0.55 * inch, stroke=0, fill=1)
        c.setFillGray(0)
        c.setDash(2, 2)
        c.setLineWidth(0.3)
        c.rect(x0, y0, CARD_W, CARD_H)
        c.setDash()
        c.setFont("PTSans-Bold", 30)
        c.drawString(x0 + 8, y0 + CARD_H - 34, str(25 + i))
        c.setFont("PTSans", 9)
        c.drawString(x0 + 8, y0 + CARD_H - 46, "Тур 3")
        qr = 0.75 * inch
        c.drawImage(qr_image(f"https://example.github.io/chgk/s/#K7M2Q.A07.{25 + i}"),
                    x0 + CARD_W - qr - 4, y0 + CARD_H - qr - 4, qr, qr)
        c.setFont("PTSans", 7)
        c.drawString(x0 + 8, y0 + 6, "Синие зайцы · Осенний кубок · 15.11.2026")
        c.drawString(x0 + 8, y0 - 10, f"logo {round(grey * 100)}% grey")

    c.save()
    print(OUT)


if __name__ == "__main__":
    main()
