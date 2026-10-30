# ЧГК answer cards & jury scanning — Specification

Status: draft v1 (2026-10-29)

## 1. Goal

Automate result collection for in-person sport ЧГК:

1. Print answer cards (Letter paper, cut into cards). Each card carries a question
   number and a QR code identifying *tournament + team + question*.
2. After each question, the jury scans every returned card with an iPhone, marks it
   ✓ / ✗ / ?, and a photo of the card is saved.
3. Results land in a Google Sheet (one per tournament), with live standings,
   per-question stats and a projector view.

## 2. Domain parameters

| Parameter | Typical | Range |
|---|---|---|
| Rounds (N) | 3 | 1–8 |
| Questions per round (K) | 12 or 15 | any; may differ per round |
| Teams | 3–25 | design for ≤ 100 |
| Jurors scanning at once | 1 | data model ready for several (UI later) |

Question numbering is **continuous** across the game (1…ΣK). The round is shown
small on the card as «Тур 3».

## 3. Components

```
┌────────────────┐   HTTPS (text/plain JSON)   ┌──────────────────────────┐
│ Python CLI     │ ──────────────────────────▶ │ Google Apps Script       │
│ (uv, organizer)│ ◀────────────────────────── │ web app (deployed once)  │
└────────────────┘                             │  • per-tournament Sheet  │
        │ PDF                                  │  • Drive photo folder    │
        ▼                                      └──────────────────────────┘
   printed cards ──QR──▶ ┌──────────────────────┐        ▲
                         │ Scanner web app       │────────┘
                         │ (GitHub Pages, iPhone)│
                         └──────────────────────┘
                         ┌──────────────────────┐
                         │ Projector board page  │── read-only ──▶ Apps Script
                         └──────────────────────┘
```

No Google Cloud project is needed: a single Apps Script web app runs under the
organizer's personal Gmail and is the only component that touches Sheets/Drive.

## 4. Tournament configuration (Python, not YAML)

Each tournament is a folder `tournaments/<slug>/` with a `config.py` written by the
organizer:

```python
from datetime import date
from chgk.config import Tournament, CardFields, Layout, LogoMode

tournament = Tournament(
    slug="autumn-cup-2026",
    name="Осенний кубок",
    date=date(2026, 11, 15),
    rounds=3,
    questions_per_round=12,          # int, or a list per round: [12, 12, 15]
    scanner_url="https://<user>.github.io/qa-chgk/s/",   # printed inside every QR
    spares_per_team=3,               # unnumbered spare cards per team, whole game
    card=CardFields(
        team_name=True,
        tournament_name=True,
        date=True,
        logo=LogoMode.TEAM_ELSE_TOURNAMENT,   # NONE | TEAM | TOURNAMENT | TEAM_ELSE_TOURNAMENT
        tournament_logo="logos/tournament.png",
        logo_grey=0.03,
    ),
    layout=Layout(cols=3, rows=5, qr_size=0.65),   # 15 cards per Letter page
)
```

Values the system generates (tournament ID, spreadsheet ID, jury token) are stored
next to the config in `tournaments/<slug>/state.json`, which is never hand-edited
and is git-ignored because it contains secrets. Until the Sheet backend exists
(Phase 2), teams come from `tournaments/<slug>/teams.csv`
(`team_id,name,city,logo_file`); missing team IDs are assigned and written back.
`tournaments/example/` is a working example.

## 5. Google Sheet (one spreadsheet per tournament)

Created by `chgk new`. Tabs:

| Tab | Who writes | Content |
|---|---|---|
| **Settings** | CLI | name, date, rounds, questions per round, IDs |
| **Teams** | organizer (source of truth) | `team_id` (auto, e.g. `A07`, stable), `name`, `city`, `logo_file`, `logo_prompt` |
| **Log** | Apps Script, append-only | `scan_id` (UUID, idempotent), server time, client time, juror, device, team, question, status, photo link, source (`app` / `sheet`) |
| **Results** | Apps Script + jury edits | teams × questions matrix, per-round sums, total, place |
| **Stats** | formulas | per question: number of teams that took it, % |

### Cell values in Results

| Value | Meaning | Counts as |
|---|---|---|
| *(blank)* | no card received | 0 |
| `R` | card received (scanned), not judged yet | 0 |
| `1` | correct ✓ | 1 |
| `0` | incorrect ✗ | 0 |
| `?` | to be decided | 0 until resolved |

A missing card scores as incorrect, but the sheet always shows whether a card was
**received** (blank vs `R`/`0`/`1`/`?`).

### Rules
- **Last scan wins**, decided by the client timestamp of the action, so an offline
  scan synced late does not overwrite a newer decision. Every action stays in Log.
