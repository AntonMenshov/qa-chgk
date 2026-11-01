"""Tournament configuration, written by the organiser as `tournaments/<slug>/config.py`."""

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum
from functools import cached_property
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from chgk import run_python_file
from chgk.cards.geometry import INCH, GeometryError, card_parts, card_rects
from chgk.ids import MAX_QUESTION, MAX_SPARE, TID_RE

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class ConfigError(ValueError):
    """The tournament config is invalid."""


def check_logo_grey(value: float) -> None:
    if not 0 < value <= 0.5:
        raise ConfigError(f"logo_grey must be in (0, 0.5], got {value}")


class LogoMode(Enum):
    NONE = "none"
    TEAM = "team"
    TOURNAMENT = "tournament"
    TEAM_ELSE_TOURNAMENT = "team_else_tournament"


EXAMPLE_FOLDER = "example"  # tournaments/example is never run: it would get a state.json of its own
MIN_SPARES = 2  # spare cards per team at the least (user rule)


@dataclass(frozen=True)
class CardFields:
    """Optional fields printed on each card."""

    team_name: bool = True
    tournament_name: bool = True
    date: bool = False  # off unless asked for (user rule)
    logo: LogoMode = LogoMode.NONE
    tournament_logo: str | None = None  # file name: tournament folder first, then the logos/ library
    fallback_logo: str | None = "nologo.png"  # for cards that would otherwise have no logo
    logo_size: float | None = None  # inches; None fits the writing area, a number up to the card's shorter inner side
    logo_grey: float = 0.14  # ink of the logo's dark parts: 0 = white, 1 = black (user's choice)
    no_qr: bool = False  # True: no QR code (a paper-only game, no scanning); its corner stays empty

    def __post_init__(self) -> None:
        if self.logo_size is not None and not 0.2 <= self.logo_size <= 8:
            raise ConfigError(f"logo_size must be 0.2–8 in, got {self.logo_size}")
        check_logo_grey(self.logo_grey)
        if self.no_qr and not self.team_name:
            raise ConfigError("no_qr with team_name=False: nothing on a card would tell whose it is")
        if not isinstance(self.logo, LogoMode):
            raise ConfigError(f"logo must be a LogoMode, e.g. LogoMode.TEAM, got {self.logo!r}")
        if self.logo is LogoMode.TOURNAMENT and not self.tournament_logo:
            raise ConfigError("logo=TOURNAMENT needs tournament_logo")


# One row covers the test page, one column has room for one sample; past the maximum, too small to write on.
MAX_ROUNDS, MAX_ROUND_SIZE = 20, 100
MIN_COLS, MAX_COLS = 2, 4
MIN_ROWS, MAX_ROWS = 2, 6


