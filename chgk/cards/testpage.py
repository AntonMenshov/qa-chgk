"""One calibration page for a tournament: print scale, QR sizes, logo shades and a
row of real cards, so the organizer can check a printer before printing everything."""

from pathlib import Path

from PIL import Image
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

from chgk.cards.geometry import INCH, PAGE_H, PAGE_W, Rect, card_parts, card_rects
from chgk.cards.model import team_deck
from chgk.cards.render import FONT, FONT_BOLD, _draw_card, _fonts, draw_qr, logo_key
from chgk.config import Tournament
from chgk.ids import CardId, encode_payload
from chgk.logos import pale
from chgk.teams import Team

QR_SIZES = [0.55, 0.6, 0.65, 0.7, 0.8]
GREYS = [0.03, 0.05, 0.08, 0.12, 0.16, 0.20]


def _ruler(c: Canvas, x: float, y: float, vertical: bool) -> None:
    length = 2 * INCH
    c.setLineWidth(0.5)
    c.line(x, y, x, y + length) if vertical else c.line(x, y, x + length, y)
    for i in range(9):
        t, tick = i * INCH / 4, (8 if i % 4 == 0 else 4)
        c.line(x, y + t, x + tick, y + t) if vertical else c.line(x + t, y, x + t, y + tick)
    c.setFont(FONT, 7)
    c.drawString(x + 10, y + length / 2, "2 in") if vertical else c.drawString(x + length / 2 - 6, y + 10, "2 in")


def render_test_page(
    tournament: Tournament,
    tid: str,
    team: Team,
    out_path: Path,
    source_logo: Image.Image | None = None,
    logos: dict[str, Image.Image] | None = None,
) -> None:
    """`source_logo` (unprocessed) is shown at every shade in GREYS; the sample cards use
    the tournament's configured logos and shade."""
    _fonts()
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    c = Canvas(str(out_path), pagesize=(PAGE_W, PAGE_H))
    c.setTitle(f"{tournament.name} — тестовая страница")

    c.setFont(FONT_BOLD, 13)
    c.drawString(0.5 * INCH, 10.35 * INCH, f"{tournament.name}: тестовая страница")
    c.setFont(FONT, 9)
    c.drawString(0.5 * INCH, 10.15 * INCH, "Print on Letter at 100% / Actual size. Both rulers must measure exactly 2 in.")
    _ruler(c, 0.5 * INCH, 9.7 * INCH, vertical=False)
    _ruler(c, 7.6 * INCH, 7.6 * INCH, vertical=True)

    # QR sizes: each encodes a real card of this tournament, so the jury phone can be tried on it.
    c.setFont(FONT, 8)
    x = 0.5 * INCH
    chosen = tournament.layout.qr_size
    for i, size in enumerate(QR_SIZES, start=1):
        payload = encode_payload(tournament.scanner_url, CardId(tid, team.team_id, question=i))
        draw_qr(c, payload, Rect(x, 8.3 * INCH, size * INCH, size * INCH))
        c.setFillGray(0)
        c.drawString(x, 8.15 * INCH, f"{size} in{' (chosen)' if size == chosen else ''}")
        x += (size + 0.45) * INCH

    # Logo shades.
    c.setFont(FONT, 8)
    reader = None
    for i, grey in enumerate(GREYS):
        box = Rect(0.5 * INCH + i * 1.15 * INCH, 6.6 * INCH, 1.0 * INCH, 1.0 * INCH)
        if source_logo is not None:
            reader = ImageReader(pale(source_logo, grey))
            c.drawImage(reader, box.x, box.y, box.w, box.h, preserveAspectRatio=True, anchor="c")
        else:
            c.setFillGray(1 - grey)
            c.rect(box.x, box.y, box.w, box.h, stroke=0, fill=1)
        c.setFillGray(0)
        mark = " (chosen)" if abs(grey - tournament.card.logo_grey) < 1e-9 else ""
        c.drawString(box.x, box.y - 11, f"{round(grey * 100)}% grey{mark}")

    # A row of real cards, as they will print: first numbered card, last numbered card, a spare.
    deck = team_deck(tournament, tid, team)
    numbered = [card for card in deck if not card.is_spare]
    samples = [numbered[0], numbered[-1]] + [card for card in deck if card.is_spare][:1]
    logos = logos or {}
    readers = {k: ImageReader(v) for k, v in logos.items()}
    rects = card_rects(tournament.layout)
    bottom_row = rects[-tournament.layout.cols :]
    qr_pt = tournament.layout.qr_size * INCH
    warnings: list[str] = []
    c.setStrokeGray(0.65)
    c.setLineWidth(0.3)
    for card, rect in zip(samples, bottom_row):
        key = logo_key(card, tournament.card, logos)
        logo_pt = tournament.card.logo_size * INCH if tournament.card.logo_size else None
        _draw_card(c, card, card_parts(rect, qr_pt, logo_pt), tournament, readers.get(key), warnings)
        c.rect(rect.x, rect.y, rect.w, rect.h, stroke=1, fill=0)
    c.showPage()
    c.save()
