# qa-chgk

Tools for in-person sport ЧГК («Что? Где? Когда?»):

- **answer cards** with QR codes, printed on Letter paper and cut into one stack per team;
- a **jury scanner** on an iPhone: scan each returned card, mark it верно / неверно / ?;
- a **Google Sheet** per tournament with standings («Итоги»), one tab per round,
  statistics, and every undecided «?» in one place;
- a **projector board** that shows the results after each round;
- a **jury sheet** (PDF) with every access QR code, how-tos, team forms and a paper backup grid.

Design: [SPEC.md](SPEC.md). Build order: [PLAN.md](PLAN.md). Status and decisions: [HANDOVER.md](HANDOVER.md).

## For the organiser

Needs [uv](https://docs.astral.sh/uv/) and a Gmail account for the results.

1. **Once per Google account:** deploy the backend, following
   [docs/google-account.md](docs/google-account.md) (about 10 minutes, no Google Cloud
   project). Check with `uv run chgk backend check`.
2. **A tournament** is a folder `tournaments/<slug>/`: copy `config.py` and `teams.py`
   from `tournaments/example/` (3 rounds of 12; `tournaments/example-15/` has 3 of 15),
   not `state.json`, which belongs to the example. Then edit them: name, date, rounds and
   questions; team names (IDs such as rating numbers are optional, missing ones are assigned).
   The examples' cards differ from the defaults (no team name, logo shade 0.10, a 1.85 in
   logo): change or delete those lines in `card=CardFields(...)` to get the defaults.
3. **Create its Sheet:** `uv run chgk new tournaments/<slug>`.
4. **Print:** `uv run chgk cards tournaments/<slug>` writes `out/<slug>/cards-<mode>.pdf`
   (it asks how you'll cut: one team per page, guillotine stack, or scissors) and
   `out/<slug>/jury.pdf`. Print at 100%; `uv run chgk test-page tournaments/<slug>`
   checks a printer first. Keep page 1 of the jury sheet away from the teams: it holds
   the secret jury access QR.
5. **Game day:**
   - each juror scans the jury access QR on page 1 once with the iPhone camera;
   - after each question, scan the returned cards and tap a verdict (each card's photo
     goes to the tournament's `Photos` folder in Drive by itself);
   - the projector laptop opens the board QR on page 2 and reveals each round with →;
   - teams can follow the view-only results QR on page 2 (the board shows both QR codes
     too; Q hides them);
   - decide «?» and appeals by typing `1` or `0` in the Sheet; all open «?» are on the
     hidden «Спорные» tab, with a link to each card's photo («Все листы» at the bottom left).
6. **Teams that turn up unregistered** get a reserve deck (R1, R2, …) and name themselves
   on the Sheet later.

**Logos** (a pale watermark on each team's cards): put PNG, JPG or SVG files in `logos/` (shared
by all tournaments, kept off GitHub) and name them in teams.py (`logo="fiasko.png"`).
`uv run chgk logos tournaments/<slug>` shows which logo each team's cards use. With
`--draw`, Claude (Opus, max effort) draws SVG drafts in the style of your logos for teams
without one, then reviews its own rendering and fixes it (with
`ANTHROPIC_API_KEY` set in your shell; without it you get a brief to hand to Claude Code);
`out/<slug>/logo-preview.pdf` shows them on real cards, and `--accept all` (or `--accept A01,A02`)
keeps them.

A jury or board link leaked (someone photographed the jury sheet)?
`uv run chgk replace-token tournaments/<slug> jury` (or `board`): the old link stops working at once,
and `out/<slug>/jury-v2.pdf` is the new sheet; each juror's phone scans its new QR once.

Changed the Teams tab in the Sheet? `uv run chgk teams tournaments/<slug>` pulls it back.
More commands: `uv run chgk --help`. Before a real game: [docs/manual-checks.md](docs/manual-checks.md).

## For contributors

- Python 3.12+ with uv; Node 22 for the JS tests and linting (`npm ci` once).
- Tests: `uv run pytest` and `npm test`.
- Lint and format before committing (Google style where it applies, 120 columns):
  `uv run ruff format . && uv run ruff check .`, `npm run format && npm run lint`.
- The scanner (`web/s/`) and the board (`web/b/`) are plain HTML/JS with no build
  step, published by GitHub Pages; the backend is `apps_script/` (bundled by
  `uv run chgk backend bundle`).
