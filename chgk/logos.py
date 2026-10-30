"""Logos: find them, and turn them into very pale greyscale watermarks.

A logo name is looked up in the tournament folder first, then in the shared library
`logos/` at the repo root. Team logos in the library stay local (git-ignored); only
`logos/nologo.png`, the fallback, is in the repo.
"""

from pathlib import Path

from PIL import Image

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


INK_THRESHOLD = 250  # luminance below this counts as part of the drawing
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


def load_pale_logo(path: Path, grey: float) -> Image.Image:
    path = Path(path)
    if path.suffix.lower() == ".svg":
        raise ValueError(f"{path.name}: SVG logos are not supported yet (Phase 6); export it as PNG")
    with Image.open(path) as image:
        image.thumbnail((MAX_SIDE, MAX_SIDE))
        return pale(image, grey)
