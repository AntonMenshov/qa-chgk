"""Answer cards with QR codes and jury scanning for in-person sport ЧГК."""

from importlib.metadata import version
from pathlib import Path

__version__ = version("chgk")

PROJECT_DIR = Path(__file__).resolve().parent.parent
ASSETS_DIR = Path(__file__).parent / "assets"
FONTS_DIR = ASSETS_DIR / "fonts"
FONT_REGULAR_FILE = FONTS_DIR / "PT_Sans-Web-Regular.ttf"  # PT Sans (OFL): the cards' and the logos' font
FONT_BOLD_FILE = FONTS_DIR / "PT_Sans-Web-Bold.ttf"
