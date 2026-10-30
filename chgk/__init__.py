"""Answer cards with QR codes and jury scanning for in-person sport ЧГК."""

from importlib.metadata import version
from pathlib import Path

__version__ = version("chgk")

PROJECT_DIR = Path(__file__).resolve().parent.parent
ASSETS_DIR = Path(__file__).parent / "assets"
FONTS_DIR = ASSETS_DIR / "fonts"
