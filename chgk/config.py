"""Tournament configuration, written by the organiser as `tournaments/<slug>/config.py`."""

import importlib.util
import re
from dataclasses import dataclass, field
from datetime import date
from enum import Enum
from pathlib import Path

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class ConfigError(ValueError):
    """The tournament config is invalid."""


class LogoMode(Enum):
    NONE = "none"
    TEAM = "team"
    TOURNAMENT = "tournament"
    TEAM_ELSE_TOURNAMENT = "team_else_tournament"


MIN_SPARES = 2  # spare cards per team at the least (user rule, 2026-10-30)


@dataclass(frozen=True)
class CardFields:
    """Optional fields printed on each card."""

    team_name: bool = True
    tournament_name: bool = True
    date: bool = False  # off unless asked for (user: no date on the cards)
    logo: LogoMode = LogoMode.NONE
    tournament_logo: str | None = None  # file name: tournament folder first, then the logos/ library
    fallback_logo: str | None = "nologo.png"  # for cards that would otherwise have no logo
    logo_size: float | None = None  # inches; None fits the writing area, a number allows up to the full card height
    logo_grey: float = 0.12  # ink of the logo's dark parts: 0 = white, 1 = black (user's choice, 2026-10-29)

    def __post_init__(self) -> None:
        if self.logo_size is not None and not 0.2 <= self.logo_size <= 8:
            raise ConfigError(f"logo_size must be 0.2–8 in, got {self.logo_size}")
        if not 0 < self.logo_grey <= 0.5:
            raise ConfigError(f"logo_grey must be in (0, 0.5], got {self.logo_grey}")
        if self.logo is LogoMode.TOURNAMENT and not self.tournament_logo:
            raise ConfigError("logo=TOURNAMENT needs tournament_logo")


@dataclass(frozen=True)
class Layout:
    """Card grid on a Letter page. Sizes are in inches."""

    cols: int = 3
    rows: int = 5
    qr_size: float = 0.65  # including the quiet zone
    margin: float = 0.25

    def __post_init__(self) -> None:
        if self.cols < 1 or self.rows < 1:
            raise ConfigError(f"grid must be at least 1×1, got {self.cols}×{self.rows}")
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
    card: CardFields = field(default_factory=CardFields)
    layout: Layout = field(default_factory=Layout)

    def __post_init__(self) -> None:
        if not SLUG_RE.match(self.slug):
            raise ConfigError(f"slug must be lowercase letters, digits and dashes, got {self.slug!r}")
        if not self.name.strip():
            raise ConfigError("name must not be empty")
        if self.rounds < 1:
            raise ConfigError(f"rounds must be ≥ 1, got {self.rounds}")
        per_round = self.round_sizes
        if len(per_round) != self.rounds:
            raise ConfigError(f"questions_per_round lists {len(per_round)} rounds, but rounds={self.rounds}")
        if any(k < 1 for k in per_round):
            raise ConfigError(f"every round needs ≥ 1 question, got {per_round}")
        if self.spares_per_team < MIN_SPARES:
            raise ConfigError(f"spares_per_team must be ≥ {MIN_SPARES}, got {self.spares_per_team}")
        if not 0 <= self.reserve_teams <= 9:
            raise ConfigError(f"reserve_teams must be 0–9, got {self.reserve_teams}")
        if not 0 <= self.board_grid_max_teams <= 100:
            raise ConfigError(f"board_grid_max_teams must be 0–100, got {self.board_grid_max_teams}")
        if not self.scanner_url.startswith("https://") or not self.scanner_url.endswith("/"):
            raise ConfigError(f"scanner_url must start with https:// and end with /, got {self.scanner_url!r}")

    @property
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
    spec = importlib.util.spec_from_file_location(f"chgk_tournament_{path.parent.name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    tournament = getattr(module, "tournament", None)
    if not isinstance(tournament, Tournament):
        raise ConfigError(f"{path} must define `tournament = Tournament(...)`")
    return tournament
