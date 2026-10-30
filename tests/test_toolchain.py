"""Proves the PDF test approach used from Phase 1 on.

A QR code and Cyrillic text drawn into a PDF can be read back (text via pypdf, QR via
pypdfium2 + zxing-cpp).
"""

import io

import pypdfium2
import segno
import zxingcpp
from pypdf import PdfReader
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from chgk import FONTS_DIR

PAYLOAD = "https://example.github.io/chgk/s/#K7M2Q.A07.27"
TEAM = "Синие зайцы"


def _make_pdf(qr_size_in: float) -> bytes:
    pdfmetrics.registerFont(TTFont("PTSans", FONTS_DIR / "PT_Sans-Web-Regular.ttf"))
    png = io.BytesIO()
    segno.make(PAYLOAD, error="m").save(png, kind="png", scale=10, border=4)
    png.seek(0)

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setFont("PTSans", 14)
    c.drawString(1 * inch, 10 * inch, TEAM)
    c.drawImage(ImageReader(png), 1 * inch, 7 * inch, qr_size_in * inch, qr_size_in * inch)
    c.save()
    return buf.getvalue()


def _decode_qrs(pdf: bytes, dpi: int = 200) -> list[str]:
    page = pypdfium2.PdfDocument(pdf)[0]
    image = page.render(scale=dpi / 72).to_pil()
    return [r.text for r in zxingcpp.read_barcodes(image)]


def test_cyrillic_text_is_extractable():
    text = PdfReader(io.BytesIO(_make_pdf(0.75))).pages[0].extract_text()
    assert TEAM in text


def test_qr_round_trips_through_pdf():
    assert _decode_qrs(_make_pdf(0.75)) == [PAYLOAD]