def _whole(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


@dataclass(frozen=True)
class Layout:
    """Card grid on a Letter page. Sizes are in inches."""

    cols: int = 3
    rows: int = 4
    qr_size: float = 0.85  # including the quiet zone
    margin: float = 0.25

    def __post_init__(self) -> None:
        if not (
            _whole(self.cols)
            and _whole(self.rows)
            and MIN_COLS <= self.cols <= MAX_COLS
            and MIN_ROWS <= self.rows <= MAX_ROWS
        ):
            raise ConfigError(
                f"grid must be {MIN_COLS}–{MAX_COLS} columns × {MIN_ROWS}–{MAX_ROWS} rows, got {self.cols}×{self.rows}"
            )
        if not 0.4 <= self.qr_size <= 2.0:
            raise ConfigError(f"qr_size must be 0.4–2.0 in, got {self.qr_size}")
        if not 0 <= self.margin <= 1:
            raise ConfigError(f"margin must be 0–1 in, got {self.margin}")

    @property
    def per_page(self) -> int:
        return self.cols * self.rows


@dataclass(frozen=True)
class Tournament:
    slug: str
    name: str
    date: date
    rounds: int
    questions_per_round: int | list[int]
    scanner_url: str  # e.g. "https://<user>.github.io/qa-chgk/s/"
    spares_per_team: int = 2  # at least 2 (user rule); empty slots add more, never a page
    # Full decks R1, R2, … (no name, generic logo) for teams that turn up unregistered.
    reserve_teams: int = 2
    # Projector board: up to this many teams it shows the full grid of every round;
    # with more, the total plus the last round's grid.
    board_grid_max_teams: int = 5
    # The tournament ID printed in every card's QR code: None generates one (5 readable
    # characters); or give your own, e.g. the rating.chgk.info tournament number (1-8 digits
    # or capital Latin letters). Set it before the first `chgk cards`, `test-page` or `new`:
    # from then on state.json keeps the ID.
    tid: str | None = None  # a number is accepted too, and kept as text
    card: CardFields = field(default_factory=CardFields)
    layout: Layout = field(default_factory=Layout)

    def __post_init__(self) -> None:
        if self.tid is not None:
            tid = str(self.tid).strip().upper()
            if not TID_RE.fullmatch(tid):
                raise ConfigError(f"tid must be 1-8 digits or Latin letters, e.g. 11234 or OSEN26, got {self.tid!r}")
            object.__setattr__(self, "tid", tid)
        if not SLUG_RE.fullmatch(self.slug):
            raise ConfigError(f"slug must be lowercase letters, digits and dashes, got {self.slug!r}")
        if not self.name.strip():
            raise ConfigError("name must not be empty")
        for name in ("rounds", "spares_per_team", "reserve_teams", "board_grid_max_teams"):
            value = getattr(self, name)
            if not _whole(value):
                raise ConfigError(f"{name} must be a whole number, got {value!r}")
        if not isinstance(self.date, date) or isinstance(self.date, datetime):
            raise ConfigError(f"date must be a date, e.g. date(2026, 11, 15), got {self.date!r}")
        if not 1 <= self.rounds <= MAX_ROUNDS:  # the backend's limits: found now, not after printing
            raise ConfigError(f"rounds must be 1–{MAX_ROUNDS}, got {self.rounds}")
        per_round = self.round_sizes
        if len(per_round) != self.rounds:
            raise ConfigError(f"questions_per_round lists {len(per_round)} rounds, but rounds={self.rounds}")
        if not all(_whole(k) and 1 <= k <= MAX_ROUND_SIZE for k in per_round):
            raise ConfigError(f"every round needs 1–{MAX_ROUND_SIZE} questions, got {per_round}")
        if self.total_questions > MAX_QUESTION:
            raise ConfigError(f"at most {MAX_QUESTION} questions fit in a card's QR code, got {self.total_questions}")
        if self.spares_per_team < MIN_SPARES:
            raise ConfigError(f"spares_per_team must be ≥ {MIN_SPARES}, got {self.spares_per_team}")
        # Empty slots on a team's last page add up to per_page − 1 more spares; all must fit S1–S99.
        most = MAX_SPARE - (self.layout.per_page - 1)
        if self.spares_per_team > most:
            raise ConfigError(
                f"spares_per_team must be ≤ {most} with {self.layout.per_page} cards per page "
                f"(spare cards are numbered S1–S{MAX_SPARE}), got {self.spares_per_team}"
            )
        if not 0 <= self.reserve_teams <= 9:
            raise ConfigError(f"reserve_teams must be 0–9, got {self.reserve_teams}")
        if not 0 <= self.board_grid_max_teams <= 100:
            raise ConfigError(f"board_grid_max_teams must be 0–100, got {self.board_grid_max_teams}")
        # A large QR code or margin can still leave no room: said now, not at the first printing.
        card = card_rects(self.layout)[0]
        try:
            card_parts(card, self.layout.qr_size * INCH, None, self.card.no_qr)
        except GeometryError as err:
            raise ConfigError(str(err)) from err
        url = urlparse(self.scanner_url)
        if url.scheme != "https" or not url.hostname or url.fragment or url.query or not url.path.endswith("/s/"):
            # /s/: the board's page is found beside it, at ../b/.
            raise ConfigError(f"scanner_url must look like https://<host>/…/s/, got {self.scanner_url!r}")

    @cached_property
    def round_sizes(self) -> list[int]:
        if isinstance(self.questions_per_round, int):
            return [self.questions_per_round] * self.rounds
        return list(self.questions_per_round)

    @property
    def total_questions(self) -> int:
        return sum(self.round_sizes)

    def round_of(self, question: int) -> int:
        """Round (1-based) of a continuously numbered question."""
        if not 1 <= question <= self.total_questions:
            raise ValueError(f"question {question} is outside 1–{self.total_questions}")
        last = 0
        for round_no, size in enumerate(self.round_sizes, start=1):
            last += size
            if question <= last:
                return round_no
        raise AssertionError("unreachable")


def load_config(folder: Path) -> Tournament:
    """Execute `<folder>/config.py` and return its `tournament` object."""
    path = Path(folder) / "config.py"
    if not path.is_file():
        raise ConfigError(f"no config.py in {folder}")
    tournament = run_python_file(path).get("tournament")
    if not isinstance(tournament, Tournament):
        raise ConfigError(f"{path} must define `tournament = Tournament(...)`")
    name = Path(folder).resolve().name
    if name == EXAMPLE_FOLDER:
        raise ConfigError(f"{path} is only a reference: copy its config.py and teams.py into a new folder")
    if tournament.slug != name:
        # A copied config that keeps the old slug would write into the other tournament's out/<slug>/.
        raise ConfigError(
            f"{path}: slug={tournament.slug!r} but the folder is {name!r}; they must be the same "
            "(the slug names out/<slug>/): change slug or rename the folder"
        )
    return tournament
