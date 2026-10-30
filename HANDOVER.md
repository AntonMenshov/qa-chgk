# Handover

Read this first when picking the project up, whether that's a new Claude session or
another person. It is updated at the end of every work session and every phase.

Last updated: 2026-10-30

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
| 2 — Apps Script backend + Sheet | ✅ deployed under the user's Gmail and checked live (sums, places, order, reserve teams, IDs, view-only link); the Sheet-trigger checks still to be confirmed by the user |
| 3 — Scanner web app | 🔶 built and tested (unit + integration + headless-Chrome end-to-end with a fake camera), checked live on Pages against the real backend; waiting for the user's iPhone check |
| 4 — Card photos | ✅ built, tested (phone queue, backend `upload_photo`, headless-Chrome check that each photo shows its card) and checked live (API upload to Drive); the iPhone check is in the user's list |
| 5 — Projector board + stats | ✅ built, tested and checked live |
| 6 — Logos | partly done: PNG/JPG → pale greyscale, shared private library, fallback owl. Left: SVG, Claude-drawn SVG, image-API generation |

- **Deployed backend:** version **8249b7275d76** under the user's Gmail (local profile
  `personal`), with the «Google Sheets API» service on. `uv run chgk backend check`
  compares it with the local code.
- **Example tournament:** `tournaments/example/` (the user's four teams 645 «42», 58746
  Фиаско, 40400 Совхоз Победа, A01 Звезды сошлись; reserve decks R1, R2), TID **QHZJ8**
  on that backend; `out/example/` holds its cards (team-pages) and jury.pdf.

### Repository layout
```
chgk/                 Python package (at repo root, no src/ — user's preference)
  cli.py              typer app: version, cards, test-page, jury-sheet, new, teams, board, view,
                      backend add|use|list|check|remove|bundle
  backend.py          backend profiles (~/.config/chgk/backends.json, CHGK_CONFIG_DIR), HTTP client, Code.gs bundler
  remote.py           new_tournament / sync_teams / ensure_board / ensure_view (a tournament keeps its own backend)
  config.py           Tournament / CardFields / Layout / LogoMode dataclasses + load_config
  ids.py              TID, team IDs, QR payload, jury and board links
  teams.py            teams.py loader/writer (keeps given team_ids, assigns + writes back missing ones)
  state.py            tournaments/<slug>/state.json (TID, backend URL/profile, sheet ID, jury and board tokens)
  logos.py            image → pale greyscale watermark
  jury.py             jury printout (platypus): QR pages, links, how-to, team forms, backup grid
  cards/
    model.py          a team's deck: numbered cards, then spares
    impose.py         team-pages / cut-stack / scissors slot assignment
    geometry.py       page grid and card parts (QR, number, writing area, logo, footer)
    render.py         reportlab drawing: vector QR, fonts, glyph check, fit-to-width
    build.py          folder → PDF (cards and test page)
    testpage.py       calibration page
  assets/fonts/       PT Sans Regular/Bold (OFL) — Cyrillic
apps_script/          backend, one global scope, joined in the order of bundle.json into one Code.gs:
                      Code.js (constants, setup, requests, access), logic.js (pure, Node-tested),
                      sheet_io.js (batched read/write), marks.js, sort.js, teams.js, drive.js,
                      disputed.js, photos.js, trigger.js; package.json makes them CommonJS
logos/                shared logo library (team logos git-ignored; nologo.png public)
tournaments/example/  working example: config.py, teams.py (the user's real teams)
tests/                pytest (tests/test_*.py) and node:test (tests/js/*.test.mjs), e.g.:
  conftest.py         shared `folder` fixture: a small tournament on disk
  test_scanner_e2e.py headless Chrome: the scanner (fake camera shows real cut-out cards) and the board; skipped without Chrome/Node
  js/fake_apps_script.mjs  in-memory Sheets, Drive, properties and Sheets API to run Code.js in Node:
                      computed values, "42" → 42 unless "@", a formula written in the same API call
                      is not calculated yet for a sortRange (seen live)
  js/sheet_formulas.mjs    evaluator for the Sheets formulas the backend writes
  js/calculations.test.mjs sums, places («2-3»), «Статистика» vs the logic.js reference; random tournaments
  js/sort_api.test.mjs     the one-call API sort against the slow sort and logic.js
  js/backend*.test.mjs     the backend by topic (core, photos, «Спорные», Sheets API I/O) on
                           the fake; shared helpers in js/backend_world.mjs
  js/logic.test.mjs, scanner.test.mjs, photos.test.mjs, board.test.mjs, vectors.test.mjs
  js/fake_backend_server.mjs  the fake backend over HTTP (for the browser tests)
  vectors/            shared JSON test vectors (qr_payloads, jury_links, board_links, merge_cases)
docs/google-account.md  deploying the backend under any Gmail account; switching; updating
docs/manual-checks.md   what the tests can't cover: iPhone, printing, the Sheet's edit trigger
docs/spikes.md        Phase 0 spike results (their code was removed; it is in the git history)
web/                  GitHub Pages site
web/s/                scanner app (no build step): index.html, app.css, app.js (wiring only), sw.js (offline),
                      manifest + icons; lib/ = payload, marks, session, lookup («Чья карточка?»), queue, api,
                      storage, camera, photos + photostore (card photos, IndexedDB); vendor/zxing-wasm-3.1.4 (QR reader, vendored: no CDN at the venue)
web/b/                projector board: index.html, board.css, board.js; lib/board.js = what to show
                      (rounds revealed by hand, places from revealed rounds only, grid vs compact);
                      lib/qr.js + vendor/qrcode-generator-1.4.4 (QR codes on screen)
.github/workflows/    tests.yml (ruff + pytest; ESLint + Prettier + npm test), pages.yml (deploys web/)
package.json          `npm test`, `npm run lint|format|format:check` (devDependencies: ESLint + Prettier only)
eslint.config.js, .prettierrc.json, pyproject.toml ([tool.ruff])  lint and format settings
README.md             organiser guide (end to end) and contributor commands
```

