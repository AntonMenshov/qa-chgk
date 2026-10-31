"""Tournament operations that talk to the Google backend: create, sync teams, replace a leaked token."""

from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Any

from chgk.backend import BackendClient, BackendError, Profile, Profiles
from chgk.config import load_config
from chgk.ids import generate_jury_token
from chgk.state import (
    STATE_FILE,
    State,
    check_reserve,
    check_tid,
    load_or_create_state,
    load_state,
    remember_team_ids,
    save_state,
)
from chgk.teams import TEAMS_FILE, Team, normalize_teams, read_teams, reserve_teams, write_teams


@dataclass(frozen=True)
class NewResult:
    state: State
    created: bool  # False if the tournament already existed on its backend


def _team_dicts(teams: list[Team]) -> list[dict[str, Any]]:
    return [{"team_id": t.team_id, "name": t.name, "city": t.city, "logo_file": t.logo_file} for t in teams]


def new_tournament(folder: Path, profile: Profile, client: BackendClient | None = None) -> NewResult:
    """Create the tournament's Sheet and Drive folder on `profile`'s backend and record it in state.json.

    Idempotent: a tournament that already has a spreadsheet is left on its own backend.
    """
    folder = Path(folder)
    tournament = load_config(folder)
    state = load_state(folder)
    if state and state.spreadsheet_id:
        check_tid(state, tournament.tid)
        return NewResult(state, created=False)
    # teams.py first: without it nothing is created (the jury sheet needs the teams too).
    teams = read_teams(folder / TEAMS_FILE)
    state = load_or_create_state(folder, tournament.tid)
    remember_team_ids(folder, [t.team_id for t in teams])
    state = replace(state, used_team_ids=sorted({*state.used_team_ids, *(t.team_id for t in teams)}))

    client = client or BackendClient(profile.url, profile.admin_token)
    account = profile.account or client.ping().get("account", "")
    reserve = reserve_teams(tournament.reserve_teams, teams)
    jury_token = state.jury_token or generate_jury_token()
    board_token = state.board_token or generate_jury_token()
    # Save the tokens first, so a retry after a timeout reuses them and the backend recognises the retry.
    state = replace(state, jury_token=jury_token, board_token=board_token, reserve_teams=tournament.reserve_teams)
    save_state(folder, state)

    try:
        reply = client.create_tournament(
            tid=state.tid,
            name=tournament.name,
            date=tournament.date.isoformat(),
            round_sizes=tournament.round_sizes,
            jury_token=jury_token,
            teams=_team_dicts(teams),
            reserve=[t.team_id for t in reserve],
            board_token=board_token,
        )
    except BackendError as err:
        if "belonged to a deleted tournament" in str(err) or "already exists" in str(err):
            # An ID this tournament can't have, and nothing was made with it: kept, state.json would bring it back.
            (folder / STATE_FILE).unlink()
        raise
    state = replace(
        state,
        backend_url=profile.url,
        backend_profile=profile.name,
        backend_account=account,
        spreadsheet_id=reply["spreadsheet_id"],
        public_id=reply.get("public_id"),
    )
    save_state(folder, state)
    return NewResult(state, created=not reply.get("existed", False))


def tournament_client(folder: Path, profiles: Profiles) -> tuple[State, BackendClient]:
    """Client for the backend this tournament was created on (not necessarily the active profile)."""
    state = load_state(folder)
    if state:
        check_tid(state, load_config(folder).tid)  # or `chgk delete` could delete the other tournament
    if state is None or not state.backend_url:
        raise ValueError("this tournament has no backend yet: run `chgk new` first")
    profile = profiles.by_url(state.backend_url)
    return state, BackendClient(profile.url, profile.admin_token)


def _local_teams(path: Path) -> list[Team]:
    """The teams in teams.py, or none if it is missing (the Sheet's list replaces it).

    A broken file is refused: only it holds the local logos and logo_grey.
    """
    if not Path(path).is_file():
        return []
    try:
        return read_teams(path)
    except ValueError as err:
        raise ValueError(f"{err}. Fix it, or delete it to take the Sheet's list as it is") from err


