# Handover

Read this first when picking the project up, whether that's a new Claude session or
another person (CLAUDE.md points here). It is updated at the end of every work session and
every phase. On another laptop: [docs/new-machine.md](docs/new-machine.md). Why the code is the
way it is: [docs/lessons.md](docs/lessons.md).

Last updated: 2026-11-01

## What this project is

Tools for in-person sport ЧГК:
- print answer cards with QR codes;
- the jury scans the returned cards on an iPhone and marks each ✓ / ✗ / ?;
- results sync to a Google Sheet.

Full design: [SPEC.md](SPEC.md). What's left: [PLAN.md](PLAN.md).

## Current state

| Phase | Status |
|---|---|
| Spec and plan | ✅ done, agreed with the user |
| 0-6 — Skeleton, cards, backend, scanner, photos, board, logos | ✅ built and tested; backend and board checked live, iPhone and Sheet-trigger checks passed in Phase 7; logos tried on the user's 22 teams (drafts kept, never accepted: Key decisions, Logos) |
| 7 — Internal test at home (printouts) | in progress: manual checks done on a throwaway tournament (CHECK1; since deleted, locally and in Drive), all fine except the feedback below, now fixed. Next: reprint, the fixes' own checks on an iPhone, the mock game, then a docs/comments check |
| 8 — External test at a tournament | not started: the same loop with real teams |
| 9 — Next version | the deferred list in PLAN.md |

- **Deployed backend:** version **7b6015416359** (2026-11-01; full live check passed: sorting, clock cap, photos, public copy, private Sheet, the one-off timer, refusals, `chgk delete`; the local code is ahead by comments only until the next deploy) under the user's Gmail (local
  profile `personal`), with the «Google Sheets API» service on. `uv run chgk backend check`
  compares it with the local code, and says when `out/apps_script/Code.gs` is an old bundle.
- **Phase 7 tournament:** `tournaments/osenniy-salat/` «Осенний салат», 2026-11-20, TID **18376**,
  the user's four teams, 3 rounds of 12; the same card look as the example. Created on the backend
  (profile `personal`), recreated 2026-10-31 on the new backend, empty, with its public copy; `out/osenniy-salat/` has its
  cards (team-pages, 3×4, 24 pages) and jury.pdf.
- **Phase 7 feedback (2026-10-30), fixed:** a card already entered offers «Отмена (останется: …)»;
  board: wrong is a red «×», no card yet a small grey «•»; board on a phone: the buttons stay, it says
  what to tap, no QR codes and the last round's grid by default; the QR sits 20% farther from the
  card's top and right edges (~0.4 mm); logo shade 14% by default, `logo_grey=` per team in teams.py.
  Earlier printouts still scan, but have the old shade and QR position. Screen rotation can't be locked from a web page on an iPhone: use its Portrait Orientation Lock.
- **`ANTHROPIC_API_KEY`:** not set on the current machine, and not needed for now: the `--draw`
  checks are in Phase 9 (user).
- **Example:** `tournaments/example/` is only a reference to copy (the user's four teams 645 «42»,
  58746 Фиаско, 40400 Совхоз Победа, A01 Звезды сошлись). It is never run and never has a `state.json`
  (user, 2026-10-30); `load_config` refuses it.

