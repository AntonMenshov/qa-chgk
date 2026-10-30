# qa-chgk

Tools for in-person sport ЧГК («Что? Где? Когда?»):

- **answer cards** with QR codes, printed on Letter paper and cut into one stack per team;
- a **jury scanner** on an iPhone: scan each returned card, mark it верно / неверно / ?;
- a **Google Sheet** per tournament with standings («Итоги»), one tab per round,
  statistics, and every undecided «?» in one place;
- a **projector board** that shows the results after each round;
- a **jury sheet** (PDF) with every access QR code, how-tos, team forms and a paper backup grid.

Design: [SPEC.md](SPEC.md). Status and decisions: [HANDOVER.md](HANDOVER.md).

## For the organiser

Needs [uv](https://docs.astral.sh/uv/) and a Gmail account for the results.

1. **Once per Google account:** deploy the backend, following
   [docs/google-account.md](docs/google-account.md) (about 10 minutes, no Google Cloud
   project). Check with `uv run chgk backend check`.
2. **A tournament** is a folder `tournaments/<slug>/`: copy `config.py` and `teams.py`
   from `tournaments/example/` (not its `state.json`, which belongs to the example), then
   edit them: name, date, rounds and questions; team names (IDs such as rating numbers
   are optional, missing ones are assigned).
3. **Create its Sheet:** `uv run chgk new tournaments/<slug>`.
4. **Print:** `uv run chgk cards tournaments/<slug>` writes `out/<slug>/cards-<mode>.pdf`
   (it asks how you'll cut: one team per page, guillotine stack, or scissors) and
   `out/<slug>/jury.pdf`. Print at 100%; `uv run chgk test-page tournaments/<slug>`
   checks a printer first. Keep page 1 of the jury sheet away from the teams: it holds
   the secret jury access QR.
5. **Game day:**
   - each juror scans the jury access QR on page 1 once with the iPhone camera;
   - after each question, scan the returned cards and tap a verdict;
   - the projector laptop opens the board QR on page 2 and reveals each round with →;
   - teams can follow the view-only results QR on page 2;
   - decide «?» and appeals by typing `1` or `0` in the Sheet; all open «?» are on the
     hidden «Спорные» tab («Все листы» at the bottom left).
6. **Teams that turn up unregistered** get a spare deck (R1, R2, …) and name themselves
   on the Sheet later.

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
