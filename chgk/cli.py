"""Command-line entry point: `uv run chgk ...`."""

import typer

from chgk import __version__

app = typer.Typer(help="ЧГК answer cards and jury scanning.", no_args_is_help=True)


@app.callback()
def main() -> None:
    """ЧГК answer cards and jury scanning."""


@app.command("version")
def show_version() -> None:
    """Print the installed version."""
    typer.echo(__version__)