### Repository layout
```
chgk/                 Python package (at repo root, no src/ — user's preference)
  __init__.py         PROJECT_DIR, the font files, out_dir(): every output under the repo's out/; write_file, warn;
                      run_python_file: config.py and teams.py compiled from their current text
  cli/                typer app, one module per group: common.py (app, errors, version), cards.py
                      (cards, test-page, jury-sheet), profiles.py (backend add|use|list|check|remove|bundle),
                      tournament.py (new, teams, board, view, results-copy, delete, replace-token), logos.py (logos)
  backend.py          backend profiles (~/.config/chgk/backends.json, CHGK_CONFIG_DIR), HTTP client, Code.gs bundler
  remote.py           new_tournament / sync_teams / replace_token (a tournament keeps its own backend)
  config.py           Tournament / CardFields / Layout / LogoMode dataclasses + load_config
  ids.py              TID, team IDs, QR payload, jury and board links
  teams.py            teams.py loader/writer (keeps given team_ids, assigns + writes back missing ones)
  state.py            tournaments/<slug>/state.json (TID, backend URL/profile, sheet ID, jury and board tokens, replacements)
  logos.py            which logo a card uses (logo_chain), loading (warnings, not crashes), pale watermark, logo_report
  svg.py              SVG logos: safety check (check_svg), rendering with PT Sans only (render_svg)
  logo_drafts.py      Claude-drawn drafts: the API request and review loop, draw_drafts (several teams at
                      once), style rules, the no-key brief, accept into logos/
  jury.py             jury printout (platypus): QR pages, links, how-to, team forms, backup grid; version and
                      a notice per replaced token
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
                      disputed.js, photos.js, results.js (the public copy), trigger.js; globals.d.ts for tsc only. logic.js is an ES module (package.json);
                      the bundler and the Node fake drop its `export`s, since Apps Script has none
logos/                shared logo library (team logos git-ignored; nologo.png public); drafts/<slug>/<team_id>.svg
tournaments/example/  reference to copy, never run: config.py, teams.py (the user's real teams)
tournaments/osenniy-salat/  the Phase 7 test game
tests/                pytest (tests/test_*.py) and node:test (tests/js/*.test.mjs). node_backend.py and
                      js/fake_apps_script.mjs run the real backend in Node on fake Google services;
                      test_scanner_e2e.py is headless Chrome; vectors/ holds the shared JSON test vectors
scripts/live_check.py  the live check after a backend deploy (throwaway tournaments on the real backend)
docs/google-account.md  deploying the backend under any Gmail account; switching; updating
docs/manual-checks.md   what the tests can't cover: iPhone, printing, the Sheet's edit trigger
docs/accepted-gaps.md   review findings closed as won't fix, with the reason
docs/lessons.md         code-level lessons: what went wrong and why the code is the way it is
docs/new-machine.md     what a clone doesn't have, and how to set it up
docs/logo-drawing.md    how Claude draws logo drafts (`chgk logos --draw`)
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
.github/workflows/    tests.yml (ruff + mypy + pytest; ESLint + tsc + Prettier + npm test), pages.yml (deploys web/, also when apps_script/logic.js changes)
.node-version         the Node version (CI reads it)
package.json          `npm test`, `npm run lint|format|format:check` (devDependencies: ESLint + Prettier only)
eslint.config.js, .prettierrc.json, pyproject.toml ([tool.ruff], [tool.mypy]), tsconfig*.json  lint, format and type settings (JS: tsc on the JSDoc, not strict)
README.md             organiser guide (end to end) and contributor commands
```

### How to run
- Tests: `uv run pytest` (incl. browser tests that need Google Chrome + Node) and
  `npm test` (then the backend and calculation tests again with the Sheets API off).
- Lint, format and types: `uv run mypy`, `npm run typecheck`, `uv run ruff format . && uv run ruff check .`, `npm run format && npm run lint`.
- Every `chgk` command: [SPEC.md §13](SPEC.md) or `uv run chgk --help`; the organiser's walkthrough:
  [README.md](README.md).

## Working conventions (agreed with the user)

- **Never deploy during a game** ([docs/accepted-gaps.md](docs/accepted-gaps.md)).
- **Python + uv**: run everything as `uv run …`. Package at the repo root (`chgk/`), no `src/`.
- **Node:** `.node-version` is the one place for the version (26; CI reads it, `engines` in package.json
  warns on another). From Homebrew, not uv (user): `nodejs-wheel` runs Node through a Python launcher, which
  leaves the tests' backend running when they stop it. When Homebrew moves to 27, update the pin and `engines` together.
- Tournament config is **Python syntax** (`tournaments/<slug>/config.py`), not YAML.
- **Unit tests are mandatory.** A phase isn't done until `uv run pytest` and
  `npm test` pass.
- **Git:** commit directly on `main`, no feature branches.
- **No Claude attribution:** commits are authored only as the user. No
  `Co-Authored-By: Claude` or "Generated with Claude Code" lines.
- **Keep this file current:** update it in the same commit as the work it describes. A new
  code-level lesson goes to [docs/lessons.md](docs/lessons.md).
