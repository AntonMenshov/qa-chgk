import json
import re

import httpx
import pytest
import respx
from conftest import LONG_NAME, runner, write_teams_file
from node_backend import NODE, NodeBackend
from pypdf import PdfReader

from chgk.backend import (
    APPS_SCRIPT_DIR,
    BackendClient,
    BackendError,
    Profile,
    Profiles,
    bundle_apps_script,
    bundle_version,
    source_version,
)
from chgk.cli import app
from chgk.ids import decode_jury_link, encode_jury_link
from chgk.remote import new_tournament, replace_token, sync_teams
from chgk.state import load_or_create_state
from chgk.teams import Team, read_teams

URL_A = "https://script.google.com/macros/s/AKfycbAccountA_000000000/exec"
URL_B = "https://script.google.com/macros/s/AKfycbAccountB_000000000/exec"


@pytest.fixture(autouse=True)
def config_dir(tmp_path, monkeypatch):
    """Profiles go to a temp dir, never to the real ~/.config/chgk."""
    d = tmp_path / "config"
    monkeypatch.setenv("CHGK_CONFIG_DIR", str(d))
    return d


def body(route_call) -> dict:
    return json.loads(route_call.request.content)


@pytest.fixture
def backends():
    """Two Google accounts' backends, each the real apps_script/ code (tests/node_backend.py)."""
    if not NODE:
        pytest.skip("needs Node")
    a, b = NodeBackend(URL_A, "a@gmail.com", "tokA"), NodeBackend(URL_B, "club@gmail.com", "tokB")
    try:
        with respx.mock(assert_all_called=False) as mock:
            mock.post(URL_A).mock(side_effect=a)
            mock.post(URL_B).mock(side_effect=b)
            yield a, b
    finally:
        a.close()
        b.close()


def sent(backend, action):
    return [c for c in backend.calls if c["action"] == action]


# ---- profiles ----


def test_profiles_round_trip_outside_the_repo(config_dir):
    profiles = Profiles()
    profiles.add(Profile("personal", URL_A, "tokA", "a@gmail.com"))
    profiles.add(Profile("club", URL_B, "tokB"), activate=False)
    profiles.save()
    path = config_dir / "backends.json"
    assert path.stat().st_mode & 0o777 == 0o600

    again = Profiles()
    assert again.active().name == "personal"
    again.use("club")
    again.save()
    assert Profiles().active().url == URL_B
    assert Profiles().by_url(URL_A).name == "personal"


def test_profile_errors():
    profiles = Profiles()
    with pytest.raises(ValueError, match="no backend profile yet"):
        profiles.active()
    with pytest.raises(ValueError, match="Apps Script"):
        profiles.add(Profile("x", "https://example.com/exec", "t"))
    with pytest.raises(ValueError, match="no backend profile"):
        profiles.use("missing")
    with pytest.raises(ValueError, match="no local profile"):
        profiles.by_url(URL_A)


def test_remove_switches_active():
    profiles = Profiles()
    profiles.add(Profile("a", URL_A, "t"))
    profiles.add(Profile("b", URL_B, "t"))
    profiles.remove("b")
    assert profiles.active().name == "a"


# ---- client ----


@respx.mock
def test_client_sends_text_plain_json_with_token():
    route = respx.post(URL_A).mock(return_value=httpx.Response(200, json={"ok": True, "account": "a@gmail.com"}))
    assert BackendClient(URL_A, "tok").ping()["account"] == "a@gmail.com"
    sent = body(route.calls[0])
    assert sent == {"action": "ping", "token": "tok"}
    assert route.calls[0].request.headers["content-type"] == "text/plain;charset=utf-8"


@respx.mock
def test_client_reports_backend_errors():
    respx.post(URL_A).mock(
        return_value=httpx.Response(200, json={"ok": False, "error": "forbidden: admin token required"})
    )
    with pytest.raises(BackendError, match="forbidden"):
        BackendClient(URL_A, "bad").ping()


@respx.mock
def test_client_explains_html_login_page():
    respx.post(URL_A).mock(return_value=httpx.Response(200, text="<html>Sign in</html>"))
    with pytest.raises(BackendError, match="Who has access: Anyone"):
        BackendClient(URL_A, "tok").ping()


@respx.mock
def test_client_explains_missing_google_permission():
    error = "You do not have permission to call SpreadsheetApp.create. Required permissions: ..."
    respx.post(URL_A).mock(return_value=httpx.Response(200, json={"ok": False, "error": error}))
    with pytest.raises(BackendError, match="Select all"):
        BackendClient(URL_A, "tok").call("create_tournament")


