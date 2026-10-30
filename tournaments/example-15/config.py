"""Example tournament with 15 questions per round (3 × 15 = 45). Copy this folder to start a new one."""

from datetime import date

from chgk.config import CardFields, Layout, LogoMode, Tournament

tournament = Tournament(
    slug="example-15",
    name="Осенний кубок · 15 вопросов",
    date=date(2026, 11, 15),
    rounds=3,
    questions_per_round=15,  # or a list per round, e.g. [12, 12, 15]
    scanner_url="https://antonmenshov.github.io/qa-chgk/s/",
    spares_per_team=2,  # at least 2; empty slots on a team's last page add more
    card=CardFields(
        team_name=False,
        tournament_name=True,
        date=False,
        logo=LogoMode.TEAM_ELSE_TOURNAMENT,  # team logo → tournament logo → fallback
        tournament_logo=None,  # e.g. "cup.png": tournament folder first, then the logos/ library
        fallback_logo="nologo.png",
        logo_grey=0.10,
        logo_size=1.85,  # inches, centred on the card (a 3×4 card allows up to ~2.48)
    ),
    layout=Layout(cols=3, rows=4, qr_size=0.85),
)
