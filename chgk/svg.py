"""SVG logos: refuse unsafe files, then render to an image with the cards' font.

An SVG is only drawing: no scripts, no event handlers, no references outside the file
(other files, URLs), no DTD (entities). Every text is set in PT Sans, the cards' font,
whatever font the file names, and no system font is used, so a logo looks the same on
every machine.

Known gap (PLAN.md Phase 9): the checks can be got past (`@IMPORT`, CSS escapes, CSS after a child of
<style>, <set>/<animate>, <?xml-stylesheet?>). Harmless for now: resvg fetches nothing from outside.
"""

import io
import re
import xml.etree.ElementTree as ET
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

UNSAFE_TAGS = {"script", "foreignObject", "iframe", "embed", "object", "audio", "video"}
LOCAL_REF = re.compile(r"^#|^data:image/(png|jpeg);base64,", re.IGNORECASE)
CSS_URL = re.compile(r"url\(\s*['\"]?\s*([^)'\"\s]*)", re.IGNORECASE)


def _local(name: str) -> str:
    return name.rsplit("}", 1)[-1]  # "{http://www.w3.org/2000/svg}rect" → "rect"


def check_svg(text: str) -> None:
    """Raise ValueError if the SVG is not plain drawing (see the module docstring)."""
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise ValueError(f"SVG larger than {MAX_BYTES // 1_000_000} MB")
    if re.search(r"<!DOCTYPE|<!ENTITY", text, re.IGNORECASE):
        raise ValueError("SVG with a DOCTYPE or entities is refused")
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
        if "@import" in sheet:
            raise ValueError("SVG with @import is refused")
        for css in [sheet, *element.attrib.values()]:  # url(...) in a style sheet, style= or fill=
            for ref in CSS_URL.findall(css):
                if not ref.startswith("#"):
                    raise ValueError(f"SVG with an external reference (url({ref[:60]})) is refused")


def _size(text: str) -> tuple[float, float]:
    """The SVG's proportions: its plain-number width and height (they decide the render), else viewBox, else square."""
    root = ET.fromstring(text)
    numbers = re.split(r"[\s,]+", (root.get("viewBox") or "").strip())
    plain = re.compile(r"[\d.]+(px)?")
    w_attr, h_attr = root.get("width") or "", root.get("height") or ""
    if plain.fullmatch(w_attr) and plain.fullmatch(h_attr):
        sides = (w_attr.removesuffix("px"), h_attr.removesuffix("px"))
    elif len(numbers) == 4:
        sides = (numbers[2], numbers[3])
    else:
        return 1.0, 1.0
    try:
        w, h = float(sides[0]), float(sides[1])
    except ValueError:
        return 1.0, 1.0
    return (w, h) if w > 0 and h > 0 else (1.0, 1.0)


def render_svg(text: str, max_side: int) -> Image.Image:
    """The SVG as an RGBA image whose longer side is `max_side` px; ValueError if unsafe or unreadable."""
    check_svg(text)
    options: dict[str, Any] = {
        "svg_string": text,
        "skip_system_fonts": True,
        "font_files": FONT_FILES,
        "font_family": FONT_FAMILY,
        "style_sheet": FORCE_FONT,
    }
    w, h = _size(text)
    if max(w, h) > MAX_ASPECT * min(w, h):
        raise ValueError(f"SVG too long and narrow ({w:g}×{h:g}) to be a logo")
    side: dict[str, Any] = (
        {"height": max_side} if h > w else {"width": max_side}
    )  # chosen first: a tall one can't fill the memory
    try:
        image = Image.open(io.BytesIO(bytes(resvg_py.svg_to_bytes(**options, **side))))
        if max(image.size) > max_side:  # units _size can't compare: fit the other side instead
            other: dict[str, Any] = {"width": max_side} if "height" in side else {"height": max_side}
            image = Image.open(io.BytesIO(bytes(resvg_py.svg_to_bytes(**options, **other))))
        image.load()
    except (ValueError, OSError, Image.DecompressionBombError) as err:
        raise ValueError(f"SVG could not be drawn ({err})") from err
    return image.convert("RGBA")


def open_svg(path: Path, max_side: int) -> Image.Image:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as err:
        raise ValueError(f"not a readable SVG ({err})") from err
    return render_svg(text, max_side)