@respx.mock
def test_client_reports_network_errors():
    respx.post(URL_A).mock(side_effect=httpx.ConnectError("offline"))
    with pytest.raises(BackendError, match="cannot reach"):
        BackendClient(URL_A, "tok").ping()


# ---- tournaments ----


def test_new_tournament_records_its_backend(folder, backends):
    a, _ = backends
    result = new_tournament(folder, Profile("personal", URL_A, "tokA"))
    assert result.created
    s = result.state
    assert (s.backend_url, s.backend_profile, s.backend_account) == (URL_A, "personal", "a@gmail.com")
    assert s.spreadsheet_id
    [req] = sent(a, "create_tournament")
    assert req["name"] == "Осенний кубок" and req["date"] == "2026-11-15" and req["round_sizes"] == [3, 3]
    assert [t["team_id"] for t in req["teams"]] == ["A01", "A02", "A03"]
    assert req["jury_token"] == s.jury_token and len(s.jury_token) >= 16
    assert req["reserve"] == ["R1", "R2"]  # reserve decks, config default
    assert req["board_token"] == s.board_token and len(s.board_token) >= 16 and s.board_token != s.jury_token
    assert s.board_access.backend_url == URL_A
    assert load_or_create_state(folder) == s
    # What the backend made of it: the teams on the Teams tab, reserves included.
    teams = a.call("get_teams", tid=s.tid)["teams"]
    assert [(t["team_id"], t["reserve"]) for t in teams][-2:] == [("R1", True), ("R2", True)]


def test_the_backend_refuses_a_tournament_without_a_board_token(backends):
    a, _ = backends
    request = {"tid": "ZZ234", "name": "X", "date": "2026-11-15", "round_sizes": [3], "teams": []}
    with pytest.raises(BackendError, match="board_token"):
        BackendClient(URL_A, "tokA").call("create_tournament", jury_token="j" * 24, **request)
    assert not a.call("get_teams", tid="ZZ234")["ok"]  # nothing was created


def test_new_tournament_with_a_tid_from_config(folder, backends):
    a, _ = backends
    config = folder / "config.py"
    config.write_text(config.read_text(encoding="utf-8").replace("spares_per_team=2,", "spares_per_team=2, tid=11234,"))
    s = new_tournament(folder, Profile("personal", URL_A, "tokA")).state
    assert s.tid == "11234" and sent(a, "create_tournament")[0]["tid"] == "11234"
    assert BackendClient(URL_A, s.jury_token).call("get_state", tid="11234")["ok"]
    config.write_text(config.read_text(encoding="utf-8").replace("tid=11234,", "tid=99999,"))
    with pytest.raises(ValueError, match="already has the ID 11234"):
        new_tournament(folder, Profile("personal", URL_A, "tokA"))


def test_new_tournament_is_idempotent(folder, backends):
    a, _ = backends
    first = new_tournament(folder, Profile("personal", URL_A, "tokA")).state
    again = new_tournament(folder, Profile("personal", URL_A, "tokA"))
    assert not again.created and again.state == first
    assert len(sent(a, "create_tournament")) == 1


def test_new_tournament_without_teams_py_fails_before_creating_anything(folder, backends):
    a, _ = backends
    (folder / "teams.py").unlink()
    with pytest.raises(ValueError, match=r"no teams\.py"):
        new_tournament(folder, Profile("personal", URL_A, "tokA"))
    assert not sent(a, "create_tournament")
    assert not (folder / "state.json").exists()


def test_switching_accounts_keeps_existing_tournaments_on_their_backend(folder, tmp_path, backends, config_dir):
    """The user's requirement: switch Gmail accounts without breaking running tournaments."""
    a, b = backends
    profiles = Profiles()
    profiles.add(Profile("personal", URL_A, "tokA"))
    profiles.add(Profile("club", URL_B, "tokB"), activate=False)
    profiles.save()

    old = new_tournament(folder, profiles.active()).state
    profiles.use("club")
    profiles.save()

    # The old tournament still talks to account A.
    sync_teams(folder, Profiles())
    assert any(c["action"] == "get_teams" for c in a.calls)
    assert not any(c["action"] == "get_teams" for c in b.calls)
    assert load_or_create_state(folder).backend_url == URL_A == old.backend_url

    # A new tournament goes to account B; its jury link points the phones there.
    other = tmp_path / "other-cup"
    other.mkdir()
    (other / "config.py").write_text(
        (folder / "config.py").read_text(encoding="utf-8").replace("test-cup", "other-cup"), encoding="utf-8"
    )
    (other / "teams.py").write_text((folder / "teams.py").read_text(encoding="utf-8"), encoding="utf-8")
    new_state = new_tournament(other, Profiles().active()).state
    assert new_state.backend_url == URL_B
    link = encode_jury_link("https://e.github.io/qa-chgk/s/", new_state.jury_access)
    assert decode_jury_link(link).backend_url == URL_B


