import json

import pytest

from chgk.ids import TID_ALPHABET
from chgk.state import load_or_create_state
from chgk.teams import Team, load_teams_csv


def write(path, text, bom=False):
    path.write_bytes(("﻿" if bom else "").encode() + text.encode("utf-8"))
    return path


def test_load_assigns_ids_and_writes_them_back(tmp_path):
    csv_path = write(tmp_path / "teams.csv", "team_id,name,city,logo_file\n,Синие зайцы,Бостон,\nB02,Думать быстро,,logos/d.png\n,Третьи,,\n")
    teams = load_teams_csv(csv_path)
    assert teams == [
        Team("A01", "Синие зайцы", "Бостон", ""),
        Team("B02", "Думать быстро", "", "logos/d.png"),
        Team("A02", "Третьи", "", ""),
    ]
    # Second load reads the same IDs from the file.
    assert load_teams_csv(csv_path) == teams
    assert "A01,Синие зайцы" in csv_path.read_text(encoding="utf-8")
    assert b"\r" not in csv_path.read_bytes()  # LF only: no git CRLF warnings


def test_load_handles_bom_name_only_column_and_blank_lines(tmp_path):
    csv_path = write(tmp_path / "teams.csv", "name\nКоманда 1\n\n,\nКоманда 2\n", bom=True)
    assert [(t.team_id, t.name) for t in load_teams_csv(csv_path)] == [("A01", "Команда 1"), ("A02", "Команда 2")]


def test_file_untouched_when_ids_already_present(tmp_path):
    text = "team_id,name,city,logo_file\nA01,X,,\n"
    csv_path = write(tmp_path / "teams.csv", text)
    load_teams_csv(csv_path)
    assert csv_path.read_text(encoding="utf-8") == text


@pytest.mark.parametrize(
    "text",
    [
        "team_id,name\n",  # no teams
        "team,city\nX,Y\n",  # no name column
        "team_id,name\nA01,\n",  # empty name
        "team_id,name\nA01,X\nA01,Y\n",  # duplicate id
    ],
)
def test_invalid_team_files(tmp_path, text):
    with pytest.raises(ValueError):
        load_teams_csv(write(tmp_path / "teams.csv", text))


def test_state_created_once_and_reused(tmp_path):
    first = load_or_create_state(tmp_path)
    assert len(first.tid) == 5 and set(first.tid) <= set(TID_ALPHABET)
    assert load_or_create_state(tmp_path).tid == first.tid
    assert json.loads((tmp_path / "state.json").read_text())["tid"] == first.tid


def test_state_derived_links_and_tolerates_unknown_keys(tmp_path):
    (tmp_path / "state.json").write_text(json.dumps({
        "tid": "K7M2Q", "spreadsheet_id": "abc123", "jury_token": "t" * 24,
        "backend_url": "https://script.google.com/macros/s/AKfycbx_Example-123/exec", "future_field": 1,
    }))
    state = load_or_create_state(tmp_path)
    assert state.spreadsheet_url == "https://docs.google.com/spreadsheets/d/abc123/edit"
    assert state.jury_access.tid == "K7M2Q"


def test_state_without_backend_has_no_jury_access(tmp_path):
    state = load_or_create_state(tmp_path)
    assert state.jury_access is None and state.spreadsheet_url is None
