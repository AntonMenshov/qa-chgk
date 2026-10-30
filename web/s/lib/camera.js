// Camera and QR decoding (zxing-wasm, vendored). Decodes frames continuously and calls
// onCode(text) once per card: the same code is reported again only after it has been
// out of view for a moment, so a card lying in front of the camera isn't scanned twice.

const WASM = "vendor/zxing-wasm-3.1.4/zxing_reader.wasm";
const SAME_CODE_GAP_MS = 1500;

let prepared = false;

function prepareReader() {
  if (prepared) return;
  // Load the .wasm from our own folder instead of the CDN the library defaults to.
  globalThis.ZXingWASM.prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) => (path.endsWith(".wasm") ? new URL(WASM, document.baseURI).href : prefix + path),
    },
    fireImmediately: true,
  });
  prepared = true;
}

export class Camera {
  constructor(video, onCode) {
    Object.assign(this, { video, onCode });
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.running = false;
    this.paused = false;
    this.last = { text: null, seenAt: 0 };
  }

  async start() {
    prepareReader();
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      this.video.srcObject = this.stream;
    }
    await this.video.play();
    if (!this.running) {
      this.running = true;
      this.loop();
    }
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
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
    if (text === this.last.text) {
      const gap = now - this.last.seenAt;
      this.last.seenAt = now;
      if (gap > SAME_CODE_GAP_MS && !this.paused) this.onCode(text);
    } else if (!this.paused) {
      this.last = { text, seenAt: now };
      this.onCode(text);
    }
  }

  async decodeFrame() {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) return null;
    this.canvas.width = v.videoWidth;
    this.canvas.height = v.videoHeight;
    this.ctx.drawImage(v, 0, 0);
    const image = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const results = await globalThis.ZXingWASM.readBarcodes(image, { formats: ["QRCode"], maxNumberOfSymbols: 1, tryHarder: false });
    return results.find((r) => r.isValid)?.text ?? null;
  }

  async loop() {
    while (this.running) {
      // Decode even while paused (a card is on screen): the card still lying in front of
      // the camera then counts as "still in view" and isn't reported again on resume.
      let text = null;
      try {
        text = await this.decodeFrame();
      } catch {
        text = null;
      }
      if (text) this.seen(text, performance.now());
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }
}