def test_sync_teams_assigns_ids_and_writes_back(folder, backends):
    a, _ = backends
    profiles = Profiles()
    profiles.add(Profile("personal", URL_A, "tokA"))
    profiles.save()
    state = new_tournament(folder, profiles.active()).state
    # The organiser adds a team in the Sheet without an ID: a row after the three teams and R1, R2.
    for col, value in enumerate(["", "Новые", "Бостон", "", ""], start=1):
        a.set_cell(state.tid, "Teams", 7, col, value)

    teams = sync_teams(folder, Profiles())
    assert [t.team_id for t in teams] == ["A01", "A02", "A03", "A04"]
    assert read_teams(folder / "teams.py")[-1] == Team("A04", "Новые", "Бостон")
    on_tab = a.call("get_teams", tid=state.tid)["teams"]
    assert ("A04", "Новые") in [(t["team_id"], t["name"]) for t in on_tab]  # written back to the Sheet


def test_sync_teams_keeps_a_local_logo_unless_the_sheet_has_one(folder, backends):
    a, _ = backends
    profiles = Profiles()
    profiles.add(Profile("personal", URL_A, "tokA"))
    profiles.save()
    state = new_tournament(folder, profiles.active()).state
    write_teams_file(
        folder,
        [
            ("A01", "Синие зайцы", "Бостон", "z.png"),
            ("A02", LONG_NAME, "", "new.svg"),
            ("A03", "Думать быстро", "", "local.svg"),
        ],
    )  # logos set locally after `chgk new`
    a.set_cell(state.tid, "Teams", 4, 4, "sheet.png")  # A03's logo typed in the Sheet
    teams = sync_teams(folder, Profiles())
    assert [t.logo_file for t in teams] == ["z.png", "new.svg", "sheet.png"]  # A02: Sheet blank, kept; A03: Sheet wins
    assert [t.logo_file for t in read_teams(folder / "teams.py")] == ["z.png", "new.svg", "sheet.png"]
    assert [t["logo_file"] for t in sent(a, "set_teams")[-1]["teams"]] == ["z.png", "new.svg", "sheet.png"]


def test_sync_teams_keeps_a_teams_logo_grey_which_stays_off_the_sheet(folder, backends):
    a, _ = backends
    profiles = Profiles()
    profiles.add(Profile("personal", URL_A, "tokA"))
    profiles.save()
    state = new_tournament(folder, profiles.active()).state
    text = (folder / "teams.py").read_text(encoding="utf-8")
    (folder / "teams.py").write_text(text.replace("id='A03'", "id='A03', logo_grey=0.3"), encoding="utf-8")
    a.set_cell(state.tid, "Teams", 4, 4, "sheet.png")  # a logo from the Sheet wins; the shade is still the team's
    teams = sync_teams(folder, Profiles())
    assert [(t.logo_file, t.logo_grey) for t in teams][2] == ("sheet.png", 0.3)
    assert read_teams(folder / "teams.py")[2].logo_grey == 0.3
    assert all("logo_grey" not in t for t in sent(a, "set_teams")[-1]["teams"])


def test_sync_teams_leaves_reserve_teams_on_the_backend(folder, backends):
    a, _ = backends
    profiles = Profiles()
    profiles.add(Profile("personal", URL_A, "tokA"))
    profiles.save()
    state = new_tournament(folder, profiles.active()).state
    # The jury named reserve team R1 in the Sheet (row 5, after A01-A03); R2 is still unused.
    a.set_cell(state.tid, "Teams", 5, 2, "Новенькие")
    teams = sync_teams(folder, Profiles())
    assert [t.team_id for t in teams] == ["A01", "A02", "A03"]
    assert "R1" not in (folder / "teams.py").read_text(encoding="utf-8")
    assert [t["team_id"] for t in sent(a, "set_teams")[-1]["teams"]] == ["A01", "A02", "A03"]
    # The backend keeps R1 with the name the jury gave it.
    reserve = [t for t in a.call("get_teams", tid=state.tid)["teams"] if t["reserve"]]
    assert [(t["team_id"], t["name"]) for t in reserve] == [("R1", "Новенькие"), ("R2", "")]