def sync_teams(
    folder: Path, profiles: Profiles, client: BackendClient | None = None, warnings: list[str] | None = None
) -> list[Team]:
    """The Sheet's Teams tab is the source of truth: pull it into teams.py.

    Teams added in the Sheet without a team_id get one, and the IDs are written back.
    Reserve teams (R1, R2, …) stay on the backend: the jury names them in the Sheet.
    A team with no logo in the Sheet keeps the one teams.py gives it (set locally, e.g. by
    `chgk logos --accept`); a logo in the Sheet wins. A team's logo_grey is only ever in teams.py.
    A team whose ID was changed in the Sheet is found by its name. `warnings` collects what
    needs the organiser's eye: a local logo left behind, a team only on the other tabs.
    """
    warnings = warnings if warnings is not None else []
    folder = Path(folder)
    state, default_client = tournament_client(folder, profiles)
    client = client or default_client
    rows = [r for r in client.get_teams(state.tid) if not r.get("reserve")]
    if not rows:
        raise ValueError("the Teams tab in the Sheet is empty")
    given = [
        Team(r.get("team_id") or "", r.get("name") or "", r.get("city") or "", r.get("logo_file") or "") for r in rows
    ]
    mine_teams = _local_teams(folder / TEAMS_FILE)
    local = {t.team_id: t for t in mine_teams}
    on_sheet = {t.team_id for t in given}
    by_name = {t.name: t for t in mine_teams if t.team_id not in on_sheet}  # a row renamed or with its ID blanked
    used = (load_state(folder) or state).used_team_ids  # reading teams.py just noted its IDs
    teams = []
    kept = set()
    for t in normalize_teams(given, "Teams tab", used):
        mine = local.get(t.team_id) or by_name.get(t.name)
        if mine:
            kept.add(mine.team_id)
        teams.append(replace(t, logo_file=t.logo_file or mine.logo_file, logo_grey=mine.logo_grey) if mine else t)
    for t in mine_teams:
        if t.team_id not in kept and (t.logo_file or t.logo_grey is not None):
            warnings.append(
                f"{t.team_id} {t.name!r} is no longer on the Teams tab: its logo {t.logo_file!r} left teams.py"
            )
    listed = {t.team_id for t in teams}
    on_tabs = client.get_state(state.tid).get("teams", [])
    gone = [t["team_id"] for t in on_tabs if not t.get("reserve") and t["team_id"] not in listed]
    if gone:
        warnings.append(
            f"still on the tabs but not on Teams: {', '.join(gone)}. If they withdrew, delete their rows on «Итоги» "
            "and the round tabs by hand, then run `chgk results-copy` to update the public copy; their marks stay "
            "in the Log."
        )
    config = load_config(folder)
    check_reserve(state, config.reserve_teams)
    reserve_teams(config.reserve_teams, teams)  # R1, R2, … are printed on the reserve decks
    client.set_teams(state.tid, _team_dicts(teams))  # writes assigned IDs back and adds rows on every tab
    write_teams(folder / TEAMS_FILE, teams)  # only once the Sheet has the same IDs
    remember_team_ids(folder, [t.team_id for t in teams])
    return teams


def make_results_copy(folder: Path, profiles: Profiles) -> State:
    """Publish the public copy now; a tournament made before public copies gets one, its real Sheet private."""
    folder = Path(folder)
    state, client = tournament_client(folder, profiles)
    state = replace(state, public_id=client.make_public_copy(state.tid)["public_id"])
    save_state(folder, state)
    return state


def delete_tournament(folder: Path, profiles: Profiles) -> State:
    """The Drive folder to the bin, the Sheet's trigger removed, the backend forgets it; then state.json goes."""
    folder = Path(folder)
    state, client = tournament_client(folder, profiles)
    try:
        client.delete_tournament(state.tid)
    except BackendError as err:
        if "unknown tournament" not in str(err):  # else: an earlier try did it, only its reply was lost
            raise
    (folder / STATE_FILE).unlink()
    return state


TOKEN_KINDS = ("jury", "board")


def replace_token(folder: Path, which: str, profiles: Profiles, client: BackendClient | None = None) -> State:
    """A leaked jury or board link: give the tournament a new token; the old one stops working at once.

    The new token goes into state.json first, then to the backend, then counts as replaced (time
    and kind). If the reply is lost, running it again sends the same token, so nothing is locked out.
    """
    if which not in TOKEN_KINDS:
        raise ValueError(f"which token? one of {', '.join(TOKEN_KINDS)}, got {which!r}")
    folder = Path(folder)
    state, default_client = tournament_client(folder, profiles)
    pending = state.pending_token or {}
    if pending and pending.get("which") != which:
        raise ValueError(
            f"replacing the {pending.get('which')} token didn't finish: run `chgk replace-token` for it first, "
            "or its new token would be lost"
        )
    token = pending["token"] if pending.get("which") == which else generate_jury_token()
    save_state(folder, replace(state, pending_token={"which": which, "token": token}))
    (client or default_client).replace_token(state.tid, which, token)
    record = {"which": which, "at": datetime.now().strftime("%Y-%m-%dT%H:%M")}
    state = replace(state, replaced=[*state.replaced, record], pending_token=None)
    state = replace(state, jury_token=token) if which == "jury" else replace(state, board_token=token)
    save_state(folder, state)
    return state
