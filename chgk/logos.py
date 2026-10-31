"""Logos: which one each card uses, finding and loading them, and making them very pale.

A logo name is looked up in the tournament folder first, then in the shared library
`logos/` at the repo root. Team logos in the library stay local (git-ignored); only
`logos/nologo.png`, the fallback, is in the repo. PNG, JPG and SVG are accepted.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from PIL import Image, ImageOps

from chgk import PROJECT_DIR
from chgk.config import CardFields, LogoMode
from chgk.svg import CUT_FROM, INK_THRESHOLD, open_svg

if TYPE_CHECKING:
    from chgk.teams import Team

LOGO_LIBRARY = PROJECT_DIR / "logos"
MAX_SIDE = 600  # px: ≥ ~300 dpi at the sizes used, and keeps PDFs small
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


def first_logo(fields: CardFields, team_id: str, logos: dict[str, Any]) -> str | None:
    """The key of the logo a team's cards show, or None."""
    return next((key for key in logo_chain(fields, team_id) if key in logos), None)


def resolve_logo(name: str, folder: Path) -> Path | None:
    for base in (Path(folder), LOGO_LIBRARY):
        path = base / name
        if path.is_file():
            return path
    return None


REFERENCE_PERCENTILE = 0.10  # the darkest 10% of the drawing defines "full ink"


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
    rgba = image.convert("RGBA")
    flat = Image.new("RGBA", rgba.size, "white")
    flat.alpha_composite(rgba)
    lum = flat.convert("L")
    hist = lum.histogram()
    ink = sum(hist[:INK_THRESHOLD])
    if ink == 0:
        return lum.point(lambda v: 255)
    target, seen, reference = ink * REFERENCE_PERCENTILE, 0, 0
    for value in range(INK_THRESHOLD):
        seen += hist[value]
        if seen >= target:
            reference = value
            break
    span = 255 - reference
    return lum.point(lambda v: round(255 - 255 * grey * min(1.0, (255 - v) / span)))


def open_logo(path: Path) -> Image.Image:
    """A logo file as an image at most MAX_SIDE px across; ValueError if it can't be used."""
    path = Path(path)
    if path.suffix.lower() == ".svg":
        return open_svg(path, MAX_SIDE)
    try:
        with Image.open(path) as opened:
            image = ImageOps.exif_transpose(opened)  # a phone's photo is stored sideways
            if image.mode in ("P", "1"):  # or shrinking keeps only exact pixels: thin lines break
                image = image.convert("RGBA")
            image.thumbnail((MAX_SIDE, MAX_SIDE))
            return image.copy()
    # Pillow raises SyntaxError for a damaged PNG.
    except (OSError, SyntaxError, Image.DecompressionBombError) as err:
        raise ValueError(f"not a readable image ({err})") from err


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
        try:
            images[key] = open_logo(path)
            if CUT_FROM in images[key].info:
                warnings.append(f"{what}: logo {name!r} is not square; cut to a square around its drawing")
        except ValueError as err:
            warnings.append(f"{what}: logo {name!r}: {err}; using the next fallback")
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
    try:
        open_logo(path)
    except ValueError as err:
        return str(err)
    return None


def logo_report(folder: Path, fields: CardFields, teams: "list[Team]") -> tuple[list[LogoStatus], list[str]]:
    """Each team's own logo and what its cards show, plus the warnings the cards would print."""
    images, warnings = load_logos(folder, fields, teams)
    rows = []
    for t in teams:
        key = first_logo(fields, t.team_id, images)
        shown = "own logo" if key == t.team_id else SHOWN[key]
        rows.append(LogoStatus(t.team_id, t.name, t.logo_file, own_logo_problem(t, folder), shown))
    return rows, warnings
