import json
from unittest import mock

import pytest

from chgk.ids import TID_ALPHABET
from chgk.state import State, load_or_create_state, load_state, save_state
from chgk.teams import Team, read_teams, team, write_teams


def write(path, text):
    path.write_text(text, encoding="utf-8")
    return path


HEADER = "from chgk.teams import team\n\n"


def test_given_ids_are_kept_missing_ones_assigned_and_written_back(tmp_path):
    path = write(
        tmp_path / "teams.py",
        HEADER
        + """teams = [
    team("Синие зайцы", city="Бостон"),
    team("Думать быстро", id="58746", logo="logos/d.png"),
    team("Третьи"),  # a comment
]
""",
    )
    teams = read_teams(path)
    assert teams == [
        Team("A01", "Синие зайцы", "Бостон", ""),
        Team("58746", "Думать быстро", "", "logos/d.png"),
        Team("A02", "Третьи", "", ""),
    ]
    # The file now carries the IDs (so QR codes stay the same) and reads back the same.
    text = path.read_text(encoding="utf-8")
    assert 'team("Синие зайцы", id="A01", city="Бостон"),' in text
    assert read_teams(path) == teams
    assert b"\r" not in path.read_bytes()


def test_file_untouched_when_every_team_has_an_id(tmp_path):
    text = HEADER + 'teams = [\n    team("X", id="645"),  # my comment stays\n]\n'
    path = write(tmp_path / "teams.py", text)
    assert read_teams(path) == [Team("645", "X")]
    assert path.read_text(encoding="utf-8") == text


def test_ids_are_normalised_and_names_trimmed(tmp_path):
    path = write(tmp_path / "teams.py", HEADER + 'teams = [team("  Альфа ", id=" a07 ")]\n')
    assert read_teams(path) == [Team("A07", "Альфа")]


def test_written_file_round_trips_awkward_names(tmp_path):
    teams = [Team("A01", 'Кавычки "внутри" и \\ слэш'), Team("645", "42", "Нью-Йорк", "logos/42.png")]
    path = tmp_path / "teams.py"
    write_teams(path, teams)
    assert read_teams(path) == teams


@pytest.mark.parametrize(
    "text",
    [
        HEADER + "teams = []\n",  # no teams
        HEADER + "squads = [team('X')]\n",  # wrong variable
        HEADER + "teams = [('A01', 'X')]\n",  # not team(...)
        HEADER + "teams = [team('  ')]\n",  # empty name
        HEADER + "teams = [team('X', id='A01'), team('Y', id='A01')]\n",  # duplicate id
        HEADER + "teams = [team('X', id='A-1')]\n",  # bad id
    ],
)
def test_invalid_team_files(tmp_path, text):
    with pytest.raises(ValueError):
        read_teams(write(tmp_path / "teams.py", text))


def test_a_teams_logo_grey_survives_the_file_being_written_back(tmp_path):
    path = write(
        tmp_path / "teams.py", HEADER + 'teams = [team("Первые", logo="a.png", logo_grey=0.2), team("Вторые")]\n'
    )
    teams = read_teams(path)  # the missing IDs make it write the file back
    assert [t.logo_grey for t in teams] == [0.2, None]
    assert 'logo="a.png", logo_grey=0.2)' in path.read_text(encoding="utf-8")
    assert read_teams(path) == teams


@pytest.mark.parametrize("grey", [0, 0.9])
def test_a_teams_logo_grey_must_be_a_usable_shade(tmp_path, grey):
    path = write(tmp_path / "teams.py", HEADER + f'teams = [team("Первые", id="A01", logo_grey={grey})]\n')
    with pytest.raises(ValueError, match="logo_grey"):
        read_teams(path)


def test_missing_teams_file(tmp_path):
    with pytest.raises(ValueError, match=r"no teams\.py"):
        read_teams(tmp_path / "teams.py")


def test_state_created_once_and_reused(tmp_path):
    first = load_or_create_state(tmp_path)
    assert len(first.tid) == 5 and set(first.tid) <= set(TID_ALPHABET)
    assert load_or_create_state(tmp_path).tid == first.tid
    assert json.loads((tmp_path / "state.json").read_text())["tid"] == first.tid


def test_state_takes_the_tid_from_config_and_refuses_a_different_one(tmp_path):
    assert load_or_create_state(tmp_path, "11234").tid == "11234"
    assert load_or_create_state(tmp_path, "11234").tid == "11234"
    assert load_or_create_state(tmp_path).tid == "11234"  # no tid in config any more: the tournament keeps its own
    with pytest.raises(ValueError, match=r"config\.py gives tid 99999, but this tournament already has the ID 11234"):
        load_or_create_state(tmp_path, "99999")


def test_state_derived_links_and_tolerates_unknown_keys(tmp_path):
    (tmp_path / "state.json").write_text(
        json.dumps(
            {
                "tid": "K7M2Q",
                "spreadsheet_id": "abc123",
                "jury_token": "t" * 24,
                "backend_url": "https://script.google.com/macros/s/AKfycbx_Example-123/exec",
                "future_field": 1,
            }
        )
    )
    state = load_or_create_state(tmp_path)
    assert state.spreadsheet_url == "https://docs.google.com/spreadsheets/d/abc123/edit"
    assert state.jury_access.tid == "K7M2Q"


def test_state_without_backend_has_no_jury_access(tmp_path):
    state = load_or_create_state(tmp_path)
    assert state.jury_access is None and state.spreadsheet_url is None


def test_team_takes_a_numeric_id_as_text():
    assert team("Фиаско", id=58746).team_id == "58746"
    assert team("Ноль", id=0).team_id == "0"
    assert team("Без номера").team_id == ""


def test_files_are_replaced_whole_and_state_is_private(tmp_path):
    save_state(tmp_path, State(tid="K7M2Q", jury_token="secret"))
    assert (tmp_path / "state.json").stat().st_mode & 0o777 == 0o600
    assert [p.name for p in tmp_path.iterdir()] == ["state.json"]  # no temporary file left

    with mock.patch("os.replace", side_effect=OSError("disk full")), pytest.raises(OSError):
        save_state(tmp_path, State(tid="OTHER"))
    assert load_state(tmp_path).tid == "K7M2Q"
    assert [p.name for p in tmp_path.iterdir()] == ["state.json"]
