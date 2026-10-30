"""Command-line entry point: `uv run chgk ...`."""

from pathlib import Path

import typer

from chgk import __version__
from chgk.cards.build import INSTRUCTIONS, build_cards, build_test_page
from chgk.cards.impose import Mode

app = typer.Typer(help="ЧГК answer cards and jury scanning.", no_args_is_help=True)

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
    folder: Path = typer.Argument(..., help="Tournament folder with config.py and teams.csv"),
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
        typer.secho(f"Error: {err}", fg="red", err=True)
        raise typer.Exit(1) from err
    for warning in result.warnings:
        typer.secho(f"Warning: {warning}", fg="yellow", err=True)
    typer.echo(f"{result.path}: {result.teams} teams, {result.cards} cards, {result.pages} pages ({mode.value}).")
    typer.echo("Print on Letter at 100% / Actual size.")
    typer.echo(INSTRUCTIONS[mode])


@app.command("test-page")
def test_page(
    folder: Path = typer.Argument(..., help="Tournament folder with config.py and teams.csv"),
    out: Path | None = typer.Option(None, help="Output PDF (default: out/<slug>/test-page.pdf)"),
) -> None:
    """Print one calibration page: rulers, QR sizes, logo shades and sample cards."""
    try:
        path = build_test_page(folder, out)
    except ValueError as err:
        typer.secho(f"Error: {err}", fg="red", err=True)
        raise typer.Exit(1) from err
    typer.echo(f"{path}: print on Letter at 100% / Actual size and check the rulers, QR sizes and logo shades.")
