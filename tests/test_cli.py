from conftest import runner

from chgk import __version__, out_dir
from chgk.cli import app
from chgk.config import load_config
from chgk.teams import read_teams


def test_version_command_prints_version():
    result = runner.invoke(app, ["version"])
    assert result.exit_code == 0
    assert result.stdout.strip() == __version__


def test_no_args_shows_help():
    result = runner.invoke(app, [])
    assert "version" in result.output


def test_a_reprint_of_some_teams_leaves_the_full_deck_pdf(folder):
    full = runner.invoke(app, ["cards", str(folder), "--mode", "team-pages"])
    assert full.exit_code == 0, full.output
    path = out_dir(load_config(folder).slug, "cards-team-pages.pdf")
    before = path.read_bytes()
    first = read_teams(folder / "teams.py")[0].team_id
    partial = runner.invoke(app, ["cards", str(folder), "--mode", "team-pages", "--teams", first])
    assert partial.exit_code == 0, partial.output
    assert path.read_bytes() == before
    assert out_dir(load_config(folder).slug, f"cards-team-pages-{first}.pdf").is_file()


def test_a_teams_option_with_no_ids_is_refused(folder):
    result = runner.invoke(app, ["cards", str(folder), "--mode", "team-pages", "--teams", ","])
    assert result.exit_code == 1
    assert "no team IDs" in result.output
