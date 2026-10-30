"""What every command group shares: the app, the `backend` group, error and warning output."""

import typer

from chgk import __version__
from chgk.backend import PERMISSIONS_HINT, SHEETS_API_HINT

app = typer.Typer(help="ЧГК answer cards and jury scanning.", no_args_is_help=True)
backend_app = typer.Typer(help="Google backends: one named profile per Google account.", no_args_is_help=True)
app.add_typer(backend_app, name="backend")


def warn_permissions(reply: dict) -> None:
    if reply.get("authorized") is False:
        typer.secho(PERMISSIONS_HINT, fg="yellow")
    if reply.get("sheets_api") is False:
        typer.secho(SHEETS_API_HINT, fg="yellow")


def fail(err: Exception) -> typer.Exit:
    typer.secho(f"Error: {err}", fg="red", err=True)
    return typer.Exit(1)


@app.callback()
def main() -> None:
    """ЧГК answer cards and jury scanning."""


@app.command("version")
def show_version() -> None:
    """Print the installed version."""
    typer.echo(__version__)
