// Camera and QR decoding (zxing-wasm, vendored). Decodes frames continuously and calls
// onCode(text) once per card: the same code is reported again only after it has been
// out of view for a moment, so a card lying in front of the camera isn't scanned twice.

const WASM = 'vendor/zxing-wasm-3.1.4/zxing_reader.wasm';
const SAME_CODE_GAP_MS = 1500;

/**
 * Standard QR codes only (what cards and the jury sheet print). zxing's "QRCode" is the
 * whole QR family, and a real QR's corner plus the modules beside it can form a valid
 * Micro QR (seen with tournament SP7EM): with one symbol per frame the phone could read
 * that instead of the card. Tested with this decoder in tests/test_scanner_e2e.py.
 */
export const READER_OPTIONS = {formats: ['QRCodeModel2'], maxNumberOfSymbols: 1, tryHarder: false};

// Frames decoded per second: a full frame per screen refresh only heats the phone. While a card
// is on screen, decoding only tells whether the card is still in view.
const DECODE_EVERY_MS = 66;
const DECODE_PAUSED_EVERY_MS = 200;
// The same card counts as gone only after this many frames decoded without it (and SAME_CODE_GAP_MS):
// a stalled loop or a hidden page decodes nothing, so it says nothing. Accepted: glare or a shadow
// hiding a card for longer than that reports it again; its verdict sheet just reopens.
const MISSED_FRAMES = 5;
const FAILURES_TO_REPORT = 30; // frames in a row that the decoder failed on

export const DECODER_TROUBLE = 'Сканер не читает кадры';

let prepared = false;

export function prepareReader() {
  if (prepared) {
    return;
  }
  if (!globalThis.ZXingWASM) {
    return; // its script failed to load: frames then fail to decode, and DECODER_TROUBLE offers the reload
  }
  prepared = true;
  // Load the .wasm from our own folder instead of the CDN the library defaults to.
  Promise.resolve(
    globalThis.ZXingWASM.prepareZXingModule({
      overrides: {
        locateFile: (path, prefix) => (path.endsWith('.wasm') ? new URL(WASM, document.baseURI).href : prefix + path),
      },
      fireImmediately: true,
    }),
  ).catch(() => {
    prepared = false; // a failed download (not cached yet): the next start tries again
  });
}

export class Camera {
  /** @param {(message: string) => void} [onTrouble] the stream ended by itself, or the decoder keeps failing */
  constructor(video, onCode, onTrouble = () => {}) {
    this.video = video;
    this.onCode = onCode;
    this.onTrouble = onTrouble;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', {willReadFrequently: true});
    this.running = false;
    this.paused = false;
    this.last = {text: null, seenAt: 0};
    this.failures = 0;
    this.missed = 0; // frames decoded without any code since the last one with a code
    this.starting = null;
    this.wanted = false; // started, and not stopped on purpose: worth restarting after an interruption
  }

  /** A second call while one is under way waits for it, instead of opening a second stream. */
  start() {
    const before = this.wanted;
    this.wanted = true;
    this.failures = 0;
    this.starting ??= this.open()
      .catch((err) => {
        this.wanted = before; // never got going: a return to the app must not ask for the camera by itself
        throw err;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  async open() {
    prepareReader();
    if (!this.stream?.getTracks().some((t) => t.readyState === 'live')) {
      this.release();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: 'environment', width: {ideal: 1920}, height: {ideal: 1080}},
        audio: false,
      });
      if (!this.wanted) {
        stream.getTracks().forEach((t) => t.stop()); // stopped while waiting for the camera
        return;
      }
      this.stream = stream;
      for (const track of stream.getTracks()) {
        track.onended = () => this.onTrouble('Камера остановилась');
      }
      this.video.srcObject = stream;
    }
    try {
      await this.video.play();
    } catch (err) {
      this.release(); // or the camera stays on behind the «Камера недоступна» message
      throw err;
    }
    if (!this.running && this.wanted) {
      this.running = true;
      this.loop();
    }
  }

  stop() {
    this.wanted = false;
    this.running = false;
    this.release();
    this.last = {text: null, seenAt: 0};
    this.missed = 0;
  }

  release() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.onended = null;
        track.stop();
      }
      this.video.srcObject = null; // its last frame must not pass for a picture (captureJpeg)
    }
    this.stream = null;
  }

  /** «Чья карточка?» opens: the card in front of the camera counts too. */
  forgetLast() {
    this.beforeLookup = this.last;
    this.last = {text: null, seenAt: 0};
  }

  /** …and closes with nothing read: that card is still the last one, not a new scan. */
  restoreLast() {
    if (this.last.text === null && this.beforeLookup) {
      this.last = {text: this.beforeLookup.text, seenAt: performance.now()};
    }
    this.beforeLookup = null;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  /**
   * A code is in view at `now`. The card last reported is reported again only after it was
   * out of view for a moment; any other card at once (but not while paused).
   */
  seen(text, now) {
    const missed = this.missed;
    this.missed = 0;
    if (text === this.last.text) {
      const gap = now - this.last.seenAt;
      this.last.seenAt = now;
      if (gap > SAME_CODE_GAP_MS && missed >= MISSED_FRAMES && !this.paused) {
        this.onCode(text);
      }
    } else if (!this.paused) {
      this.last = {text, seenAt: now};
      this.onCode(text);
    }
  }

  /** The current frame as a JPEG (longest side ≤ maxSide, ~150-300 KB), or null without a picture. */
  captureJpeg({maxSide = 1600, quality = 0.8} = {}) {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) {
      return Promise.resolve(null);
    }
    const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality));
  }

  async decodeFrame() {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) {
      return null;
    }
    if (this.canvas.width !== v.videoWidth || this.canvas.height !== v.videoHeight) {
      this.canvas.width = v.videoWidth;
      this.canvas.height = v.videoHeight;
    }
    this.ctx.drawImage(v, 0, 0);
    const image = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const results = await globalThis.ZXingWASM.readBarcodes(image, READER_OPTIONS);
    const text = results.find((r) => r.isValid)?.text ?? null;
    if (!text) {
      this.missed += 1;
    }
    return text;
  }

  async loop() {
    while (this.running) {
      // Decode even while paused (a card is on screen): the card still lying in front of
      // the camera then counts as "still in view" and isn't reported again on resume.
      let text;
      try {
        text = await this.decodeFrame();
        this.failures = 0;
      } catch {
        text = null;
        this.failures += 1;
        if (this.failures === FAILURES_TO_REPORT) {
          this.onTrouble(DECODER_TROUBLE);
        }
      }
      if (text && this.running) {
        try {
          this.seen(text, performance.now());
        } catch (err) {
          console.error(err); // one card's failure must not end the scanning
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.paused ? DECODE_PAUSED_EVERY_MS : DECODE_EVERY_MS));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }
}
