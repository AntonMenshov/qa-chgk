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
    spares_per_team=2,  # at least 2; empty slots on a team's last page add more
    tid=None,  # None: generated (this example has one in state.json); or e.g. 11234, the rating number
    card=CardFields(
        team_name=False,
        tournament_name=True,
        date=False,
        logo=LogoMode.TEAM_ELSE_TOURNAMENT,  # team logo → tournament logo → fallback
        tournament_logo=None,  # e.g. "cup.png": tournament folder first, then the logos/ library
        fallback_logo="nologo.png",
        logo_grey=0.10,
        logo_size=1.85,  # inches, centred on the card (a 3×4 card allows up to ~2.48)
        no_qr=False,  # True: no QR code, for a paper-only game without scanning
    ),
    layout=Layout(cols=3, rows=4, qr_size=0.85),
)
