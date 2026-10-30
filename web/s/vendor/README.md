# Vendored libraries

Kept in the repo (not loaded from a CDN) so the scanner works when a CDN is slow or
blocked at the venue, and so the service worker can cache it for offline reloads.

- `zxing-wasm-3.1.4/`: QR reader, from the npm package `zxing-wasm@3.1.4`
  (`dist/iife/reader/index.js` → `zxing-reader.iife.js`, `dist/reader/zxing_reader.wasm`).
  MIT licence (`LICENSE`), by Ze-Zheng Wu; it compiles zxing-cpp (Apache-2.0) to WebAssembly.
  Chosen in spike 2 (docs/spikes.md).
