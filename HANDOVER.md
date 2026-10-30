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
| 0 — Skeleton and spikes | 🔶 skeleton ✅; spike 1 ✅; spike 3 ✅ (user chose 0.65 in QR, 3% grey); spike 2 waiting for GitHub Pages |
| 1 — Config, identity, card PDF | ✅ done; cards work offline from `teams.csv` |
| 2 — Apps Script backend + Sheet | next |
| 3 — Scanner web app | not started |
| 4 — Card photos | not started |
| 5 — Projector board + stats | not started |
| 6 — Logos | not started (basic PNG/JPG → pale greyscale already done in Phase 1) |

### Repository layout
```
chgk/                 Python package (at repo root, no src/ — user's preference)
  cli.py              typer app: version, cards, test-page
  config.py           Tournament / CardFields / Layout / LogoMode dataclasses + load_config
  ids.py              TID, team IDs, QR payload encode/decode
  teams.py            teams.csv loader (assigns + writes back missing team_ids)
  state.py            tournaments/<slug>/state.json (TID; later sheet ID + jury token)
  logos.py            image → pale greyscale watermark
  cards/
    model.py          a team's deck: numbered cards, then spares
    impose.py         team-pages / cut-stack / scissors slot assignment
    geometry.py       page grid and card parts (QR, number, writing area, logo, footer)
    render.py         reportlab drawing: vector QR, fonts, glyph check, fit-to-width
    build.py          folder → PDF (cards and test page)
    testpage.py       calibration page
  assets/fonts/       PT Sans Regular/Bold (OFL) — Cyrillic
tournaments/example/  working example: config.py, teams.csv, placeholder logos
tests/                pytest (test_*.py) + JS tests in tests/js/*.test.mjs
tests/vectors/        shared JSON test vectors (qr_payloads.json) for Python and JS
spikes/               throwaway Phase 0 experiments (no tests)
docs/spikes.md        spike instructions and results
.github/workflows/    CI: pytest + npm test (no remote yet, so not running)
package.json          only for `npm test` (no npm dependencies)
```

### How to run
- Python tests: `uv run pytest` (277 pass)
- JS tests: `npm test` (1 passes)
- Cards: `uv run chgk cards tournaments/example [--mode team-pages|cut-stack|scissors] [--teams A01,A02]`
  → `out/<slug>/cards-<mode>.pdf`. Without `--mode` it asks.
- Calibration page: `uv run chgk test-page tournaments/example` → `out/<slug>/test-page.pdf`

The render tests decode every QR code back from the rendered PDF and check it sits in
the slot the imposition assigned. The cut-stack test simulates the guillotine and
checks that the decks come out in order.

## Working conventions (agreed with the user)

- **Python + uv**: run everything as `uv run …`. Package at the repo root (`chgk/`), no `src/`.
- Tournament config is **Python syntax** (`tournaments/<slug>/config.py`), not YAML.
- **Unit tests are mandatory.** A phase isn't done until `uv run pytest` and
  `npm test` pass.
- **Git:** commit directly on `main`, no feature branches.
- **Keep this file current:** update it in the same commit as the work it describes.
- **Questions:** ask the user through the question interface (AskUserQuestion), a
  few questions at a time, with recommended defaults.
- **Printed labels are in Russian.** Card labels may say «Тур», but never «Вопрос»
  (a test enforces this).

## Key decisions (details in SPEC.md)

- **Backend:** one Apps Script web app under the user's personal Gmail. It creates
  one Sheet and one Drive folder per tournament. No Google Cloud project.
- **Scanner:** static web app on GitHub Pages, public repo **`qa-chgk`**; v1 access via
  a secret jury link.
- **QR:** a URL, `…/s/#<TID>.<TEAM>.<Q>`; spare cards use `S1…Sn`. Printed at
  **0.65 in** including the quiet zone, error correction M, vector.
- **Results cells:**
  - blank = no card;
  - `R` = received, not judged;
  - `1` / `0` / `?` = judged.
  - A missing card scores 0. Last write wins by client timestamp. `?` and appeals are
    resolved by editing the sheet.
- **Photos:** one photo of every card, uploaded separately from the marks. Measured
  (spike 1): ~1 s per request, ~3 s per photo with the Drive save. So marks go in
  batches and photos upload 2–3 at a time.
- **Cards:**
  - Letter, default 3×5 = 15 per page, grid configurable.
  - **Edge to edge in every mode**: neighbouring cards share a cut line. The user
    rejected gutters in scissors mode as wasteful.
  - Modes: team-pages (light lines + crop marks), cut-stack (same, guillotine order),
    scissors (darker dashed lines, no crop marks). The CLI asks which one.
  - Logo watermark at **3% grey**.
- **Teams:** one stack per team for the whole game, plus spares (3 by default). Empty
  slots on a team's last page become extra spares.
- **Juror view:** the app doesn't show the official answer.
- **Jurors:** one at a time for now; the data model is ready for several.
- **Deferred:**
  - rating.chgk.info export;
  - multi-juror UI;
  - Google sign-in.

## Open items (defaults used unless the user says otherwise)

1. Projector board freezes during the last round: **no**.
2. Photo retention in Drive: **forever**.

## Next steps

1. **GitHub:** the user must run `gh auth login` (`gh` is installed, not logged in).
   Then create the public repo `qa-chgk`, push, and enable Pages. Put the real
   `scanner_url` (`https://<user>.github.io/qa-chgk/s/`) in
   `tournaments/example/config.py`.
2. **Spike 2** (iPhone QR scan) once Pages is live: open `…/spikes/qr_scan/` on the
   iPhone, choose the QR library, and record the results in `docs/spikes.md`. Also
   confirm the spike 1 page works from iPhone Safari.
3. **Phase 2:** Apps Script backend + Sheet (see PLAN.md). The user already deployed
   the spike 1 script, so they know the deploy flow.

## Lessons learned

- PT Sans has no `″` or `→` glyphs. `render.missing_glyphs` guards every drawn string,
  and unknown characters print as `?` with a warning.
- typer 0.27 no longer depends on click: don't `import click`.
- Draw cut guides **after** the cards, or the QR's white quiet zone hides them.

## Things that need the user

- `gh auth login`, so the repo can be created and pushed.
- Deploying the real Apps Script (Phase 2) under their Gmail.
- iPhone test (spike 2) and a real print of the cards.
- Delete `spike.jpg` from the root of their Google Drive (left by spike 1).
