"""Logos: find them, and turn them into very pale greyscale watermarks.

A logo name is looked up in the tournament folder first, then in the shared library
`logos/` at the repo root. Team logos in the library stay local (git-ignored); only
`logos/nologo.png`, the fallback, is in the repo.
"""

from pathlib import Path

from PIL import Image, ImageOps

from chgk import PROJECT_DIR

LOGO_LIBRARY = PROJECT_DIR / "logos"
MAX_SIDE = 600  # px; a card's logo area is about 1 in, so this is ~600 dpi and keeps PDFs small
TOURNAMENT_KEY = "tournament"
FALLBACK_KEY = "fallback"


def resolve_logo(name: str, folder: Path) -> Path | None:
    for base in (Path(folder), LOGO_LIBRARY):
        path = base / name
        if path.is_file():
            return path
    return None


def pale(image: Image.Image, grey: float) -> Image.Image:
    """Greyscale on white whose darkest possible pixel has `grey` ink (0 = white, 1 = black).

    Transparent areas become white; the logo's own contrast is stretched first so a
    faint source still uses the full range before being lightened.
    """
    if not 0 < grey <= 1:
        raise ValueError(f"grey must be in (0, 1], got {grey}")
    rgba = image.convert("RGBA")
    flat = Image.new("RGBA", rgba.size, "white")
    flat.alpha_composite(rgba)
    lum = ImageOps.autocontrast(flat.convert("L"))
    return lum.point(lambda v: round(255 - (255 - v) * grey))


def load_pale_logo(path: Path, grey: float) -> Image.Image:
    path = Path(path)
    if path.suffix.lower() == ".svg":
        raise ValueError(f"{path.name}: SVG logos are not supported yet (Phase 6); export it as PNG")
    with Image.open(path) as image:
        image.thumbnail((MAX_SIDE, MAX_SIDE))
        return pale(image, grey)
