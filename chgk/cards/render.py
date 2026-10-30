"""Draw imposed pages into a Letter PDF."""

from functools import cache
from pathlib import Path

import segno
from PIL import Image
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

from chgk import FONTS_DIR
from chgk.cards.geometry import (
    INFO_SIZE,
    NUMBER_SIZE,
    PAGE_H,
    PAGE_W,
    ROUND_SIZE,
    TEAM_SIZE,
    CardParts,
    Rect,
    card_parts,
    card_rects,
    printable_area,
)
from chgk.cards.impose import Mode, Page
from chgk.cards.model import Card
from chgk.config import CardFields, LogoMode, Tournament
from chgk.ids import encode_payload
from chgk.logos import FALLBACK_KEY, TOURNAMENT_KEY

FONT, FONT_BOLD = "PTSans", "PTSans-Bold"
GUIDE_GREY = 0.65  # solid cut lines (team-pages, cut-stack): 0 = black, 1 = white
SCISSORS_GREY = 0.35  # darker, dashed cut lines that are easy to follow with scissors
ELLIPSIS = "…"
SPARE_BOX_W = 0.8 * 72  # pt: room for a handwritten two- or three-digit number
SPARE_BOX_GREY = 0.35
RESERVE_ID_SIZE = 8  # pt: a reserve deck's ID (R1, …), bottom right; small but readable
RESERVE_NAME_LABEL = "Команда:"


@cache
def _fonts() -> TTFont:
    regular = TTFont(FONT, FONTS_DIR / "PT_Sans-Web-Regular.ttf")
    pdfmetrics.registerFont(regular)
    pdfmetrics.registerFont(TTFont(FONT_BOLD, FONTS_DIR / "PT_Sans-Web-Bold.ttf"))
    # Lets <b> work inside reportlab Paragraphs (jury sheet).
    pdfmetrics.registerFontFamily(FONT, normal=FONT, bold=FONT_BOLD, italic=FONT, boldItalic=FONT_BOLD)
    return regular


def missing_glyphs(text: str) -> set[str]:
    """Characters the bundled font cannot draw (they would print as empty boxes)."""
    cmap = _fonts().face.charToGlyph
    return {ch for ch in text if ord(ch) not in cmap and not ch.isspace()}


def printable(text: str, warnings: list[str]) -> str:
    missing = missing_glyphs(text)
    if not missing:
        return text
    warnings.append(f"{text!r}: no glyph for {''.join(sorted(missing))!r}, printed as '?'")
    return "".join("?" if ch in missing else ch for ch in text)


def fit_text(text: str, font: str, size: float, max_width: float, min_size: float) -> tuple[str, float]:
    """Shrink to fit; below `min_size`, cut the text and end it with an ellipsis."""
    while size > min_size and pdfmetrics.stringWidth(text, font, size) > max_width:
        size = max(min_size, size - 0.5)
    if pdfmetrics.stringWidth(text, font, size) <= max_width:
        return text, size
    while text and pdfmetrics.stringWidth(text + ELLIPSIS, font, size) > max_width:
        text = text[:-1]
    return text.rstrip() + ELLIPSIS, size


def logo_key(card: Card, fields: CardFields, logos: dict[str, Image.Image]) -> str | None:
    """Which loaded logo a card shows: its team's, the tournament's, the fallback, or none."""
    if fields.logo is LogoMode.NONE:
        return None
    chain = []
    if fields.logo in (LogoMode.TEAM, LogoMode.TEAM_ELSE_TOURNAMENT):
        chain.append(card.team.team_id)
    if fields.logo in (LogoMode.TOURNAMENT, LogoMode.TEAM_ELSE_TOURNAMENT):
        chain.append(TOURNAMENT_KEY)
    chain.append(FALLBACK_KEY)
    return next((key for key in chain if key in logos), None)


def draw_qr(c: Canvas, payload: str, rect: Rect) -> None:
    """Vector QR code filling `rect`, including a white 4-module quiet zone."""
    qr = segno.make_qr(payload, error="m", boost_error=False)
    matrix = qr.matrix
    n = len(matrix)
    module = rect.w / (n + 8)
    c.setFillGray(1)
    c.rect(rect.x, rect.y, rect.w, rect.h, stroke=0, fill=1)
    c.setFillGray(0)
    path = c.beginPath()
    for r, row in enumerate(matrix):
        y = rect.top - (r + 5) * module
        col = 0
        while col < n:
            if row[col]:
                start = col
                while col < n and row[col]:
                    col += 1
                path.rect(rect.x + (start + 4) * module, y, (col - start) * module, module)
            else:
                col += 1
    c.drawPath(path, stroke=0, fill=1)


