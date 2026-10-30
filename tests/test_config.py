from dataclasses import replace
from datetime import date

import pytest

from chgk.config import CardFields, ConfigError, Layout, LogoMode, Tournament, load_config


def make(**overrides) -> Tournament:
    base = dict(
        slug="autumn-cup",
        name="Осенний кубок",
        date=date(2026, 11, 15),
        rounds=3,
        questions_per_round=12,
        scanner_url="https://example.github.io/qa-chgk/s/",
    )
    return Tournament(**(base | overrides))


def test_uniform_rounds():
    t = make()
    assert t.round_sizes == [12, 12, 12]
    assert t.total_questions == 36
    assert [t.round_of(q) for q in (1, 12, 13, 24, 25, 36)] == [1, 1, 2, 2, 3, 3]


def test_uneven_rounds():
    t = make(questions_per_round=[12, 12, 15])
    assert t.total_questions == 39
    assert t.round_of(24) == 2
    assert t.round_of(25) == 3
    assert t.round_of(39) == 3


def test_single_round_single_question():
    t = make(rounds=1, questions_per_round=1)
    assert t.total_questions == 1
    assert t.round_of(1) == 1


@pytest.mark.parametrize("q", [0, 37, -1])
def test_round_of_out_of_range(q):
    with pytest.raises(ValueError):
        make().round_of(q)


def test_defaults_match_user_choices():
    t = make()
    assert t.spares_per_team == 3
    assert t.reserve_teams == 2  # decks for teams that turn up unregistered
    assert t.board_grid_max_teams == 5  # user: full grid on the board up to 5 teams
    assert (t.layout.cols, t.layout.rows, t.layout.per_page) == (3, 5, 15)
    assert t.layout.qr_size == 0.65
    assert t.card.logo_grey == 0.12
    assert t.card.logo is LogoMode.NONE


@pytest.mark.parametrize(
    "overrides",
    [
        dict(slug="Bad Slug"),
        dict(name="  "),
        dict(rounds=0),
        dict(questions_per_round=[12, 12]),
        dict(questions_per_round=[12, 0, 12]),
        dict(spares_per_team=-1),
        dict(reserve_teams=-1),
        dict(reserve_teams=10),
        dict(board_grid_max_teams=-1),
        dict(scanner_url="http://example.com/s/"),
        dict(scanner_url="https://example.com/s"),
    ],
)
def test_invalid_tournament(overrides):
    with pytest.raises(ConfigError):
        make(**overrides)


@pytest.mark.parametrize(
    "build",
    [
        lambda: Layout(cols=0),
        lambda: Layout(qr_size=0.2),
        lambda: Layout(margin=-0.1),
        lambda: CardFields(logo_grey=0),
        lambda: CardFields(logo_grey=0.9),
        lambda: CardFields(logo=LogoMode.TOURNAMENT),
        lambda: CardFields(logo_size=0.1),
    ],
)
def test_invalid_parts(build):
    with pytest.raises(ConfigError):
        build()


def test_zero_spares_allowed():
    assert make(spares_per_team=0).spares_per_team == 0


def test_load_config(tmp_path):
    (tmp_path / "config.py").write_text(
        "from datetime import date\n"
        "from chgk.config import Tournament\n"
        "tournament = Tournament(slug='x', name='X', date=date(2026, 1, 1), rounds=2,\n"
        "    questions_per_round=[3, 4], scanner_url='https://e.github.io/qa-chgk/s/')\n",
        encoding="utf-8",
    )
    t = load_config(tmp_path)
    assert t.total_questions == 7


def test_load_config_missing_file(tmp_path):
    with pytest.raises(ConfigError):
        load_config(tmp_path)


def test_load_config_without_tournament_variable(tmp_path):
    (tmp_path / "config.py").write_text("x = 1\n")
    with pytest.raises(ConfigError):
        load_config(tmp_path)


def test_config_is_immutable():
    t = make()
    with pytest.raises(AttributeError):
        t.rounds = 5  # type: ignore[misc]
    assert replace(t, rounds=4, questions_per_round=10).total_questions == 40
