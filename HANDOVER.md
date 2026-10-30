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
| 0 — Skeleton and spikes | ✅ spike 1 (laptop + iPhone Safari), spike 2 (all QR sizes scan well; zxing-wasm chosen), spike 3 (0.65 in QR; logo shade later changed to 12%) |
| 1 — Config, identity, card PDF | ✅ done; cards + jury sheet work offline from `teams.py` |
| 2 — Apps Script backend + Sheet | ✅ deployed under the user's Gmail and checked live (sums, places, order, reserve teams, IDs); two Sheet-trigger checks still to be confirmed by the user |
| 3 — Scanner web app | 🔶 built and tested (unit + integration + headless-Chrome end-to-end with a fake camera); waiting for the live and iPhone checks |
| 4 — Card photos | not started |
| 5 — Projector board + stats | ✅ built, tested and checked live (version 6db9ad957009, example QHZJ8) |
| 6 — Logos | partly done: PNG/JPG → pale greyscale, shared private library, fallback owl. Left: SVG, Claude-drawn SVG, image-API generation |

### Repository layout
```
chgk/                 Python package (at repo root, no src/ — user's preference)
  cli.py              typer app: version, cards, test-page, jury-sheet, new, teams, backend add|use|list|check|remove|bundle
  backend.py          backend profiles (~/.config/chgk/backends.json, CHGK_CONFIG_DIR), HTTP client, Code.gs bundler
  remote.py           new_tournament / sync_teams (tournament keeps its own backend)
  config.py           Tournament / CardFields / Layout / LogoMode dataclasses + load_config
  ids.py              TID, team IDs, QR payload encode/decode
  teams.py            teams.py loader/writer (keeps given team_ids, assigns + writes back missing ones)
  state.py            tournaments/<slug>/state.json (TID, backend URL/profile, sheet ID, jury token)
  logos.py            image → pale greyscale watermark
  jury.py             jury printout (platypus): QR page, links, how-to, team forms, backup grid
  cards/
    model.py          a team's deck: numbered cards, then spares
    impose.py         team-pages / cut-stack / scissors slot assignment
    geometry.py       page grid and card parts (QR, number, writing area, logo, footer)
    render.py         reportlab drawing: vector QR, fonts, glyph check, fit-to-width
    build.py          folder → PDF (cards and test page)
    testpage.py       calibration page
  assets/fonts/       PT Sans Regular/Bold (OFL) — Cyrillic
apps_script/          backend: logic.js (pure, Node-tested) + Code.js (Sheets/Drive); package.json makes them CommonJS
logos/                shared logo library (team logos git-ignored; nologo.png public)
tournaments/example/  working example: config.py, teams.py (the user's real teams)
tests/                pytest (test_*.py) + JS tests in tests/js/*.test.mjs
tests/conftest.py     shared `folder` fixture: a small tournament on disk
tests/js/fake_apps_script.mjs  in-memory Sheets/Drive/properties to run Code.js in Node;
                      getValues() returns computed values, "42" becomes 42 unless the cell is "@"
tests/js/sheet_formulas.mjs   evaluator for the Sheets formulas the backend writes
tests/js/calculations.test.mjs  sums, places («2-3»), Stats vs logic.js reference; random tournaments
tests/js/scanner.test.mjs     scanner lib: vectors, session, queue, camera; phone ↔ fake backend
tests/js/fake_backend_server.mjs  the fake backend over HTTP (for the browser tests)
tests/js/board.test.mjs       board logic and link; places/order agree with logic.js on random data
tests/test_scanner_e2e.py     headless Chrome: fake camera shows real cut-out cards; skipped without Chrome/Node
tests/vectors/        shared JSON test vectors (qr_payloads, jury_links, merge_cases) for Python and JS
docs/google-account.md  deploying the backend under any Gmail account; switching; updating
spikes/               throwaway Phase 0 experiments (no tests)
docs/spikes.md        spike instructions and results
web/                  GitHub Pages site
web/s/                scanner app (no build step): index.html, app.css, app.js (wiring only), sw.js (offline),
                      manifest + icons; lib/ = payload, marks, session, lookup («Чья карточка?»), queue, api,
                      storage, camera;
                      vendor/zxing-wasm-3.1.4 (QR reader, vendored: no CDN at the venue)
web/b/                projector board: index.html, board.css, board.js; lib/board.js = what to show
                      (rounds revealed by hand, places from revealed rounds only, grid vs compact)
.github/workflows/    tests.yml (pytest + npm test), pages.yml (deploys web/ + spike pages)
package.json          only for `npm test` (no npm dependencies)
```

