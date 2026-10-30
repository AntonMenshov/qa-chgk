"""Team list. Until the Google Sheet backend exists (Phase 2) it comes from
`tournaments/<slug>/teams.csv` with columns: team_id, name, city, logo_file."""

import csv
from dataclasses import dataclass
from pathlib import Path

from chgk.ids import assign_team_ids

COLUMNS = ["team_id", "name", "city", "logo_file"]


@dataclass(frozen=True)
class Team:
    team_id: str
    name: str
    city: str = ""
    logo_file: str = ""  # path relative to the tournament folder
    reserve: bool = False  # a deck for a team that turns up unregistered; the jury names it later


def reserve_teams(count: int, teams: list[Team]) -> list[Team]:
    """Reserve teams R1, R2, …: no name, no logo of their own. Their IDs must be free."""
    reserve = [Team(f"R{i}", "", reserve=True) for i in range(1, count + 1)]
    clash = sorted({t.team_id for t in teams} & {t.team_id for t in reserve})
    if clash:
        raise ValueError(f"team_id {', '.join(clash)} is kept for reserve teams: give that team another ID "
                         "or lower reserve_teams in config.py")
    return reserve


def load_teams_csv(path: Path) -> list[Team]:
    """Read teams; assign missing team_ids and write them back so they stay stable."""
    path = Path(path)
    # utf-8-sig: Excel and Google Sheets exports often start with a BOM.
    with path.open(encoding="utf-8-sig", newline="") as f:
        rows = [
            row
            for row in csv.DictReader(f)
            # Extra cells beyond the header land under the key None as a list; ignore them.
            if any(isinstance(v, str) and v.strip() for k, v in row.items() if k is not None)
        ]
    if not rows:
        raise ValueError(f"{path} has no teams")
    if "name" not in rows[0]:
        raise ValueError(f"{path} needs a 'name' column")

    existing = [(row.get("team_id") or "").strip() or None for row in rows]
    ids = assign_team_ids(existing)  # keeps given IDs (upper-cased), fills in the blanks
    teams = []
    for row, team_id in zip(rows, ids):
        name = (row.get("name") or "").strip()
        if not name:
            raise ValueError(f"{path}: team {team_id} has no name")
        teams.append(Team(team_id, name, (row.get("city") or "").strip(), (row.get("logo_file") or "").strip()))

    if ids != existing:
        write_teams_csv(path, teams)
    return teams


def write_teams_csv(path: Path, teams: list[Team]) -> None:
    with Path(path).open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, lineterminator="\n")  # git-friendly; Excel reads it too
        writer.writerow(COLUMNS)
        for t in teams:
            writer.writerow([t.team_id, t.name, t.city, t.logo_file])
