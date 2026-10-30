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


def team_pages(decks: list[list[Card]], per_page: int, tid: str) -> list[Page]:
    """Each page holds one team's cards in order. Empty slots on a team's last page
    become extra spares, numbered after the team's own spares."""
    pages: list[Page] = []
    for deck in decks:
        if not deck:
            continue
        cards = list(deck)
        free = -len(cards) % per_page
        if free:
            team = cards[0].team
            next_spare = 1 + max((c.id.spare for c in cards if c.is_spare), default=0)
            cards += [spare_card(tid, team, next_spare + i) for i in range(free)]
        pages += [cards[i : i + per_page] for i in range(0, len(cards), per_page)]
    return pages


def cut_stack(decks: list[list[Card]], per_page: int) -> list[Page]:
    """For a guillotine: stack the printed sheets in print order, cut once, then put
    the slot piles on top of each other in slot order (slot 1 on top). The result is
    every team's deck, in order, one after another.

    Card i of the overall sequence goes to page i mod P, slot i div P, so the pile
    for slot s holds cards s·P … s·P + P − 1.
    """
    sequence = [card for deck in decks for card in deck]
    if not sequence:
        return []
    n_pages = ceil(len(sequence) / per_page)
    pages: list[Page] = [[None] * per_page for _ in range(n_pages)]
    for i, card in enumerate(sequence):
        pages[i % n_pages][i // n_pages] = card
    return pages


def stack_and_cut(pages: list[Page]) -> list[Card]:
    """Simulate the guillotine workflow for `cut_stack` (used by tests and as a self-check)."""
    per_page = len(pages[0]) if pages else 0
    piles = [[page[s] for page in pages] for s in range(per_page)]
    return [card for pile in piles for card in pile if card is not None]
