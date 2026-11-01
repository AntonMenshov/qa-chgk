"""Card identity: tournament ID, team IDs and the QR payload.

A tournament ID is generated (5 readable characters) or given in config.py: 1-8 digits or
capital Latin letters, e.g. the rating.chgk.info tournament number.

QR payload: `<scanner_url>#<TID>.<TEAM>.<Q>` where Q is a question number or
`S<n>` for the n-th spare card, e.g. `https://u.github.io/qa-chgk/s/#K7M2Q.A07.27`.

A team ID is 1-8 digits or capital Latin letters: the organiser's own (e.g. the team's
rating.chgk.info number, 58746) or one we assign (A01, A02, …). With a 5-character TID,
eight characters keep the QR code at the same size (version 4-M) as A01; a longer TID
can need a denser code (render.py CHECKED_QR_VERSION warns).
"""

import re
import secrets
from collections.abc import Iterable
from dataclasses import dataclass
from urllib.parse import urljoin

# A generated TID: no 0/O or 1/I/L, so it can be read aloud or typed without mistakes.
TID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
TID_LENGTH = 5
# Any TID, generated or given in config.py (e.g. the rating.chgk.info tournament number):
# 1-8 digits or capital Latin letters, like a team ID.
TID_PATTERN = "[0-9A-Z]{1,8}"
TID_RE = re.compile(rf"^{TID_PATTERN}$")
TEAM_ID_RE = re.compile(r"^[0-9A-Z]{1,8}$")
MAX_QUESTION = 999  # the payload holds questions 1–999 …
MAX_SPARE = 99  # … and spare cards S1–S99 (_FRAGMENT_RE, and payload.js on the phone)
_FRAGMENT_RE = re.compile(
    rf"^(?P<tid>{TID_PATTERN})\.(?P<team>[0-9A-Z]{{1,8}})\.(?:(?P<q>[1-9][0-9]{{0,2}})|S(?P<s>[1-9][0-9]{{0,1}}))$"
)


class PayloadError(ValueError):
    """A QR payload is not a valid card ID."""


@dataclass(frozen=True)
class CardId:
    tid: str
    team_id: str
    question: int | None = None  # set for numbered cards
    spare: int | None = None  # set for spare cards (1-based)

    def __post_init__(self) -> None:
        if (self.question is None) == (self.spare is None):
            raise ValueError("a card has either a question number or a spare number")
        if not TID_RE.fullmatch(self.tid) or not TEAM_ID_RE.fullmatch(self.team_id):
            raise ValueError(f"not a card's IDs: tournament {self.tid!r}, team {self.team_id!r}")
        if not (1 <= (self.question or 0) <= MAX_QUESTION or 1 <= (self.spare or 0) <= MAX_SPARE):
            raise ValueError(f"no card can hold question {self.question} or spare {self.spare}")

    @property
    def fragment(self) -> str:
        last = str(self.question) if self.question is not None else f"S{self.spare}"
        return f"{self.tid}.{self.team_id}.{last}"


def generate_tid() -> str:
    return "".join(secrets.choice(TID_ALPHABET) for _ in range(TID_LENGTH))


def encode_payload(scanner_url: str, card: CardId) -> str:
    return f"{scanner_url}#{card.fragment}"


def decode_payload(payload: str) -> CardId:
    """Parse a scanned QR payload (full URL, or just the part after '#')."""
    fragment = payload.rsplit("#", 1)[-1]
    m = _FRAGMENT_RE.fullmatch(fragment)
    if not m:
        raise PayloadError(f"not a ЧГК card: {payload!r}")
    if m["q"] is not None:
        return CardId(m["tid"], m["team"], question=int(m["q"]))
    return CardId(m["tid"], m["team"], spare=int(m["s"]))


def _team_id(n: int) -> str:
    """Assigned team ID number n: 0 → A01, 98 → A99, 99 → B01, and so on."""
    letter, number = divmod(n, 99)
    if letter >= 26:
        raise ValueError("too many teams")
    return f"{chr(ord('A') + letter)}{number + 1:02d}"


def normalize_team_id(team_id: str | None) -> str | None:
    """'  a07 ' → 'A07'; blank → None (the team gets an ID assigned)."""
    team_id = (team_id or "").strip().upper()
    return team_id or None