### How to run
- Python tests: `uv run pytest` (384 pass, incl. the browser test, ~12 s; needs Google Chrome + Node, else skipped)
- JS tests: `npm test` (148 pass)
- Cards: `uv run chgk cards tournaments/example [--mode team-pages|cut-stack|scissors] [--teams A01,A02]`
  → `out/<slug>/cards-<mode>.pdf` + `out/<slug>/jury.pdf`. Without `--mode` it asks.
- Jury sheet alone: `uv run chgk jury-sheet tournaments/example`
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
- **No Claude attribution:** commits are authored only as the user. No
  `Co-Authored-By: Claude` or "Generated with Claude Code" lines (history rewritten on
  2026-10-29 to remove them).
- **Keep this file current:** update it in the same commit as the work it describes.
- **Questions:** ask the user through the question interface (AskUserQuestion), a
  few questions at a time, with recommended defaults.
- **Printed labels are in Russian.** Card labels may say «Тур», but never «Вопрос»
  (a test enforces this).

## Key decisions (details in SPEC.md)

- **Backend:** one Apps Script web app per Google account. It creates one Sheet and
  one Drive folder per tournament. No Google Cloud project.
- **Switchable Google account (user requirement, SPEC §3.1):**
  - no account is named in the repo;
  - backends are named local profiles in `~/.config/chgk/backends.json`;
  - each tournament's `state.json` records its backend;
  - the jury link carries the backend URL;
  - QR codes don't depend on the account.
- **Scanner:** static web app on GitHub Pages, public repo **`qa-chgk`**; v1 access via
  a secret jury link.
- **QR:** a URL, `…/s/#<TID>.<TEAM>.<Q>`; spare cards use `S1…Sn`. Printed at
  **0.65 in** including the quiet zone, error correction M, vector.
- **Mark cells (round tabs):**
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
  - Logo watermark at **12% grey**, measured on the logo's dark parts (SPEC §9).
  - **Logo library** `logos/` at the repo root (SPEC §9):
    - team logos are private (git-ignored); only `nologo.png` is public;
    - fallback chain: team → tournament → `nologo.png`;
    - the example tournament is the user's four logo teams (42, Фиаско, Совхоз Победа,
      Звезды сошлись), set up the way they asked: **no team name on cards, logo
      10%, logo_size 1.85 in**. The defaults elsewhere stay team name on, 12%, auto size.
- **Teams:** one stack per team for the whole game, plus spares (3 by default). Empty
  slots on a team's last page become extra spares. Spare cards carry no words: an
  empty box where the number goes (user request).
- **Juror view:** the app doesn't show the official answer.
- **Jury printout** (user request, SPEC §8.6), in Russian, written with every
  `cards` run:
  - secret access QR;
  - details and links;
  - juror how-to and «?»/appeals how-to;
  - team roster with a "handed out" checkbox;
  - paper backup grid.
- **Jury link:** `<scanner_url>#setup=<TID>.<TOKEN>.<DEPLOYMENT_ID>`.
- **Jurors:** one at a time for now; the data model is ready for several.
- **Deferred:**
  - rating.chgk.info export;
  - multi-juror UI;
  - Google sign-in.

## Open items (defaults used unless the user says otherwise)

1. Projector board freezes during the last round: **no**.
2. Photo retention in Drive: **forever**.

## Next steps

1. **Finish Phase 2:**
   - The user deploys the bundle under their Gmail (docs/google-account.md), runs
     `setup`, and runs the printed `chgk backend add` command.
   - Then run the live end-to-end check: `chgk backend check`,
     `chgk new tournaments/example`, post a few events with the jury token (scratch
     script, no commit), look at the Sheet, try a jury edit on a round tab, and
     `chgk teams`.
   - Fix whatever the real Sheets service does differently from the fakes in
     `tests/js/fake_apps_script.mjs`.
2. **Phase 3:** the scanner web app in `web/s/` (zxing-wasm, setup via the jury link,
   offline queue, batches of marks).

