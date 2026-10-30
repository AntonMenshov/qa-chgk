"""From a tournament folder to a printable PDF."""

from dataclasses import dataclass
from pathlib import Path

from chgk.cards.impose import Mode, impose
from chgk.cards.model import team_deck
from chgk.cards.render import render_cards
from chgk.cards.testpage import render_test_page
from chgk.config import Tournament, load_config
from chgk.jury import render_jury_sheet
from chgk.logos import first_logo, load_logos, pale
from chgk.state import load_or_create_state
from chgk.teams import TEAMS_FILE, Team, read_teams, reserve_teams

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


@dataclass(frozen=True)
class BuildResult:
    path: Path
    jury_path: Path
    teams: int  # the organiser's teams printed
    reserve: int  # reserve decks printed (R1, R2, …)
    cards: int
    pages: int
    warnings: list[str]


def _pale(sources: dict, grey: float) -> dict:
    return {key: pale(image, grey) for key, image in sources.items()}


def load_teams(folder: Path, tournament: Tournament) -> list[Team]:
    """The organiser's teams from teams.py, then the reserve teams R1, R2, and so on."""
    teams = read_teams(Path(folder) / TEAMS_FILE)
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
    sources, logo_warnings = load_logos(folder, tournament.card, teams)
    decks = [team_deck(tournament, state.tid, team) for team in teams]
    pages = impose(mode, decks, tournament.layout.per_page, state.tid)
    if out:
        out = Path(out)
        jury_out = out.with_name(f"{out.stem}-jury.pdf")
    else:
        out = Path("out") / tournament.slug / f"cards-{mode.value}.pdf"
        jury_out = out.with_name("jury.pdf")
    logos = _pale(sources, tournament.card.logo_grey)
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
    """Calibration page for the first registered team with a logo, else the first team."""
    folder = Path(folder)
    tournament = load_config(folder)
    teams = read_teams(folder / TEAMS_FILE)  # a registered team: the page shows a real one
    state = load_or_create_state(folder)
    sources, _ = load_logos(folder, tournament.card, teams)
    team = next((t for t in teams if t.team_id in sources), teams[0])
    key = first_logo(tournament.card, team.team_id, sources)
    out = Path(out) if out else Path("out") / tournament.slug / "test-page.pdf"
    render_test_page(tournament, state.tid, team, out, sources.get(key), _pale(sources, tournament.card.logo_grey))
    return out
