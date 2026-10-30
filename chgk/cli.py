"""Command-line entry point: `uv run chgk ...`."""

from pathlib import Path

import typer

from chgk import __version__
from chgk.backend import (
    BUNDLE_FILE,
    PERMISSIONS_HINT,
    SHEETS_API_HINT,
    BackendClient,
    BackendError,
    Profile,
    Profiles,
    bundle_apps_script,
    bundle_version,
    source_version,
)
from chgk.cards.build import INSTRUCTIONS, build_cards, build_jury_sheet, build_test_page
from chgk.cards.impose import Mode
from chgk.config import load_config
from chgk.jury import board_link
from chgk.remote import new_tournament, sync_teams
from chgk.state import load_state

app = typer.Typer(help="ЧГК answer cards and jury scanning.", no_args_is_help=True)
backend_app = typer.Typer(help="Google backends: one named profile per Google account.", no_args_is_help=True)
app.add_typer(backend_app, name="backend")


def _warn_permissions(reply: dict) -> None:
    if reply.get("authorized") is False:
        typer.secho(PERMISSIONS_HINT, fg="yellow")
    if reply.get("sheets_api") is False:
        typer.secho(SHEETS_API_HINT, fg="yellow")


def _fail(err: Exception) -> typer.Exit:
    typer.secho(f"Error: {err}", fg="red", err=True)
    return typer.Exit(1)


MODE_HELP = {
    Mode.TEAM_PAGES: "one team per page, cut along the lines",
    Mode.CUT_STACK: "guillotine: stack all sheets, cut once, piles come out sorted",
    Mode.SCISSORS: "one team per page, dashed lines for scissors",
}


@app.callback()
def main() -> None:
    """ЧГК answer cards and jury scanning."""


@app.command("version")
def show_version() -> None:
    """Print the installed version."""
    typer.echo(__version__)


def _ask_mode() -> Mode:
    modes = list(Mode)
    typer.echo("How will the cards be cut?")
    for i, mode in enumerate(modes, start=1):
        typer.echo(f"  {i}. {mode.value:<11} {MODE_HELP[mode]}")
    while True:
        choice = typer.prompt(f"Choose 1-{len(modes)}", type=int)
        if 1 <= choice <= len(modes):
            return modes[choice - 1]
        typer.echo(f"Please enter a number from 1 to {len(modes)}.")


@app.command("cards")
def cards(
    folder: Path = typer.Argument(..., help="Tournament folder with config.py and teams.py"),
    mode: Mode | None = typer.Option(None, help="Imposition; asked interactively when omitted"),
    teams: str | None = typer.Option(None, help="Only these team_ids, comma-separated, e.g. A01,A07"),
    out: Path | None = typer.Option(None, help="Output PDF (default: out/<slug>/cards-<mode>.pdf)"),
) -> None:
    """Generate the printable answer cards."""
    mode = mode or _ask_mode()
    team_ids = [t.strip() for t in teams.split(",")] if teams else None
    try:
        result = build_cards(folder, mode, out, team_ids)
    except ValueError as err:
        raise _fail(err) from err
    for warning in result.warnings:
        typer.secho(f"Warning: {warning}", fg="yellow", err=True)
    reserve = f" + {result.reserve} reserve decks" if result.reserve else ""
    typer.echo(
        f"{result.path}: {result.teams} teams{reserve}, {result.cards} cards, {result.pages} pages ({mode.value})."
    )
    typer.echo(f"{result.jury_path}: jury sheet (contains the secret jury access QR once `chgk new` has run).")
    typer.echo("Print on Letter at 100% / Actual size.")
    typer.echo(INSTRUCTIONS[mode])


@app.command("test-page")
def test_page(
    folder: Path = typer.Argument(..., help="Tournament folder with config.py and teams.py"),
    out: Path | None = typer.Option(None, help="Output PDF (default: out/<slug>/test-page.pdf)"),
) -> None:
    """Print one calibration page: rulers, QR sizes, logo shades and sample cards."""
    try:
        path = build_test_page(folder, out)
    except ValueError as err:
        raise _fail(err) from err
    typer.echo(f"{path}: print on Letter at 100% / Actual size and check the rulers, QR sizes and logo shades.")


@app.command("jury-sheet")
def jury_sheet(
    folder: Path = typer.Argument(..., help="Tournament folder with config.py and teams.py"),
    out: Path | None = typer.Option(None, help="Output PDF (default: out/<slug>/jury.pdf)"),
) -> None:
    """Print the jury sheet: QR codes, links, how-to, team and player forms, paper backup grid."""
    try:
        path, warnings = build_jury_sheet(folder, out)
    except ValueError as err:
        raise _fail(err) from err
    for warning in warnings:
        typer.secho(f"Warning: {warning}", fg="yellow", err=True)
    typer.echo(f"{path}: jury sheet. Keep it away from the teams: it holds the jury access QR.")


# ---- backend profiles (SPEC §3.1) ----