## Lessons learned

- Board (user decisions, SPEC §10.1): revealed by hand after each round; full grid up to
  5 teams, else total + last round's grid; «Взяли» row. Read-only board token
  (`get_board`); `chgk board` adds one to tournaments created before Phase 5.

- Scanner «Чья карточка?» (user request, SPEC §7.1 item 5): read-only lookup of a card —
  team, question, current mark; records nothing. Leaving its sheet (or opening any other)
  ends the mode. In the e2e test the looping video shows judged cards again and the
  backend marks must be unchanged.

- Scanner: a link to the open page only changes `#…` (no reload) — handle `hashchange`
  (found by the screenshot run, now in the e2e test). The camera keeps decoding while a
  card is on screen, so the card lying there isn't reported again; another card is.
- Browser test: Chrome's `--use-file-for-fake-video-capture=<file>.mjpeg` plays real
  cut-out cards; requests to script.google.com are routed to the fake backend server.

- PDF links: a long URL wrapped over lines is only auto-linked on its first line by
  viewers (user clicked a cut-off Sheet link). Every URL in jury.pdf is a real link
  annotation (`_link()` markup, plus `linkURL` over each QR); tested.

- Reserve decks (SPEC §8.7): R1, R2 are on the Teams tab from the start but join the
  other tabs only on first scan or when named, so they never distort places. Names typed
  on any tab are propagated by team ID (`propagateNames_`), like marks.
- Jury sheet (user requests): page 1 holds every QR code, one per quarter (tested ≥ 3″
  apart, none on other pages); the roster became per-team player forms (ID + name +
  8 lines), no town or card counts.

- Team IDs are the organiser's (user request: rating numbers such as 58746) or assigned
  A01…; format 1-8 of `[0-9A-Z]`, which keeps the QR at version 4-M. Column A on every
  tab is plain text, or Sheets turns 645 into a number.

- Tabs are sorted (user request), so rows move under the jury. Never trust an edit's row:
  `applySheetEdits_` diffs every mark against Meta's known values by team ID, in the
  trigger and at the start of every `record_events`. Sorting refreshes per-row formulas
  before and after `Range.sort` (the fake's sort deliberately doesn't re-point them).
  `get_state` lists teams in ID order for the phones.

- Test the numbers, not only formula text: `sheet_formulas.mjs` evaluates the backend's
  formulas in the fakes, and `calculations.test.mjs` compares them with
  `standings()`/`placeLabels()` in logic.js. Mutating the place formula is caught by 8 tests.
  The live `get_results` action reads what Google really computed, for the same check
  against the real Sheet.
- Sheets turns text that looks like a number into a number (team «42» was right-aligned).
  Name columns are formatted `@` before rows are written; `set_teams` rewrites names
  stored as numbers, and «Итоги» formulas that differ from the current ones.

- PT Sans has no `″ → ✓ ✗ ◀ ▶ ☐ Σ` glyphs: use words («верно», «неверно»), drawn boxes, «Сумма».
- PT Sans glyph gaps: `render.missing_glyphs` guards every drawn string,
  and unknown characters print as `?` with a warning.
- typer 0.27 no longer depends on click: don't `import click`.
- Never make a phone user type or paste URLs/tokens: deliver them by QR (spike 2 lesson).
- Logic in `apps_script/` stays pure in logic.js; Code.js is exercised in Node through fakes (range bounds 1000×26 like real sheets).
- Judge shades on real content: 3% looked right as a solid swatch, but on the light-grey
  logos it was invisible. Scaling by the darkest pixel was a bug (a few stray dark pixels);
  now the darkest 10% of the drawing sets the shade.
- Draw cut guides **after** the cards, or the QR's white quiet zone hides them.
- The Sheet has «Итоги» plus one tab per round (user request), not one Results tab.
  Every lookup goes by team ID in column A (round tabs, «Итоги» formulas via MATCH, Meta
  with `team_id` in column A), so the jury can sort any tab. Formatting lives in
  `formatSheets_` and is re-applied by `set_teams`. Sheets with the old Results layout
  get a clear "older layout" error: create the tournament again.
- Google's consent screen lets the owner untick single permissions. The first live
  `chgk new` failed with "no permission to call SpreadsheetApp.create". Now `setup()`
  calls `ScriptApp.requireAllScopes`, ping reports `authorized`, and the CLI explains
  the error and warns on `backend add/check`.
