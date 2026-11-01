"""From a tournament folder to a printable PDF."""

from dataclasses import dataclass, replace
from pathlib import Path

from PIL.Image import Image

from chgk import out_dir
from chgk.cards.impose import Mode, impose
from chgk.cards.model import team_deck
from chgk.cards.render import denser_qr_warning, render_cards
from chgk.cards.testpage import render_test_page
from chgk.config import LogoMode, Tournament, load_config
from chgk.ids import encode_payload, generate_tid
from chgk.jury import render_jury_sheet
from chgk.logos import first_logo, load_logos, open_logo, pale
from chgk.state import State, check_reserve, load_or_create_state, load_state, remember_team_ids
from chgk.svg import CUT_FROM
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


def _pale(sources: dict[str, Image], grey: float, teams: list[Team]) -> dict[str, Image]:
    """The pale logos: `grey`, or a team's own logo_grey for its own logo (keyed by its team_id)."""
    own = {t.team_id: t.logo_grey for t in teams if t.logo_grey is not None}
    return {key: pale(image, own.get(key, grey)) for key, image in sources.items()}


def load_teams(folder: Path, tournament: Tournament) -> list[Team]:
    """The organiser's teams from teams.py, then the reserve teams R1, R2, and so on."""
    teams = read_teams(Path(folder) / TEAMS_FILE)
    return teams + reserve_teams(tournament.reserve_teams, teams)


def _state(folder: Path, tournament: Tournament, teams: list[Team]) -> tuple[State, list[str]]:
    """The tournament's state, plus a warning if a new ID was just made though printouts exist."""
    is_new = load_state(folder) is None
    state = load_or_create_state(folder, tournament.tid)
    check_reserve(state, tournament.reserve_teams)
    remember_team_ids(folder, [t.team_id for t in teams if not t.reserve])  # the state may be new only now
    warnings = []
    if state.pending_token:
        which = state.pending_token.get("which")
        warnings.append(
            f"a replacement of the {which} token never finished: the jury sheet may carry a dead one. "
            f"Run `chgk replace-token {folder} {which}` again."
        )
    printed = is_new and any(out_dir(tournament.slug).glob("*.pdf"))
    if printed and not tournament.tid:
        warnings.append(
            f"no state.json in {folder}: this is a new tournament ID ({state.tid}), so cards printed "
            f"earlier (out/{tournament.slug}/) won't scan into it. Restore state.json if you have it."
        )
    return state, warnings


def build_cards(folder: Path, mode: Mode, out: Path | None = None, team_ids: list[str] | None = None) -> BuildResult:
    folder = Path(folder)
    tournament = load_config(folder)
    teams = load_teams(folder, tournament)
    all_teams = teams
    if team_ids is not None:
        if not team_ids:
            raise ValueError("--teams gives no team IDs")
        unknown = set(team_ids) - {t.team_id for t in teams}
        if unknown:
            raise ValueError(f"unknown team_id(s): {', '.join(sorted(unknown))}")
        teams = [t for t in teams if t.team_id in team_ids]
    state, warnings = _state(folder, tournament, all_teams)
    sources, logo_warnings = load_logos(folder, tournament.card, teams)
    decks = [team_deck(tournament, state.tid, team) for team in teams]
    pages = impose(mode, decks, tournament.layout.per_page)
    if out:
        out = Path(out)
        jury_out = out.with_name(f"{out.stem}-jury.pdf")
    else:
        # A reprint of some teams has its own name: the full deck's PDF stays.
        only = f"-{'-'.join(team_ids)}" if team_ids else ""
        out = out_dir(tournament.slug, f"cards-{mode.value}{only}.pdf")
        jury_out = out.with_name("jury.pdf")
    logos = _pale(sources, tournament.card.logo_grey, teams)
    warnings += logo_warnings + render_cards(pages, tournament, mode, out, logos)
    payloads = [encode_payload(tournament.scanner_url, card.id) for page in pages for card in page]
    if not tournament.card.no_qr:
        warnings += [w for w in [denser_qr_warning(payloads)] if w]
    warnings += render_jury_sheet(tournament, state, all_teams, jury_out)
    n_cards = sum(len(page) for page in pages)
    n_reserve = sum(1 for t in teams if t.reserve)
    return BuildResult(out, jury_out, len(teams) - n_reserve, n_reserve, n_cards, len(pages), sorted(set(warnings)))


def build_jury_sheet(folder: Path, out: Path | None = None, teams: list[Team] | None = None) -> tuple[Path, list[str]]:
    """Jury sheet on its own (also written by build_cards). `teams`: with reserve decks, if already read."""
    folder = Path(folder)
    tournament = load_config(folder)
    teams = load_teams(folder, tournament) if teams is None else teams
    state, warnings = _state(folder, tournament, teams)
    out = Path(out) if out else out_dir(tournament.slug, "jury.pdf")
    return out, warnings + render_jury_sheet(tournament, state, teams, out)


def build_test_page(folder: Path, out: Path | None = None) -> tuple[Path, list[str]]:
    """Calibration page for the first registered team with a logo, else the first team."""
    folder = Path(folder)
    tournament = load_config(folder)
    teams = read_teams(folder / TEAMS_FILE)  # a registered team: the page shows a real one
    state, warnings = _state(folder, tournament, teams)
    sources, logo_warnings = load_logos(folder, tournament.card, teams)
    team = next((t for t in teams if t.team_id in sources), teams[0])
    key = first_logo(tournament.card, team.team_id, sources)
    out = Path(out) if out else out_dir(tournament.slug, "test-page.pdf")
    warnings += logo_warnings + render_test_page(
        tournament,
        state.tid,
        team,
        out,
        sources.get(key) if key else None,
        _pale(sources, tournament.card.logo_grey, teams),
    )
    return out, sorted(set(warnings))


def build_logo_preview(
    folder: Path, tournament: Tournament, all_teams: list[Team], drafts: dict[str, Path], out: Path | None = None
) -> tuple[Path | None, list[str]]:
    """One real card per drafted team, the draft at the tournament's shade and size; plus warnings.

    Drawn on the tournament's own card layout whatever its logo mode, so a draft can be
    judged before it is accepted. A draft that can't be drawn is a warning and left out; with
    none left, no PDF is written (None).
    """
    teams = [t for t in all_teams if t.team_id in drafts]
    images, warnings = {}, []
    for t in teams:
        try:
            grey = tournament.card.logo_grey if t.logo_grey is None else t.logo_grey
            source = open_logo(drafts[t.team_id])
            images[t.team_id] = pale(source, grey)
            if CUT_FROM in source.info:
                warnings.append(f"draft {drafts[t.team_id]}: not square ({source.info[CUT_FROM]}); shown cut")
        except ValueError as err:
            warnings.append(f"draft {drafts[t.team_id]}: {err}")
    preview = replace(tournament, card=replace(tournament.card, logo=LogoMode.TEAM, fallback_logo=None))
    state = load_state(folder)
    tid = state.tid if state else tournament.tid or generate_tid()  # no tournament yet: the QR codes are only for show
    cards = [team_deck(preview, tid, t)[0] for t in teams if t.team_id in images]
    if not cards:
        return None, warnings
    per_page = preview.layout.per_page
    pages = [cards[i : i + per_page] for i in range(0, len(cards), per_page)]
    out = Path(out) if out else out_dir(tournament.slug, "logo-preview.pdf")
    warnings += render_cards(pages, preview, Mode.TEAM_PAGES, out, images)
    return out, warnings
