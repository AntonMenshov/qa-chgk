"""Imposition: which card goes into which slot of which page.

A page is a list of `per_page` cards in reading order (left to right, top to
bottom). Pages come out full: free slots become spare cards.
"""

from enum import Enum
from math import ceil

from chgk.cards.model import Card, spare_card

Page = list[Card]


class Mode(Enum):
    TEAM_PAGES = "team-pages"
    CUT_STACK = "cut-stack"
    SCISSORS = "scissors"


def impose(mode: Mode, decks: list[list[Card]], per_page: int) -> list[Page]:
    if mode is Mode.CUT_STACK:
        return cut_stack(decks, per_page)
    return team_pages(decks, per_page)


def with_extra_spares(deck: list[Card], extra: int) -> list[Card]:
    """The deck followed by `extra` more spares, numbered after its own."""
    if not extra:
        return list(deck)
    next_spare = 1 + max((c.id.spare or 0 for c in deck), default=0)
    first = deck[0]
    return list(deck) + [spare_card(first.id.tid, first.team, next_spare + i) for i in range(extra)]


def team_pages(decks: list[list[Card]], per_page: int) -> list[Page]:
    """Each page holds one team's cards in order.

    Empty slots on a team's last page become extra spares, numbered after the team's own
    spares (user rule: at least the configured spares, more when they fit without a page).
    """
    pages: list[Page] = []
    for deck in decks:
        cards = with_extra_spares(deck, -len(deck) % per_page)
        pages += [cards[i : i + per_page] for i in range(0, len(cards), per_page)]
    return pages


def cut_stack(decks: list[list[Card]], per_page: int) -> list[Page]:
    """For a guillotine: one cut through the stack gives every team's deck in order.

    Stack the printed sheets in print order, cut once, then put the slot piles on top of
    each other in slot order (slot 1 on top). The result is every team's deck, in order,
    one after another.

    With P pages, card i of the overall sequence goes to page i mod P, slot i div P, so
    the pile for slot s holds cards s·P … s·P + P − 1.

    The empty slots of the last pages become extra spares, shared out across the decks
    (the first decks get one more when they don't divide evenly), so no page is added
    and no slot is left empty (user rule).
    """
    total = sum(len(deck) for deck in decks)
    if not total:
        return []
    n_pages = ceil(total / per_page)
    free = n_pages * per_page - total
    decks = [with_extra_spares(deck, free // len(decks) + (k < free % len(decks))) for k, deck in enumerate(decks)]
    sequence = [card for deck in decks for card in deck]
    return [sequence[p::n_pages] for p in range(n_pages)]
