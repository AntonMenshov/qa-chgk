"""Team list: `tournaments/<slug>/teams.py`, a Python file like config.py.

    from chgk.teams import team

    teams = [
        team("42", id="645", logo="42.png"),
        team("Звезды сошлись", logo="zvezdy.png"),  # no id: one is assigned and written back
        team("Фиаско", id="58746", logo="fiasko.png", logo_grey=0.2),  # this logo's shade, not the tournament's
    ]

IDs end up in the cards' QR codes, so a team without one gets the next free A01, A02, …
written back into the file (which is then regenerated, without comments). `chgk teams`
also regenerates it from the Sheet's Teams tab.
"""

import json
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from chgk import run_python_file, write_file
from chgk.config import check_logo_grey
from chgk.ids import assign_team_ids
from chgk.state import load_state, remember_team_ids

TEAMS_FILE = "teams.py"


@dataclass(frozen=True)
class Team:
    team_id: str
    name: str
    city: str = ""
    logo_file: str = ""  # file name: tournament folder first, then the logos/ library
    reserve: bool = False  # a deck for a team that turns up unregistered; the jury names it later
    logo_grey: float | None = None  # the ink of this team's own logo; None: the tournament's CardFields.logo_grey


def team(name: str, id: str | None = None, city: str = "", logo: str = "", logo_grey: float | None = None) -> Team:
    """One entry in teams.py. Without `id` (e.g. the team's rating number) one is assigned."""
    if logo_grey is not None:
        check_logo_grey(logo_grey)
    return Team("" if id is None else str(id), name, city, logo, logo_grey=logo_grey)


def normalize_teams(teams: list[Team], source: str, taken: Iterable[str] = ()) -> list[Team]:
    """Assign the missing team IDs and strip spaces; every team needs a name (`source` names the list).

    `taken`: IDs the tournament used before (state.json), never given to a new team.
    """
    ids = assign_team_ids([t.team_id.strip() or None for t in teams], taken)
    out = []
    for t, team_id in zip(teams, ids, strict=True):
        name = t.name.strip()
        if not name:
            raise ValueError(f"{source}: team {team_id} has no name")
        out.append(Team(team_id, name, t.city.strip(), t.logo_file.strip(), logo_grey=t.logo_grey))
    return out


def reserve_teams(count: int, teams: list[Team]) -> list[Team]:
    """Reserve teams R1, R2, …: no name, no logo of their own. Their IDs must be free."""
    reserve = [Team(f"R{i}", "", reserve=True) for i in range(1, count + 1)]
    clash = sorted({t.team_id for t in teams} & {t.team_id for t in reserve})
    if clash:
        raise ValueError(
            f"team_id {', '.join(clash)} is kept for reserve teams: give that team another ID "
            "or lower reserve_teams in config.py"
        )
    return reserve


def read_teams(path: Path) -> list[Team]:
    """Run teams.py and return its `teams`; assign missing team IDs and write them back."""
    path = Path(path)
    if not path.is_file():
        raise ValueError(f"no {TEAMS_FILE} in {path.parent}")
    given = run_python_file(path).get("teams")
    if not isinstance(given, list) or not all(isinstance(t, Team) for t in given):
        raise ValueError(f"{path} must define `teams = [team(...), ...]`")
    if not given:
        raise ValueError(f"{path} has no teams")
    state = load_state(path.parent)
    teams = normalize_teams(given, str(path), state.used_team_ids if state else ())
    if teams != given:
        write_teams(path, teams)
    remember_team_ids(path.parent, [t.team_id for t in teams])
    return teams


def _py(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)  # a valid Python string literal, double-quoted


def write_teams(path: Path, teams: list[Team]) -> None:
    lines = [
        "# Teams of this tournament. A team without an id gets one assigned and written back",
        "# here; `chgk teams` rewrites this file from the Sheet's Teams tab.",
        "from chgk.teams import team",
        "",
        "teams = [",
    ]
    for t in teams:
        args = [_py(t.name), f"id={_py(t.team_id)}"]
        if t.city:
            args.append(f"city={_py(t.city)}")
        if t.logo_file:
            args.append(f"logo={_py(t.logo_file)}")
        if t.logo_grey is not None:
            args.append(f"logo_grey={t.logo_grey}")
        lines.append(f"    team({', '.join(args)}),")
    lines.append("]")
    write_file(path, "\n".join(lines) + "\n")