def test_sync_teams_needs_a_backend(folder):
    with pytest.raises(ValueError, match="chgk new"):
        sync_teams(folder, Profiles())


# ---- bundle ----


def test_bundle_contains_every_file_and_a_stable_version(tmp_path):
    out, version = bundle_apps_script(tmp_path / "Code.gs")
    text = out.read_text(encoding="utf-8")
    assert version == source_version() and len(version) == 12
    assert f"const VERSION = '{version}';" in text and "const VERSION = 'dev';" not in text
    for name in (
        "function mergeCell",
        "function applyEvents",
        "function doPost",
        "function setup",
        "function onSheetEdit",
    ):
        assert name in text
    # The editor's Run button starts on the first function, so that must be setup().
    assert re.search(r"^function (\w+)", text, re.M).group(1) == "setup"
    assert text.index("// ===== Code.js") < text.index("// ===== logic.js")
    assert not re.search(r"(?m)^export ", text)  # logic.js is an ES module; Apps Script has none
    assert bundle_apps_script(tmp_path / "again.gs")[1] == version
    assert (APPS_SCRIPT_DIR / "Code.js").read_text().count("const VERSION = 'dev';") == 1


# ---- CLI ----


def test_cli_backend_add_list_use_check(backends):
    result = runner.invoke(app, ["backend", "add", "personal", "--url", URL_A, "--token", "tokA"])
    assert result.exit_code == 0, result.output
    assert "a@gmail.com" in result.output
    assert runner.invoke(app, ["backend", "add", "club", "--url", URL_B, "--token", "tokB"]).exit_code == 0

    listing = runner.invoke(app, ["backend", "list"]).output
    assert "* club" in listing and "  personal" in listing
    assert runner.invoke(app, ["backend", "use", "personal"]).exit_code == 0
    check = runner.invoke(app, ["backend", "check"])
    assert check.exit_code == 0 and "account a@gmail.com" in check.output
    assert "Local code is version" in check.output  # the test backend runs the unbundled code: version 'dev'


def test_cli_backend_check_points_out_an_old_bundle(backends, tmp_path):
    # A Code.gs left over from before a change, pasted by mistake (out/ is tmp_path/out here).
    runner.invoke(app, ["backend", "add", "personal", "--url", URL_A, "--token", "tokA"])
    check = lambda: " ".join(runner.invoke(app, ["backend", "check"]).output.split())  # noqa: E731
    assert "run `chgk backend bundle` and paste it" in check()  # no bundle yet
    old = tmp_path / "out" / "apps_script" / "Code.gs"
    old.parent.mkdir(parents=True)
    old.write_text("const VERSION = 'e08511993c86';\n", encoding="utf-8")
    assert "is an old bundle (version e08511993c86)" in check()
    assert runner.invoke(app, ["backend", "bundle"]).exit_code == 0
    assert f"(already version {source_version()})" in check()
    assert bundle_version(old) == source_version()


def test_cli_backend_warns_when_a_permission_is_missing(backends):
    a, _ = backends
    a.options(allScopes=False)
    added = runner.invoke(app, ["backend", "add", "personal", "--url", URL_A, "--token", "tokA"])
    assert added.exit_code == 0 and "Select all" in added.output
    assert "Select all" in runner.invoke(app, ["backend", "check"]).output
    a.options(allScopes=True)
    assert "Select all" not in runner.invoke(app, ["backend", "check"]).output


def test_cli_backend_check_warns_when_the_sheets_api_service_is_off(backends):
    a, _ = backends
    runner.invoke(app, ["backend", "add", "personal", "--url", URL_A, "--token", "tokA"])
    assert "Google Sheets API" not in runner.invoke(app, ["backend", "check"]).output
    a.options(sheetsApi=False)
    check = runner.invoke(app, ["backend", "check"])
    assert check.exit_code == 0 and "Services (+) → Google Sheets API → Add" in check.output


def test_cli_backend_add_rejects_unreachable():
    with respx.mock:
        respx.post(URL_A).mock(return_value=httpx.Response(200, json={"ok": False, "error": "forbidden"}))
        result = runner.invoke(app, ["backend", "add", "personal", "--url", URL_A, "--token", "bad"])
    assert result.exit_code == 1 and "forbidden" in result.output
    assert not Profiles().profiles