- **Commit in its own step:** run the checks, read each result, then commit and push; never chain them (`set -e`
  doesn't stop a chain in this shell). After a push, read every workflow on the commit: `tests` and `pages`.
- **Tokens never go through the chat:** the user runs `chgk backend add … --token …` in a separate
  terminal, not with Claude Code's `!` prefix, which puts the command into the conversation.
- **Redeploying:** whenever a commit changes `apps_script/`, run `chgk backend bundle` and
  `pbcopy < out/apps_script/Code.gs` *before* asking the user to redeploy, and give the version
  and the steps (paste, save, Deploy → Manage deployments → edit → New version). A stale
  `Code.gs` was pasted once and the backend stayed old (`chgk backend check` now says so).
  After "deployed": `uv run python scripts/live_check.py` (it runs `chgk backend check` first), this file's version line.
- After a change to how cards or the jury sheet are drawn, regenerate the current tournament's
  output in the mode already used; don't ask (user feedback).
- **Questions:** ask the user through the question interface (AskUserQuestion), a
  few questions at a time, with recommended defaults.
- **Printed labels are in Russian.** Card labels may say «Тур», but never «Вопрос»
  (a test enforces this).
- **Lint and format before committing** (user request, Google style where it applies,
  120 columns; CI checks both):
  - Python: `uv run ruff format . && uv run ruff check .` (pyproject: pycodestyle,
    pyflakes, isort, naming, bugbear, pyupgrade, simplify, comprehensions, ruff's own rules,
    Google-convention docstrings; missing docstrings are not errors).
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
- **No upgrade code for older Sheets** (user, 2026-10-30): a tournament made by an older version is created
  again. The one exception: `chgk results-copy` gives a tournament without a public copy one.
- **Sheet tabs**, mark cells (blank / `R` / `1` `0` `?`, last write wins), «Спорные» — SPEC §5.
- **QR and card identity** — SPEC §6: QR 0.85 in (user), moved 20% in from the top and right edges (user); the tournament
  ID from config.py (`tid=`, e.g. the rating number) or generated (5 characters); it and team IDs
  are 1-8 `[0-9A-Z]`; the QR is version 4-M except for the longest mix (both 8 characters, a
  3-digit question), where `chgk cards` warns.
- **Scanner**, sync, card photos (kept forever), access via the jury link, no Google sign-in (user) — SPEC §7.
- **Cards** — SPEC §8: default grid 3×4 (user), allowed 2–4 columns × 2–6 rows, edge to edge in every mode (the
  user rejected gutters in scissors mode), the CLI asks the cut mode, no date unless
  `CardFields(date=True)` (user), `CardFields(no_qr=True)` for a paper-only
  game (default False; the QR corner stays empty), at least 2 spares and free slots
  as extra spares, reserve decks R1, R2… (§8.7), the jury printout (§8.6).
- **Logos** — SPEC §9: private library `logos/`, fallback chain, 14% shade (user), a team's `logo_grey` in teams.py overrides it; SVG and Claude-drawn
  drafts §9.1, [docs/logo-drawing.md](docs/logo-drawing.md) (always Claude Opus 5.5 at max effort, a 100k task budget, a render-and-review loop;
  the key only from `ANTHROPIC_API_KEY`). Drafts are never deleted or overwritten (user). The
  user's test drafts (22 teams each) in `logos/drafts/logo-drafts/` (session) and
  `logos/drafts/logo-drafts-api/` (API) are never deleted, overwritten or accepted without
  asking; their tournament folders were deleted, so `chgk logos` can't preview them. The
  example and Осенний салат have no team name on cards and logo_size 1.85 in (user); elsewhere
  the defaults stay.
- **A leaked jury or board link** — `chgk replace-token`, a new jury-v<N>.pdf saying what
  happened; phones keep their waiting marks and photos (SPEC §7.4).
- **Board** — SPEC §10.1. **Juror view:** no official answer (§7.5). **Jurors:** one at a
  time; the data model is ready for several (§7.3).
- **Deferred:** one list, [PLAN.md](PLAN.md) Phase 9 (next version).

## Next steps

0. **Code review:** closed, no round open. Every finding ended as fixed, or won't fix with its reason in [docs/accepted-gaps.md](docs/accepted-gaps.md); the last was the final pass on `aeb627b` (2026-11-01), with no further round on its fixes (the user's choice). A round, if another is wanted: `/code-review high --max-findings all` on the range, at most 5 at a time (whole range, `apps_script`, `web/s`, `web/b`, `chgk scripts`); triage all, fix the obvious, reject what is decided, ask about the large or unclear.
1. **Phase 7**, the rest: reprint `out/osenniy-salat/`, the fixes' own checks on an iPhone
   ([docs/manual-checks.md](docs/manual-checks.md)), the mock game, fixes, a docs/comments check.
   Then **Phase 8**, an external test at a tournament, with the same loop.
2. **Phase 9 — next version:** the deferred list in PLAN.md.

## GitHub

- Repo: <https://github.com/AntonMenshov/qa-chgk> (public).
- Pages: <https://antonmenshov.github.io/qa-chgk/>, deployed by `.github/workflows/pages.yml`
  on pushes touching `web/` or `apps_script/logic.js` (web/shared/logic.js links to it). The
  scanner URL printed in QR codes is `https://antonmenshov.github.io/qa-chgk/s/`.
- Push after each commit: `git push`.
- Actions in the workflows run on Node 24 (`setup-uv` has no major tag since v8: it is pinned to an exact version).
- The repo is public: never commit a Google account, deployment URL or token. The Gmail
  account behind the backend must stay switchable (named local profiles, SPEC §3.1).

## Live checks

After every deploy: `uv run python scripts/live_check.py`. It runs against the user's backend, on throwaway tournaments it makes and deletes, and covers `backend check`, sorting, the clock cap, photos, the public copy and its timer, the private Sheet, reserve decks, refusals and `chgk delete`. Edits typed in the Sheet need a person ([docs/manual-checks.md](docs/manual-checks.md)). Earlier runs: git log of this file.

Latest:
- **2026-11-01, 7b6015416359 (throwaways, deleted):** `scripts/live_check.py` all passed; the timer in 94 s.
