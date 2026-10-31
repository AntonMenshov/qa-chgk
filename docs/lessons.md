# Lessons learned

Code-level lessons: what went wrong, and why the code is the way it is. Worth a look before changing
the part they name. Rules for how to work are in [HANDOVER.md](../HANDOVER.md) «Working conventions».

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
- **Organiser files are compiled from their text, never imported:** an import reused a stale
  `.pyc` of a config.py edited within the same second at the same size (seen in a test), and
  left `__pycache__` in tournament folders (`run_python_file`).
- **reportlab stores identical images once:** two teams with the same draft gave one image
  in the PDF; tests that count images need different drawings.
- **A phone widens the page to fit overflowing content:** `overflow: hidden` on html and body wasn't
  enough; the board's table stayed cut off because `innerWidth` grew before `fit()` ran. `body` is
  now `position: fixed` (found by a mobile-emulation screenshot; the desktop view hid it).
- **Temp paths differ by OS:** a test asserting "no `/tmp` in the output" passed on macOS
  (`/private/var/folders/…`) and failed on Linux CI, where pytest's tmp_path is under `/tmp`.
- **Tests of a rule must state the rule themselves.** The first access tests read the allowed
  token from the ACTIONS table, so weakening the table weakened the tests too; found by
  deliberately breaking the table. backend_access.test.mjs now pins the rule on its own.
- **Sheets API, seen live:** in one `spreadsheets.batchUpdate`, a formula written by
  `updateCells` is not calculated yet for a later `sortRange`; every key looked blank and
  «Итоги» fell into ID order (totals and places were right). The fake now behaves the
  same, which reproduces it. Check sorting against a reference on the real Sheet after
  any change to it (`get_results` returns what Google computed).
- **Phantom Micro QR:** a test failed about once in 100 runs. For some
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
- Never make a phone user type or paste URLs/tokens: deliver them by QR (seen on the iPhone).
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
