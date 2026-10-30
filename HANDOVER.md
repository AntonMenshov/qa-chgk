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
| 0 — Skeleton and spikes | ✅ spike 1 (laptop + iPhone Safari), spike 2 (all QR sizes scan well; zxing-wasm chosen), spike 3 (0.65 in QR, later 0.85; logo shade later changed to 12%) |
| 1 — Config, identity, card PDF | ✅ done; cards + jury sheet work offline from `teams.py` |
| 2 — Apps Script backend + Sheet | ✅ deployed under the user's Gmail and checked live (sums, places, order, reserve teams, IDs, view-only link); the Sheet-trigger checks are in Phase 7 |
| 3 — Scanner web app | 🔶 built and tested (unit + integration + headless-Chrome end-to-end with a fake camera), checked live on Pages against the real backend; the iPhone check is in Phase 7 |
| 4 — Card photos | ✅ built, tested (phone queue, backend `upload_photo`, headless-Chrome check that each photo shows its card) and checked live (API upload to Drive); the iPhone check is in Phase 7 |
| 5 — Projector board + stats | ✅ built, tested and checked live |
| 6 — Logos | ✅ built and tested (SPEC §9.1): SVG logos (resvg, PT Sans lettering, unsafe SVGs refused), `chgk logos` report, Claude-drawn drafts (Claude Opus 5.5 at max effort with a render-and-review loop, key from `ANTHROPIC_API_KEY` only; a brief for Claude Code without it), preview PDF, `--accept`. Tested on the user's 22 teams: drawn in a session (`tournaments/logo-drafts/`) and through the API (`tournaments/logo-drafts-api/`); local only, never accepted. Image-API logos: Phase 9 |
| 7 — Internal test at home (printouts) | not started: the manual checks (docs/manual-checks.md), a mock game, feedback, bug analysis and fixes, then a docs/comments check |
| 8 — External test at a tournament | not started: the same loop with real teams |
| 9 — Next version | the deferred list in PLAN.md |

- **Deployed backend:** version **8ec3eeb36149** (2026-10-30) under the user's Gmail (local
  profile `personal`), with the «Google Sheets API» service on. `uv run chgk backend check`
  compares it with the local code, and says when `out/apps_script/Code.gs` is an old bundle.
- **Example tournament:** `tournaments/example/` (the user's four teams 645 «42», 58746
  Фиаско, 40400 Совхоз Победа, A01 Звезды сошлись; reserve decks R1, R2), TID **UYDJ7**
  (re-created 2026-10-30 after the user deleted the old folder) on that backend;
  `out/example/` holds its cards (team-pages, 3×4, 24 pages) and jury.pdf.
- **Second example:** `tournaments/example-15/` — the same four teams, 3 rounds of 15
  questions, TID **U9FP4**; `out/example-15/` has its cards (team-pages, 3×4, 24 pages)
  and jury.pdf.

