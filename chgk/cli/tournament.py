"""A tournament on its backend: create it, sync its teams, its board and view-only links, replace a leaked link."""

from enum import StrEnum
from pathlib import Path

import typer

from chgk import out_dir
from chgk.backend import BackendError, Profiles
from chgk.cards.build import build_jury_sheet, load_teams
from chgk.cli.common import app, fail
from chgk.config import load_config
from chgk.jury import board_link, sheet_version
from chgk.remote import new_tournament, replace_token, sync_teams
from chgk.state import check_tid, load_state


@app.command("new")
def new(
    folder: Path = typer.Argument(..., help="Tournament folder with config.py (and teams.py)"),
    backend: str | None = typer.Option(None, help="Backend profile (default: active)"),
) -> None:
    """Create the tournament's Google Sheet and Drive folder; writes state.json and the jury sheet."""
    profiles = Profiles()
    try:
        profile = profiles.get(backend) if backend else profiles.active()
        result = new_tournament(folder, profile)
        jury_path, warnings = build_jury_sheet(folder)
    except (ValueError, BackendError) as err:
        raise fail(err) from err
    for warning in warnings:
        typer.secho(f"Warning: {warning}", fg="yellow", err=True)
    s = result.state
    if result.created:
        typer.echo(f"Created on backend '{s.backend_profile}' ({s.backend_account}).")
    else:
        typer.echo(f"Already created on backend '{s.backend_profile}' ({s.backend_account}); the Sheet is unchanged.")
    typer.echo(f"Sheet: {s.spreadsheet_url}")
    typer.echo(f"{jury_path}: jury sheet with the access QR. Re-run `chgk cards` to refresh it next to the cards.")


@app.command("teams")
def teams_cmd(folder: Path = typer.Argument(..., help="Tournament folder")) -> None:
    """Pull the Sheet's Teams tab into teams.py (assigning team IDs, written back to the Sheet)."""
    warnings: list[str] = []
    try:
        teams = sync_teams(folder, Profiles(), warnings=warnings)
    except (ValueError, BackendError) as err:
        raise fail(err) from err
    for warning in warnings:
        typer.secho(f"Warning: {warning}", fg="yellow", err=True)
    typer.echo(f"{len(teams)} teams synced to {Path(folder) / 'teams.py'}.")


@app.command("board")
def board_cmd(folder: Path = typer.Argument(..., help="Tournament folder")) -> None:
    """Print the projector board link (read-only; its token is made by `chgk new`)."""
    try:
        tournament = load_config(folder)
    except ValueError as err:
        raise fail(err) from err
    state = load_state(folder)
    link = board_link(tournament, state) if state else None
    if not link:
        raise fail(ValueError("this tournament has no board yet: run `chgk new` first"))
    typer.echo("Open on the projector laptop (read-only; → shows the next round):")
    typer.echo(link)
    typer.echo("Its QR code is on page 2 of the jury sheet: run `chgk jury-sheet` (or `chgk cards`) to refresh it.")


@app.command("view")
def view_cmd(folder: Path = typer.Argument(..., help="Tournament folder")) -> None:
    """Print the Sheet's view-only link (shared "anyone with the link can view" when created)."""
    state = load_state(folder)
    if state is None or not state.view_url:
        raise fail(ValueError("this tournament has no Sheet yet: run `chgk new` first"))
    typer.echo("Results, view-only for anyone with the link (marks appear as the jury enters them):")
    typer.echo(state.view_url)
    typer.echo("Its QR code is on page 2 of the jury sheet and on the projector board.")


class TokenKind(StrEnum):
    JURY = "jury"
    BOARD = "board"


LEAKED = {
    TokenKind.JURY: "jury access link (page 1 of the jury sheet): every juror's phone",
    TokenKind.BOARD: "projector board link (page 2 of the jury sheet)",
}


@app.command("replace-token")
def replace_token_cmd(
    folder: Path = typer.Argument(..., help="Tournament folder"),
    which: TokenKind = typer.Argument(..., help="The leaked link: jury or board"),
    yes: bool = typer.Option(False, "--yes", help="Don't ask for confirmation"),
) -> None:
    """Replace a leaked jury or board link: the old one stops working at once; writes jury-v<N>.pdf."""
    # All that the new sheet needs comes first: once the backend switches, the old link is dead.
    try:
        tournament = load_config(folder)
        load_teams(folder, tournament)
        current = load_state(folder)
        if current is not None:
            check_tid(current, tournament.tid)
        out_dir(tournament.slug).mkdir(parents=True, exist_ok=True)
    except ValueError as err:
        raise fail(err) from err
    if not yes:
        typer.confirm(
            f"«{tournament.name}» ({tournament.slug}): the old {LEAKED[which]} stops working at once. Replace it?",
            abort=True,
        )
    try:
        state = replace_token(folder, which.value, Profiles())
    except BackendError as err:
        typer.secho(
            "It may have been replaced all the same: run this command again, it sends the same new token.",
            fg="yellow",
            err=True,
        )
        raise fail(err) from err
    except ValueError as err:
        raise fail(err) from err
    try:
        path, warnings = build_jury_sheet(folder, out_dir(tournament.slug, f"jury-v{sheet_version(state)}.pdf"))
    except (ValueError, OSError) as err:
        typer.secho(
            f"The new token is live, but the sheet failed: fix this, then `chgk jury-sheet {folder}`.",
            fg="yellow",
            err=True,
        )
        raise fail(err) from err
    for warning in warnings:
        typer.secho(f"Warning: {warning}", fg="yellow", err=True)
    typer.echo(f"New {which.value} token is live; the old one is refused from now on.")
    typer.echo(f"{path}: the new jury sheet (version {sheet_version(state)}), saying what happened. Print it.")
    if which is TokenKind.JURY:
        typer.echo(
            "Each juror's phone scans the new «Доступ жюри» QR (page 1) once; marks and photos waiting "
            "on a phone are sent with the new token."
        )
    else:
        typer.echo(f"Open the new board link on the projector (page 2, or `chgk board {folder}`).")
    typer.echo(
        f"Earlier jury sheets hold the old link, {out_dir(tournament.slug, 'jury.pdf')} too: destroy their printouts."
    )