def _draw_guides(c: Canvas, tournament: Tournament, mode: Mode, rects: list[Rect]) -> None:
    """Cut lines on the shared card edges; crop marks in the margin for guillotine modes."""
    area = printable_area(tournament.layout)
    xs = sorted({round(r.x, 3) for r in rects} | {round(area.right, 3)})
    ys = sorted({round(r.y, 3) for r in rects} | {round(area.top, 3)})
    scissors = mode is Mode.SCISSORS
    c.setStrokeGray(SCISSORS_GREY if scissors else GUIDE_GREY)
    c.setLineWidth(0.4 if scissors else 0.3)
    if scissors:
        c.setDash(4, 2)
    for x in xs:
        c.line(x, area.y, x, area.top)
    for y in ys:
        c.line(area.x, y, area.right, y)
    c.setDash()
    if scissors:
        return
    # Crop marks in the margin, so cut positions are visible on the edge of a stack.
    m = area.x
    for x in xs:
        c.line(x, 2, x, m - 3)
        c.line(x, PAGE_H - 2, x, PAGE_H - m + 3)
    for y in ys:
        c.line(2, y, m - 3, y)
        c.line(PAGE_W - 2, y, PAGE_W - m + 3, y)


def spare_box(number: Rect) -> Rect:
    """The blank box for the question number on a spare card."""
    return Rect(number.x, number.y, min(SPARE_BOX_W, number.w), number.h)


def _draw_card(
    c: Canvas, card: Card, parts: CardParts, tournament: Tournament, logo: ImageReader | None, warnings: list[str]
) -> None:
    fields = tournament.card
    if logo is not None:
        lr = parts.logo
        c.drawImage(logo, lr.x, lr.y, lr.w, lr.h, preserveAspectRatio=True, anchor="c")

    draw_qr(c, encode_payload(tournament.scanner_url, card.id), parts.qr)

    nr = parts.number
    c.setFillGray(0)
    if card.is_spare:
        # An empty box where the number sits on every other card: the team writes it in.
        # White inside, so the logo behind it shows through neither the border nor the handwriting.
        box = spare_box(nr)
        c.setStrokeGray(SPARE_BOX_GREY)
        c.setFillGray(1)
        c.setLineWidth(1)
        c.roundRect(box.x, box.y, box.w, box.h, 4, stroke=1, fill=1)
        c.setStrokeGray(0)
        c.setFillGray(0)
    else:
        c.setFont(FONT_BOLD, NUMBER_SIZE)
        c.drawString(nr.x, nr.top - pdfmetrics.getAscent(FONT_BOLD, NUMBER_SIZE), str(card.id.question))
        c.setFont(FONT, ROUND_SIZE)
        c.drawString(nr.x, nr.y + 1, f"Тур {card.round}")

    fr = parts.footer
    if fields.team_name and card.team.reserve:
        # A reserve deck: the team writes its name here.
        c.setFont(FONT, TEAM_SIZE - 1)
        c.drawString(fr.x, parts.team_baseline, RESERVE_NAME_LABEL)
        start = fr.x + pdfmetrics.stringWidth(RESERVE_NAME_LABEL, FONT, TEAM_SIZE - 1) + 3
        c.setLineWidth(0.5)
        c.line(start, parts.team_baseline - 1, fr.right, parts.team_baseline - 1)
    elif fields.team_name:
        text, size = fit_text(printable(card.team.name, warnings), FONT_BOLD, TEAM_SIZE, fr.w, 5.5)
        c.setFont(FONT_BOLD, size)
        c.drawString(fr.x, parts.team_baseline, text)
    info = " · ".join(
        part
        for part, on in (
            (printable(tournament.name, warnings), fields.tournament_name),
            (tournament.date.strftime("%d.%m.%Y"), fields.date),
        )
        if on
    )
    id_w = 0.0
    if card.team.reserve:
        # A reserve deck has no name on its cards yet: its ID tells the decks apart (user request).
        c.setFont(FONT_BOLD, RESERVE_ID_SIZE)
        c.drawRightString(fr.right, parts.info_baseline, card.team.team_id)
        id_w = pdfmetrics.stringWidth(card.team.team_id, FONT_BOLD, RESERVE_ID_SIZE) + 6
    if info:
        text, size = fit_text(info, FONT, INFO_SIZE, fr.w - id_w, 5)
        c.setFont(FONT, size)
        c.drawString(fr.x, parts.info_baseline, text)


def render_cards(
    pages: list[Page],
    tournament: Tournament,
    mode: Mode,
    out_path: Path,
    logos: dict[str, Image.Image] | None = None,
) -> list[str]:
    """Write the PDF; return warnings (e.g. characters the font cannot print).

    `logos` maps team_id / TOURNAMENT_KEY / FALLBACK_KEY to pale images.
    """
    _fonts()
    logos = logos or {}
    readers = {k: ImageReader(v) for k, v in logos.items()}

    rects = card_rects(tournament.layout)
    qr_pt = tournament.layout.qr_size * 72
    logo_pt = tournament.card.logo_size * 72 if tournament.card.logo_size else None
    all_parts = [card_parts(r, qr_pt, logo_pt) for r in rects]

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    c = Canvas(str(out_path), pagesize=(PAGE_W, PAGE_H))
    c.setTitle(f"{tournament.name} — карточки ({mode.value})")
    warnings: list[str] = []
    for page in pages:
        for card, parts in zip(page, all_parts, strict=False):  # a last page may have empty slots
            if card is None:
                continue
            key = logo_key(card, tournament.card, logos)
            _draw_card(c, card, parts, tournament, readers.get(key), warnings)
        # Guides last: the QR's white quiet zone would otherwise hide them at the corners.
        _draw_guides(c, tournament, mode, rects)
        c.showPage()
    c.save()
    return sorted(set(warnings))
