"""A tournament on its backend: create it, sync its teams, its board and view-only links, replace a leaked link."""

from pathlib import Path

import typer

from chgk import out_dir
from chgk.backend import BackendError, Profiles
from chgk.cards.build import build_jury_sheet, load_teams
from chgk.cli.common import app, fail, warn_all
from chgk.config import load_config
from chgk.jury import board_link, sheet_version
from chgk.remote import TokenKind, delete_tournament, make_results_copy, new_tournament, replace_token, sync_teams
from chgk.state import check_tid, load_state


@app.command("new")
def new(
    folder: Path = typer.Argument(..., help="Tournament folder with config.py (and teams.py)"),
    backend: str | None = typer.Option(None, help="Backend profile (default: active)"),
) -> None:
    """Create the tournament's Google Sheet and Drive folder; writes state.json and the jury sheet."""
    profiles = Profiles()
    profile = profiles.get(backend) if backend else profiles.active()
    result = new_tournament(folder, profile)
    jury_path, warnings = build_jury_sheet(folder, teams=result.teams)
    warn_all(warnings)
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
    teams = sync_teams(folder, Profiles(), warnings=warnings)
    warn_all(warnings)
    typer.echo(f"{len(teams)} teams synced to {Path(folder) / 'teams.py'}.")


@app.command("board")
def board_cmd(folder: Path = typer.Argument(..., help="Tournament folder")) -> None:
    """Print the projector board link (read-only; its token is made by `chgk new`)."""
    tournament = load_config(folder)
    state = load_state(folder)
    link = board_link(tournament, state) if state else None
    if not link:
        raise ValueError("this tournament has no board yet: run `chgk new` first")
    typer.echo("Open on the projector laptop (read-only; → shows the next round):")
    typer.echo(link)
    typer.echo("Its QR code is on page 2 of the jury sheet: run `chgk jury-sheet` (or `chgk cards`) to refresh it.")


@app.command("view")
def view_cmd(folder: Path = typer.Argument(..., help="Tournament folder")) -> None:
    """Print the public results link: a separate copy, the real Sheet stays private."""
    # Not "no Sheet yet" for a mistyped folder; and the link needs no working config.py.
    if not (folder / "config.py").exists() and not (folder / "state.json").exists():
        raise ValueError(f"{folder} is not a tournament folder: no config.py or state.json")
    state = load_state(folder)
    if state is None or not state.view_url:
        raise ValueError("this tournament has no Sheet yet: run `chgk new` first")
    typer.echo("Results, view-only for anyone with the link (marks appear about a minute after the jury enters them):")
    typer.echo(state.view_url)
    typer.echo("Its QR code is on page 2 of the jury sheet and on the projector board.")


@app.command("results-copy")
def results_copy_cmd(folder: Path = typer.Argument(..., help="Tournament folder")) -> None:
    """Update the public results copy now; a tournament made before public copies gets one, its real Sheet private."""
    before = load_state(folder)
    state = make_results_copy(folder, Profiles())
    if before and before.public_id == state.public_id:
        typer.echo(f"Public results updated: {state.view_url}")
        return
    path, warnings = build_jury_sheet(folder)
    warn_all(warnings)
    typer.echo(f"Public results: {state.view_url}")
    typer.echo(f"{path}: refreshed with the new link. Printed sheets and the old link no longer show the results.")


@app.command("delete")
def delete_cmd(
    folder: Path = typer.Argument(..., help="Tournament folder"),
    yes: bool = typer.Option(False, "--yes", help="Don't ask for confirmation"),
) -> None:
    """Delete a tournament: its Drive folder goes to the bin, its Sheet's trigger and state.json are removed."""
    tournament = load_config(folder)
    if not yes:
        typer.confirm(
            f"«{tournament.name}» ({tournament.slug}): its Sheet, marks and photos go to the bin of Google Drive, "
            "and every jury and board link stops working. Delete it?",
            abort=True,
        )
    state = delete_tournament(folder, Profiles())
    typer.echo(
        f"Tournament {state.tid} deleted; config.py and teams.py stay. Its Drive folder is in the bin for 30 days."
    )


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
    tournament = load_config(folder)
    teams = load_teams(folder, tournament)
    current = load_state(folder)
    if current is not None:
        check_tid(current, tournament.tid)
    out_dir(tournament.slug).mkdir(parents=True, exist_ok=True)
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
    try:
        path, warnings = build_jury_sheet(folder, out_dir(tournament.slug, f"jury-v{sheet_version(state)}.pdf"), teams)
    except (ValueError, OSError) as err:
        typer.secho(
            f"The new token is live, but the sheet failed: fix this, then `chgk jury-sheet {folder}`.",
            fg="yellow",
            err=True,
        )
        raise fail(err) from err
    warn_all(warnings)
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
