"""Google backends: named local profiles (one per Google account) and the HTTP client.

Profiles live outside the repo in `~/.config/chgk/backends.json` (override the folder
with CHGK_CONFIG_DIR), so switching Google accounts never touches git. See SPEC §3.1.
"""

import hashlib
import json
import os
import re
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import httpx

from chgk import out_dir, write_file
from chgk.ids import BACKEND_URL_RE

APPS_SCRIPT_DIR = Path(__file__).resolve().parent.parent / "apps_script"
# The backend's files in bundle order (also read by the Node fake and ESLint). Code.js goes
# first: the editor's Run button starts on the file's first function, which must be setup().
# They share one global scope; no file runs another's code at load time.
BUNDLE_ORDER = json.loads((APPS_SCRIPT_DIR / "bundle.json").read_text(encoding="utf-8"))["files"]


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


def check_backend_url(url: str) -> None:
    if not BACKEND_URL_RE.fullmatch(url):
        raise ValueError(f"not an Apps Script web app URL (…/macros/s/<id>/exec): {url}")


@dataclass(frozen=True)
class Profile:
    name: str
    url: str
    admin_token: str = field(repr=False)
    account: str = ""  # label only, e.g. the Gmail address


def config_dir() -> Path:
    return Path(os.environ.get("CHGK_CONFIG_DIR") or Path.home() / ".config" / "chgk")


class Profiles:
    def __init__(self, path: Path | None = None):
        self.path = path or config_dir() / "backends.json"
        try:
            data = json.loads(self.path.read_text(encoding="utf-8")) if self.path.is_file() else {}
            self.active_name: str | None = data.get("active")
            self.profiles = {name: Profile(name=name, **p) for name, p in data.get("profiles", {}).items()}
        except (ValueError, TypeError, AttributeError) as err:
            raise ValueError(f"{self.path} is broken ({err}): fix it, or add the backends again") from err

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "active": self.active_name,
            "profiles": {n: {k: v for k, v in asdict(p).items() if k != "name"} for n, p in self.profiles.items()},
        }
        write_file(self.path, json.dumps(data, indent=2) + "\n", private=True)  # holds admin tokens

    def add(self, profile: Profile, activate: bool = True) -> None:
        check_backend_url(profile.url)
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

    def call(self, action: str, **payload: Any) -> dict[str, Any]:
        body = json.dumps({**payload, "action": action, "token": self.token}, ensure_ascii=False)
        try:
            # text/plain: Apps Script web apps don't answer CORS preflights; same as the phone.
            response = self.http.post(
                self.url, content=body.encode(), headers={"Content-Type": "text/plain;charset=utf-8"}
            )
        except httpx.TimeoutException as err:
            raise BackendError(
                f"the backend did not answer in time, but it may have done {action} all the same"
            ) from err
        except httpx.HTTPError as err:
            raise BackendError(f"cannot reach the backend: {err}") from err
        try:
            data = response.json()
        except ValueError:
            raise BackendError(
                f"backend answered HTTP {response.status_code} without JSON. Is the web app deployed with "
                "'Execute as: Me' and 'Who has access: Anyone'?"
            ) from None
        if not isinstance(data, dict):
            raise BackendError(f"backend answered HTTP {response.status_code} with unexpected JSON: {data!r}")
        if not data.get("ok"):
            error = data.get("error") or f"backend error (HTTP {response.status_code})"
            if "permission to call" in error:
                error += "\n" + PERMISSIONS_HINT
            raise BackendError(error)
        return data

    def ping(self) -> dict[str, Any]:
        return self.call("ping")

    def create_tournament(
        self,
        tid: str,
        name: str,
        date: str,
        round_sizes: list[int],
        jury_token: str,
        teams: list[dict[str, Any]],
        board_token: str,
        reserve: Sequence[str] = (),
    ) -> dict[str, Any]:
        return self.call(
            "create_tournament",
            tid=tid,
            name=name,
            date=date,
            round_sizes=round_sizes,
            jury_token=jury_token,
            teams=teams,
            reserve=list(reserve),
            board_token=board_token,
        )

    def make_public_copy(self, tid: str) -> dict[str, Any]:
        return self.call("make_public_copy", tid=tid)

    def delete_tournament(self, tid: str) -> dict[str, Any]:
        return self.call("delete_tournament", tid=tid)

    def get_state(self, tid: str) -> dict[str, Any]:
        return self.call("get_state", tid=tid)

    def get_teams(self, tid: str) -> list[dict[str, Any]]:
        teams: list[dict[str, Any]] = self.call("get_teams", tid=tid)["teams"]
        return teams

    def set_teams(self, tid: str, teams: list[dict[str, Any]]) -> dict[str, Any]:
        return self.call("set_teams", tid=tid, teams=teams)

    def replace_token(self, tid: str, which: str, new_token: str) -> dict[str, Any]:
        return self.call("replace_token", tid=tid, which=which, new_token=new_token)


def bundle_file() -> Path:
    """Where `chgk backend bundle` writes Code.gs by default: the repo's out/apps_script/."""
    return out_dir("apps_script", "Code.gs")


def bundle_version(path: Path | None = None) -> str | None:
    """The version inside a bundle written earlier (by default bundle_file()), or None if there is none."""
    path = Path(path) if path else bundle_file()
    if not path.is_file():
        return None
    match = re.search(r"^const VERSION = '([^']*)';", path.read_text(encoding="utf-8"), re.M)
    return match.group(1) if match else None


def source_version() -> str:
    digest = hashlib.sha256()
    for name in BUNDLE_ORDER:
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
        text = re.sub(r"(?m)^export ", "", text)  # logic.js is an ES module for the web pages; Apps Script has none
        if name == "Code.js":
            marker = "const VERSION = 'dev';"  # single quotes, as Prettier writes them
            if marker not in text:
                raise BackendError("Code.js must define VERSION")
            text = text.replace(marker, f"const VERSION = '{version}';")
        parts.append(f"\n// ===== {name} =====\n\n{text}")
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(parts), encoding="utf-8")
    return out, version
