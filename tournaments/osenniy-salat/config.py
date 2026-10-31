"""Осенний салат: the Phase 7 test game at home (PLAN.md)."""

from datetime import date

from chgk.config import CardFields, Layout, LogoMode, Tournament

tournament = Tournament(
    slug="osenniy-salat",
    name="Осенний салат",
    date=date(2026, 11, 20),
    rounds=3,
    questions_per_round=12,
    scanner_url="https://antonmenshov.github.io/qa-chgk/s/",
    spares_per_team=2,
    tid=18376,
    card=CardFields(
        team_name=False,
        tournament_name=True,
        date=False,
        logo=LogoMode.TEAM_ELSE_TOURNAMENT,
        tournament_logo=None,
        fallback_logo="nologo.png",
        logo_size=1.85,
        no_qr=False,
    ),
    layout=Layout(cols=3, rows=4, qr_size=0.85),
)
