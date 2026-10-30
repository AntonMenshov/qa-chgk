"""Command-line entry point: `uv run chgk ...`. One module per group of commands."""

from chgk.cli import cards, profiles, tournament  # noqa: F401 (importing them registers their commands)
from chgk.cli.common import app

__all__ = ["app"]