### Repository layout
```
chgk/                 Python package (at repo root, no src/ — user's preference)
  cli/                typer app, one module per group: common.py (app, errors, version), cards.py
                      (cards, test-page, jury-sheet), profiles.py (backend add|use|list|check|remove|bundle),
                      tournament.py (new, teams, board, view), logos.py (logos)
  backend.py          backend profiles (~/.config/chgk/backends.json, CHGK_CONFIG_DIR), HTTP client, Code.gs bundler
  remote.py           new_tournament / sync_teams (a tournament keeps its own backend)
  config.py           Tournament / CardFields / Layout / LogoMode dataclasses + load_config
  ids.py              TID, team IDs, QR payload, jury and board links
  teams.py            teams.py loader/writer (keeps given team_ids, assigns + writes back missing ones)
  state.py            tournaments/<slug>/state.json (TID, backend URL/profile, sheet ID, jury and board tokens)
  logos.py            which logo a card uses (logo_chain), loading (warnings, not crashes), pale watermark, logo_report
  svg.py              SVG logos: safety check (check_svg), rendering with PT Sans only (render_svg)
  logo_drafts.py      Claude-drawn drafts: the API request, style rules, the no-key brief, accept into logos/
  jury.py             jury printout (platypus): QR pages, links, how-to, team forms, backup grid
  cards/
    model.py          a team's deck: numbered cards, then spares
    impose.py         team-pages / cut-stack / scissors slot assignment
    geometry.py       page grid and card parts (QR, number, writing area, logo, footer)
    render.py         reportlab drawing: vector QR, fonts, glyph check, fit-to-width
    build.py          folder → PDF (cards, test page, logo preview)
    testpage.py       calibration page
  assets/fonts/       PT Sans Regular/Bold (OFL) — Cyrillic
apps_script/          backend, one global scope, joined in the order of bundle.json into one Code.gs:
                      Code.js (constants, setup, requests, access), logic.js (pure, Node-tested),
                      sheet_io.js (batched read/write), marks.js, sort.js, teams.js, drive.js,
                      disputed.js, photos.js, trigger.js. logic.js is an ES module (package.json);
                      the bundler and the Node fake drop its `export`s, since Apps Script has none
logos/                shared logo library (team logos git-ignored; nologo.png public); drafts/<slug>/<team_id>.svg
tournaments/example/  working example: config.py, teams.py (the user's real teams)
tournaments/example-15/  the same teams, 3 rounds of 15 questions
tests/                pytest (tests/test_*.py) and node:test (tests/js/*.test.mjs), e.g.:
  conftest.py         shared `folder` fixture: a small tournament on disk (TEST_GRID: 3×5, 0.65 in QR on purpose)
  node_backend.py     the real backend (js/fake_backend_server.mjs in Node) answering the CLI tests through respx
  test_scanner_e2e.py headless Chrome: the scanner (fake camera shows real cut-out cards), the board, the phone's decoder vs a phantom Micro QR; skipped without Chrome/Node
  js/fake_apps_script.mjs  in-memory Sheets, Drive, properties and Sheets API to run Code.js in Node:
                      computed values, "42" → 42 unless "@", a formula written in the same API call
                      is not calculated yet for a sortRange (seen live)
  js/sheet_formulas.mjs    evaluator for the Sheets formulas the backend writes
  js/calculations.test.mjs sums, places («2-3»), «Статистика» vs the logic.js reference; random tournaments
  js/sort_api.test.mjs     the one-call API sort against the slow sort and logic.js
  js/backend*.test.mjs     the backend by topic (core, access, photos, «Спорные», Sheets API I/O) on
                           the fake; shared helpers in js/backend_world.mjs
  js/logic.test.mjs, scanner.test.mjs, photos.test.mjs, board.test.mjs, vectors.test.mjs
  js/fake_backend_server.mjs  the fake backend over HTTP (for the browser and CLI tests)
  vectors/            shared JSON test vectors (qr_payloads, jury_links, board_links, merge_cases)
docs/google-account.md  deploying the backend under any Gmail account; switching; updating
docs/manual-checks.md   what the tests can't cover: iPhone, printing, the Sheet's edit trigger
docs/spikes.md        Phase 0 spike results (their code was removed; it is in the git history)
web/                  GitHub Pages site
web/s/                scanner app (no build step): index.html, app.css, app.js (wiring + start), sw.js (offline),
                      ui/ = screens (state: the shared `app` object; dom, setup, tournament, scan,
                      whose «Чья карточка?», sync),
                      manifest + icons; lib/ = payload, marks, session, lookup («Чья карточка?»), queue, api,
                      storage, camera, photos + photostore (card photos, IndexedDB); vendor/zxing-wasm-3.1.4 (QR reader, vendored: no CDN at the venue)
web/shared/logic.js   link to apps_script/logic.js: the scanner (merge rule) and the board (places,
                      tie-break order) import the backend's own rules; pages.yml copies it (cp -L)
web/b/                projector board: index.html, board.css, board.js; lib/board.js = what to show
                      (rounds revealed by hand, places from revealed rounds only, grid vs compact);
                      lib/qr.js + vendor/qrcode-generator-1.4.4 (QR codes on screen)
.github/workflows/    tests.yml (ruff + pytest; ESLint + Prettier + npm test), pages.yml (deploys web/, also when apps_script/logic.js changes)
package.json          `npm test`, `npm run lint|format|format:check` (devDependencies: ESLint + Prettier only)
eslint.config.js, .prettierrc.json, pyproject.toml ([tool.ruff])  lint and format settings
README.md             organiser guide (end to end) and contributor commands
```

### How to run
- Tests: `uv run pytest` (500, incl. 3 browser tests that need Google Chrome + Node) and
  `npm test` (216, then 75 backend tests again with the Sheets API off).