@backend_app.command("bundle")
def backend_bundle(out: Path = typer.Option(BUNDLE_FILE, help="Where to write the bundle")) -> None:
    """Write the single Code.gs to paste into an Apps Script project."""
    path, version = bundle_apps_script(out)
    typer.echo(f"{path}: backend version {version}. Paste it into script.google.com (docs/google-account.md).")


@backend_app.command("add")
def backend_add(
    name: str = typer.Argument(..., help="Profile name, e.g. personal or club"),
    url: str = typer.Option(..., help="The web app /exec URL"),
    token: str = typer.Option(..., help="Admin token printed by setup() in the script editor"),
    account: str = typer.Option("", help="Label, e.g. the Gmail address (filled in from the backend if empty)"),
    check: bool = typer.Option(True, help="Ping the backend before saving"),
) -> None:
    """Add (or replace) a backend profile and make it active."""
    profiles = Profiles()
    if check:
        try:
            reply = BackendClient(url, token).ping()
        except BackendError as err:
            raise _fail(err) from err
        account = account or reply.get("account", "")
        _warn_permissions(reply)
    try:
        profiles.add(Profile(name, url, token, account))
    except ValueError as err:
        raise _fail(err) from err
    profiles.save()
    typer.echo(f"Backend '{name}' saved and active{f' ({account})' if account else ''}.")


@backend_app.command("use")
def backend_use(name: str) -> None:
    """Make a profile active: new tournaments are created on it."""
    profiles = Profiles()
    try:
        profiles.use(name)
    except ValueError as err:
        raise _fail(err) from err
    profiles.save()
    typer.echo(f"Active backend: {name}. Existing tournaments stay on the backend they were created on.")


@backend_app.command("list")
def backend_list() -> None:
    """List profiles; * marks the active one."""
    profiles = Profiles()
    if not profiles.profiles:
        typer.echo("No backend profiles yet (docs/google-account.md).")
    for p in profiles.profiles.values():
        mark = "*" if p.name == profiles.active_name else " "
        typer.echo(f"{mark} {p.name:<12} {p.account or '-':<28} {p.url}")


@backend_app.command("remove")
def backend_remove(name: str) -> None:
    """Forget a profile (the Google side is not touched)."""
    profiles = Profiles()
    try:
        profiles.remove(name)
    except ValueError as err:
        raise _fail(err) from err
    profiles.save()
    typer.echo(f"Removed backend '{name}'.")


@backend_app.command("check")
def backend_check(name: str | None = typer.Argument(None, help="Profile (default: active)")) -> None:
    """Ping a backend: shows its Google account and whether its code is up to date."""
    profiles = Profiles()
    try:
        profile = profiles.get(name) if name else profiles.active()
        reply = BackendClient(profile.url, profile.admin_token).ping()
    except (ValueError, BackendError) as err:
        raise _fail(err) from err
    local = source_version()
    typer.echo(f"Backend '{profile.name}' OK: account {reply.get('account') or '?'}, version {reply.get('version')}.")
    _warn_permissions(reply)
    if reply.get("version") != local:
        bundled = bundle_version()
        if bundled == local:
            step = f"paste {BUNDLE_FILE} (already version {local}) into the script"
        elif bundled:
            step = f"{BUNDLE_FILE} is an old bundle (version {bundled}): run `chgk backend bundle`, then paste it"
        else:
            step = "run `chgk backend bundle` and paste it into the script"
        typer.secho(
            f"Local code is version {local}: {step}, then Deploy → Manage deployments → edit → New version.",
            fg="yellow",
        )


# ---- tournaments on the backend ----


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
        raise _fail(err) from err
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
        raise _fail(err) from err
    typer.echo(f"{len(teams)} teams synced to {Path(folder) / 'teams.py'}.")


@app.command("board")
def board_cmd(folder: Path = typer.Argument(..., help="Tournament folder")) -> None:
    """Print the projector board link (read-only; its token is made by `chgk new`)."""
    try:
        tournament = load_config(folder)
    except ValueError as err:
        raise _fail(err) from err
    state = load_state(folder)
    link = board_link(tournament, state) if state else None
    if not link:
        raise _fail(ValueError("this tournament has no board yet: run `chgk new` first"))
    typer.echo("Open on the projector laptop (read-only; → shows the next round):")
    typer.echo(link)
    typer.echo("Its QR code is on page 2 of the jury sheet: run `chgk jury-sheet` (or `chgk cards`) to refresh it.")


@app.command("view")
def view_cmd(folder: Path = typer.Argument(..., help="Tournament folder")) -> None:
    """Print the Sheet's view-only link (shared "anyone with the link can view" when created)."""
    state = load_state(folder)
    if state is None or not state.view_url:
        raise _fail(ValueError("this tournament has no Sheet yet: run `chgk new` first"))
    typer.echo("Results, view-only for anyone with the link (marks appear as the jury enters them):")
    typer.echo(state.view_url)
    typer.echo("Its QR code is on page 2 of the jury sheet and on the projector board.")
