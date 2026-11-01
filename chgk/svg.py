"""SVG logos: refuse unsafe files, then render to an image with the cards' font.

An SVG is only drawing: no scripts, no event handlers, no references outside the file
(other files, URLs), no DTD (entities). Every text is set in PT Sans, the cards' font,
whatever font the file names, and no system font is used, so a logo looks the same on
every machine.

A logo is square: a file of another shape is cut to one around its drawing (`_square`).

Known gap (PLAN.md Phase 9): the checks can be got past (CSS escapes, CSS after a child of
<style>, <set>/<animate>, <?xml-stylesheet?>). Harmless for now: resvg fetches nothing from outside.
"""

import contextlib
import io
import re
import xml.etree.ElementTree as ET
from math import isfinite
from pathlib import Path
from typing import Any

import resvg_py
from PIL import Image

from chgk import FONT_BOLD_FILE, FONT_REGULAR_FILE

MAX_ASPECT = 20  # longer side / shorter side of a logo at most: beyond it, not a logo
FONT_FILES = [str(FONT_REGULAR_FILE), str(FONT_BOLD_FILE)]
FONT_FAMILY = "PT Sans"
FORCE_FONT = f'* {{ font-family: "{FONT_FAMILY}" !important; }}'
MAX_BYTES = 2_000_000
INK_THRESHOLD = 250  # luminance below this counts as part of the drawing
LENGTH = re.compile(r"(\d*\.?\d+(?:e[+-]?\d+)?)(px|mm|cm|in|pt|pc|)", re.IGNORECASE)
UNITS = {"": 1.0, "px": 1.0, "in": 96.0, "cm": 96 / 2.54, "mm": 96 / 25.4, "pt": 96 / 72, "pc": 16.0}
CUT_FROM = "cut_from"  # Image.info key: the "W×H" a non-square file was cut from

UNSAFE_TAGS = {"script", "foreignObject", "iframe", "embed", "object", "audio", "video"}
LOCAL_REF = re.compile(r"^#|^data:image/(png|jpeg);base64,", re.IGNORECASE)
CSS_URL = re.compile(r"url\(\s*['\"]?\s*([^)'\"\s]*)", re.IGNORECASE)


def _local(name: str) -> str:
    return name.rsplit("}", 1)[-1]  # "{http://www.w3.org/2000/svg}rect" → "rect"


def check_svg(text: str) -> ET.Element:
    """The SVG's root element; ValueError if it is not plain drawing (see the module docstring)."""
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise ValueError(f"SVG larger than {MAX_BYTES // 1_000_000} MB")
    # The standard DOCTYPE line many exporters write is harmless; defining anything in it is not. Possessive:
    # a plain repeat keeps memory per character (731 MB on a 2 MB file, measured).
    if re.search(r"""<!DOCTYPE(?:[^>"'\[]++|"[^"]*+"|'[^']*+')*+\[|<!ENTITY""", text, re.IGNORECASE):
        raise ValueError("SVG with anything defined in its DOCTYPE is refused")
    try:
        root = ET.fromstring(text)
    except ET.ParseError as err:
        raise ValueError(f"not a valid SVG ({err})") from err
    if _local(root.tag) != "svg":
        raise ValueError(f"not an SVG (root element <{_local(root.tag)}>)")
    for element in root.iter():
        tag = _local(element.tag)
        if tag in UNSAFE_TAGS:
            raise ValueError(f"SVG with <{tag}> is refused")
        for raw_name, value in element.attrib.items():
            name = _local(raw_name)
            if name.lower().startswith("on"):
                raise ValueError(f"SVG with an event handler ({name}) is refused")
            if name == "href" and not LOCAL_REF.match(value.strip()):
                raise ValueError(f"SVG with an external reference ({value[:60]!r}) is refused")
        sheet = (element.text or "") if tag == "style" else ""
        if "@import" in sheet.lower():
            raise ValueError("SVG with @import is refused")
        for css in [sheet, *element.attrib.values()]:  # url(...) in a style sheet, style= or fill=
            for ref in CSS_URL.findall(css):
                if not ref.startswith("#"):
                    raise ValueError(f"SVG with an external reference (url({ref[:60]})) is refused")
    return root


