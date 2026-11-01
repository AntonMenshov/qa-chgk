import pytest
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


def test_a_typo_in_an_organisers_file_is_a_clean_error(folder):
    (folder / "config.py").write_text("tournament = Tournament(\n", encoding="utf-8")
    result = runner.invoke(app, ["cards", str(folder), "--mode", "team-pages"])
    assert result.exit_code == 1
    assert "config.py" in result.output and "SyntaxError" in result.output
    assert not isinstance(result.exception, SyntaxError)


def test_a_broken_backends_file_is_a_clean_error(tmp_path, monkeypatch):
    monkeypatch.setenv("CHGK_CONFIG_DIR", str(tmp_path))
    (tmp_path / "backends.json").write_text("{", encoding="utf-8")
    result = runner.invoke(app, ["backend", "list"])
    assert result.exit_code == 1
    assert "backends.json is broken" in result.output


def test_a_bad_output_path_is_a_clean_error(folder, tmp_path):
    (tmp_path / "file").write_text("x", encoding="utf-8")
    result = runner.invoke(
        app, ["cards", str(folder), "--mode", "team-pages", "--out", str(tmp_path / "file" / "x.pdf")]
    )
    assert result.exit_code == 1
    assert "Error" in result.output


def test_cards_warn_when_a_lost_state_json_makes_a_new_tournament_id(folder):
    assert runner.invoke(app, ["cards", str(folder), "--mode", "team-pages"]).exit_code == 0
    (folder / "state.json").unlink()
    result = runner.invoke(app, ["cards", str(folder), "--mode", "team-pages"])
    assert result.exit_code == 0
    assert "new tournament ID" in result.output


@pytest.mark.parametrize(
    "args",
    [
        ["cards", "{folder}", "--mode", "team-pages"],
        ["test-page", "{folder}"],
        ["jury-sheet", "{folder}"],
        ["logos", "{folder}"],
    ],
)
def test_a_command_runs_teams_py_once(folder, args):
    teams_py = folder / "teams.py"
    runs = folder / "runs.txt"
    text = teams_py.read_text(encoding="utf-8")
    add = "p.write_text((p.read_text() if p.exists() else '') + 'x')"
    count = f"from pathlib import Path\np = Path({str(runs)!r})\n{add}\n"
    teams_py.write_text(count + text, encoding="utf-8")
    result = runner.invoke(app, [a.format(folder=folder) for a in args])
    assert result.exit_code == 0, result.output
    assert runs.read_text() == "x"