def test_cli_new_and_teams(folder, backends):
    runner.invoke(app, ["backend", "add", "personal", "--url", URL_A, "--token", "tokA"])
    result = runner.invoke(app, ["new", str(folder)])
    assert result.exit_code == 0, result.output
    assert "Created on backend 'personal' (a@gmail.com)" in result.output
    assert "docs.google.com/spreadsheets/d/" in result.output
    again = runner.invoke(app, ["new", str(folder)])
    assert "Already created" in again.output
    teams = runner.invoke(app, ["teams", str(folder)])
    assert teams.exit_code == 0 and "3 teams synced" in teams.output


def test_cli_new_prints_the_jury_sheets_warnings(folder, backends):
    write_teams_file(folder, [("A01", "Зайцы 🐰", "", "")])  # the font has no emoji
    runner.invoke(app, ["backend", "add", "personal", "--url", URL_A, "--token", "tokA"])
    result = runner.invoke(app, ["new", str(folder)])
    assert result.exit_code == 0, result.output
    assert "Warning:" in result.output and "🐰" in result.output


def test_cli_new_without_profile_explains(folder):
    result = runner.invoke(app, ["new", str(folder)])
    assert result.exit_code == 1 and "google-account.md" in result.output


# ---- replacing a leaked link ----


def test_replace_token_switches_the_backend_and_records_it(folder, backends):
    profiles = Profiles()
    profiles.add(Profile("personal", URL_A, "tokA"))
    profiles.save()
    old = new_tournament(folder, profiles.active()).state
    state = replace_token(folder, "jury", Profiles())
    assert state.jury_token != old.jury_token and state.board_token == old.board_token
    assert [r["which"] for r in state.replaced] == ["jury"] and re.fullmatch(
        r"\d{4}-\d\d-\d\dT\d\d:\d\d", state.replaced[0]["at"]
    )
    assert load_or_create_state(folder) == state
    with pytest.raises(BackendError, match="forbidden"):
        BackendClient(URL_A, old.jury_token).call("get_state", tid=state.tid)
    assert BackendClient(URL_A, state.jury_token).call("get_state", tid=state.tid)["ok"]
    state = replace_token(folder, "board", Profiles())
    assert [r["which"] for r in state.replaced] == ["jury", "board"] and state.board_token != old.board_token
    with pytest.raises(ValueError, match="which token"):
        replace_token(folder, "admin", Profiles())


def test_replace_token_needs_a_tournament(folder):
    with pytest.raises(ValueError, match="chgk new"):
        replace_token(folder, "jury", Profiles())


def test_cli_replace_token_writes_a_new_jury_sheet_that_says_what_happened(folder, backends):
    runner.invoke(app, ["backend", "add", "personal", "--url", URL_A, "--token", "tokA"])
    runner.invoke(app, ["new", str(folder)])
    first = (folder.parent / "out" / "test-cup" / "jury.pdf").read_bytes()
    assert runner.invoke(app, ["replace-token", str(folder), "jury"], input="n\n").exit_code == 1  # asked, declined
    result = runner.invoke(app, ["replace-token", str(folder), "jury", "--yes"])
    assert result.exit_code == 0, result.output
    assert "jury-v2.pdf" in result.output and "destroy" in result.output
    v2 = folder.parent / "out" / "test-cup" / "jury-v2.pdf"
    text = " ".join(" ".join(p.extract_text().split()) for p in PdfReader(v2).pages[:2])
    assert "версия 2" in text and "Ключ доступа жюри заменён" in text and "Ссылка табло заменена" not in text
    assert (folder.parent / "out" / "test-cup" / "jury.pdf").read_bytes() == first  # the old sheet is kept as it was
    state = load_or_create_state(folder)
    links = {a.get("/A", {}).get("/URI") for p in PdfReader(v2).pages[:1] for a in (p.get("/Annots") or [])}
    links = {str(link) for link in links if link}
    assert any(state.jury_token in link for link in links)  # page 1 carries the new jury link
    result = runner.invoke(app, ["replace-token", str(folder), "board", "--yes"])
    v3 = folder.parent / "out" / "test-cup" / "jury-v3.pdf"
    page2 = " ".join(PdfReader(v3).pages[1].extract_text().split())
    assert result.exit_code == 0 and "версия 3" in page2 and "Ссылка табло заменена" in page2


# ---- projector board ----


