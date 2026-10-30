// QR codes drawn on the projector board, with the vendored generator
// (vendor/qrcode-generator-1.4.4, a classic script that defines `qrcode`).

/** SVG markup of a QR code for `text`: error correction M, a 4-module white quiet zone. */
export function qrSvg(text, qrcode = globalThis.qrcode) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const size = n + 8;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        path += `M${c + 4} ${r + 4}h1v1h-1z`;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  );
}
