"""From a tournament folder to a printable PDF."""

from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from chgk.cards.impose import Mode, impose
from chgk.cards.model import team_deck
from chgk.cards.render import render_cards
from chgk.cards.testpage import render_test_page
from chgk.config import LogoMode, Tournament, load_config
from chgk.jury import render_jury_sheet
from chgk.logos import FALLBACK_KEY, LOGO_LIBRARY, MAX_SIDE, TOURNAMENT_KEY, load_pale_logo, resolve_logo
from chgk.state import load_or_create_state
from chgk.teams import Team, load_teams_csv, reserve_teams

TEAMS_FILE = "teams.csv"

INSTRUCTIONS = {
    Mode.TEAM_PAGES: "Each page holds one team's cards. Cut each page along the grey lines.",
    Mode.SCISSORS: "Each page holds one team's cards. Cut along the dashed lines; neighbouring cards share a line.",
    Mode.CUT_STACK: (
        "Keep the sheets in print order (page 1 on top), align them and cut the whole stack "
        "along the grey lines. Then put the piles together in reading order: top-left pile "
        "on top, then the next pile to its right, and so on row by row. The result is every "
        "team's deck in order, one team after another."
    ),
}


def _load_logos(folder: Path, tournament: Tournament, teams: list[Team]) -> tuple[dict[str, Path], list[str]]:
    """Logo files to use, keyed by team_id / TOURNAMENT_KEY / FALLBACK_KEY. A file that
    can't be found is a warning, not an error: the card falls back to the next logo."""
    fields = tournament.card
    found: dict[str, Path] = {}
    warnings: list[str] = []
    if fields.logo is LogoMode.NONE:
        return found, warnings

    def find(name: str, key: str, what: str) -> None:
        path = resolve_logo(name, folder)
        if path is None:
            warnings.append(f"{what}: logo {name!r} not found in {folder} or {LOGO_LIBRARY}; using the next fallback")
        else:
            found[key] = path

    if fields.logo in (LogoMode.TEAM, LogoMode.TEAM_ELSE_TOURNAMENT):
        for t in teams:
            if t.logo_file:
                find(t.logo_file, t.team_id, f"team {t.team_id}")
    if fields.logo in (LogoMode.TOURNAMENT, LogoMode.TEAM_ELSE_TOURNAMENT) and fields.tournament_logo:
        find(fields.tournament_logo, TOURNAMENT_KEY, "tournament")
    if fields.fallback_logo:
        find(fields.fallback_logo, FALLBACK_KEY, "fallback")
    return found, warnings


def _pale_logos(files: dict[str, Path], grey: float) -> dict[str, Image.Image]:
    return {key: load_pale_logo(path, grey) for key, path in files.items()}


@dataclass(frozen=True)
class BuildResult:
    path: Path
    jury_path: Path
    teams: int  # the organiser's teams printed
    reserve: int  # reserve decks printed (R1, R2, …)
    cards: int
    pages: int
    warnings: list[str]


def load_teams(folder: Path, tournament: Tournament) -> list[Team]:
    """The organiser's teams from teams.csv, then the reserve teams R1, R2, …"""
    teams = load_teams_csv(Path(folder) / TEAMS_FILE)
    return teams + reserve_teams(tournament.reserve_teams, teams)


def build_cards(folder: Path, mode: Mode, out: Path | None = None, team_ids: list[str] | None = None) -> BuildResult:
    folder = Path(folder)
    tournament = load_config(folder)
    teams = load_teams(folder, tournament)
    all_teams = teams
    if team_ids:
        unknown = set(team_ids) - {t.team_id for t in teams}
        if unknown:
            raise ValueError(f"unknown team_id(s): {', '.join(sorted(unknown))}")
        teams = [t for t in teams if t.team_id in team_ids]
    state = load_or_create_state(folder)
    logo_files, logo_warnings = _load_logos(folder, tournament, teams)
    decks = [team_deck(tournament, state.tid, team) for team in teams]
    pages = impose(mode, decks, tournament.layout.per_page, state.tid)
    if out:
        out = Path(out)
        jury_out = out.with_name(f"{out.stem}-jury.pdf")
    else:
        out = Path("out") / tournament.slug / f"cards-{mode.value}.pdf"
        jury_out = out.with_name("jury.pdf")
    logos = _pale_logos(logo_files, tournament.card.logo_grey)
    warnings = logo_warnings + render_cards(pages, tournament, mode, out, logos)
    warnings += render_jury_sheet(tournament, state, all_teams, jury_out)
    n_cards = sum(1 for page in pages for card in page if card is not None)
    n_reserve = sum(1 for t in teams if t.reserve)
    return BuildResult(out, jury_out, len(teams) - n_reserve, n_reserve, n_cards, len(pages), sorted(set(warnings)))


def build_jury_sheet(folder: Path, out: Path | None = None) -> tuple[Path, list[str]]:
    """Jury sheet on its own (also written by build_cards)."""
    folder = Path(folder)
    tournament = load_config(folder)
    teams = load_teams(folder, tournament)
    state = load_or_create_state(folder)
    out = Path(out) if out else Path("out") / tournament.slug / "jury.pdf"
    return out, render_jury_sheet(tournament, state, teams, out)


def build_test_page(folder: Path, out: Path | None = None) -> Path:
    """Calibration page using the tournament's first team (prefer one with a logo)."""
    folder = Path(folder)
    tournament = load_config(folder)
    teams = load_teams_csv(folder / TEAMS_FILE)  # a registered team: the page shows a real one
    state = load_or_create_state(folder)
    logo_files, _ = _load_logos(folder, tournament, teams)
    team = next((t for t in teams if t.team_id in logo_files), teams[0])
    source_path = next((logo_files[k] for k in (team.team_id, TOURNAMENT_KEY, FALLBACK_KEY) if k in logo_files), None)
    source = None
    if source_path is not None:
        with Image.open(source_path) as image:
            image.thumbnail((MAX_SIDE, MAX_SIDE))
            source = image.copy()

    out = Path(out) if out else Path("out") / tournament.slug / "test-page.pdf"
    render_test_page(tournament, state.tid, team, out, source, _pale_logos(logo_files, tournament.card.logo_grey))
    return out
