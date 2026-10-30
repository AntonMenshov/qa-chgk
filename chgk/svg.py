"""SVG logos: refuse unsafe files, then render to an image with the cards' font.

An SVG is only drawing: no scripts, no event handlers, no references outside the file
(other files, URLs), no DTD (entities). Every text is set in PT Sans, the cards' font,
whatever font the file names, and no system font is used, so a logo looks the same on
every machine.
"""

import io
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import resvg_py
from PIL import Image

from chgk import FONT_BOLD_FILE, FONT_REGULAR_FILE

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


def render_svg(text: str, max_side: int) -> Image.Image:
    """The SVG as an RGBA image whose longer side is `max_side` px; ValueError if unsafe or unreadable."""
    check_svg(text)
    options = {
        "svg_string": text,
        "skip_system_fonts": True,
        "font_files": FONT_FILES,
        "font_family": FONT_FAMILY,
        "style_sheet": FORCE_FONT,
    }
    try:
        png = resvg_py.svg_to_bytes(**options, width=max_side)
        image = Image.open(io.BytesIO(bytes(png)))
        if image.height > max_side:  # taller than wide: fit the height instead
            image = Image.open(io.BytesIO(bytes(resvg_py.svg_to_bytes(**options, height=max_side))))
        image.load()
    except (ValueError, OSError) as err:
        raise ValueError(f"SVG could not be drawn ({err})") from err
    return image.convert("RGBA")


def open_svg(path: Path, max_side: int) -> Image.Image:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as err:
        raise ValueError(f"not a readable SVG ({err})") from err
    return render_svg(text, max_side)
