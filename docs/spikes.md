# Phase 0 spikes

Throwaway experiments that settle open technical questions before the real build.
Code lives in `spikes/` and has no unit tests; only the findings below matter.

## Spike 1: POST from a static page to Apps Script

**Question:** can the scanner page send marks and a ~200 KB photo to an Apps Script
web app, and read the reply, despite CORS?

1. Go to script.google.com → New project → paste `spikes/apps_script_post/Code.gs`.
2. Deploy → New deployment → type **Web app**; Execute as **Me**; Who has access
   **Anyone**. Authorize, then copy the `/exec` URL.
3. Serve the page locally: `uv run python -m http.server 8000 -d spikes`, open
   <http://localhost:8000/apps_script_post/> on the laptop, and paste the URL.
4. Run GET, small POST, ~200 KB photo (with and without "save to Drive"), and the
   burst of 10.

Localhost behaves like GitHub Pages for CORS, so a laptop run answers the question.

| Check | Result |
|---|---|
| GET works | |
| POST small JSON works, reply readable | |
| POST ~200 KB photo works; time | |
| Photo saved to Drive | |
| Burst of 10: typical round trip (ms) | |

## Spike 2: QR scanning on iPhone Safari

**Question:** which QR library scans printed cards fastest and most reliably, and
what resolution do the card photos come out at?

Needs HTTPS, so the page must be served from GitHub Pages (see HANDOVER.md, "Things
that need the user"). Open `…/spikes/qr_scan/` on the iPhone, print
`out/print_test.pdf`, then for each library:
- scan the five QR sizes;
- scan the three sample cards quickly one after another.

| Library | Avg / max decode (ms) | Smallest size read reliably | Notes |
|---|---|---|---|
| zxing-wasm 3.1.4 | | | |
| qr-scanner 1.4.2 | | | |
| BarcodeDetector | | | probably unavailable on iOS |

Camera resolution: ____; photo size per card: ____ KB.

## Spike 3: printed test page

`uv run python spikes/print_test/make_sheet.py` → `out/print_test.pdf`. Print at
**100% / Actual size** on each printer you expect to use.

| Check | Printer | Result |
|---|---|---|
| Rulers measure exactly 2 in | | |
| Palest grey still visible | | |
| Grey you'd pick for the logo watermark | | |
| Sample cards: enough room to write? | | |

## Findings so far (automated)

- PT Sans (bundled) renders Cyrillic, but it has **no `″` (U+2033) or `→` (U+2192)**
  glyphs. Card text must stick to covered characters, and Phase 1 adds a test that
  every character drawn exists in the font.
- All QR sizes 0.5–1.0 in on the test page decode correctly from a 150 dpi render
  (zxing-cpp). That's an upper bound; the real limit comes from the iPhone in spike 2.
