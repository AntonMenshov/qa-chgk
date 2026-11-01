"""What every command group shares: the app, the `backend` group, error and warning output."""

from collections.abc import Iterable
from typing import Any

import typer
from typer.core import TyperGroup

from chgk import __version__, warn
from chgk.backend import PERMISSIONS_HINT, SHEETS_API_HINT, BackendError


class CleanErrors(TyperGroup):
    """Any command: a broken file, a bad path or a refusal is `Error: …`, never a traceback."""

    def invoke(self, ctx: Any) -> Any:
        try:
            return super().invoke(ctx)
        except (ValueError, OSError, BackendError) as err:
            raise fail(err) from err


app = typer.Typer(cls=CleanErrors, help="ЧГК answer cards and jury scanning.", no_args_is_help=True)
backend_app = typer.Typer(
    cls=CleanErrors, help="Google backends: one named profile per Google account.", no_args_is_help=True
)
app.add_typer(backend_app, name="backend")


def warn_permissions(reply: dict[str, Any]) -> None:
    if reply.get("authorized") is False:
        typer.secho(PERMISSIONS_HINT, fg="yellow")
    if reply.get("sheets_api") is False:
        typer.secho(SHEETS_API_HINT, fg="yellow")


def team_ids(text: str) -> list[str]:
    """Team IDs typed on the command line: "a01, A02" → ["A01", "A02"]."""
    return [t.strip().upper() for t in text.split(",") if t.strip()]


def warn_all(warnings: Iterable[str]) -> None:
    for warning in warnings:
        warn(warning)


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
