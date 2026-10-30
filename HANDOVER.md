# Handover

Read this first when picking the project up, whether that's a new Claude session or
another person. It is updated at the end of every work session and every phase.

Last updated: 2026-10-29

## What this project is

Tools for in-person sport ЧГК:
- print answer cards with QR codes;
- the jury scans the returned cards on an iPhone and marks each ✓ / ✗ / ?;
- results sync to a Google Sheet.

Full design: [SPEC.md](SPEC.md). Build order: [PLAN.md](PLAN.md).

## Current state

| Phase | Status |
|---|---|
| Spec and plan | ✅ done, agreed with the user |
| 0 — Skeleton and spikes | 🔶 skeleton done; spikes prepared, waiting on the user to run them |
| 1 — Config, identity, card PDF | not started |
| 2 — Apps Script backend + Sheet | not started |
| 3 — Scanner web app | not started |
| 4 — Card photos | not started |
| 5 — Projector board + stats | not started |
| 6 — Logos | not started |

### Repository layout
```
chgk/                 Python package (at repo root, no src/ — user's preference)
  cli.py              typer app; `uv run chgk version` only so far
  assets/fonts/       PT Sans Regular/Bold (OFL) — Cyrillic
tests/                pytest (test_*.py) + JS tests in tests/js/*.test.mjs
tests/vectors/        shared JSON test vectors checked by both Python and JS
spikes/               throwaway Phase 0 experiments (no tests)
docs/spikes.md        how to run the spikes + results table to fill in
.github/workflows/    CI: pytest + node --test (no remote yet, so not running)
package.json          only for `npm test` (no npm dependencies)
```

### How to run
- Python tests: `uv run pytest`
- JS tests: `npm test` (= `node --test "tests/js/**/*.test.mjs"`)
- Print test page: `uv run python spikes/print_test/make_sheet.py` → `out/print_test.pdf`

Both suites pass (5 Python, 1 JS). `tests/test_toolchain.py` proves the PDF test
approach: Cyrillic text and QR codes are read back from a rendered PDF.

## Working conventions (agreed with the user)

- **Python + uv**: run everything as `uv run …`.
- Tournament config is **Python syntax** (`tournaments/<slug>/config.py`), not YAML.
- **Unit tests are mandatory.** A phase isn't done until `uv run pytest` and
  `node --test` pass.
- **Git:** commit directly on `main`, no feature branches. No remote yet.
- **Keep this file current:** update it in the same commit as the work it describes.
- **Questions:** ask the user through the question interface (AskUserQuestion), a
  few questions at a time, with recommended defaults.
- **Printed labels are in Russian.** Card labels may say «Тур», but never «Вопрос».

## Key decisions (details in SPEC.md)

- **Backend:** one Apps Script web app under the user's personal Gmail. It creates
  one Sheet and one Drive folder per tournament. No Google Cloud project.
- **Scanner:** static web app on GitHub Pages; v1 access via a secret jury link.
- **QR:** a URL, `…/s/#<TID>.<TEAM>.<Q>`; spare cards use `S1…Sn`.
- **Results cells:**
  - blank = no card;
  - `R` = received, not judged;
  - `1` / `0` / `?` = judged.
  - A missing card scores 0. Last write wins by client timestamp. `?` and appeals are
    resolved by editing the sheet.
- **Photos:** one photo of every card, uploaded separately from the marks.
- **Cards:** Letter, default 3×5 = 15 per page, grid configurable. Three imposition
  modes (team-pages / cut-stack / scissors); the CLI asks which one.
- **Teams:** one stack per team for the whole game, plus spares.
- **Juror view:** the app doesn't show the official answer.
- **Jurors:** one at a time for now; the data model is ready for several.
- **Deferred:**
  - rating.chgk.info export;
  - multi-juror UI;
  - Google sign-in.

## Open items (defaults used unless the user says otherwise)

1. Spare cards per team: **3**.
2. Projector board freezes during the last round: **no**.
3. Photo retention in Drive: **forever**.
4. Empty slots on the last team-pages page become extra spares: **yes**.

## Next steps

1. User runs the spikes (instructions and results tables in `docs/spikes.md`):
   - Spike 1 (Apps Script POST): laptop only, needs their Google account.
   - Spike 2 (iPhone QR scan): needs the repo on GitHub Pages first.
   - Spike 3 (print): print `out/print_test.pdf`.
2. Record the findings in `docs/spikes.md`; choose the QR library and the logo grey
   shade.
3. Phase 1 can start in parallel. It doesn't depend on the spike results except the
   QR size, which the user set from the test print: **0.65 in**, logo **3% grey**.

Lessons so far: PT Sans lacks `″` and `→`. Phase 1 must test that every drawn
character exists in the font.

## Things that need the user

- A GitHub account/repo for Pages hosting. Not created yet; `gh` CLI is not
  installed on this machine.
- Deploying the Apps Script under their Gmail.
- iPhone and printer tests.