### How to run
- Tests: `uv run pytest` (401, incl. 2 browser tests that need Google Chrome + Node) and
  `npm test` (213, then 74 backend tests again with the Sheets API off).
- Lint and format: `uv run ruff format . && uv run ruff check .`, `npm run format && npm run lint`.
- Backend: `uv run chgk backend add|use|list|check|remove|bundle` (docs/google-account.md).
- A tournament: `uv run chgk new <folder>` (Sheet + Drive folder), `uv run chgk teams <folder>`
  (pull the Teams tab), `uv run chgk board <folder>` / `uv run chgk view <folder>` (board and
  view-only links).
- Cards: `uv run chgk cards tournaments/example [--mode team-pages|cut-stack|scissors] [--teams A01,A02]`
  → `out/<slug>/cards-<mode>.pdf` + `out/<slug>/jury.pdf`. Without `--mode` it asks.
- Jury sheet alone: `uv run chgk jury-sheet <folder>`; calibration page: `uv run chgk test-page <folder>`.

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

- **Lint and format before committing** (user request, Google style where it applies,
  120 columns; CI checks both):
  - Python: `uv run ruff format . && uv run ruff check .` (pyproject: pycodestyle,
    pyflakes, isort, naming, bugbear, pyupgrade, Google-convention docstrings; missing
    docstrings are not errors).
  - JS/HTML/CSS: `npm run format && npm run lint` (Prettier in Google's layout: single
    quotes, `{a, b}` without inner spaces; ESLint recommended + Google's checkable rules,
    braces on every `if`). `chgk backend bundle` looks for `const VERSION = 'dev';`.
  - pytest runs with `filterwarnings = error`: any warning fails the run.

## Key decisions (details in SPEC.md)

- **Backend:** one Apps Script web app per Google account. It creates one Sheet and
  one Drive folder per tournament. No Google Cloud project.
- **Switchable Google account (user requirement, SPEC §3.1):**
  - no account is named in the repo;
  - backends are named local profiles in `~/.config/chgk/backends.json`;
  - each tournament's `state.json` records its backend;
  - the jury link carries the backend URL;
  - QR codes don't depend on the account.
