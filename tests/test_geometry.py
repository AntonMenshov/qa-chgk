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
    assert rects[0].h == pytest.approx(10.5 / 5 * INCH)
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
        for part in (parts.qr, parts.number, parts.writing, parts.logo, parts.footer):
            assert card.contains(part)
        named = {"qr": parts.qr, "number": parts.number, "writing": parts.writing, "footer": parts.footer}
        for (na, a), (nb, b) in combinations(named.items(), 2):
            assert not a.intersects(b), f"{na} overlaps {nb}"
        assert parts.writing.contains(parts.logo)
        assert not parts.logo.intersects(parts.qr)


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
