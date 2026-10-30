"""Turn a logo image into a very pale greyscale watermark."""

from pathlib import Path

from PIL import Image, ImageOps


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
        return pale(image, grey)
