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
| 0 — Skeleton and spikes | ⏳ next |
| 1 — Config, identity, card PDF | not started |
| 2 — Apps Script backend + Sheet | not started |
| 3 — Scanner web app | not started |
| 4 — Card photos | not started |
| 5 — Projector board + stats | not started |
| 6 — Logos | not started |

No code exists yet.

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

Phase 0 in PLAN.md:
1. uv project skeleton, `.gitignore`, test layout, CI workflow.
2. Spike: POST from GitHub Pages to Apps Script (CORS, ~200 KB photo).
3. Spike: QR library scan speed on iPhone Safari.
4. Spike: one printed test card.

Spikes 2–4 need the user (Google deploy, iPhone, printer); prepare the materials and
ask.

## Things that need the user

- A GitHub account/repo for Pages hosting. Not created yet.
- Deploying the Apps Script under their Gmail.
- iPhone and printer tests.
