"""Logos: which logo each team's cards use, Claude-drawn drafts, the preview and accepting them."""

from pathlib import Path

import anthropic
import typer

from chgk import logo_drafts as drafts
from chgk import out_dir
from chgk.cards.build import build_logo_preview
from chgk.cli.common import app, fail, team_ids
from chgk.config import LogoMode, Tournament, load_config
from chgk.logos import LOGO_LIBRARY, logo_report, own_logo_problem
from chgk.teams import TEAMS_FILE, Team, read_teams


def _draw(folder: Path, slug: str, look: drafts.LogoLook, teams: list[Team], only: list[str] | None) -> None:
    if only:
        unknown = sorted(set(only) - {t.team_id for t in teams})
        if unknown:
            raise fail(ValueError(f"unknown team_id(s): {', '.join(unknown)}"))
        todo = [t for t in teams if t.team_id in only]
    else:
        have = drafts.existing_drafts(slug, teams)
        todo = [t for t in teams if own_logo_problem(t, folder) and t.team_id not in have]
    if not todo:
        typer.echo("Nothing to draw: every team has a logo or a draft (`--draw --team A01` redraws one).")
        return
    if not drafts.api_key_set():
        out = drafts.write_brief(out_dir(slug, "logo-brief.md"), folder, slug, todo, look)
        typer.echo(f"{drafts.API_KEY_ENV} is not set, so nothing was sent to the API.")
        typer.echo(f"{out}: a brief for {len(todo)} logos. Open Claude Code here and ask it to follow that file.")
        return
    references, warnings = drafts.reference_blocks(drafts.reference_logos())
    for warning in warnings:
        typer.secho(f"Warning: {warning}", fg="yellow", err=True)
    typer.echo(
        f"Drawing {len(todo)} logos with {drafts.MODEL} at {drafts.EFFORT} effort, {drafts.PARALLEL} at a time, "
        f"each reviewed up to {drafts.REVIEW_ROUNDS} times ({len(references)} reference logos). This takes a while…"
    )

    def log(team: Team, line: str, problem: bool) -> None:
        typer.secho(f"  {team.team_id} «{team.name}»: {line}", fg="yellow" if problem else None)

    try:
        drafts.draw_drafts(drafts.make_client(), slug, todo, references, look, log)
    except anthropic.AuthenticationError as err:
        raise fail(ValueError(f"the API refused {drafts.API_KEY_ENV} (HTTP {err.status_code})")) from err


def _report(folder: Path, tournament: Tournament, teams: list[Team]) -> None:
    rows, warnings = logo_report(folder, tournament.card, teams)
    have = drafts.existing_drafts(tournament.slug, teams)
    for r in rows:
        own = r.logo_file + (f" ({r.problem})" if r.problem else "") if r.logo_file else "(none)"
        draft = "  draft ready" if r.team_id in have else ""
        typer.echo(f"  {r.team_id:<8} {r.name:<28} {own:<36} cards show: {r.shown}{draft}")
    for warning in warnings:
        typer.secho(f"Warning: {warning}", fg="yellow", err=True)
    if tournament.card.logo in (LogoMode.NONE, LogoMode.TOURNAMENT):
        typer.secho(f"This tournament's cards don't show team logos (logo={tournament.card.logo.name}).", fg="yellow")
    key = "set" if drafts.api_key_set() else "not set (`--draw` writes a brief for Claude Code instead)"
    typer.echo(f"{drafts.API_KEY_ENV}: {key}.")
    if have:
        path, warnings = build_logo_preview(folder, have)
        for warning in warnings:
            typer.secho(f"Warning: {warning}", fg="yellow", err=True)
        if path:
            typer.echo(f"{path}: the drafts on real cards, at this tournament's shade. Print it to judge them.")
            typer.echo(f"Keep them: `uv run chgk logos {folder} --accept all` (or `--accept A01,A02`).")


@app.command("logos")
def logos_cmd(
    folder: Path = typer.Argument(..., help="Tournament folder with config.py and teams.py"),
    draw: bool = typer.Option(False, "--draw", help="Draw logos for teams without one (Claude API, or a brief)"),
    team: str | None = typer.Option(None, help="With --draw: only these team_ids, redrawing them, e.g. A01"),
    accept: str | None = typer.Option(None, help="Record drafts in teams.py: all, or team_ids like A01,A02"),
) -> None:
    """Show which logo each team's cards use; draw drafts with Claude; preview and accept them."""
    if team and not draw:
        raise fail(ValueError("--team goes with --draw"))
    if draw and accept:
        raise fail(ValueError("use --draw and --accept one at a time: preview the drafts first"))
    try:
        tournament = load_config(folder)
        teams_path = Path(folder) / TEAMS_FILE
        teams = read_teams(teams_path)
        if accept:
            which = None if accept.strip().lower() == "all" else team_ids(accept)
            for t in drafts.accept_drafts(teams_path, tournament.slug, teams, which):
                typer.echo(f"  {t.team_id} «{t.name}»: logo={t.logo_file!r} (in {LOGO_LIBRARY})")
            teams = read_teams(teams_path)
        if draw:
            look = drafts.logo_look(tournament.card, tournament.layout)
            _draw(Path(folder), tournament.slug, look, teams, team_ids(team) if team else None)
        _report(Path(folder), tournament, teams)
    except ValueError as err:
        raise fail(err) from err
