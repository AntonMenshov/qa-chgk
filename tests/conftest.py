import textwrap

import pytest
import zxingcpp
from PIL import Image, ImageDraw

from chgk.config import Layout

SCANNER = "https://example.github.io/qa-chgk/s/"
# The test tournament keeps 3×5 (15 per page), not the 3×4 default: the hand-written card
# orders in the tests assume it, and it keeps a non-default grid covered.
TEST_GRID = Layout(cols=3, rows=5, qr_size=0.65)
LONG_NAME = "Команда с очень-очень длинным названием «Правило трёх буравчиков»"
# (team_id, name, city, logo) of the fixture tournament's teams.py
TEAM_ROWS = [("A01", "Синие зайцы", "Бостон", "z.png"), ("A02", LONG_NAME, "", ""), ("A03", "Думать быстро", "", "")]


def read_qr(image):
    """Standard QR codes in an image, read as the phone reads them (READER_OPTIONS in camera.js).

    zxing's "QRCode" is the whole QR family, and the corner of a real QR code plus the
    modules beside it can form a valid Micro QR: with tournament ID SP7EM a phantom
    «091544» turned up next to a card's QR (test_render).
    """
    return zxingcpp.read_barcodes(image, formats=zxingcpp.BarcodeFormat.QRCodeModel2)


def write_teams_file(folder, rows):
    """teams.py as an organiser would write it (team_id None = no id given)."""
    lines = ["from chgk.teams import team", "", "teams = ["]
    for team_id, name, city, logo in rows:
        args = (
            [repr(name)]
            + ([f"id={team_id!r}"] if team_id else [])
            + ([f"city={city!r}"] if city else [])
            + ([f"logo={logo!r}"] if logo else [])
        )
        lines.append(f"    team({', '.join(args)}),")
    (folder / "teams.py").write_text("\n".join([*lines, "]", ""]), encoding="utf-8")


@pytest.fixture
def folder(tmp_path):
    """A small tournament: 2 rounds × 3 questions, 2 spares, three teams."""
    (tmp_path / "config.py").write_text(
        textwrap.dedent(
            f"""
            from datetime import date
            from chgk.config import CardFields, Layout, LogoMode, Tournament
            tournament = Tournament(
                slug="test-cup", name="Осенний кубок", date=date(2026, 11, 15), rounds=2,
                questions_per_round=3, scanner_url="{SCANNER}", spares_per_team=2,
                card=CardFields(logo=LogoMode.TEAM_ELSE_TOURNAMENT, tournament_logo="t.png"),
                layout={TEST_GRID!r},
            )
            """
        ),
        encoding="utf-8",
    )
    write_teams_file(tmp_path, TEAM_ROWS)
    for name in ("t.png", "z.png"):
        img = Image.new("RGB", (200, 200), "white")
        ImageDraw.Draw(img).ellipse((20, 20, 180, 180), fill="black")
        img.save(tmp_path / name)
    return tmp_path


@pytest.fixture(autouse=True)
def isolated_cwd(tmp_path, monkeypatch):
    """Commands that write to the default out/<slug>/ must not touch the repo's out/."""
    monkeypatch.chdir(tmp_path)
