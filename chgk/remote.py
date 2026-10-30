"""Tournament operations that talk to the Google backend: create, sync teams."""

from dataclasses import dataclass, replace
from pathlib import Path

from chgk.backend import BackendClient, Profile, Profiles
from chgk.config import load_config
from chgk.ids import assign_team_ids, generate_jury_token
from chgk.state import State, load_or_create_state, save_state
from chgk.teams import TEAMS_FILE, Team, read_teams, reserve_teams, write_teams


@dataclass(frozen=True)
class NewResult:
    state: State
    created: bool  # False if the tournament already existed on its backend


def _team_dicts(teams: list[Team]) -> list[dict]:
    return [{"team_id": t.team_id, "name": t.name, "city": t.city, "logo_file": t.logo_file} for t in teams]


def new_tournament(folder: Path, profile: Profile, client: BackendClient | None = None) -> NewResult:
    """Create the tournament's Sheet and Drive folder on `profile`'s backend and record it in state.json.

    Idempotent: a tournament that already has a spreadsheet is left on its own backend.
    """
    folder = Path(folder)
    tournament = load_config(folder)
    state = load_or_create_state(folder)
    if state.spreadsheet_id:
        return NewResult(state, created=False)

    client = client or BackendClient(profile.url, profile.admin_token)
    account = profile.account or client.ping().get("account", "")
    teams_file = folder / TEAMS_FILE
    teams = read_teams(teams_file) if teams_file.is_file() else []
    reserve = reserve_teams(tournament.reserve_teams, teams)
    jury_token = state.jury_token or generate_jury_token()
    board_token = state.board_token or generate_jury_token()
    # Save the tokens first, so a retry after a timeout reuses them and the backend recognises the retry.
    state = replace(state, jury_token=jury_token, board_token=board_token)
    save_state(folder, state)

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
    state = replace(
        state,
        backend_url=profile.url,
        backend_profile=profile.name,
        backend_account=account,
        spreadsheet_id=reply["spreadsheet_id"],
        view_shared=True,  # create_tournament shares it view-only
    )
    save_state(folder, state)
    return NewResult(state, created=not reply.get("existed", False))


def tournament_client(folder: Path, profiles: Profiles) -> tuple[State, BackendClient]:
    """Client for the backend this tournament was created on (not necessarily the active profile)."""
    state = load_or_create_state(folder)
    if not state.backend_url:
        raise ValueError("this tournament has no backend yet: run `chgk new` first")
    profile = profiles.by_url(state.backend_url)
    return state, BackendClient(profile.url, profile.admin_token)


def sync_teams(folder: Path, profiles: Profiles, client: BackendClient | None = None) -> list[Team]:
    """The Sheet's Teams tab is the source of truth: pull it into teams.py.

    Teams added in the Sheet without a team_id get one, and the IDs are written back.
    Reserve teams (R1, R2, …) stay on the backend: the jury names them in the Sheet.
    """
    folder = Path(folder)
    state, default_client = tournament_client(folder, profiles)
    client = client or default_client
    rows = [r for r in client.get_teams(state.tid) if not r.get("reserve")]
    if not rows:
        raise ValueError("the Teams tab in the Sheet is empty")
    ids = assign_team_ids([(r.get("team_id") or "").strip() or None for r in rows])
    teams = []
    for row, team_id in zip(rows, ids, strict=True):
        name = (row.get("name") or "").strip()
        if not name:
            raise ValueError(f"Teams tab: team {team_id} has no name")
        teams.append(Team(team_id, name, (row.get("city") or "").strip(), (row.get("logo_file") or "").strip()))
    write_teams(folder / TEAMS_FILE, teams)
    client.set_teams(state.tid, _team_dicts(teams))  # writes assigned IDs back and adds rows on every tab
    return teams


def ensure_board(folder: Path, profiles: Profiles, client: BackendClient | None = None) -> State:
    """Give the tournament a read-only board token (tournaments created before Phase 5 have none)."""
    folder = Path(folder)
    state, default_client = tournament_client(folder, profiles)
    if state.board_token:
        return state
    client = client or default_client
    state = replace(state, board_token=generate_jury_token())
    client.set_board_token(state.tid, state.board_token)
    save_state(folder, state)
    return state


def ensure_view(folder: Path, profiles: Profiles, client: BackendClient | None = None) -> State:
    """Share the Sheet view-only with anyone who has the link and hide the service tabs.

    New tournaments get both at creation; this is for older ones. Safe to repeat.
    """
    folder = Path(folder)
    state, default_client = tournament_client(folder, profiles)
    (client or default_client).share_view(state.tid)
    state = replace(state, view_shared=True)
    save_state(folder, state)
    return state
