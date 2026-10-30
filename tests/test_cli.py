from typer.testing import CliRunner

from chgk import __version__
from chgk.cli import app

runner = CliRunner()


def test_version_command_prints_version():
    result = runner.invoke(app, ["version"])
    assert result.exit_code == 0
    assert result.stdout.strip() == __version__


def test_no_args_shows_help():
    result = runner.invoke(app, [])
    assert "version" in result.output
