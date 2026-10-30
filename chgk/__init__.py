"""Answer cards with QR codes and jury scanning for in-person sport ЧГК."""

from importlib.metadata import version
from pathlib import Path

__version__ = version("chgk")

PROJECT_DIR = Path(__file__).resolve().parent.parent
ASSETS_DIR = Path(__file__).parent / "assets"
FONTS_DIR = ASSETS_DIR / "fonts"
FONT_REGULAR_FILE = FONTS_DIR / "PT_Sans-Web-Regular.ttf"  # PT Sans (OFL): the cards' and the logos' font
FONT_BOLD_FILE = FONTS_DIR / "PT_Sans-Web-Bold.ttf"
OUT_ROOT = PROJECT_DIR / "out"  # generated files (git-ignored); the tests point it at a temporary folder


def out_dir(*parts: str) -> Path:
    """A path under the repo's out/, wherever chgk is run from."""
    return OUT_ROOT.joinpath(*parts)
