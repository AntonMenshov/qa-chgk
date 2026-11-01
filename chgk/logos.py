"""Logos: which one each card uses, finding and loading them, and making them very pale.

A logo name is looked up in the tournament folder first, then in the shared library
`logos/` at the repo root. Team logos in the library stay local (git-ignored); only
`logos/nologo.png`, the fallback, is in the repo. PNG, JPG and SVG are accepted.
"""

from dataclasses import dataclass
from itertools import accumulate
from pathlib import Path
from typing import TYPE_CHECKING, Any

from PIL import Image, ImageOps

from chgk import PROJECT_DIR
from chgk.config import CardFields, LogoMode
from chgk.svg import CUT_FROM, INK_THRESHOLD, MAX_ASPECT, ink_box, on_white, open_svg

if TYPE_CHECKING:
    from chgk.teams import Team

LOGO_LIBRARY = PROJECT_DIR / "logos"
MAX_SIDE = 600  # px: ≥ ~300 dpi at the default grid's sizes (about 170 on 2×2), and keeps PDFs small
TOURNAMENT_KEY = "tournament"
FALLBACK_KEY = "fallback"


def logo_chain(fields: CardFields, team_id: str) -> list[str]:
    """The logos a team's cards try, in order (team_id, TOURNAMENT_KEY, FALLBACK_KEY); the first loaded one is used."""
    if fields.logo is LogoMode.NONE:
        return []
    chain = []
    if fields.logo in (LogoMode.TEAM, LogoMode.TEAM_ELSE_TOURNAMENT):
        chain.append(team_id)
    if fields.logo in (LogoMode.TOURNAMENT, LogoMode.TEAM_ELSE_TOURNAMENT):
        chain.append(TOURNAMENT_KEY)
    return [*chain, FALLBACK_KEY]


def shows_team_logos(fields: CardFields) -> bool:
    return fields.logo in (LogoMode.TEAM, LogoMode.TEAM_ELSE_TOURNAMENT)


def first_logo(fields: CardFields, team_id: str, logos: dict[str, Any]) -> str | None:
    """The key of the logo a team's cards show, or None."""
    return next((key for key in logo_chain(fields, team_id) if key in logos), None)


def resolve_logo(name: str, folder: Path) -> Path | None:
    if Path(name).name != name:  # a file name, and it can come from the shared Sheet: nothing outside these folders
        return None
    for base in (Path(folder), LOGO_LIBRARY):
        path = base / name
        if path.is_file():
            return path
    return None


PALE_PAPER = 200  # a logo's edge at least this light, and not white: paper, not drawing
REFERENCE_PERCENTILE = 0.10  # the darkest 10% of the drawing defines "full ink"


