"""Logos: which logo each team's cards use, Claude-drawn drafts, the preview and accepting them."""

from pathlib import Path

import anthropic
import typer

from chgk import logo_drafts as drafts
from chgk import out_dir
from chgk.cards.build import build_logo_preview
from chgk.cli.common import app, fail, team_ids
from chgk.config import Tournament, load_config
from chgk.logos import LOGO_LIBRARY, logo_report, own_logo_problem, shows_team_logos
from chgk.teams import TEAMS_FILE, Team, read_teams


def _draw(folder: Path, slug: str, look: drafts.LogoLook, teams: list[Team], only: list[str] | None) -> None:
    if only is not None:
        if not only:
            raise ValueError("--team gives no team IDs")
        unknown = sorted(set(only) - {t.team_id for t in teams})
        if unknown:
            raise ValueError(f"unknown team_id(s): {', '.join(unknown)}")
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
    if not shows_team_logos(tournament.card):
        typer.secho(f"This tournament's cards don't show team logos (logo={tournament.card.logo.name}).", fg="yellow")
    key = "set" if drafts.api_key_set() else "not set (`--draw` writes a brief for Claude Code instead)"
    typer.echo(f"{drafts.API_KEY_ENV}: {key}.")
    if have:
        path, warnings = build_logo_preview(folder, tournament, teams, have)
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
    if team is not None and not draw:
        raise ValueError("--team goes with --draw")
    if draw and accept is not None:
        raise ValueError("use --draw and --accept one at a time: preview the drafts first")
    tournament = load_config(folder)
    teams_path = folder / TEAMS_FILE
    teams = read_teams(teams_path)
    if accept is not None:
        which = None if accept.strip().lower() == "all" else team_ids(accept)
        if which == []:
            raise ValueError("--accept gives no team IDs")
        accepted = drafts.accept_drafts(teams_path, tournament.slug, teams, which)
        for t in accepted:
            typer.echo(f"  {t.team_id} «{t.name}»: logo={t.logo_file!r} (in {LOGO_LIBRARY})")
        new = {t.team_id: t for t in accepted}
        teams = [new.get(t.team_id, t) for t in teams]
    if draw:
        if not shows_team_logos(tournament.card):
            raise ValueError("this tournament's cards don't show team logos: drawing them would be paid for nothing")
        look = drafts.logo_look(tournament.card, tournament.layout)
        _draw(folder, tournament.slug, look, teams, team_ids(team) if team is not None else None)
    _report(folder, tournament, teams)
