# Vendored libraries

Kept in the repo (not loaded from a CDN) so the scanner works when a CDN is slow or
blocked at the venue, and so the service worker can cache it for offline reloads.

- `zxing-wasm-3.1.4/`: QR reader, from the npm package `zxing-wasm@3.1.4`
  (`dist/iife/reader/index.js` → `zxing-reader.iife.js`, `dist/reader/zxing_reader.wasm`).
  MIT licence (`LICENSE`), by Ze-Zheng Wu; it compiles zxing-cpp (Apache-2.0) to WebAssembly.
  Chosen on an iPhone test over qr-scanner 1.4.2, which read as well at every size (0.55-0.8 in) but
  whose last release was in 2022; zxing-wasm is maintained, and its reader is ~1 MB of WASM to vendor.