- **Backend speed (SPEC §3.2; user picked the proposals, 2026-10-30):**
  - one Sheets API `Values.batchGet` and one `Values.batchUpdate` (RAW) per request,
    SpreadsheetApp as the fallback (service off, quota 60/min/account, a tab past its grid);
  - the spreadsheet is opened only when needed (`open_` returns a lazy wrapper);
  - a re-sort is one `spreadsheets.batchUpdate` (per tab: sortRange, then the per-row
    formulas), after checking the computed sort keys against the marks (`m.sortKeysOk`);
    tab IDs cached in the registry (`sheet_ids`); otherwise the slow sort;
  - every reply has `timing`; Log times are text in the script's time zone.
  - Proposal numbering used with the user: #1 timings (done), #2 cache for board/phone
    reads (parked for a later version), #3 batched read/write and one-call sort (done),
    #4 one ARRAYFORMULA per column (rejected).
  - Live, 30 teams × 36 questions: board/phone refresh ~1.1 s, one mark ~1.6 s, a mark
    that re-sorts ~1.7–2.2 s, 15 marks ~1.4 s (before: 2.6 / 2.8 / 4.3 / 5.0 / 5.9 s);
    ~0.7–1 s of each is Google outside the script.
- **Sheet tabs:** «Итоги», «Тур 1…N» (sorted), «Статистика», hidden «Спорные» (every undecided «?» with its card photo's
  link, in A–D; counts overall, per round and per team in G–H, two empty columns away;
  rewritten only when the set of «?» changes or a «?» card's photo arrives), hidden
  Teams, Log, Settings, Meta. Only the visible ones appear on the view-only link.
- **Scanner:** static web app on GitHub Pages, public repo **`qa-chgk`**; v1 access via
  a secret jury link. The current question follows the scans; a spare card asks for its
  question; «Чья карточка?» reads a card without recording anything.
- **Board (SPEC §10.1):** revealed by hand after each round; full grid up to 5 teams,
  else total + last round's grid; «Взяли» row. Read-only board token (`get_board`). QR
  codes of the view-only table and of the board itself (the jury sheet's links, decoded
  from screenshots in the browser test); Q toggles them.
- **Drive names are Latin** (user rule, SPEC §3.3): `CHGK/<date> <name> (<TID>)` with
  the Sheet and `Photos` inside; names transliterated by `latinName` (logic.js).
- **View-only link:** the Sheet is shared "anyone with the link can view" at creation;
  the QR opens `…/htmlview`; `chgk view` prints it.
- **No upgrade code for older Sheets** (user decision, 2026-10-30): the migrations
  (ЧГК→CHGK, Stats→Статистика, old Meta format, old Results layout, old «Спорные» layout,
  Latin renaming, `share_view`) were removed after the example (QHZJ8) had been upgraded.
  A tournament made by an older version must be created again.
- **QR:** a URL, `…/s/#<TID>.<TEAM>.<Q>`; spare cards use `S1…Sn`. Printed at
  **0.65 in** including the quiet zone, error correction M, vector.
- **Team IDs** are the organiser's (e.g. rating numbers such as 58746) or assigned
  A01…; 1-8 of `[0-9A-Z]`, which keeps the QR at version 4-M.
- **Mark cells (round tabs):**
  - blank = no card;
  - `R` = received, not judged;
  - `1` / `0` / `?` = judged.
  - A missing card scores 0. Last write wins by client timestamp. `?` and appeals are
    resolved by editing the sheet.
- **Photos (Phase 4, SPEC §7.2):** one photo per card per phone, taken from the frame the
  QR was read from; own queue in IndexedDB, 2 uploads at a time, never delaying marks;
  `upload_photo` saves to the tournament's `Photos` folder (Latin names) outside the lock,
  logs the link, and shows it on «Спорные» for a «?». Kept forever.
- **Cards:**
  - Letter, default 3×5 = 15 per page, grid configurable.
  - **Edge to edge in every mode**: neighbouring cards share a cut line. The user
    rejected gutters in scissors mode as wasteful.
  - Modes: team-pages (light lines + crop marks), cut-stack (same, guillotine order),
    scissors (darker dashed lines, no crop marks). The CLI asks which one; regenerating
    the example reuses the mode of the existing PDF.
  - No date unless `CardFields(date=True)` (user: "I never asked for it").
  - Logo watermark at **12% grey**, measured on the logo's dark parts (SPEC §9). A sized
    logo is centred on the card; its corner may go under the QR, which is drawn on top.
  - **Logo library** `logos/` at the repo root (SPEC §9):
    - team logos are private (git-ignored); only `nologo.png` is public;
    - fallback chain: team → tournament → `nologo.png`;
    - the example tournament is set up the way the user asked: **no team name on cards,
      logo 10%, logo_size 1.85 in**. The defaults elsewhere stay team name on, 12%, auto size.
- **Teams:** one stack per team for the whole game, plus at least 2 spares (user rule);
  free slots become extra spares in every mode (guillotine: shared out across the teams),
  never an extra page. Spare cards carry no words: an empty white box where the number
  goes (user request).
- **Reserve decks (SPEC §8.7):** R1, R2… for teams that turn up unregistered. They are on
  the Teams tab from the start but join the other tabs only on first scan or when named,
  so they never distort places. Their cards print the ID bottom right.
- **Juror view:** the app doesn't show the official answer.
- **Jury printout** (user requests, SPEC §8.6), in Russian, written with every `cards` run:
  - page 1 (secret): jury access (top half), editable Sheet, scanner;
  - page 2: board + view-only Sheet; no QR on other pages;
  - page 3: details, links, juror, «?»/appeals and board («Табло») how-tos;
  - team forms (ID, name, 8 player lines), two per row;
  - paper backup grid; the date in the QR pages' titles and every footer.
- **Jury link:** `<scanner_url>#setup=<TID>.<TOKEN>.<DEPLOYMENT_ID>`.
- **Jurors:** one at a time for now; the data model is ready for several.
- **Deferred:** one list, in [PLAN.md](PLAN.md) («Later»).

## Open items

Kept in one place: [SPEC.md §14](SPEC.md) (defaults used unless the user says otherwise).

## Next steps

1. **User checks:** the scanner on an iPhone with the example cards (incl. «Чья
   карточка?» and card photos) and the Sheet-trigger checks ([docs/manual-checks.md](docs/manual-checks.md)).
2. **Phase 6 — logos** (PLAN.md, agreed with the user 2026-10-30): SVG input and
   `chgk logos` (report, preview, accept), then Claude-drawn SVG drafts (API, or in a
   session without a key) in the style of the existing logos.
3. **Later:** see PLAN.md «Later».

## Lessons learned

- **Sheets API, seen live:** in one `spreadsheets.batchUpdate`, a formula written by
  `updateCells` is not calculated yet for a later `sortRange`; every key looked blank and
  «Итоги» fell into ID order (totals and places were right). The fake now behaves the
  same, which reproduces it. Check sorting against a reference on the real Sheet after
  any change to it (`get_results` returns what Google computed).
- **Phantom Micro QR (2026-10-30):** a test failed about once in 100 runs. For some
  tournament IDs (e.g. SP7EM) a real QR's corner plus its neighbouring modules form a
  valid Micro QR, and zxing's "QRCode" format is the whole family (Model 1/2, Micro,
  rMQR). The phone now asks for `QRCodeModel2` only (`READER_OPTIONS`, camera.js), the
  tests read the same way (`read_qr` in conftest.py), and three tests guard it: a
  Micro QR next to a card in the phone's real decoder (browser test), the options
  themselves (Node), and every card's QR read back at 150 dpi for 12 tournament IDs in
  every mode. Breaking the filter fails two of them.
