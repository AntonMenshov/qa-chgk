"""Generated per-tournament values in `tournaments/<slug>/state.json` (git-ignored).

Never hand-edited. `chgk new` fills the backend fields from the backend profile it uses,
so a tournament stays on the Google account it was created on.
"""

import json
from dataclasses import asdict, dataclass, field, fields, replace
from pathlib import Path
from typing import Any

from chgk import write_file
from chgk.ids import TID_RE, BoardAccess, JuryAccess, generate_tid

SHEETS_URL = "https://docs.google.com/spreadsheets/d/"
STATE_FILE = "state.json"


@dataclass(frozen=True)
class State:
    tid: str
    backend_url: str | None = None  # Apps Script /exec URL
    backend_profile: str | None = None  # local profile name, e.g. "club"
    backend_account: str | None = None  # label only, e.g. "chgk.club@gmail.com"
    spreadsheet_id: str | None = None
    public_id: str | None = None  # the public copy with the results only; older tournaments may have none
    jury_token: str | None = None
    board_token: str | None = None  # read-only token for the projector board
    # Each token replaced after a leaked link (`chgk replace-token`): {"which": "jury"|"board",
    # "at": "YYYY-MM-DDTHH:MM"}, oldest first. The jury sheet says what happened.
    replaced: list[dict[str, Any]] = field(default_factory=list)
    # A replacement under way: {"which": …, "token": …}, saved before the backend is called, so a
    # lost reply never leaves the live token only on the backend; a retry sends the same one.
    pending_token: dict[str, Any] | None = None
    # Every team ID this tournament has used: printed on cards, so never given to another team.
    used_team_ids: list[str] = field(default_factory=list)
    reserve_teams: int | None = None  # as at `chgk new`: the backend knows only those decks; None on older states

    @property
    def spreadsheet_url(self) -> str | None:
        return f"{SHEETS_URL}{self.spreadsheet_id}/edit" if self.spreadsheet_id else None

    @property
    def view_url(self) -> str | None:
        """Read-only page of the results for anyone with the link (Google's HTML view of the public copy)."""
        sheet = self.public_id or self.spreadsheet_id
        return f"{SHEETS_URL}{sheet}/htmlview" if sheet else None

    @property
    def board_access(self) -> BoardAccess | None:
        if self.backend_url and self.board_token:
            return BoardAccess(self.tid, self.board_token, self.backend_url)
        return None

    @property
    def jury_access(self) -> JuryAccess | None:
        if self.backend_url and self.jury_token:
            return JuryAccess(self.tid, self.jury_token, self.backend_url)
        return None


def load_state(folder: Path) -> State | None:
    """The tournament's state, or None if it has none yet (nothing is written)."""
    path = Path(folder) / STATE_FILE
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        known = {f.name for f in fields(State)}
        state = State(**{k: v for k, v in data.items() if k in known})
        if not TID_RE.fullmatch(state.tid):  # it goes into every card's QR code
            raise ValueError(f"tid {state.tid!r} is not 1-8 digits or capital Latin letters")
        return state
    except (ValueError, TypeError, AttributeError) as err:
        raise ValueError(f"{path} is broken ({err}): restore it from your copy") from err


def check_tid(state: State, tid: str | None) -> None:
    """A tournament ID given in config.py must be the one the tournament already has."""
    if tid and state.tid != tid:
        made = " and its Sheet" if state.spreadsheet_id else ""
        raise ValueError(
            f"config.py gives tid {tid}, but this tournament already has the ID {state.tid} "
            f"(state.json; in its printed cards{made}). Remove tid from config.py, or, if nothing "
            "was printed or created yet, delete state.json."
        )


def check_reserve(state: State, count: int) -> None:
    """Reserve decks added after `chgk new` would print, then be refused at their first scan."""
    if state.spreadsheet_id and state.reserve_teams is not None and state.reserve_teams != count:
        raise ValueError(
            f"config.py gives reserve_teams={count}, but this tournament was created with {state.reserve_teams}, "
            "and the backend knows only those decks. Put the number back, or recreate the tournament."
        )


def new_id_warning(folder: Path, slug: str, state: State) -> str:
    """Printouts exist, but state.json was missing: the ID just made isn't the one on those cards."""
    return (
        f"no state.json in {folder}: this is a new tournament ID ({state.tid}), so cards printed "
        f"earlier (out/{slug}/) won't scan into it. Restore state.json if you have it."
    )


def load_or_create_state(folder: Path, tid: str | None = None) -> State:
    """The tournament's state; a new one if it has none yet, with `tid` (from config.py) or a fresh ID."""
    state = load_state(folder)
    if state is not None:
        check_tid(state, tid)
        return state
    state = State(tid=tid or generate_tid())
    save_state(folder, state)
    return state


def remember_team_ids(folder: Path, team_ids: list[str]) -> None:
    """Note these IDs as used, if this tournament has a state yet (before that nothing is printed)."""
    state = load_state(folder)
    if state is not None and not set(team_ids) <= set(state.used_team_ids):
        save_state(folder, replace(state, used_team_ids=sorted({*state.used_team_ids, *team_ids})))


def save_state(folder: Path, state: State) -> None:
    write_file(Path(folder) / STATE_FILE, json.dumps(asdict(state), indent=2) + "\n", private=True)  # holds tokens
