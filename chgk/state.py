"""Generated per-tournament values in `tournaments/<slug>/state.json` (git-ignored).

Never hand-edited. The backend fields are filled by `chgk new` (Phase 2) from the
active backend profile, so a tournament stays on the Google account it was created on.
"""

import json
from dataclasses import asdict, dataclass, fields
from pathlib import Path

from chgk.ids import JuryAccess, generate_tid

STATE_FILE = "state.json"


@dataclass
class State:
    tid: str
    backend_url: str | None = None  # Apps Script /exec URL
    backend_profile: str | None = None  # local profile name, e.g. "club"
    backend_account: str | None = None  # label only, e.g. "chgk.club@gmail.com"
    spreadsheet_id: str | None = None
    jury_token: str | None = None
    board_url: str | None = None  # projector view (Phase 5)

    @property
    def spreadsheet_url(self) -> str | None:
        return f"https://docs.google.com/spreadsheets/d/{self.spreadsheet_id}/edit" if self.spreadsheet_id else None

    @property
    def jury_access(self) -> JuryAccess | None:
        if self.backend_url and self.jury_token:
            return JuryAccess(self.tid, self.jury_token, self.backend_url)
        return None


def load_or_create_state(folder: Path) -> State:
    path = Path(folder) / STATE_FILE
    if path.is_file():
        data = json.loads(path.read_text(encoding="utf-8"))
        known = {f.name for f in fields(State)}
        return State(**{k: v for k, v in data.items() if k in known})
    state = State(tid=generate_tid())
    save_state(folder, state)
    return state


def save_state(folder: Path, state: State) -> None:
    (Path(folder) / STATE_FILE).write_text(json.dumps(asdict(state), indent=2) + "\n", encoding="utf-8")