def _paper_to_white(lum: Image.Image) -> Image.Image:
    """A scan or JPEG on off-white paper: lift that paper to white, or it would count as the drawing itself."""
    w, h = lum.size
    edges = [lum.crop(box).histogram() for box in ((0, 0, w, 1), (0, h - 1, w, h), (0, 0, 1, h), (w - 1, 0, w, h))]
    counts = [sum(column) for column in zip(*edges, strict=True)]
    paper = counts.index(max(counts))
    return lum.point(lambda v: min(255, v * 255 // paper)) if PALE_PAPER <= paper < INK_THRESHOLD else lum


def pale(image: Image.Image, grey: float) -> Image.Image:
    """Greyscale on white where the logo's dark parts get exactly `grey` ink (0 = white, 1 = black).

    "Dark parts" means the darkest 10% of the drawing, not its single darkest pixel:
    real logos often have a few near-black pixels while the drawing itself is light
    grey, and scaling by those would print the logo far paler than asked. Anything
    darker than the reference is clamped, so no pixel exceeds `grey`. Transparent
    areas become white.
    """
    if not 0 < grey <= 1:
        raise ValueError(f"grey must be in (0, 1], got {grey}")
    lum = _paper_to_white(on_white(image))
    hist = lum.histogram()
    ink = sum(hist[:INK_THRESHOLD])
    if ink == 0:
        return Image.new("L", lum.size, 255)
    target = ink * REFERENCE_PERCENTILE
    reference = next(value for value, seen in enumerate(accumulate(hist[:INK_THRESHOLD])) if seen >= target)
    span = 255 - reference
    return lum.point(lambda v: round(255 - 255 * grey * min(1.0, (255 - v) / span)))


def open_logo(path: Path) -> Image.Image:
    """A logo file as an image at most MAX_SIDE px across; ValueError if it can't be used."""
    image = _read_logo(Path(path))
    if ink_box(image) is None:  # white on transparent, say: the cards would print nothing and call it a logo
        raise ValueError("nothing would print: the image is empty or all white")
    return image


def _read_logo(path: Path) -> Image.Image:
    if path.suffix.lower() == ".svg":
        return open_svg(path, MAX_SIDE)
    try:
        with Image.open(path) as opened:
            opened.draft("RGB", (2 * MAX_SIDE, 2 * MAX_SIDE))  # a JPEG decodes smaller, far quicker
            image = ImageOps.exif_transpose(opened)  # a phone's photo is stored sideways
            if max(image.size) > MAX_ASPECT * min(image.size):
                raise ValueError(f"too long and narrow ({image.width}×{image.height}) to be a logo")
            # Or shrinking keeps only exact pixels (thin lines break), or smears a transparent colour (a halo).
            if image.mode in ("P", "1") or "transparency" in image.info:
                image = image.convert("RGBA")
            image.thumbnail((MAX_SIDE, MAX_SIDE))
            image.info.pop(CUT_FROM, None)  # a PNG's text can hold any name; only render_svg sets this one
            return image
    # Pillow raises SyntaxError for a damaged PNG.
    except (OSError, SyntaxError, Image.DecompressionBombError) as err:
        raise ValueError(f"not a readable image ({err})") from err


def _open(path: Path) -> tuple[Image.Image | None, str | None]:
    """A logo file, or None and why it can't be used: what the report and the cards both go by."""
    try:
        return open_logo(path), None
    except ValueError as err:
        return None, str(err)


def load_logos(folder: Path, fields: CardFields, teams: "list[Team]") -> tuple[dict[str, Image.Image], list[str]]:
    """The logos these teams' cards can use, keyed as in logo_chain, plus warnings.

    A missing or unreadable file is a warning, not an error: the cards use the next logo in their chain.
    """
    names: dict[str, tuple[str, str | None]] = {t.team_id: (f"team {t.team_id}", t.logo_file) for t in teams}
    names[TOURNAMENT_KEY] = ("tournament", fields.tournament_logo)
    names[FALLBACK_KEY] = ("fallback", fields.fallback_logo)
    images: dict[str, Image.Image] = {}
    warnings: list[str] = []
    for key in dict.fromkeys(key for t in teams for key in logo_chain(fields, t.team_id)):
        what, name = names[key]
        if not name:
            continue
        path = resolve_logo(name, folder)
        if path is None:
            warnings.append(f"{what}: logo {name!r} not found in {folder} or {LOGO_LIBRARY}; using the next fallback")
            continue
        image, problem = _open(path)
        if image is None:
            warnings.append(f"{what}: logo {name!r}: {problem}; using the next fallback")
            continue
        images[key] = image
        if CUT_FROM in image.info:
            warnings.append(f"{what}: logo {name!r} is not square; cut to a square around its drawing")
    return images, warnings


SHOWN = {TOURNAMENT_KEY: "tournament logo", FALLBACK_KEY: "fallback logo", None: "no logo"}


@dataclass(frozen=True)
class LogoStatus:
    team_id: str
    name: str
    logo_file: str
    problem: str | None  # why the team's own logo can't be used ("not set", "not found", …); None if it can
    shown: str  # what the team's cards show: "own logo", "tournament logo", "fallback logo" or "no logo"


def own_logo_problem(team: "Team", folder: Path) -> str | None:
    """Why a team's own logo can't be used, or None if it loads."""
    if not team.logo_file:
        return "not set"
    path = resolve_logo(team.logo_file, folder)
    if path is None:
        return "not found"
    return _open(path)[1]


def logo_report(folder: Path, fields: CardFields, teams: "list[Team]") -> tuple[list[LogoStatus], list[str]]:
    """Each team's own logo and what its cards show, plus the warnings the cards would print."""
    images, warnings = load_logos(folder, fields, teams)
    rows = []
    for t in teams:
        key = first_logo(fields, t.team_id, images)
        shown = "own logo" if key == t.team_id else SHOWN[key]
        problem = None if key == t.team_id else own_logo_problem(t, folder)  # that one just loaded
        rows.append(LogoStatus(t.team_id, t.name, t.logo_file, problem, shown))
    return rows, warnings
