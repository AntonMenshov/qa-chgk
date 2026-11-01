// QR codes drawn on the projector board, with the vendored generator
// (vendor/qrcode-generator-1.4.4, a classic script that defines `qrcode`).

const MAX_CODES = 8; // the board shows two, and its links rarely change
const codes = new Map(); // by text: the board redraws often

function parseSvg(svg) {
  const template = document.createElement('template');
  template.innerHTML = svg;
  return template.content.firstElementChild;
}

/** SVG markup of a QR code for `text`, as UTF-8: error correction M, a 4-module white quiet zone. */
export function qrSvg(text, qrcode = globalThis.qrcode) {
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  return qr.createSvgTag({cellSize: 1, margin: 4, scalable: true});
}

/** A new node of the QR code for `text`: each is generated and parsed once, then only copied. */
export function qrNode(text, qrcode = globalThis.qrcode, parse = parseSvg) {
  if (!codes.has(text)) {
    if (codes.size >= MAX_CODES) {
      codes.clear();
    }
    codes.set(text, parse(qrSvg(text, qrcode)));
  }
  return codes.get(text).cloneNode(true);
}
