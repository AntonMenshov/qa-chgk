# Phase 0 spikes

Throwaway experiments that settled open technical questions before the real build.
Their code (`spikes/`) and pages were removed on 2026-10-30; it is in the git history
up to commit f68651c. Only the findings below matter.

## Spike 1: POST from a static page to Apps Script

**Question:** can the scanner page send marks and a ~200 KB photo to an Apps Script
web app, and read the reply, despite CORS?

How it was run (the files are in the git history):

1. Go to script.google.com → New project → paste `spikes/apps_script_post/Code.gs`.
2. Deploy → New deployment → type **Web app**; Execute as **Me**; Who has access
   **Anyone**. Authorize, then copy the `/exec` URL.
3. Serve the page locally: `uv run python -m http.server 8000 -d spikes`, open
   <http://localhost:8000/apps_script_post/> on the laptop, and paste the URL.
4. Run GET, small POST, ~200 KB photo (with and without "save to Drive"), and the
   burst of 10.

Localhost behaves like GitHub Pages for CORS, so a laptop run answers the question.

Run 2026-10-29 from the laptop (Python httpx, sending `Origin: https://example.github.io`)
against the user's deployment. The deployment URL is kept out of the repo.

| Check | Result |
|---|---|
| GET works | ✅ 200; 302 redirect to googleusercontent, final response has `Access-Control-Allow-Origin: *` |
| POST small JSON works, reply readable | ✅ ~1.0 s round trip; Cyrillic echoed correctly; server time ~1 ms |
| POST photo (94 KB JPEG, 129 K base64 chars) | ✅ 1.3 s round trip; server time 0.1 s |
| Photo saved to Drive | ✅ 3.0 s round trip; **Drive save itself ~1.9 s** |
| Burst of 10 small POSTs | ✅ 0.6–1.05 s each, median ~0.95 s |

**Conclusions**
- The Apps Script backend works as designed. `text/plain` POST needs no preflight,
  and the CORS header is present on the final response. Still to confirm in real iPhone
  Safari during spike 2 (the page is ready).
- ~1 s per request means marks must go **from the background queue, several events
  per request**, never blocking the juror.
- Photos cost ~3 s each with the Drive save, so ~75 s for 25 cards if sequential.
  Upload them in the background with **2–3 in parallel**, separate from marks
  (already in the spec).
- The test left one file, `spike.jpg`, in the root of the user's Drive (since deleted by the user).
- **Confirmed from iPhone Safari** (user, 2026-10-29) via the GitHub Pages copy of the
  page, opened from a QR code that carried the URL in `#url=`.

## Spike 2: QR scanning on iPhone Safari

**Question:** which QR library scans printed cards fastest and most reliably, and
what resolution do the card photos come out at?

Needs HTTPS, so the page was served from GitHub Pages (`…/spikes/qr_scan/`). It was
opened on the iPhone with `out/print_test.pdf` printed, then for each library:
- scan the five QR sizes;
- scan the three sample cards quickly one after another.

User report 2026-10-29: **scanning works well at every size on the test page
(0.55–0.8 in)**. No per-library timings were reported.

| Library | Result |
|---|---|
| zxing-wasm 3.1.4 | good at all sizes |
| qr-scanner 1.4.2 | good at all sizes |
| BarcodeDetector | not checked (probably unavailable on iOS) |

**Decision:** zxing-wasm. It reads well, is actively maintained (releases through
Oct 2026), and its reader is ~1 MB of WASM that can be vendored. qr-scanner's last
release was 2022.

**Lesson:** pasting a long URL on a phone is painful. Anything a phone needs (backend
URL, tokens) must arrive **by scanning a QR code**, as the jury access QR already does.
The spike 1 page then took `#url=<exec URL>` for this reason.

## Spike 3: printed test page

Superseded by `uv run chgk test-page <tournament folder>` (Phase 1), which uses the
tournament's real settings, QR codes and logo.

The spike's script printed `out/print_test.pdf`, to be printed at **100% / Actual size**.

| Check | Printer | Result |
|---|---|---|
| Grey you'd pick for the logo watermark | (user, 2026-10-29) | **3%** (later 12%, chosen from real cards: SPEC §8.2) |
| QR size | (user, 2026-10-29) | **0.65 in** (between the 0.6 and 0.7 samples) |
| Rulers measure exactly 2 in | | not reported |
| Sample cards: enough room to write? | | not reported |

## Findings so far (automated)

- PT Sans (bundled) renders Cyrillic, but it has **no `″` (U+2033) or `→` (U+2192)**
  glyphs. Card text must stick to covered characters, and Phase 1 adds a test that
  every character drawn exists in the font.
- All QR sizes 0.5–1.0 in on the test page decode correctly from a 150 dpi render
  (zxing-cpp). That's an upper bound; the real limit comes from the iPhone in spike 2.
