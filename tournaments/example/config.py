"""Example tournament. Copy this folder to start a new one."""

from datetime import date

from chgk.config import CardFields, Layout, LogoMode, Tournament

tournament = Tournament(
    slug="example",
    name="Осенний кубок",
    date=date(2026, 11, 15),
    rounds=3,
    questions_per_round=12,  # or a list per round, e.g. [12, 12, 15]
    scanner_url="https://antonmenshov.github.io/qa-chgk/s/",
    spares_per_team=3,
    card=CardFields(
        team_name=True,
        tournament_name=True,
        date=True,
        logo=LogoMode.TEAM_ELSE_TOURNAMENT,
        tournament_logo="logos/tournament.png",
        logo_grey=0.03,
    ),
    layout=Layout(cols=3, rows=5, qr_size=0.65),
)
