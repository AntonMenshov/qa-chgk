"""Answer cards with QR codes and jury scanning for in-person sport ЧГК."""

import os
import tempfile
from importlib.metadata import version
from pathlib import Path
from typing import Any

__version__ = version("chgk")

PROJECT_DIR = Path(__file__).resolve().parent.parent
ASSETS_DIR = Path(__file__).parent / "assets"
FONTS_DIR = ASSETS_DIR / "fonts"
FONT_REGULAR_FILE = FONTS_DIR / "PT_Sans-Web-Regular.ttf"  # PT Sans (OFL): the cards' and the logos' font
FONT_BOLD_FILE = FONTS_DIR / "PT_Sans-Web-Bold.ttf"
OUT_ROOT = PROJECT_DIR / "out"  # generated files (git-ignored); the tests point it at a temporary folder


def run_python_file(path: Path) -> dict[str, Any]:
    """Run an organiser's Python file (config.py, teams.py) and return its names.

    Compiled from the current text every time: an import would reuse a cached .pyc when the
    file was edited within the same second without changing size (seen in a test), and would
    leave __pycache__ folders in the tournament folders.
    """
    path = Path(path)
    names = {"__name__": f"chgk_{path.parent.name}_{path.stem}", "__file__": str(path)}
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as err:
        raise ValueError(f"{path}: not UTF-8 ({err})") from err
    try:
        exec(compile(text, str(path), "exec"), names)  # the organiser's own file
    except ValueError as err:
        if str(path) in str(err):
            raise
        # Our own checks say what is wrong, not in which file. Their type stays (ConfigError).
        message = f"{path}: {err}"
        err.args = (message,)
        if str(err) != message:
            raise ValueError(message) from err  # a type whose text ignores its args
        raise
    except Exception as err:
        raise ValueError(f"{path}: {type(err).__name__}: {err}") from err
    return names


def write_file(path: Path, text: str, private: bool = False) -> None:
    """Replace a file whole: a crash or a full disk never leaves half of it. `private`: owner-only."""
    path = Path(path)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())  # or a power cut can leave the rename without the data
        os.chmod(temporary, 0o600 if private else 0o644)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def out_dir(*parts: str) -> Path:
    """A path under the repo's out/, wherever chgk is run from."""
    return OUT_ROOT.joinpath(*parts)