def test_cli_board_prints_the_link_made_by_new(folder, backends):
    a, _ = backends
    result = runner.invoke(app, ["board", str(folder)])
    assert result.exit_code == 1 and "chgk new" in result.output  # no tournament yet
    runner.invoke(app, ["backend", "add", "personal", "--url", URL_A, "--token", "tokA"])
    runner.invoke(app, ["new", str(folder)])
    result = runner.invoke(app, ["board", str(folder)])
    assert result.exit_code == 0, result.output
    link = next(line for line in result.output.splitlines() if "#board=" in line)
    assert link.startswith("https://example.github.io/qa-chgk/b/?grid=5#board=")
    state = load_or_create_state(folder)
    assert state.board_token in link
    assert a.call("get_board", tid=state.tid, token=state.board_token)["ok"]
    calls = len(a.calls)
    runner.invoke(app, ["board", str(folder)])
    assert len(a.calls) == calls  # no backend call: the link is local


def test_new_tournament_is_view_only_shared(folder, backends):
    runner.invoke(app, ["backend", "add", "personal", "--url", URL_A, "--token", "tokA"])
    runner.invoke(app, ["new", str(folder)])
    state = load_or_create_state(folder)
    assert state.view_url == f"https://docs.google.com/spreadsheets/d/{state.spreadsheet_id}/htmlview"


def test_cli_view_prints_the_link_without_calling_the_backend(folder, backends):
    a, _ = backends
    runner.invoke(app, ["backend", "add", "personal", "--url", URL_A, "--token", "tokA"])
    assert runner.invoke(app, ["view", str(folder)]).exit_code == 1  # no Sheet yet
    runner.invoke(app, ["new", str(folder)])
    calls = len(a.calls)
    result = runner.invoke(app, ["view", str(folder)])
    assert result.exit_code == 0, result.output
    state = load_or_create_state(folder)
    assert f"https://docs.google.com/spreadsheets/d/{state.spreadsheet_id}/htmlview" in result.output
    assert len(a.calls) == calls


@pytest.mark.parametrize("command", ["board", "view", "teams"])
def test_cli_commands_that_need_new_write_nothing_before_it(folder, command):
    result = runner.invoke(app, [command, str(folder)])
    assert result.exit_code == 1 and "chgk new" in result.output
    assert not (folder / "state.json").exists()  # no tournament ID made up on the way


def test_a_url_with_a_trailing_newline_is_refused(tmp_path):
    profiles = Profiles(tmp_path / "backends.json")
    with pytest.raises(ValueError, match="not an Apps Script"):
        profiles.add(Profile("x", URL_A + "\n", "t"))


def test_the_admin_token_stays_out_of_repr_and_the_profiles_file_is_private(tmp_path):
    path = tmp_path / "backends.json"
    profiles = Profiles(path)
    profiles.add(Profile("x", URL_A, "very-secret"))
    profiles.save()
    assert "very-secret" not in repr(profiles.get("x"))
    assert path.stat().st_mode & 0o777 == 0o600


@respx.mock
def test_a_json_reply_that_is_no_object_is_a_backend_error():
    respx.post(URL_A).mock(return_value=httpx.Response(200, text="null"))
    with pytest.raises(BackendError, match="unexpected JSON"):
        BackendClient(URL_A, "t").call("ping")


@respx.mock
def test_a_payload_cannot_replace_the_token():
    route = respx.post(URL_A).mock(return_value=httpx.Response(200, json={"ok": True}))
    BackendClient(URL_A, "real").call("ping", token="other")
    assert json.loads(route.calls.last.request.content) == {"action": "ping", "token": "real"}


@respx.mock
def test_backend_add_refuses_a_bad_url_before_sending_the_token(backends):
    bad = "http://script.google.com.evil.example/exec"
    route = respx.post(bad).mock(return_value=httpx.Response(200, json={"ok": True}))
    result = runner.invoke(app, ["backend", "add", "x", "--url", bad, "--token", "t"])
    assert result.exit_code == 1
    assert not route.called
    assert "not an Apps Script" in result.output


def test_sync_teams_refuses_a_registered_team_on_a_reserve_id_before_changing_anything(folder, backends):
    a, _ = backends
    profiles = Profiles()
    profiles.add(Profile("personal", URL_A, "tokA"))
    profiles.save()
    state = new_tournament(folder, profiles.active()).state
    before = (folder / "teams.py").read_text(encoding="utf-8")
    a.set_cell(state.tid, "Teams", 2, 1, "R1")  # a registered team retyped as R1
    with pytest.raises(ValueError, match="kept for reserve"):
        sync_teams(folder, Profiles())
    assert (folder / "teams.py").read_text(encoding="utf-8") == before
    assert not sent(a, "set_teams")
