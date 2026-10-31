from itertools import combinations, product

import pytest

from chgk.cards.geometry import (
    INCH,
    PAGE_H,
    PAGE_W,
    GeometryError,
    Rect,
    card_parts,
    card_rects,
    printable_area,
)
from chgk.config import Layout

GRIDS = [(3, 5), (2, 4), (2, 3), (1, 1), (3, 4), (2, 5)]


@pytest.mark.parametrize("grid", GRIDS)
def test_cards_tile_the_printable_area_without_gaps(grid):
    layout = Layout(cols=grid[0], rows=grid[1])
    area = printable_area(layout)
    rects = card_rects(layout)
    assert len(rects) == layout.per_page
    assert all(area.contains(r) for r in rects)
    assert not any(a.intersects(b) for a, b in combinations(rects, 2))
    assert sum(r.w * r.h for r in rects) == pytest.approx(area.w * area.h)  # no wasted paper


def test_default_card_size_and_reading_order():
    rects = card_rects(Layout())
    assert rects[0].w == pytest.approx(8.0 / 3 * INCH)
    assert rects[0].h == pytest.approx(10.5 / 4 * INCH)
    # first card is top-left, second is to its right, fourth starts the next row
    assert rects[0].x < rects[1].x and rects[0].y == rects[1].y
    assert rects[3].x == rects[0].x and rects[3].y < rects[0].y


def test_margin_respected():
    area = printable_area(Layout(margin=0.25))
    assert (area.x, area.y, area.right, area.top) == pytest.approx((18, 18, PAGE_W - 18, PAGE_H - 18))


@pytest.mark.parametrize("grid,qr_in", list(product(GRIDS, [0.55, 0.65, 0.8])))
def test_card_parts_fit_and_do_not_overlap(grid, qr_in):
    for card in card_rects(Layout(cols=grid[0], rows=grid[1])):
        parts = card_parts(card, qr_in * INCH)
        assert parts.qr.w == parts.qr.h == pytest.approx(qr_in * INCH)
        # The black modules stand 20% farther from the top and right edges than the quiet zone alone.
        quiet = qr_in * INCH * 4 / 41
        assert card.right - parts.qr.right == pytest.approx(0.2 * quiet)
        assert card.top - parts.qr.top == pytest.approx(0.2 * quiet)
        for part in (parts.qr, parts.number, parts.writing, parts.logo, parts.footer):
            assert card.contains(part)
        named = {"qr": parts.qr, "number": parts.number, "writing": parts.writing, "footer": parts.footer}
        for (na, a), (nb, b) in combinations(named.items(), 2):
            assert not a.intersects(b), f"{na} overlaps {nb}"
        assert parts.writing.contains(parts.logo)
        assert not parts.logo.intersects(parts.qr)


@pytest.mark.parametrize("grid", GRIDS)
@pytest.mark.parametrize("logo_in", [0.5, 1.4, 1.85, 5.0])
def test_sized_logo_is_centred_on_the_card(grid, logo_in):
    for card in card_rects(Layout(cols=grid[0], rows=grid[1])):
        parts = card_parts(card, 0.65 * INCH, logo_in * INCH)
        assert card.contains(parts.logo)
        # Centred on the card, not in the space left of the QR (user request).
        assert parts.logo.x + parts.logo.w / 2 == pytest.approx(card.x + card.w / 2)
        assert parts.logo.y + parts.logo.h / 2 == pytest.approx(card.y + card.h / 2)
        assert parts.logo.w == parts.logo.h <= logo_in * INCH + 1e-6


def test_sized_logo_is_bigger_than_the_default_on_a_3x5_card():
    card = card_rects(Layout(cols=3, rows=5))[0]
    default = card_parts(card, 0.65 * INCH).logo.w
    big = card_parts(card, 0.65 * INCH, 1.85 * INCH).logo.w
    assert big == pytest.approx(1.85 * INCH)
    assert big > 1.7 * default


def test_too_small_card_is_rejected():
    tiny = Rect(0, 0, 1.0 * INCH, 0.9 * INCH)
    with pytest.raises(GeometryError):
        card_parts(tiny, 0.65 * INCH)


def test_rect_helpers():
    a = Rect(0, 0, 10, 10)
    assert a.intersects(Rect(5, 5, 10, 10))
    assert not a.intersects(Rect(10, 0, 5, 5))  # touching edges is not overlap
    assert a.contains(Rect(1, 1, 2, 2))
    assert not a.contains(Rect(9, 9, 2, 2))


def test_a_card_without_a_qr_is_not_too_small_for_it():
    card = Rect(0, 0, 1.33 * INCH, 2.62 * INCH)
    with pytest.raises(GeometryError):
        card_parts(card, 0.85 * INCH)
    assert card_parts(card, 0.85 * INCH, no_qr=True)
