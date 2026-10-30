"""Tournament operations that talk to the Google backend: create, sync teams."""

from dataclasses import dataclass, replace
from pathlib import Path

from chgk.backend import BackendClient, Profile, Profiles
from chgk.cards.build import TEAMS_FILE
from chgk.config import load_config
from chgk.ids import assign_team_ids, generate_jury_token
from chgk.state import State, load_or_create_state, save_state
from chgk.teams import Team, load_teams_csv, write_teams_csv


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
    teams_csv = folder / TEAMS_FILE
    teams = load_teams_csv(teams_csv) if teams_csv.is_file() else []
    jury_token = state.jury_token or generate_jury_token()
    # Save the token first, so a retry after a timeout reuses it and the backend recognises the retry.
    state = replace(state, jury_token=jury_token)
    save_state(folder, state)

    reply = client.create_tournament(
        tid=state.tid, name=tournament.name, date=tournament.date.isoformat(),
        round_sizes=tournament.round_sizes, jury_token=jury_token, teams=_team_dicts(teams),
    )
    state = replace(
        state, backend_url=profile.url, backend_profile=profile.name, backend_account=account,
        spreadsheet_id=reply["spreadsheet_id"],
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
    """The Sheet's Teams tab is the source of truth: pull it into teams.csv.

    Teams added in the Sheet without a team_id get one, and the IDs are written back.
    """
    folder = Path(folder)
    state, default_client = tournament_client(folder, profiles)
    client = client or default_client
    rows = client.get_teams(state.tid)
    if not rows:
        raise ValueError("the Teams tab in the Sheet is empty")
    ids = assign_team_ids([(r.get("team_id") or "").strip() or None for r in rows])
    teams = []
    for row, team_id in zip(rows, ids):
        name = (row.get("name") or "").strip()
        if not name:
            raise ValueError(f"Teams tab: team {team_id} has no name")
        teams.append(Team(team_id, name, (row.get("city") or "").strip(), (row.get("logo_file") or "").strip()))
    write_teams_csv(folder / TEAMS_FILE, teams)
    client.set_teams(state.tid, _team_dicts(teams))  # writes assigned IDs back and adds rows on every tab
    return teams