- Lint and format: `uv run ruff format . && uv run ruff check .`, `npm run format && npm run lint`.
- Backend: `uv run chgk backend add|use|list|check|remove|bundle` (docs/google-account.md).
- A tournament: `uv run chgk new <folder>` (Sheet + Drive folder), `uv run chgk teams <folder>`
  (pull the Teams tab), `uv run chgk board <folder>` / `uv run chgk view <folder>` (board and
  view-only links).
- Cards: `uv run chgk cards tournaments/example [--mode team-pages|cut-stack|scissors] [--teams A01,A02]`
  → `out/<slug>/cards-<mode>.pdf` + `out/<slug>/jury.pdf`. Without `--mode` it asks.
- Jury sheet alone: `uv run chgk jury-sheet <folder>`; calibration page: `uv run chgk test-page <folder>`.
- Logos: `uv run chgk logos <folder> [--draw [--team A01]] [--accept all|A01,A02]` (report; drafts;
  `out/<slug>/logo-preview.pdf`). The tests never call the API: the SDK runs on a mocked transport.

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

One line each; SPEC has the details. Decisions recorded only here are written out.

- **Backend:** one Apps Script web app per Google account, one Sheet + Drive folder per
  tournament, no Google Cloud project; the account is switchable (named profiles,
  `state.json` keeps each tournament's backend) — SPEC §3, §3.1.
- **Backend speed** — SPEC §3.2. Proposal numbers used with the user: #1 timings (done),
  #2 cache for board/phone reads (Phase 9), #3 batched read/write and one-call sort (done),
  #4 one ARRAYFORMULA per column (rejected).
- **Drive names are Latin** — SPEC §3.3.
- **No upgrade code for older Sheets** (user, 2026-10-30): migrations and the pre-Phase-5
  board-token upgrade were removed; a tournament made by an older version is created again.
- **Sheet tabs**, mark cells (blank / `R` / `1` `0` `?`, last write wins), «Спорные» — SPEC §5.
- **QR and card identity** — SPEC §6; 0.85 in (was 0.65; user: ~30% bigger); team IDs of
  1-8 `[0-9A-Z]` keep the QR at version 4-M.
- **Scanner**, sync, card photos (kept forever), access via the jury link — SPEC §7.
- **Cards** — SPEC §8: default grid 3×4 (user; was 3×5), edge to edge in every mode (the
  user rejected gutters in scissors mode), the CLI asks the cut mode, no date unless
  `CardFields(date=True)` (user: "I never asked for it"), `CardFields(no_qr=True)` for a paper-only
  game (default False; the QR corner stays empty), at least 2 spares and free slots
  as extra spares, reserve decks R1, R2… (§8.7), the jury printout (§8.6).
- **Logos** — SPEC §9: private library `logos/`, fallback chain, 12% shade; SVG and Claude-drawn
  drafts §9.1 (always Claude Opus 5.5 at max effort, with a render-and-review loop; the key only
  from `ANTHROPIC_API_KEY`). Drafts are never deleted or overwritten (user, 2026-10-30).
  The example tournament has no team name on cards, logo 10%, logo_size 1.85 in (user);
  elsewhere the defaults stay.
- **Board** — SPEC §10.1. **Juror view:** no official answer (§7.5). **Jurors:** one at a
  time; the data model is ready for several (§7.3).
- **Deferred:** one list, [PLAN.md](PLAN.md) Phase 9 (next version).

## Open items

Kept in one place: [SPEC.md §14](SPEC.md) (defaults used unless the user says otherwise).

## Next steps

1. **Phase 6 follow-up:** the logo drafts are a test only (user, 2026-10-30: they will not be
   accepted). `tournaments/logo-drafts/` (22 drawn in a session) and `tournaments/logo-drafts-api/`
   (the same teams through the API) stay local (git-ignored). The key is in the user's shell
   profile: a Claude Code session started earlier doesn't see it, so run
   `zsh -ic 'uv run chgk logos … --draw'`.
2. **Phase 7** internal test at home with printouts: it starts with the user's manual
   checks ([docs/manual-checks.md](docs/manual-checks.md)), then a mock game. Then **Phase 8**,
   an external test at a tournament. Each with feedback entry, bug analysis and fixes, and a
   docs/comments check.
3. **Phase 9 — next version:** the deferred list in PLAN.md.

## Lessons learned

- **resvg drops text in a font it doesn't have** (no fallback when `skip_system_fonts`):
  a `font-family="Helvetica"` name vanished. `render_svg` forces PT Sans with a style sheet
  (`!important` beats `style=` and `font=`); a test renders four font names identically.
- **The anthropic SDK 2.x runs on `httpx2`**, so respx can't mock it: the tests give a real
  client an `httpx2.MockTransport` that answers with SSE text. It sends the key as
  `Authorization: Bearer`.
- **Logo drafts, what made them weak** (22 drawn in a session from shared templates): owls all
  alike; the owl standing next to the prop instead of acting; jokes resting on details that
  vanish pale (A12's bandage, A18's spade); a cluster of circles read as roses (A17); a name
  touching the edges (A16). `style_rules` and the review loop now address each.
- **Max effort without a task budget ran out of tokens:** in the first full API run, 2 of 4
  drawings thought until the 128K output limit and ended with no SVG (~$2.50 each for nothing);
  finished drawings used 107-124k in the drawing round, ~150-175k per logo in all (~$3-3.50).
  Now a 100k task budget plus one retry of a cut-off drawing.
- **reportlab stores identical images once:** two teams with the same draft gave one image
  in the PDF; tests that count images need different drawings.
- **Redeploying:** run `chgk backend bundle` right before pasting; a stale
  `out/apps_script/Code.gs` was pasted once and the backend stayed old (`chgk backend check`
  now says so). After "deployed": `chgk backend check`, a live check, this file's version line.
- **Tests of a rule must state the rule themselves.** The first access tests read the allowed
  token from the ACTIONS table, so weakening the table weakened the tests too; found by
  deliberately breaking the table. backend_access.test.mjs now pins the rule on its own.
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
- **A request Google never answers** (seen once: a photo upload > 90 s; the same upload
  then took 3.4 s). The phone now cuts every request at 45 s (`REQUEST_TIMEOUT_MS`, api.js)
  and retries it like any failure; marks and photos carry IDs, so nothing counts twice.
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
- After a change to how cards or the jury sheet are drawn, regenerate `out/example/` and
  `out/example-15/` in the mode already used; don't ask (user feedback).

## GitHub

- Repo: <https://github.com/AntonMenshov/qa-chgk> (public). `gh` is logged in as
  AntonMenshov.
- Pages: <https://antonmenshov.github.io/qa-chgk/>, deployed by `.github/workflows/pages.yml`
  on pushes touching `web/` or `apps_script/logic.js` (web/shared/logic.js links to it). The scanner URL printed in QR codes is
  `https://antonmenshov.github.io/qa-chgk/s/`.
- Push after each commit: `git push`.

## Things that need the user

- The manual checks ([docs/manual-checks.md](docs/manual-checks.md)): iPhone scanner, the
  Sheet's edit trigger, a real print. They are the start of Phase 7 (PLAN.md).

Live checks done so far, all against the user's backend:
- **2026-10-29/30:** marks, duplicates, stale scans, bad teams and tokens; sums, «2-3»
  places and tie-break order vs the logic.js reference on 4- and 14-team tournaments;
  reserve decks; the scanner on Pages in headless Chrome; the board; the view-only link
  without a Google login.
- **2026-10-30, speed:** the one-call sort (10 rounds of order-changing marks, «Итоги»
  equal to the reference).
- **2026-10-30, Latin Drive names** (6719354da92c): a new tournament «Проверка имён «Звёзды»
  №1» created as `2026-10-30 Proverka imen Zvezdy No1 (UDHBH)`; marks, reserve team and
  standings correct, view-only links open.
- **2026-10-30, card photos** (5bee727e1620, throwaway RG3HC): a 66 KB JPEG saved to Drive
  in ~2 s, a repeat upload recognised, a non-JPEG refused; the board's QR codes on Pages
  decode to the jury sheet's links.
- **2026-10-30, cleaned-up backend** (e08511993c86): split files, migrations removed,
  photos for unknown teams refused, `share_view` gone; marks, reserve, standings, photo
  3.4 s, board, example OK.
- **2026-10-30, ac4a2b56a43a:** board and phone data for both examples (UYDJ7, U9FP4);
  `set_board_token` refused as unknown.
- **2026-10-30, cf91a9af927e (ACTIONS table):** admin, jury, board and a wrong token against
  get_teams / get_state / get_board on the example: each token reaches exactly its level.
- **2026-10-30, 8ec3eeb36149 (review fixes):** both examples' get_state / get_board; throwaway
  UAHQT: a re-scan keeps the judgement, `R`, `?`, question 99 refused alone, the batch in. The
  cleared-cell and deleted-row cases need a Sheet edit: docs/manual-checks.md.

Throwaway tournaments: the user deletes them.
