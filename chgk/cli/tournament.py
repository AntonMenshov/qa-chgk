"""A tournament on its backend: create it, sync its teams, its board and view-only links."""

from pathlib import Path

import typer

from chgk.backend import BackendError, Profiles
from chgk.cards.build import build_jury_sheet
from chgk.cli.common import app, fail
from chgk.config import load_config
from chgk.jury import board_link
from chgk.remote import new_tournament, sync_teams
from chgk.state import load_state


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
        jury_path, _ = build_jury_sheet(folder)
    except (ValueError, BackendError) as err:
        raise fail(err) from err
    s = result.state
    if result.created:
        typer.echo(f"Created on backend '{s.backend_profile}' ({s.backend_account}).")
    else:
        typer.echo(f"Already created on backend '{s.backend_profile}' ({s.backend_account}); nothing changed.")
    typer.echo(f"Sheet: {s.spreadsheet_url}")
    typer.echo(f"{jury_path}: jury sheet with the access QR. Re-run `chgk cards` to refresh it next to the cards.")


@app.command("teams")
def teams_cmd(folder: Path = typer.Argument(..., help="Tournament folder")) -> None:
    """Pull the Sheet's Teams tab into teams.py (assigning team IDs, written back to the Sheet)."""
    try:
        teams = sync_teams(folder, Profiles())
    except (ValueError, BackendError) as err:
        raise fail(err) from err
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