- The jury resolves `?` and appeals **by editing the Results cell in the sheet**. An
  `onEdit` trigger records those edits in Log (`source = sheet`) with a timestamp, so
  they take part in last-write-wins.
- Writes are serialized with `LockService`, which keeps several simultaneous jurors
  safe.

## 6. QR code and card identity

- QR content is a URL, so the iPhone's built-in Camera also opens the app:
  `https://<user>.github.io/<repo>/s/#<TID>.<TEAM>.<Q>`
  - `TID`: random 5-char tournament code; `TEAM`: `team_id`; `Q`: question number,
    or `S1…Sn` for spare cards.
  - Example: `…/s/#K7M2Q.A07.27`. This is short enough for a small, robust QR
    (error correction M, quiet zone 4 modules). Printed at **0.65″** including the
    quiet zone (user's choice from the test print; configurable).
- The QR contains no secret. Submitting a mark requires the jury token (§7.4).
- When a **spare card** is scanned, the app assumes the current question and asks for
  one-tap confirmation, or lets the juror pick another question.

## 7. Scanner web app (iPhone, GitHub Pages)

Static HTML/JS (ES modules, no build step), installable to the Home Screen. Camera
access needs HTTPS, which GitHub Pages provides.

### 7.1 Flow (the only mode in v1)
1. The juror sets the **current question** (big ◀ 27 ▶ control).
2. The camera scans continuously. When a card is detected:
   - a full-resolution **photo of the frame is captured** (every card);
   - the team name is shown in large type and a `received` event is recorded;
   - **warning** (colour + vibration) if the card's question ≠ current question,
     or if this team already has a mark for this question.
3. The juror taps **✓ / ✗ / ?**. The status event is recorded and the app returns to
   scanning.
4. **"Missing: n teams ▸"** lists teams with no card for the current question
   (local state merged with server state).

### 7.2 Sync
- Internet is usually fine, but every event goes to an on-device queue (IndexedDB)
  first and is posted from there with automatic retry. A status pill shows
  "synced / n pending".
- Photos upload separately from marks (JPEG ≈ 150 KB), so a slow photo never delays
  a result.
- Events are idempotent (`scan_id`), so retries never double-count.
- Measured (spike 1): one Apps Script request takes ~1 s, and a photo with the Drive
  save ~3 s. So marks are sent in batches (all pending events in one request), and
  photos upload 2–3 at a time.

### 7.3 Multi-juror readiness (UI later)
Every event carries juror name, device ID, client timestamp and UUID, and the
missing list is backed by the server. Adding several jurors later needs UI work
only, not data-model changes.

### 7.4 Access
- v1: **secret jury link**. `chgk jury-link` prints a URL and a QR,
  `…/s/#setup=<TID>:<JURY_TOKEN>`. Opening it once stores the token on the phone.
- Later option: Google sign-in with an allow-list of emails.
- Caveat: on iOS a Home-Screen app and Safari keep separate storage, so a card URL
  opened from the built-in Camera may ask for the jury link once.

### 7.5 The juror does **not** see the official answer
The app doesn't show it (decided).

## 8. Answer cards (PDF)

### 8.1 Page and card
- Letter (8.5″×11″), printed at 100%, so it's safe to send to a copy shop. The 0.25″
  margins cover printers that can't print to the edge.
- The grid is configurable; the default is **3 columns × 5 rows = 15 cards**, about
  2.67″ × 2.1″ each.
- Cards sit edge to edge, so neighbouring cards share one cut line and no paper is
  wasted. Thin grey cut lines; crop marks in the margin for the guillotine modes.

### 8.2 Card contents (Russian labels; no «Вопрос»)
```
┌───────────────────────────────┐
│ 27                ▄▄▄▄  Тур 3 │   big question number; QR top-right
│                   █▀▀█        │
│                   ▀▀▀▀        │
│   (pale logo watermark)       │   writing area
│                               │
│ Синие зайцы · Осенний кубок · 15.11.2026 │   optional footer
└───────────────────────────────┘
```
- Spare cards show «Запасной» instead of a number, and a «№ ____» line for the team to
  write the question number.
- Characters the font can't draw (e.g. emoji in a team name) print as `?`, with a
  warning.
- An embedded Unicode TTF font (OFL licence, e.g. PT Sans or Noto Sans) is used for
  Cyrillic.
- The logo never overlaps the QR quiet zone.
- Logo watermark default: **3% grey** (user's choice from the test print; configurable).

### 8.3 Imposition: all three modes are available, and the CLI **asks which one** before generating unless it's passed
| Mode | Description |
|---|---|
| `team-pages` | each page holds one team's cards in order; leftover slots become extra spares |
| `cut-stack` | for guillotine: stack all sheets, cut once; stacking the piles in slot order gives every team's cards already sorted |
| `scissors` | one team per page, same edge-to-edge grid (cards share cut lines, no wasted paper); darker dashed lines and no crop marks |

### 8.4 Distribution
Each team gets **one stack for the whole game** (numbered cards + spares).

### 8.5 Test page
`chgk test-page` prints a calibration page:
- the logo at several grey shades, so the organizer can pick one that stays pale on
  the actual printer;
- QR codes at several sizes;
- a 1″ ruler, to confirm the page printed at 100%.

## 9. Logos

A pale greyscale watermark. The source is chosen per team and per tournament:

| Source | How |
|---|---|
| none | no logo |
| provided file | PNG/JPG/SVG in `tournaments/<slug>/logos/` → greyscale → flatten → lightened to the chosen shade |
| Claude-drawn SVG | vector emblem or monogram from a text spec (drawn in a Claude Code session, or via the Claude API with the user's key) |
| image API | prompt → OpenAI / Google image model (user's API key) → same post-processing |

The Claude API does not output raster images, but it can write SVG.

## 10. Outputs

| Output | v1 | Later |
|---|---|---|
| Results tab (standings, round sums, place) | ✓ | |
| Stats tab (teams taking each question) | ✓ | |
| Projector board (web page, live standings, read-only token) | ✓ | |
| rating.chgk.info export | | after the core is done |
| Question-rating tiebreak | | not requested |

## 11. Testing (required for every phase)

Every component has unit tests, and a phase is not done until they pass. Logic is
written as pure functions, so the code that touches the camera, Sheets and Drive
stays a thin layer.

| Layer | Runner | What is unit-tested |
|---|---|---|
| Python (`chgk/`) | `uv run pytest` | config validation and question/round numbering; QR payload encode/decode; imposition (every card placed exactly once; simulated cut-and-stack yields sorted decks; page count); layout geometry (everything inside margins, QR ≥ min size, QR and logo don't overlap); logo processing (greyscale, darkest pixel ≤ chosen shade); Apps Script client with mocked HTTP (`respx`) |
| PDF output | `uv run pytest` | smoke tests: page count; Cyrillic text extractable (`pypdf`); **QR codes decoded back from the rendered PDF** (`pypdfium2` + `zxing-cpp`) and matching the expected payloads |
| Apps Script logic (`apps_script/`) | `node --test` | last-write-wins merge, status → cell mapping, request validation, token check, idempotency by `scan_id`. Pure functions live in a file that runs both in Apps Script and in Node |
| Web app logic (`web/`) | `node --test` | payload parsing, offline queue (retry, dedupe), missing-teams computation, question-mismatch / duplicate warnings, spare-card handling |
| Cross-language contract | both | shared test vectors in `tests/vectors/*.json` (QR payloads, events, merge cases), checked by both the Python and JS suites, so the encoder and the decoders can't drift apart |

Not unit-testable, so covered by a manual checklist per release (`docs/manual-checks.md`):
- iPhone camera scanning speed and reliability;
- print scale and grey shades on real printers;
- deployed Apps Script quotas and CORS.

CI: a GitHub Actions workflow runs `uv run pytest` and `node --test` on every push,
once a remote exists.

## 12. Tech stack

- **Python ≥ 3.12, uv**:
  - `typer` (CLI), `reportlab` (PDF), `segno` (QR), `Pillow` (logos), `httpx`;
  - dev: `pytest`, `respx`, `pypdf`, `pypdfium2`, `zxing-cpp`.
- **Apps Script** (`apps_script/`): deployed once as a web app ("execute as me",
  "anyone"). The code is pushed with `clasp` or pasted by hand.
- **Web** (`web/`): plain HTML/JS with a vendored QR decoding library (`qr-scanner`
  or `zxing-wasm`, picked in the spike), served by GitHub Pages.
- **Node** (dev only): its built-in `node --test` runner, no npm dependencies.

## 13. CLI (planned commands)

```
uv run chgk new tournaments/<slug>          # create Sheet + Drive folder via Apps Script, write state.json
uv run chgk teams tournaments/<slug>        # pull Teams tab, assign team_ids, validate logos
uv run chgk logos tournaments/<slug>        # process/generate logos → pale PNGs
uv run chgk cards tournaments/<slug> [--mode team-pages|cut-stack|scissors] [--teams A01,A07]
uv run chgk test-page tournaments/<slug>
uv run chgk jury-link tournaments/<slug>    # print setup URL + QR
uv run chgk board-link tournaments/<slug>   # projector URL
```

## 14. Open items (non-blocking; defaults in brackets)

1. How many spare cards per team [3]?
2. Projector board: freeze standings during the last round [no]?
3. Card photos: how long to keep them in Drive [forever]?
4. Fill empty slots on the last `team-pages` page with extra spares [yes]?
