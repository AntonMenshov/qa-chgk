import textwrap

import pytest
from PIL import Image, ImageDraw

SCANNER = "https://example.github.io/qa-chgk/s/"
LONG_NAME = "Команда с очень-очень длинным названием «Правило трёх буравчиков»"


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
                layout=Layout(cols=3, rows=5, qr_size=0.65),
            )
            """
        ),
        encoding="utf-8",
    )
    (tmp_path / "teams.csv").write_text(
        f"team_id,name,city,logo_file\nA01,Синие зайцы,Бостон,z.png\nA02,{LONG_NAME},,\nA03,Думать быстро,,\n",
        encoding="utf-8",
    )
    for name in ("t.png", "z.png"):
        img = Image.new("RGB", (200, 200), "white")
        ImageDraw.Draw(img).ellipse((20, 20, 180, 180), fill="black")
        img.save(tmp_path / name)
    return tmp_path


@pytest.fixture(autouse=True)
def isolated_cwd(tmp_path, monkeypatch):
    """Commands that write to the default out/<slug>/ must not touch the repo's out/."""
    monkeypatch.chdir(tmp_path)
