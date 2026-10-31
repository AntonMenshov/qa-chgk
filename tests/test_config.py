from dataclasses import replace
from datetime import date, datetime

import pytest

from chgk import PROJECT_DIR
from chgk.config import CardFields, ConfigError, Layout, LogoMode, Tournament, load_config


def make(**overrides) -> Tournament:
    base = {
        "slug": "autumn-cup",
        "name": "Осенний кубок",
        "date": date(2026, 11, 15),
        "rounds": 3,
        "questions_per_round": 12,
        "scanner_url": "https://example.github.io/qa-chgk/s/",
    }
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
    assert t.spares_per_team == 2
    assert t.reserve_teams == 2  # decks for teams that turn up unregistered
    assert t.board_grid_max_teams == 5  # user: full grid on the board up to 5 teams
    assert (t.layout.cols, t.layout.rows, t.layout.per_page) == (3, 4, 12)
    assert t.layout.qr_size == 0.85
    assert t.card.logo_grey == 0.14
    assert t.card.logo is LogoMode.NONE


@pytest.mark.parametrize(
    "overrides",
    [
        {"slug": "Bad Slug"},
        {"name": "  "},
        {"rounds": 0},
        {"questions_per_round": [12, 12]},
        {"questions_per_round": [12, 0, 12]},
        {"spares_per_team": -1},
        {"reserve_teams": -1},
        {"reserve_teams": 10},
        {"board_grid_max_teams": -1},
        {"scanner_url": "http://example.com/s/"},
        {"scanner_url": "https://example.com/s"},
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


def test_at_least_two_spares():
    assert make(spares_per_team=2).spares_per_team == 2
    for few in (0, 1):
        with pytest.raises(ConfigError, match="spares_per_team must be ≥ 2"):
            make(spares_per_team=few)


def test_every_card_fits_its_qr_payload():
    """Questions 1–999 and spares S1–S99, counting the extra spares a last page can add."""
    assert make(rounds=9, questions_per_round=111).total_questions == 999
    with pytest.raises(ConfigError, match="at most 999 questions"):
        make(rounds=10, questions_per_round=100)
    grid = Layout(cols=3, rows=4)  # 12 per page: up to 11 extra spares
    assert make(spares_per_team=88, layout=grid).spares_per_team == 88
    with pytest.raises(ConfigError, match="spares_per_team must be ≤ 88 with 12 cards per page"):
        make(spares_per_team=89, layout=grid)


def write_config(folder, slug):
    folder.mkdir(exist_ok=True)
    (folder / "config.py").write_text(
        "from datetime import date\n"
        "from chgk.config import Tournament\n"
        f"tournament = Tournament(slug={slug!r}, name='X', date=date(2026, 1, 1), rounds=2,\n"
        "    questions_per_round=[3, 4], scanner_url='https://e.github.io/qa-chgk/s/')\n",
        encoding="utf-8",
    )


def test_load_config(tmp_path):
    write_config(tmp_path / "x", "x")
    assert load_config(tmp_path / "x").total_questions == 7


def test_slug_must_match_the_folder(tmp_path):
    """A copied config that keeps the old slug would write into the other tournament's out/<slug>/."""
    write_config(tmp_path / "autumn-cup", "example")
    with pytest.raises(ConfigError, match=r"slug='example' but the folder is 'autumn-cup'"):
        load_config(tmp_path / "autumn-cup")


def test_the_example_is_only_a_reference():
    with pytest.raises(ConfigError, match="only a reference"):
        load_config(PROJECT_DIR / "tournaments" / "example")


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


@pytest.mark.parametrize(
    "given,tid", [(None, None), ("11234", "11234"), (11234, "11234"), (" osen26 ", "OSEN26"), ("ABCD1234", "ABCD1234")]
)
def test_tid_from_config(given, tid):
    """The tournament ID may come from config.py, e.g. the rating.chgk.info number; else it is generated."""
    assert make(tid=given).tid == tid


@pytest.mark.parametrize("given", ["", "ABCDE1234", "K7-2Q", "Осень", "A B"])
def test_invalid_tid(given):
    with pytest.raises(ConfigError, match="tid must be 1-8 digits or Latin letters"):
        make(tid=given)


def test_date_must_be_a_date():
    for bad in ("2026-11-15", datetime(2026, 11, 15)):
        with pytest.raises(ConfigError, match="date must be a date"):
            Tournament(
                slug="t", name="T", date=bad, rounds=1, questions_per_round=12, scanner_url="https://x.github.io/s/"
            )


def test_logo_mode_must_be_a_logomode():
    with pytest.raises(ConfigError, match="logo must be a LogoMode"):
        CardFields(logo="none")


def test_a_trailing_newline_is_no_part_of_a_slug():
    with pytest.raises(ConfigError, match="slug"):
        Tournament(
            slug="t\n",
            name="T",
            date=date(2026, 11, 15),
            rounds=1,
            questions_per_round=12,
            scanner_url="https://x.github.io/s/",
        )