- **Profile before optimising:** the first guess (the sort) was not the main cost; the
  per-step `timing` showed Google's ~1 s per request, ~0.3 s for opening the spreadsheet,
  and many small reads and writes.
- **«Спорные»:** compare with Meta's known values, not with the tab: a jury edit is
  already on the tab when the trigger reads it (a test caught this). A photo sent in the
  same request as its «?» must count too.
- Tabs are sorted (user request), so rows move under the jury. Never trust an edit's row:
  `applySheetEdits_` diffs every mark against Meta's known values by team ID, in the
  trigger and at the start of every `record_events`. `get_state` lists teams in ID order
  for the phones. Every lookup goes by team ID in column A.
- Sheets turns text that looks like a number into a number (team «42» was right-aligned,
  ID 645 became a number). Name and ID columns are formatted `@` before rows are written;
  Sheets API writes are RAW.
- Test the numbers, not only formula text: `sheet_formulas.mjs` evaluates the backend's
  formulas in the fakes, and `calculations.test.mjs` compares them with
  `standings()`/`placeLabels()` in logic.js.
- **Mutation checks:** for risky logic, break the code on purpose and confirm a test
  fails (done for the place formula and for the one-call sort: all breaks caught).
- Scanner: a link to the open page only changes `#…` (no reload) — handle `hashchange`
  (found by the screenshot run, now in the e2e test). The camera keeps decoding while a
  card is on screen, so the card lying there isn't reported again; another card is.
