// QR codes drawn on the projector board, with the vendored generator
// (vendor/qrcode-generator-1.4.4, a classic script that defines `qrcode`).

const codes = new WeakMap(); // by generator, then text: the board redraws often, and its links don't change

/** SVG markup of a QR code for `text`: error correction M, a 4-module white quiet zone. */
export function qrSvg(text, qrcode = globalThis.qrcode) {
  if (!codes.has(qrcode)) {
    codes.set(qrcode, new Map());
  }
  const cached = codes.get(qrcode).get(text);
  if (cached) {
    return cached;
  }
  const qr = qrcode(0, 'M');
  // As UTF-8 bytes: the generator keeps only the low byte of each character.
  qr.addData(String.fromCharCode(...new TextEncoder().encode(text)), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const size = n + 8;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        const start = c;
        while (c + 1 < n && qr.isDark(r, c + 1)) {
          c += 1; // a run of dark modules is one shape: about half the markup
        }
        const run = c - start + 1;
        path += `M${start + 4} ${r + 4}h${run}v1h-${run}z`;
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  codes.get(qrcode).set(text, svg);
  return svg;
}