def assign_team_ids(existing: list[str | None], taken: Iterable[str] = ()) -> list[str]:
    """Keep the given IDs (normalised) and give each missing one the next unused A01, A02, and so on.

    `taken`: IDs used earlier, which are on printed cards: a new team never gets one.
    """
    given = [normalize_team_id(t) for t in existing]
    used: set[str] = set()
    for team_id in given:
        if team_id is None:
            continue
        if not TEAM_ID_RE.fullmatch(team_id):
            raise ValueError(f"invalid team_id {team_id!r}: use 1-8 digits or capital Latin letters, e.g. 58746 or A07")
        if team_id in used:
            raise ValueError(f"duplicate team_id {team_id}")
        used.add(team_id)
    result: list[str] = []
    n = 0
    for team_id in given:
        if team_id is None:
            while _team_id(n) in used or _team_id(n) in taken:
                n += 1
            team_id = _team_id(n)
            used.add(team_id)
        result.append(team_id)
    return result


# Jury setup link: `<scanner_url>#setup=<TID>.<JURY_TOKEN>.<DEPLOYMENT_ID>`.
# The deployment ID is the part of the Apps Script URL between /macros/s/ and /exec,
# so the phone learns which backend (Google account) this tournament lives on.
BACKEND_URL_RE = re.compile(r"^https://script\.google\.com/macros/s/(?P<id>[A-Za-z0-9_-]{10,})/exec$")
_SETUP_RE = re.compile(
    rf"^setup=(?P<tid>{TID_PATTERN})\.(?P<token>[A-Za-z0-9_-]{{16,}})\.(?P<dep>[A-Za-z0-9_-]{{10,}})$"
)


@dataclass(frozen=True)
class JuryAccess:
    tid: str
    jury_token: str
    backend_url: str


def generate_jury_token() -> str:
    return secrets.token_urlsafe(18)  # 24 chars of [A-Za-z0-9_-]


def encode_jury_link(scanner_url: str, access: JuryAccess) -> str:
    m = BACKEND_URL_RE.fullmatch(access.backend_url)
    if not m:
        raise ValueError(f"not an Apps Script web app URL: {access.backend_url!r}")
    return f"{scanner_url}#setup={access.tid}.{access.jury_token}.{m['id']}"


def decode_jury_link(link: str) -> JuryAccess:
    m = _SETUP_RE.fullmatch(link.rsplit("#", 1)[-1])
    if not m:
        raise PayloadError(f"not a jury setup link: {link!r}")
    return JuryAccess(m["tid"], m["token"], f"https://script.google.com/macros/s/{m['dep']}/exec")


# Projector board link: `<board_url>?grid=<N>#board=<TID>.<BOARD_TOKEN>.<DEPLOYMENT_ID>`.
# The board token is read-only (marks and teams), separate from the jury token. `grid`:
# up to this many teams the board shows the full grid of every round.
_BOARD_RE = re.compile(
    rf"^board=(?P<tid>{TID_PATTERN})\.(?P<token>[A-Za-z0-9_-]{{16,}})\.(?P<dep>[A-Za-z0-9_-]{{10,}})$"
)


@dataclass(frozen=True)
class BoardAccess:
    tid: str
    board_token: str
    backend_url: str


def board_page_url(scanner_url: str) -> str:
    """The board lives next to the scanner: …/qa-chgk/s/ → …/qa-chgk/b/."""
    return urljoin(scanner_url, "../b/")


def encode_board_link(scanner_url: str, access: BoardAccess, grid_max_teams: int) -> str:
    m = BACKEND_URL_RE.fullmatch(access.backend_url)
    if not m:
        raise ValueError(f"not an Apps Script web app URL: {access.backend_url!r}")
    return f"{board_page_url(scanner_url)}?grid={grid_max_teams}#board={access.tid}.{access.board_token}.{m['id']}"


def decode_board_link(link: str) -> BoardAccess:
    m = _BOARD_RE.fullmatch(link.rsplit("#", 1)[-1])
    if not m:
        raise PayloadError(f"not a board link: {link!r}")
    return BoardAccess(m["tid"], m["token"], f"https://script.google.com/macros/s/{m['dep']}/exec")
