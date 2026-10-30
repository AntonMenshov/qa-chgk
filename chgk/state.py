"""Generated per-tournament values in `tournaments/<slug>/state.json` (git-ignored).

Never hand-edited. `chgk new` fills the backend fields from the backend profile it uses,
so a tournament stays on the Google account it was created on.
"""

import json
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

from chgk.ids import BoardAccess, JuryAccess, generate_tid

STATE_FILE = "state.json"


@dataclass
class State:
    tid: str
    backend_url: str | None = None  # Apps Script /exec URL
    backend_profile: str | None = None  # local profile name, e.g. "club"
    backend_account: str | None = None  # label only, e.g. "chgk.club@gmail.com"
    spreadsheet_id: str | None = None
    jury_token: str | None = None
    board_token: str | None = None  # read-only token for the projector board
    # Each token replaced after a leaked link (`chgk replace-token`): {"which": "jury"|"board",
    # "at": "YYYY-MM-DDTHH:MM"}, oldest first. The jury sheet says what happened.
    replaced: list[dict] = field(default_factory=list)

    @property
    def spreadsheet_url(self) -> str | None:
        return f"https://docs.google.com/spreadsheets/d/{self.spreadsheet_id}/edit" if self.spreadsheet_id else None

    @property
    def view_url(self) -> str | None:
        """Read-only page of the Sheet for anyone with the link (Google's HTML view)."""
        if self.spreadsheet_id:  # shared "anyone with the link can view" when created
            return f"https://docs.google.com/spreadsheets/d/{self.spreadsheet_id}/htmlview"
        return None

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
    data = json.loads(path.read_text(encoding="utf-8"))
    known = {f.name for f in fields(State)}
    return State(**{k: v for k, v in data.items() if k in known})


def load_or_create_state(folder: Path) -> State:
    """The tournament's state; a new one with a fresh tournament ID if it has none yet."""
    state = load_state(folder)
    if state is not None:
        return state
    state = State(tid=generate_tid())
    save_state(folder, state)
    return state


def save_state(folder: Path, state: State) -> None:
    (Path(folder) / STATE_FILE).write_text(json.dumps(asdict(state), indent=2) + "\n", encoding="utf-8")
