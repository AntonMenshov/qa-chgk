"""The live check after a backend deploy: `uv run python scripts/live_check.py`.

Runs against the active backend profile, on throwaway tournaments it creates and deletes. Their
Drive folders stay in the bin for 30 days, and their IDs stay refused. Edits typed in the Sheet
need a person: docs/manual-checks.md. Exits 1 if anything failed.
"""

import base64
import io
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
from datetime import date
from pathlib import Path
from urllib.parse import quote

import httpx
from PIL import Image

from chgk import out_dir
from chgk.backend import BackendClient, BackendError, Profiles
from chgk.state import load_state

SHEETS = "https://docs.google.com/spreadsheets/d"
TIMER_LIMIT_S = 300
PAUSE_S = 32  # PUBLISH_EVERY_MS in apps_script/results.js, and a little
failures = 0


def check(name, passed, detail=""):
    global failures
    failures += not passed
    print("PASS" if passed else "FAIL", name, detail, flush=True)


def chgk(*args):
    done = subprocess.run(["uv", "run", "chgk", *map(str, args)], capture_output=True, text=True, input="\n")
    return done.returncode, done.stdout + done.stderr


def now_ms():
    return int(time.time() * 1000)


def event(team, question, status, client_ts=None):
    return {
        "scan_id": uuid.uuid4().hex,
        "team_id": team,
        "question": question,
        "status": status,
        "client_ts": client_ts or now_ms() - 1000,
        "juror": "check",
        "device": "cli",
    }


class Throwaway:
    """A tournament on the real backend, in a temporary folder."""

    def __init__(self, parent, slug, team_rows):
        self.folder = Path(parent) / slug
        self.folder.mkdir()
        self.slug = slug
        self.write_config()
        teams = "".join(f"    team({name!r}, id={team_id!r}),\n" for team_id, name in team_rows)
        (self.folder / "teams.py").write_text(f"from chgk.teams import team\n\nteams = [\n{teams}]\n", encoding="utf-8")
        code, output = chgk("new", self.folder)
        check(f"{slug}: created", code == 0, "" if code == 0 else output[-200:])
        self.state = load_state(self.folder)
        self.tid = self.state.tid
        self.jury = BackendClient(self.state.backend_url, self.state.jury_token)
        self.board = BackendClient(self.state.backend_url, self.state.board_token)
        self.web = httpx.Client(follow_redirects=True, timeout=60)

    def write_config(self, extra=""):
        (self.folder / "config.py").write_text(
            f"""from datetime import date

from chgk.config import Tournament

tournament = Tournament(
    {extra}slug={self.slug!r},
    name="Check live",
    date=date({date.today().year}, 12, 31),
    rounds=2,
    questions_per_round=3,
    scanner_url="https://example.github.io/qa-chgk/s/",
)
""",
            encoding="utf-8",
        )

    def record(self, *events):
        return self.jury.call("record_events", tid=self.tid, events=list(events))

    def order(self):
        reply = self.jury.call("get_results", tid=self.tid)
        return [(row["team_id"], row["total"], row["place"]) for row in reply["standings"]]

    def public_summary(self):
        tab = quote("Итоги")
        return self.web.get(f"{SHEETS}/{self.state.public_id}/gviz/tq?tqx=out:csv&sheet={tab}").text

    def delete(self):
        code, output = chgk("delete", self.folder, "--yes")
        check(f"{self.slug}: deleted", code == 0, output[-100:].strip())
        shutil.rmtree(out_dir(self.slug), ignore_errors=True)


def check_sharing(t):
    state = t.state
    check("real Sheet and public copy differ", bool(state.public_id) and state.public_id != state.spreadsheet_id)
    reply = t.web.get(f"{SHEETS}/{state.public_id}/export?format=xlsx")
    names = []
    if reply.status_code == 200 and reply.content[:2] == b"PK":
        workbook = zipfile.ZipFile(io.BytesIO(reply.content)).read("xl/workbook.xml").decode()
        names = re.findall(r'<sheet [^>]*name="([^"]+)"', workbook)
    check("public download holds only the results tabs", names == ["Итоги", "Тур 1", "Тур 2", "Статистика"], names)
    reply = t.web.get(f"{SHEETS}/{state.spreadsheet_id}/export?format=xlsx")
    check(
        "real Sheet refuses anonymous", not (reply.status_code == 200 and reply.content[:2] == b"PK"), reply.status_code
    )


def check_marks_and_sorting(t):
    reply = t.record(event("A02", 1, "correct"), event("A02", 2, "correct"), event("007", 1, "correct"))
    check("marks applied", all(r.get("applied") for r in reply["results"]), reply["timing"]["total"])
    order = t.order()
    check("Итоги sorted after a reorder", [row[0] for row in order] == ["A02", "007", "A01"], order)
    t.record(event("A01", 4, "correct"), event("A01", 5, "correct"), event("A01", 6, "correct"))
    order = t.order()
    check("Итоги sorted again", [row[0] for row in order] == ["A01", "A02", "007"], order)


