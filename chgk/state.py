"""Generated per-tournament values in `tournaments/<slug>/state.json` (git-ignored).

Never hand-edited. Phase 2 adds the spreadsheet ID and the jury token here.
"""

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from chgk.ids import generate_tid

STATE_FILE = "state.json"


@dataclass
class State:
    tid: str
    spreadsheet_id: str | None = None
    jury_token: str | None = None


def load_or_create_state(folder: Path) -> State:
    path = Path(folder) / STATE_FILE
    if path.is_file():
        return State(**json.loads(path.read_text(encoding="utf-8")))
    state = State(tid=generate_tid())
    save_state(folder, state)
    return state


def save_state(folder: Path, state: State) -> None:
    (Path(folder) / STATE_FILE).write_text(json.dumps(asdict(state), indent=2) + "\n", encoding="utf-8")
