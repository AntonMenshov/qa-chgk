"""Where things go on the page. All values in PDF points (1/72 in), origin bottom-left."""

from dataclasses import dataclass

from chgk.config import Layout

INCH = 72.0
PAGE_W, PAGE_H = 8.5 * INCH, 11 * INCH  # Letter

PAD = 0.07 * INCH  # inner padding of a card
NUMBER_SIZE = 26  # pt, question number
ROUND_SIZE = 8  # pt, «Тур N»
TEAM_SIZE = 8  # pt, footer line 1
INFO_SIZE = 6.5  # pt, footer line 2
FOOTER_H = TEAM_SIZE + INFO_SIZE + 4
MIN_WRITING_H = 0.35 * INCH


class GeometryError(ValueError):
    """The grid leaves no usable room on the card."""


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    w: float
    h: float

    @property
    def right(self) -> float:
        return self.x + self.w

    @property
    def top(self) -> float:
        return self.y + self.h

    def intersects(self, other: "Rect") -> bool:
        return self.x < other.right and other.x < self.right and self.y < other.top and other.y < self.top

    def contains(self, other: "Rect", tol: float = 1e-6) -> bool:
        return (
            other.x >= self.x - tol
            and other.y >= self.y - tol
            and other.right <= self.right + tol
            and other.top <= self.top + tol
        )


@dataclass(frozen=True)
class CardParts:
    card: Rect
    qr: Rect  # includes the quiet zone
    number: Rect  # question number + «Тур N», left of the QR
    writing: Rect  # free area for the answer; the logo watermark sits here
    logo: Rect  # square, centred in the writing area
    footer: Rect  # team name / tournament · date

    @property
    def team_baseline(self) -> float:
        return self.footer.y + INFO_SIZE + 3

    @property
    def info_baseline(self) -> float:
        return self.footer.y + 1


def printable_area(layout: Layout) -> Rect:
    m = layout.margin * INCH
    return Rect(m, m, PAGE_W - 2 * m, PAGE_H - 2 * m)


def card_rects(layout: Layout) -> list[Rect]:
    """Card rectangles in reading order: left to right, top to bottom. Neighbouring
    cards share an edge, so every cut separates two cards and no paper is wasted."""
    area = printable_area(layout)
    w = area.w / layout.cols
    h = area.h / layout.rows
    return [
        Rect(area.x + col * w, area.top - (row + 1) * h, w, h)
        for row in range(layout.rows)
        for col in range(layout.cols)
    ]


def card_parts(card: Rect, qr_size: float) -> CardParts:
    """Split one card into its parts. `qr_size` in points, including the quiet zone.

    The QR's own quiet zone provides its margin, so it sits in the corner without padding.
    """
    qr = Rect(card.right - qr_size, card.top - qr_size, qr_size, qr_size)
    number_h = NUMBER_SIZE + ROUND_SIZE + 5
    number = Rect(card.x + PAD, card.top - PAD - number_h, qr.x - card.x - 2 * PAD, number_h)
    footer = Rect(card.x + PAD, card.y + PAD, card.w - 2 * PAD, FOOTER_H)
    writing_top = min(qr.y, number.y)
    writing = Rect(card.x + PAD, footer.top, card.w - 2 * PAD, writing_top - footer.top)
    if number.w < 0.45 * INCH or writing.h < MIN_WRITING_H:
        raise GeometryError(
            f"card {card.w / INCH:.2f}×{card.h / INCH:.2f} in is too small for a {qr_size / INCH:.2f} in QR code"
        )
    side = min(writing.w, writing.h) * 0.92
    logo = Rect(writing.x + (writing.w - side) / 2, writing.y + (writing.h - side) / 2, side, side)
    return CardParts(card, qr, number, writing, logo, footer)