- Browser test: Chrome's `--use-file-for-fake-video-capture=<file>.mjpeg` plays real
  cut-out cards; requests to script.google.com are routed to the fake backend server.
- PDF links: a long URL wrapped over lines is only auto-linked on its first line by
  viewers (user clicked a cut-off Sheet link). Every URL in jury.pdf is a real link
  annotation (`_link()` markup, plus `linkURL` over each QR); tested.
- PT Sans has no `″ → ✓ ✗ ◀ ▶ ☐ Σ ☰` glyphs: use words («верно», «неверно»), drawn boxes,
  «Сумма». `render.missing_glyphs` guards every drawn string; unknown characters print
  as `?` with a warning.
- Prettier's single quotes: `chgk backend bundle` looks for `const VERSION = 'dev';`
  (a test caught the old double-quoted marker).
- typer 0.27 no longer depends on click: don't `import click`.
- Never make a phone user type or paste URLs/tokens: deliver them by QR (spike 2 lesson).
- Logic in `apps_script/` stays pure in logic.js; Code.js is exercised in Node through
  fakes (range bounds 1000×26 like real sheets).
- Judge shades on real content: 3% looked right as a solid swatch, but on the light-grey
  logos it was invisible. Scaling by the darkest pixel was a bug (a few stray dark
  pixels); now the darkest 10% of the drawing sets the shade.
- Draw cut guides **after** the cards, or the QR's white quiet zone hides them.
- Google's consent screen lets the owner untick single permissions. The first live
  `chgk new` failed with "no permission to call SpreadsheetApp.create". Now `setup()`
  calls `ScriptApp.requireAllScopes`, ping reports `authorized`, and the CLI explains
  the error and warns on `backend add/check`.
- `setup()` run from the editor sees the owner-only `/dev` URL. It prints a placeholder;
  the CLI needs the deployment's `/exec` URL.
- The Apps Script editor's Run button starts on the file's first function. Code.js goes
  first in the bundle and its first function is `setup()` (tested).
- After a change to how cards or the jury sheet are drawn, regenerate `out/example/` in
  the mode already used; don't ask (user feedback).

## GitHub

- Repo: <https://github.com/AntonMenshov/qa-chgk> (public). `gh` is logged in as
  AntonMenshov.
- Pages: <https://antonmenshov.github.io/qa-chgk/>, deployed by `.github/workflows/pages.yml`
  on pushes touching `web/`. The scanner URL printed in QR codes is
  `https://antonmenshov.github.io/qa-chgk/s/`.
- Push after each commit: `git push`.

## Things that need the user

- The iPhone check of the scanner with the example cards, incl. «Чья карточка?» and card photos
  ([docs/manual-checks.md](docs/manual-checks.md), "iPhone scanner").
- The Sheet-trigger checks: typing a name over «R1 · впишите название», a mark edit on a
  round tab (`+` → `1`, row moves, Log row), and a «?» leaving «Спорные»
  (docs/manual-checks.md, "The Sheet's edit trigger").
- A real print of the cards.

Live checks done so far (2026-10-29/30, all against the user's backend): marks,
duplicates, stale scans, bad teams and tokens; sums, «2-3» places and tie-break order vs
the logic.js reference on 4- and 14-team tournaments; reserve decks; the scanner on
Pages in headless Chrome; the board; the view-only link without a Google login; backend
speed and the one-call sort (10 rounds of order-changing marks, «Итоги» equal to the
reference); Latin Drive names (version 6719354da92c: the example renamed by `chgk view`;
a new tournament «Проверка имён «Звёзды» №1» created as `2026-10-30 Proverka imen Zvezdy
No1 (UDHBH)`, marks, reserve team and standings correct, view-only links open);
card photos (5bee727e1620, throwaway RG3HC: a 66 KB JPEG saved to Drive in ~2 s, a repeat
upload recognised, a non-JPEG refused) and the board's QR codes on Pages against the real
backend (decoded = the jury sheet's links). Throwaway tournaments: the user deletes them.