- `setup()` run from the editor sees the owner-only `/dev` URL. It now prints a
  placeholder; the CLI needs the deployment's `/exec` URL.
- The Apps Script editor's Run button starts on the file's first function. The bundle
  used to start with logic.js's `fail()`, so the user's first "Run" just threw. Code.js
  now goes first and the first function is `setup()` (tested). `source_version` still
  hashes in logic.js, Code.js order, so reordering didn't change the version.

## GitHub

- Repo: <https://github.com/AntonMenshov/qa-chgk> (public). `gh` is logged in as
  AntonMenshov.
- Pages: <https://antonmenshov.github.io/qa-chgk/>, deployed by `.github/workflows/pages.yml`
  on pushes touching `web/` or `spikes/`. The scanner URL printed in QR codes is
  `https://antonmenshov.github.io/qa-chgk/s/`.
- Push after each commit: `git push`.

## Things that need the user

- Live backend (Phase 2): deployed under the user's Gmail as profile `personal`, now
  version 1ba5289567d9 (round tabs). The example tournament was re-created on it
  (new TID; cards and jury.pdf regenerated). Test marks, duplicates, stale scans, a
  bad team, a wrong token and `chgk teams` all checked live on 2026-10-29.
  2026-10-30, version 9a067acc3aed (sorted tabs): `get_results` from real Google matched
  the logic.js reference (sums, «2-3» places, tie-break order, Stats) on the example and
  on a throwaway 14-team tournament with two random batches (folder «Проверка расчётов»,
  the user may delete it). Latency: one mark per request ≈ 3.6–4.5 s (read all tabs, sort,
  refresh formulas); a 148-mark batch ≈ 10 s. Fine with the background queue, but worth
  optimising in Phase 3 (skip the sort when the order didn't change, fewer reads).
  User confirmed: tab colours, sorting, «42» left-aligned (2026-10-30).
  2026-10-30, version eb1607f87ed2: example re-created with the user's team IDs (645,
  58746, 40400; A01 assigned) and reserve decks R1, R2. Live: 270 card QRs decode, jury
  page 1 holds 3 QRs ≥ 3.7″ apart and no other page has one, R1's first scan put it on the
  tabs, the unused R2 stays off and out of the places, numbers match the reference.
  Version 385920657ebf deployed: an unused reserve's invalid event reports the real error
  (checked live: R2, question 99 → «invalid question»).
  2026-10-30: the user trashed the old folders; example re-created as QHZJ8 on version
  097f2269b709 (fresh ЧГК folder, no test marks), cards and jury.pdf regenerated and
  checked (270 QRs, jury QR, full-URL links).
  2026-10-30 scanner live check: headless Chrome on the deployed GitHub Pages app (fake
  camera, real cut-out cards) against the real backend (version 097f2269b709), throwaway
  tournament «Проверка сканера» (6VQPF; the user may delete its folder): 4 cards judged
  (incl. spare → keypad, reserve R1), foreign card refused, marks and places correct in
  the Sheet, no page errors. Sending took ~14 s after the last tap (background); the
  sort-skipping speedup is in 34a5241c5813, not yet deployed.
  34a5241c5813 deployed (user re-ran `setup` after `backend check` reported a missing
  permission; now clean). Measured live: 3.3–4.8 s per record_events request whether or
  not the order changes, so the sort was not the main cost; it is fixed per-request
  overhead. Background-only for the juror. Next backend update: add a timing breakdown to
  the reply, then optimise the biggest part.
  2026-10-30 board live check: version 6db9ad957009 deployed, `chgk board` gave QHZJ8 a
  board token, jury.pdf regenerated (board QR on page 1). Headless Chrome on the Pages
  board against the real backend: title screen, then → reveals Тур 1 and Тур 2 (grid, 4
  teams, all «1-4» with no marks yet), no page errors.
  **Still to confirm by the user (needs the edit trigger):** typing a name over
  «R1 · впишите название», and a mark edit on a round tab (`+` → `1`, row moves, Log row).
- Delete the old example folder `ЧГК/… (5R547)` (single Results layout) from Drive.
- A real print of the cards.
- Delete `spike.jpg` from the root of their Google Drive (left by spike 1).
