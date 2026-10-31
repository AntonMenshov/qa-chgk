"""Printing: answer cards, the test page, the jury sheet."""

from pathlib import Path

import typer

from chgk.cards.build import INSTRUCTIONS, build_cards, build_jury_sheet, build_test_page
from chgk.cards.impose import Mode
from chgk.cli.common import app, fail, team_ids

MODE_HELP = {
    Mode.TEAM_PAGES: "one team per page, cut along the lines",
    Mode.CUT_STACK: "guillotine: stack all sheets, cut once, piles come out sorted",
    Mode.SCISSORS: "one team per page, dashed lines for scissors",
}


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
    out: Path | None = typer.Option(
        None,
        help="Output PDF (default: out/<slug>/cards-<mode>.pdf); the secret jury sheet goes beside it: <name>-jury.pdf",
    ),
) -> None:
    """Generate the printable answer cards."""
    mode = mode or _ask_mode()
    try:
        result = build_cards(folder, mode, out, team_ids(teams) if teams is not None else None)
    except ValueError as err:
        raise fail(err) from err
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
        raise fail(err) from err
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
        raise fail(err) from err
    for warning in warnings:
        typer.secho(f"Warning: {warning}", fg="yellow", err=True)
    typer.echo(
        f"{path}: jury sheet. Keep it away from the teams once `chgk new` has run: it then holds the jury access QR."
    )
