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
from chgk.logos import load_pale_logo
from chgk.state import load_or_create_state
from chgk.teams import Team, load_teams_csv

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


def _load_logos(folder: Path, tournament: Tournament, teams: list[Team]) -> tuple[dict[str, Image.Image], Image.Image | None]:
    fields = tournament.card
    team_logos = {}
    if fields.logo in (LogoMode.TEAM, LogoMode.TEAM_ELSE_TOURNAMENT):
        team_logos = {t.team_id: load_pale_logo(folder / t.logo_file, fields.logo_grey) for t in teams if t.logo_file}
    tournament_logo = None
    if fields.logo in (LogoMode.TOURNAMENT, LogoMode.TEAM_ELSE_TOURNAMENT) and fields.tournament_logo:
        tournament_logo = load_pale_logo(folder / fields.tournament_logo, fields.logo_grey)
    return team_logos, tournament_logo


@dataclass(frozen=True)
class BuildResult:
    path: Path
    jury_path: Path
    teams: int
    cards: int
    pages: int
    warnings: list[str]


def build_cards(folder: Path, mode: Mode, out: Path | None = None, team_ids: list[str] | None = None) -> BuildResult:
    folder = Path(folder)
    tournament = load_config(folder)
    teams = load_teams_csv(folder / TEAMS_FILE)
    if team_ids:
        unknown = set(team_ids) - {t.team_id for t in teams}
        if unknown:
            raise ValueError(f"unknown team_id(s): {', '.join(sorted(unknown))}")
        teams = [t for t in teams if t.team_id in team_ids]
    state = load_or_create_state(folder)
    team_logos, tournament_logo = _load_logos(folder, tournament, teams)
    decks = [team_deck(tournament, state.tid, team) for team in teams]
    pages = impose(mode, decks, tournament.layout.per_page, state.tid)
    if out:
        out = Path(out)
        jury_out = out.with_name(f"{out.stem}-jury.pdf")
    else:
        out = Path("out") / tournament.slug / f"cards-{mode.value}.pdf"
        jury_out = out.with_name("jury.pdf")
    warnings = render_cards(pages, tournament, mode, out, team_logos, tournament_logo)
    warnings += render_jury_sheet(tournament, state, teams, jury_out, pages)
    n_cards = sum(1 for page in pages for card in page if card is not None)
    return BuildResult(out, jury_out, len(teams), n_cards, len(pages), sorted(set(warnings)))


def build_jury_sheet(folder: Path, mode: Mode | None = None, out: Path | None = None) -> tuple[Path, list[str]]:
    """Jury sheet on its own. With `mode`, card counts include the extra spares that mode prints."""
    folder = Path(folder)
    tournament = load_config(folder)
    teams = load_teams_csv(folder / TEAMS_FILE)
    state = load_or_create_state(folder)
    pages = None
    if mode is not None:
        decks = [team_deck(tournament, state.tid, team) for team in teams]
        pages = impose(mode, decks, tournament.layout.per_page, state.tid)
    out = Path(out) if out else Path("out") / tournament.slug / "jury.pdf"
    return out, render_jury_sheet(tournament, state, teams, out, pages)


def build_test_page(folder: Path, out: Path | None = None) -> Path:
    """Calibration page using the tournament's first team (prefer one with a logo)."""
    folder = Path(folder)
    tournament = load_config(folder)
    teams = load_teams_csv(folder / TEAMS_FILE)
    state = load_or_create_state(folder)
    team_logos, tournament_logo = _load_logos(folder, tournament, teams)
    team = next((t for t in teams if t.team_id in team_logos), teams[0])

    source = None
    if team.team_id in team_logos:
        source = Image.open(folder / team.logo_file)
    elif tournament_logo is not None:
        source = Image.open(folder / tournament.card.tournament_logo)

    out = Path(out) if out else Path("out") / tournament.slug / "test-page.pdf"
    render_test_page(tournament, state.tid, team, out, source, team_logos, tournament_logo)
    return out
