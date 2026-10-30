from collections import Counter
from datetime import date
from itertools import product

import pytest

from chgk.cards.impose import Mode, Page, cut_stack, impose, team_pages
from chgk.cards.model import Card, team_deck
from chgk.config import Tournament
from chgk.teams import Team

TID = "K7M2Q"


def stack_and_cut(pages: list[Page]) -> list[Card]:
    """Simulate the guillotine workflow for `cut_stack`: stack the sheets, cut once, piles in slot order."""
    per_page = len(pages[0]) if pages else 0
    piles = [[page[s] for page in pages] for s in range(per_page)]
    return [card for pile in piles for card in pile if card is not None]


def tournament(questions: list[int], spares: int) -> Tournament:
    return Tournament(
        slug="t",
        name="T",
        date=date(2026, 1, 1),
        rounds=len(questions),
        questions_per_round=questions,
        scanner_url="https://e.github.io/qa-chgk/s/",
        spares_per_team=spares,
    )


def decks(n_teams: int, questions: list[int], spares: int):
    t = tournament(questions, spares)
    teams = [Team(f"A{i + 1:02d}", f"Команда {i + 1}") for i in range(n_teams)]
    return [team_deck(t, TID, team) for team in teams]


def test_team_deck_order_and_rounds():
    deck = decks(1, [2, 3], 2)[0]
    assert [c.id.fragment for c in deck] == [f"{TID}.A01.{x}" for x in ("1", "2", "3", "4", "5", "S1", "S2")]
    assert [c.round for c in deck] == [1, 1, 2, 2, 2, None, None]


COMBOS = list(product([1, 2, 7], [[1], [12, 12, 12], [12, 12, 15], [15] * 8], [2, 3], [1, 8, 15]))


@pytest.mark.parametrize("n_teams,questions,spares,per_page", COMBOS)
def test_cut_stack_properties(n_teams, questions, spares, per_page):
    ds = decks(n_teams, questions, spares)
    own = [c for d in ds for c in d]
    pages = cut_stack(ds, per_page)

    assert all(len(p) == per_page for p in pages)
    assert len(pages) == -(-len(own) // per_page)  # ceil: extra spares never add a page
    assert all(None not in p for p in pages)  # every free slot became an extra spare
    placed = [c for p in pages for c in p]
    assert Counter(c for c in placed if c in set(own)) == Counter(own)  # every own card exactly once
    # The guillotine workflow yields each team's deck, then its extra spares, team after team.
    stacked = stack_and_cut(pages)
    extras = []
    for deck in ds:
        assert stacked[: len(deck)] == deck
        stacked = stacked[len(deck) :]
        more = [c for c in stacked[: per_page * len(pages)] if c.team == deck[0].team]
        n = len(more)
        assert stacked[:n] == more and all(c.is_spare for c in more)
        assert [c.id.spare for c in more] == list(range(spares + 1, spares + n + 1))  # numbered after the deck's own
        stacked = stacked[n:]
        extras.append(n)
    assert stacked == []
    assert max(extras) - min(extras) <= 1  # shared out evenly, the first decks first
    assert extras == sorted(extras, reverse=True)


@pytest.mark.parametrize("n_teams,questions,spares,per_page", COMBOS)
def test_team_pages_properties(n_teams, questions, spares, per_page):
    ds = decks(n_teams, questions, spares)
    pages = team_pages(ds, per_page)

    assert all(len(p) == per_page and None not in p for p in pages)  # free slots filled
    assert all(len({c.team for c in p}) == 1 for p in pages)  # one team per page
    per_team_pages = -(-len(ds[0]) // per_page)
    assert len(pages) == n_teams * per_team_pages

    for deck in ds:
        team = deck[0].team
        printed = [c for p in pages for c in p if c.team == team]
        assert printed[: len(deck)] == deck  # own cards first, in order
        extras = printed[len(deck) :]
        assert all(c.is_spare for c in extras)
        assert [c.id.spare for c in printed if c.is_spare] == list(range(1, spares + len(extras) + 1))


def test_impose_dispatch():
    ds = decks(2, [3], 2)
    assert impose(Mode.CUT_STACK, ds, 15) == cut_stack(ds, 15)
    assert impose(Mode.TEAM_PAGES, ds, 15) == team_pages(ds, 15)
    assert impose(Mode.SCISSORS, ds, 15) == team_pages(ds, 15)


def test_empty_input():
    assert cut_stack([], 15) == []
    assert team_pages([], 15) == []