def _length(value: str) -> float | None:
    """A width or height in px, whatever its unit; None if not a length (ValueError for em and the like)."""
    match = LENGTH.fullmatch(value.strip())
    if match:
        return float(match[1]) * UNITS[match[2].lower()]
    if value.strip() in ("", "100%"):  # no size of its own: the viewBox decides
        return None
    raise ValueError(f"SVG with a size that can't be read ({value[:30]!r})")  # em, 5000%: it could fill the memory


def _size(root: ET.Element) -> tuple[float, float]:
    """The SVG's proportions: its width and height (they decide the render), else viewBox, else square."""
    width, height = _length(root.get("width") or ""), _length(root.get("height") or "")
    numbers = re.split(r"[\s,]+", (root.get("viewBox") or "").strip())
    w, h = 1.0, 1.0
    if width is not None and height is not None:
        w, h = width, height
    elif len(numbers) == 4:
        with contextlib.suppress(ValueError):
            w, h = float(numbers[2]), float(numbers[3])
    if not (isfinite(w) and isfinite(h)):
        raise ValueError("SVG with an endless size")
    return (w, h) if w > 0 and h > 0 else (1.0, 1.0)


def on_white(image: Image.Image) -> Image.Image:
    """The image as greyscale, flattened on white: how its transparent parts print."""
    rgba = image.convert("RGBA")
    flat = Image.new("RGBA", rgba.size, "white")
    flat.alpha_composite(rgba)
    return flat.convert("L")


def ink_box(image: Image.Image) -> tuple[int, int, int, int] | None:
    """Where the drawing is: anything darker than INK_THRESHOLD once flattened on white; None if nothing is."""
    return on_white(image).point(lambda v: 255 if v < INK_THRESHOLD else 0).getbbox()


def _square(image: Image.Image) -> Image.Image:
    """A square of the image's shorter side, centred on the drawing: nothing is lost if the drawing fits in it."""
    w, h = image.size
    if w == h:
        return image
    box = ink_box(image) or (0, 0, w, h)
    side = min(w, h)
    left = min(max((box[0] + box[2] - side) // 2, 0), w - side)
    top = min(max((box[1] + box[3] - side) // 2, 0), h - side)
    square = image.crop((left, top, left + side, top + side))
    square.info[CUT_FROM] = f"{w}×{h}"
    return square


def render_svg(text: str, max_side: int) -> Image.Image:
    """The SVG as a square RGBA image `max_side` px across (`_square`); ValueError if unsafe or unreadable."""
    root = check_svg(text)
    options: dict[str, Any] = {
        "svg_string": text,
        "skip_system_fonts": True,
        "font_files": FONT_FILES,
        "font_family": FONT_FAMILY,
        "style_sheet": FORCE_FONT,
        "dpi": 96,  # or a size in mm or pt comes out as nothing
    }
    w, h = _size(root)
    if max(w, h) > MAX_ASPECT * min(w, h):
        raise ValueError(f"SVG too long and narrow ({w:g}×{h:g}) to be a logo")
    longest = round(max_side * max(w, h) / min(w, h))  # so that the cut square is still max_side across
    side: dict[str, Any] = {"height": longest} if h > w else {"width": longest}  # MAX_ASPECT bounds the memory
    try:
        image = Image.open(io.BytesIO(bytes(resvg_py.svg_to_bytes(**options, **side))))
        if max(image.size) > longest:  # units _size can't compare: fit the other side instead
            other: dict[str, Any] = {"width": longest} if "height" in side else {"height": longest}
            image = Image.open(io.BytesIO(bytes(resvg_py.svg_to_bytes(**options, **other))))
        image.load()
    except (ValueError, OSError, Image.DecompressionBombError) as err:
        raise ValueError(f"SVG could not be drawn ({err})") from err
    square = _square(image.convert("RGBA"))
    square.thumbnail((max_side, max_side))  # resvg rounds a canvas up to whole pixels
    return square


def open_svg(path: Path, max_side: int) -> Image.Image:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as err:
        raise ValueError(f"not a readable SVG ({err})") from err
    return render_svg(text, max_side)
