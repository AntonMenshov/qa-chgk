"""Google backends: named local profiles (one per Google account) and the HTTP client.

Profiles live outside the repo in `~/.config/chgk/backends.json` (override the folder
with CHGK_CONFIG_DIR), so switching Google accounts never touches git. See SPEC §3.1.
"""

import hashlib
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path

import httpx

from chgk.ids import BACKEND_URL_RE

APPS_SCRIPT_DIR = Path(__file__).resolve().parent.parent / "apps_script"
BUNDLE_SOURCES = ["logic.js", "Code.js"]
# Code.js goes first in the bundle: the editor's Run button starts on the file's first
# function, which must be setup(). Neither file runs the other's code at load time.
BUNDLE_ORDER = ["Code.js", "logic.js"]


PERMISSIONS_HINT = (
    "The script is missing a Google permission. In the script editor, pick `setup`, press Run and, "
    "on Google's consent screen, tick 'Select all' (Sheets, Drive and triggers). See docs/google-account.md."
)


SHEETS_API_HINT = (
    "The script's 'Google Sheets API' service is off, so every request takes ~2 s longer. In the script "
    "editor: Services (+) → Google Sheets API → Add, then Deploy → Manage deployments → edit → New version. "
    "See docs/google-account.md."
)


class BackendError(RuntimeError):
    """The backend refused a request or could not be reached."""


@dataclass(frozen=True)
class Profile:
    name: str
    url: str
    admin_token: str
    account: str = ""  # label only, e.g. the Gmail address


def config_dir() -> Path:
    return Path(os.environ.get("CHGK_CONFIG_DIR") or Path.home() / ".config" / "chgk")


class Profiles:
    def __init__(self, path: Path | None = None):
        self.path = path or config_dir() / "backends.json"
        data = json.loads(self.path.read_text(encoding="utf-8")) if self.path.is_file() else {}
        self.active_name: str | None = data.get("active")
        self.profiles = {name: Profile(name=name, **p) for name, p in data.get("profiles", {}).items()}

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "active": self.active_name,
            "profiles": {n: {k: v for k, v in asdict(p).items() if k != "name"} for n, p in self.profiles.items()},
        }
        self.path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        self.path.chmod(0o600)  # holds admin tokens

    def add(self, profile: Profile, activate: bool = True) -> None:
        if not BACKEND_URL_RE.match(profile.url):
            raise ValueError(f"not an Apps Script web app URL (…/macros/s/<id>/exec): {profile.url}")
        self.profiles[profile.name] = profile
        if activate or self.active_name is None:
            self.active_name = profile.name

    def use(self, name: str) -> None:
        self.get(name)
        self.active_name = name

    def remove(self, name: str) -> None:
        self.get(name)
        del self.profiles[name]
        if self.active_name == name:
            self.active_name = next(iter(self.profiles), None)

    def get(self, name: str) -> Profile:
        if name not in self.profiles:
            raise ValueError(f"no backend profile {name!r}; known: {', '.join(self.profiles) or 'none'}")
        return self.profiles[name]

    def active(self) -> Profile:
        if not self.active_name:
            raise ValueError(
                "no backend profile yet: deploy the Apps Script, then `chgk backend add` (docs/google-account.md)"
            )
        return self.get(self.active_name)

    def by_url(self, url: str) -> Profile:
        for p in self.profiles.values():
            if p.url == url:
                return p
        raise ValueError(f"no local profile for backend {url}; add it with `chgk backend add`")


class BackendClient:
    def __init__(self, url: str, token: str, http: httpx.Client | None = None):
        self.url, self.token = url, token
        self.http = http or httpx.Client(follow_redirects=True, timeout=90)

    def call(self, action: str, **payload) -> dict:
        body = json.dumps({"action": action, "token": self.token, **payload}, ensure_ascii=False)
        try:
            # text/plain: Apps Script web apps don't answer CORS preflights; same as the phone.
            response = self.http.post(
                self.url, content=body.encode(), headers={"Content-Type": "text/plain;charset=utf-8"}
            )
        except httpx.HTTPError as err:
            raise BackendError(f"cannot reach the backend: {err}") from err
        try:
            data = response.json()
        except ValueError:
            raise BackendError(
                f"backend answered HTTP {response.status_code} without JSON. Is the web app deployed with "
                "'Execute as: Me' and 'Who has access: Anyone'?"
            ) from None
        if not data.get("ok"):
            error = data.get("error") or f"backend error (HTTP {response.status_code})"
            if "permission to call" in error:
                error += "\n" + PERMISSIONS_HINT
            raise BackendError(error)
        return data

    def ping(self) -> dict:
        return self.call("ping")

    def create_tournament(
        self,
        tid: str,
        name: str,
        date: str,
        round_sizes: list[int],
        jury_token: str,
        teams: list[dict],
        reserve: list[str] = (),
        board_token: str | None = None,
    ) -> dict:
        extra = {"board_token": board_token} if board_token else {}
        return self.call(
            "create_tournament",
            tid=tid,
            name=name,
            date=date,
            round_sizes=round_sizes,
            jury_token=jury_token,
            teams=teams,
            reserve=list(reserve),
            **extra,
        )

    def set_board_token(self, tid: str, board_token: str) -> dict:
        return self.call("set_board_token", tid=tid, board_token=board_token)

    def get_teams(self, tid: str) -> list[dict]:
        return self.call("get_teams", tid=tid)["teams"]

    def set_teams(self, tid: str, teams: list[dict]) -> dict:
        return self.call("set_teams", tid=tid, teams=teams)


def source_version() -> str:
    digest = hashlib.sha256()
    for name in BUNDLE_SOURCES:
        digest.update((APPS_SCRIPT_DIR / name).read_bytes())
    return digest.hexdigest()[:12]


def bundle_apps_script(out: Path) -> tuple[Path, str]:
    """One Code.gs to paste into a new Apps Script project (any Google account)."""
    version = source_version()
    parts = [
        "// chgk backend — generated by `uv run chgk backend bundle`; do not edit here.\n"
        f"// Version {version}. Paste into an Apps Script project; see docs/google-account.md.\n"
        "// After deploying, pick `setup` in the editor's function menu and press Run.\n"
    ]
    for name in BUNDLE_ORDER:
        text = (APPS_SCRIPT_DIR / name).read_text(encoding="utf-8")
        if name == "Code.js":
            marker = "const VERSION = 'dev';"  # Prettier's quotes (.prettierrc)
            assert marker in text, "Code.js must define VERSION"
            text = text.replace(marker, f"const VERSION = '{version}';")
        parts.append(f"\n// ===== {name} =====\n\n{text}")
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(parts), encoding="utf-8")
    return out, version
