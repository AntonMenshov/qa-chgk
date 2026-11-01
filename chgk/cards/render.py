"""Draw imposed pages into a Letter PDF."""

import re
import unicodedata
from collections.abc import Sequence
from functools import cache
from pathlib import Path

import segno
from PIL import Image
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

from chgk import FONT_BOLD_FILE, FONT_REGULAR_FILE
from chgk.cards.geometry import (
    INCH,
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
from chgk.config import Tournament
from chgk.ids import encode_payload
from chgk.logos import first_logo

FONT, FONT_BOLD = "PTSans", "PTSans-Bold"
GUIDE_GREY = 0.65  # solid cut lines (team-pages, cut-stack): 0 = black, 1 = white
SCISSORS_GREY = 0.35  # darker, dashed cut lines that are easy to follow with scissors
ELLIPSIS = "…"
SPARE_BOX_W = 0.8 * 72  # pt: room for a handwritten two- or three-digit number
SPARE_BOX_GREY = 0.35
RESERVE_ID_SIZE = 8  # pt: a reserve deck's ID (R1, …), bottom right; small but readable
RESERVE_NAME_LABEL = "Команда:"


@cache
def register_fonts() -> TTFont:
    regular = TTFont(FONT, FONT_REGULAR_FILE)
    pdfmetrics.registerFont(regular)
    pdfmetrics.registerFont(TTFont(FONT_BOLD, FONT_BOLD_FILE))
    # Lets <b> work inside reportlab Paragraphs (jury sheet).
    pdfmetrics.registerFontFamily(FONT, normal=FONT, bold=FONT_BOLD, italic=FONT, boldItalic=FONT_BOLD)
    return regular


def missing_glyphs(text: str) -> set[str]:
    """Characters the bundled font cannot draw (they would print as empty boxes)."""
    cmap = register_fonts().face.charToGlyph
    return {ch for ch in text if ord(ch) not in cmap and not ch.isspace()}


def printable(text: str, warnings: list[str]) -> str:
    # Pasted names: decomposed letters and thin spaces, which have no glyph but the normal forms do.
    text = re.sub(r"[^\S \u00a0]", " ", unicodedata.normalize("NFC", text))
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


MIN_NUMBER_SIZE = 14  # pt: three digits fit in the 0.45 in that card_parts guarantees

# Card QR codes have been checked at this version (33 modules) on paper and on the iPhone;
# a longer payload (an 8-character tid and team ID) needs a denser code.
CHECKED_QR_VERSION = 4


def make_qr(payload: str) -> segno.QRCode:
    return segno.make_qr(payload, error="m", boost_error=False)


def denser_qr_warning(payloads: list[str]) -> str | None:
    """A warning when the longest card payload needs a denser QR code than the checked one."""
    longest = max(payloads, key=len, default="")
    version = int(make_qr(longest).version) if longest else 0
    if version <= CHECKED_QR_VERSION:
        return None
    return (
        f"the longest card QR code ({longest}) needs version {version}, denser than the checked "
        f"version {CHECKED_QR_VERSION}: print the test page and check that the phone reads it quickly"
    )


def draw_qr(c: Canvas, payload: str, rect: Rect) -> None:
    """Vector QR code filling `rect`, including a white 4-module quiet zone."""
    qr = make_qr(payload)
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
    """Cut lines on the shared card edges; crop marks in the margin, except in scissors mode."""
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


def draw_card(
    c: Canvas, card: Card, parts: CardParts, tournament: Tournament, logo: ImageReader | None, warnings: list[str]
) -> None:
    c.saveState()  # the caller's pen stays as it was (the test page draws outlines between cards)
    fields = tournament.card
    if logo is not None:
        lr = parts.logo
        c.drawImage(logo, lr.x, lr.y, lr.w, lr.h, preserveAspectRatio=True, anchor="c")

    if not fields.no_qr:  # without the QR its corner stays empty: nothing moves into it
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
        # Three digits may not fit beside the QR code at full size.
        number, size = fit_text(str(card.id.question), FONT_BOLD, NUMBER_SIZE, nr.w, MIN_NUMBER_SIZE)
        c.setFont(FONT_BOLD, size)
        c.drawString(nr.x, nr.top - pdfmetrics.getAscent(FONT_BOLD, size), number)
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
        if text.endswith(ELLIPSIS):
            warnings.append(f"team name cut on the cards: {card.team.name!r} prints as {text!r}")
        c.setFont(FONT_BOLD, size)
        c.drawString(fr.x, parts.team_baseline, text)
    info = " · ".join(
        part
        for part, on in (
            (printable(tournament.name, warnings) if fields.tournament_name else "", fields.tournament_name),
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
        if text.endswith(ELLIPSIS):
            warnings.append(f"cut on the cards: {info!r} prints as {text!r}")
        c.setFont(FONT, size)
        c.drawString(fr.x, parts.info_baseline, text)
    c.restoreState()


def placed_parts(rect: Rect, tournament: Tournament) -> CardParts:
    """The parts of a card at `rect`, with the tournament's QR and logo sizes."""
    logo_pt = tournament.card.logo_size * INCH if tournament.card.logo_size else None
    return card_parts(rect, tournament.layout.qr_size * INCH, logo_pt, tournament.card.no_qr)


def draw_cards(
    c: Canvas,
    cards: Sequence[Card],
    parts: Sequence[CardParts],
    tournament: Tournament,
    readers: dict[str, ImageReader],
    warnings: list[str],
) -> None:
    """Each card in its place, with the logo its team's cards use; a page may have empty slots at the end."""
    for card, place in zip(cards, parts, strict=False):
        key = first_logo(tournament.card, card.team.team_id, readers)
        draw_card(c, card, place, tournament, readers.get(key) if key else None, warnings)


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
    register_fonts()
    readers = {key: ImageReader(image) for key, image in (logos or {}).items()}

    rects = card_rects(tournament.layout)
    all_parts = [placed_parts(r, tournament) for r in rects]

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    c = Canvas(str(out_path), pagesize=(PAGE_W, PAGE_H))
    c.setTitle(f"{tournament.name} — карточки ({mode.value})")
    warnings: list[str] = []
    logo_pt = (tournament.card.logo_size or 0) * INCH
    if logo_pt and all_parts[0].logo.w < logo_pt - 0.5:
        warnings.append(
            f"logo_size {tournament.card.logo_size} in is larger than a card has room for: "
            f"it prints at {all_parts[0].logo.w / INCH:.2f} in"
        )
    for page in pages:
        draw_cards(c, page, all_parts, tournament, readers, warnings)
        # Guides last: the QR's white quiet zone would otherwise hide them at the corners.
        _draw_guides(c, tournament, mode, rects)
        c.showPage()
    c.save()
    return sorted(set(warnings))
