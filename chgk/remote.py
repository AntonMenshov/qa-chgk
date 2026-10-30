"""Tournament operations that talk to the Google backend: create, sync teams, replace a leaked token."""

from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path

from chgk.backend import BackendClient, Profile, Profiles
from chgk.config import load_config
from chgk.ids import generate_jury_token
from chgk.state import State, load_or_create_state, load_state, save_state
from chgk.teams import TEAMS_FILE, Team, normalize_teams, read_teams, reserve_teams, write_teams


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
    state = load_state(folder)
    if state and state.spreadsheet_id:
        return NewResult(state, created=False)
    # teams.py first: without it nothing is created (the jury sheet needs the teams too).
    teams = read_teams(folder / TEAMS_FILE)
    state = load_or_create_state(folder)

    client = client or BackendClient(profile.url, profile.admin_token)
    account = profile.account or client.ping().get("account", "")
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
    )
    save_state(folder, state)
    return NewResult(state, created=not reply.get("existed", False))


def tournament_client(folder: Path, profiles: Profiles) -> tuple[State, BackendClient]:
    """Client for the backend this tournament was created on (not necessarily the active profile)."""
    state = load_state(folder)
    if state is None or not state.backend_url:
        raise ValueError("this tournament has no backend yet: run `chgk new` first")
    profile = profiles.by_url(state.backend_url)
    return state, BackendClient(profile.url, profile.admin_token)


def _local_teams(path: Path) -> list[Team]:
    """The teams in teams.py, or none if it is missing or broken (the Sheet's list replaces it)."""
    try:
        return read_teams(path)
    except ValueError:
        return []


def sync_teams(folder: Path, profiles: Profiles, client: BackendClient | None = None) -> list[Team]:
    """The Sheet's Teams tab is the source of truth: pull it into teams.py.

    Teams added in the Sheet without a team_id get one, and the IDs are written back.
    Reserve teams (R1, R2, …) stay on the backend: the jury names them in the Sheet.
    A team with no logo in the Sheet keeps the one teams.py gives it (set locally, e.g. by
    `chgk logos --accept`); a logo in the Sheet wins.
    """
    folder = Path(folder)
    state, default_client = tournament_client(folder, profiles)
    client = client or default_client
    rows = [r for r in client.get_teams(state.tid) if not r.get("reserve")]
    if not rows:
        raise ValueError("the Teams tab in the Sheet is empty")
    given = [Team(*(r.get(k) or "" for k in ("team_id", "name", "city", "logo_file"))) for r in rows]
    local = {t.team_id: t.logo_file for t in _local_teams(folder / TEAMS_FILE)}
    teams = [
        t if t.logo_file else replace(t, logo_file=local.get(t.team_id, ""))
        for t in normalize_teams(given, "Teams tab")
    ]
    write_teams(folder / TEAMS_FILE, teams)
    client.set_teams(state.tid, _team_dicts(teams))  # writes assigned IDs back and adds rows on every tab
    return teams


TOKEN_KINDS = ("jury", "board")


def replace_token(folder: Path, which: str, profiles: Profiles, client: BackendClient | None = None) -> State:
    """A leaked jury or board link: give the tournament a new token; the old one stops working at once.

    The backend switches first, then state.json records the new token and the replacement
    (time and kind). If the reply is lost, running it again simply sets another new token.
    """
    if which not in TOKEN_KINDS:
        raise ValueError(f"which token? one of {', '.join(TOKEN_KINDS)}, got {which!r}")
    folder = Path(folder)
    state, default_client = tournament_client(folder, profiles)
    token = generate_jury_token()
    (client or default_client).replace_token(state.tid, which, token)
    record = {"which": which, "at": datetime.now().strftime("%Y-%m-%dT%H:%M")}
    state = replace(state, **{f"{which}_token": token}, replaced=[*state.replaced, record])
    save_state(folder, state)
    return state
