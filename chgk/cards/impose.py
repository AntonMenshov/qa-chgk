"""Imposition: which card goes into which slot of which page.

A page is a list of `per_page` slots in reading order (left to right, top to
bottom); an empty slot is None.
"""

from enum import Enum
from math import ceil

from chgk.cards.model import Card, spare_card

Page = list[Card | None]


class Mode(Enum):
    TEAM_PAGES = "team-pages"
    CUT_STACK = "cut-stack"
    SCISSORS = "scissors"


def impose(mode: Mode, decks: list[list[Card]], per_page: int, tid: str = "") -> list[Page]:
    if mode is Mode.CUT_STACK:
        return cut_stack(decks, per_page)
    return team_pages(decks, per_page, tid)


def with_extra_spares(deck: list[Card], extra: int, tid: str) -> list[Card]:
    """The deck followed by `extra` more spares, numbered after its own."""
    if not extra:
        return list(deck)
    next_spare = 1 + max((c.id.spare for c in deck if c.is_spare), default=0)
    return list(deck) + [spare_card(tid, deck[0].team, next_spare + i) for i in range(extra)]


def team_pages(decks: list[list[Card]], per_page: int, tid: str) -> list[Page]:
    """Each page holds one team's cards in order.

    Empty slots on a team's last page become extra spares, numbered after the team's own
    spares (user rule: at least the configured spares, more when they fit without a page).
    """
    pages: list[Page] = []
    for deck in decks:
        if not deck:
            continue
        cards = with_extra_spares(deck, -len(deck) % per_page, tid)
        pages += [cards[i : i + per_page] for i in range(0, len(cards), per_page)]
    return pages


def cut_stack(decks: list[list[Card]], per_page: int) -> list[Page]:
    """For a guillotine: one cut through the stack gives every team's deck in order.

    Stack the printed sheets in print order, cut once, then put the slot piles on top of
    each other in slot order (slot 1 on top). The result is every team's deck, in order,
    one after another.

    Card i of the overall sequence goes to page i mod P, slot i div P, so the pile
    for slot s holds cards s·P … s·P + P − 1.

    The empty slots of the last pages become extra spares, shared out across the decks
    (the first decks get one more when they don't divide evenly), so no page is added
    and no slot is left empty (user rule).
    """
    decks = [deck for deck in decks if deck]
    total = sum(len(deck) for deck in decks)
    if not total:
        return []
    n_pages = ceil(total / per_page)
    free = n_pages * per_page - total
    decks = [
        with_extra_spares(deck, free // len(decks) + (k < free % len(decks)), deck[0].id.tid)
        for k, deck in enumerate(decks)
    ]
    sequence = [card for deck in decks for card in deck]
    pages: list[Page] = [[None] * per_page for _ in range(n_pages)]
    for i, card in enumerate(sequence):
        pages[i % n_pages][i // n_pages] = card
    return pages


def stack_and_cut(pages: list[Page]) -> list[Card]:
    """Simulate the guillotine workflow for `cut_stack` (used by tests and as a self-check)."""
    per_page = len(pages[0]) if pages else 0
    piles = [[page[s] for page in pages] for s in range(per_page)]
    return [card for pile in piles for card in pile if card is not None]