def check_clock_cap(t):
    t.record(event("A02", 3, "correct", now_ms() + 3 * 3600 * 1000))
    time.sleep(1)
    t.record(event("A02", 3, "incorrect"))
    marks = t.jury.call("get_state", tid=t.tid)["marks"]["A02"]
    check("a fast clock loses to a later mark", marks[2] == 0, marks)


def check_reserve_decks_stay_off(t):
    teams = t.jury.call("get_state", tid=t.tid)["teams"]
    on_tabs = {row["team_id"]: row["on_tabs"] for row in teams}
    check(
        "reserve decks stay off the tabs",
        on_tabs == {"007": True, "A01": True, "A02": True, "R1": False, "R2": False},
        on_tabs,
    )


def check_photo(t):
    buffer = io.BytesIO()
    Image.new("RGB", (200, 200), "white").save(buffer, "JPEG")
    reply = t.jury.call(
        "upload_photo",
        tid=t.tid,
        photo_id=uuid.uuid4().hex,
        team_id="007",
        question=1,
        client_ts=now_ms(),
        juror="check",
        device="cli",
        image=base64.b64encode(buffer.getvalue()).decode(),
    )
    check("photo saved", bool(reply.get("url")), reply["timing"]["total"])
    answer = t.web.get(reply["url"])
    check("photo link private", answer.status_code != 200 or "accounts.google" in str(answer.url))


def check_read_publishes(t):
    time.sleep(PAUSE_S)
    reply = t.board.call("get_board", tid=t.tid)
    check("board links the public copy", t.state.public_id in reply["view_url"])
    check("a read publishes after the pause", "publish" in reply["timing"], reply["timing"].get("publish"))
    time.sleep(3)
    summary = t.public_summary()
    check("public copy has the marks", '"A01","Альфа","0","3"' in summary, summary[:150].replace("\n", " | "))


def check_wrong_token(t):
    try:
        BackendClient(t.state.backend_url, "wrong-token-0123456789").call("get_state", tid=t.tid)
        check("wrong token refused", False)
    except BackendError as err:
        check("wrong token refused", err.code == "jury_token_refused", err.code)


def check_timer(t):
    """With nothing polling, only the one-off timer can publish."""
    before = t.public_summary()
    check("public copy shows a shared place as text", '"1-2"' in before, before[:150].replace("\n", " | "))
    t.record(event("A02", 1, "correct"), event("A02", 2, "correct"))
    start = time.time()
    while time.time() - start < TIMER_LIMIT_S:
        time.sleep(10)
        if t.public_summary() != before:
            check("the timer published with nobody polling", True, f"after {round(time.time() - start)} s")
            return
    check("the timer published with nobody polling", False)


def check_commands(t):
    code, output = chgk("results-copy", t.folder)
    check("results-copy updates a copy that exists", code == 0 and "updated" in output, output[-100:].strip())
    t.write_config("reserve_teams=5,\n    ")
    code, output = chgk("teams", t.folder)
    check("a changed reserve count is refused", code != 0 and "reserve_teams=5" in output, output[-120:].strip())
    t.write_config()
    code, output = chgk("teams", t.folder)
    check("chgk teams runs", code == 0, output[-90:].strip())
    admin = BackendClient(t.state.backend_url, Profiles().active().admin_token)
    alpha = {"team_id": "A01", "name": "Альфа", "city": "", "logo_file": ""}
    beta = {"team_id": "A02", "name": "Бета", "city": "", "logo_file": ""}
    reply = admin.set_teams(t.tid, [alpha])
    check("set_teams names a team off the Teams tab", reply.get("off_teams") == ["A02"], reply.get("off_teams"))
    admin.set_teams(t.tid, [alpha, beta])


def check_deleted_id(t):
    t.delete()
    try:
        t.jury.call("delete_tournament", tid=t.tid)
        check("a repeated delete has its reason code", False)
    except BackendError as err:
        check("a repeated delete has its reason code", err.code == "unknown_tournament", err.code)
    t.write_config(f"tid={t.tid!r},\n    ")
    code, output = chgk("new", t.folder)
    check("a deleted ID is refused", code != 0 and "belonged to a deleted" in output, output[-100:].strip())
    check("a refused ID leaves no state.json", not (t.folder / "state.json").exists())
    shutil.rmtree(out_dir(t.slug), ignore_errors=True)


def main():
    code, output = chgk("backend", "check")
    print(output.strip())
    check("backend check is clean", code == 0)
    with tempfile.TemporaryDirectory() as parent:
        t = Throwaway(parent, "check-live", [("A01", "Альфа"), ("A02", "Бета"), ("007", "Гамма")])
        try:
            check_sharing(t)
            check_marks_and_sorting(t)
            check_clock_cap(t)
            check_reserve_decks_stay_off(t)
            check_photo(t)
            check_read_publishes(t)
            check_wrong_token(t)
        finally:
            t.delete()
        t = Throwaway(parent, "check-timer", [("A01", "Альфа"), ("A02", "Бета")])
        try:
            check_timer(t)
            check_commands(t)
        finally:
            check_deleted_id(t)
    print(f"{failures} failed" if failures else "All passed.")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
