// Card photos wait here (kept on the phone, see photostore.js) and upload in the
// background, two at a time, independently of the marks: a slow photo never delays a
// result. A failed upload is retried with growing pauses; one the server refuses as wrong
// (retry: false) is dropped, since sending it again can't help.
// Accepted (docs/accepted-gaps.md): that deletes the phone's only copy, even when the
// refusal was temporary («unknown team» while `chgk teams` rewrites Teams), and the card counts as
// photographed, so it isn't retaken. Only the photo is lost, never the mark; the panel shows a count.

import {backoffMs, errorText} from './queue.js'; // the same pauses as the marks

export class PhotoQueue {
  /**
   * @param {object} o
   * @param {{all(): Promise<any[]>, put(rec): Promise<void>, delete(id): Promise<void>}} o.store
   * @param {(rec) => Promise<object>} o.send  upload_photo call; throws on failure (err.retry === false: don't retry)
   * @param {() => number} [o.now]
   * @param {number} [o.parallel]  uploads at the same time
   */
  constructor({store, send, now = Date.now, parallel = 2}) {
    this.store = store;
    this.send = send;
    this.now = now;
    this.parallel = parallel;
    this.items = new Map(); // photo_id → {rec, failures, nextAt}
    this.inFlight = new Set();
    this.sent = 0;
    this.dropped = [];
    this.lastError = null;
    this.ready = store.all().then((recs) => {
      for (const rec of recs) {
        this.items.set(rec.photo_id, {rec, failures: 0, nextAt: 0});
      }
    });
  }

  /** Keep a photo (on the phone first, then in the queue) and start uploading. */
  async add(rec) {
    await this.ready;
    await this.store.put(rec);
    this.items.set(rec.photo_id, {rec, failures: 0, nextAt: 0});
    return this.pump();
  }

  /** Start the uploads that are due, oldest first, up to `parallel` at once; resolves when they end. */
  async pump() {
    await this.ready;
    const room = this.parallel - this.inFlight.size;
    if (room <= 0) {
      return [];
    }
    const due = [...this.items.values()]
      .filter((it) => !this.inFlight.has(it.rec.photo_id) && this.now() >= it.nextAt)
      .sort((a, b) => a.rec.client_ts - b.rec.client_ts);
    return Promise.all(due.slice(0, room).map((it) => this.upload(it)));
  }

  async upload(it) {
    const id = it.rec.photo_id;
    this.inFlight.add(id);
    try {
      await this.send(it.rec);
      await this.forget(id);
      this.sent += 1;
      this.lastError = null;
    } catch (err) {
      const message = errorText(err);
      if (err && err.retry === false) {
        await this.forget(id);
        const {blob, ...meta} = it.rec; // eslint-disable-line no-unused-vars
        this.dropped.push({rec: meta, error: message});
      } else {
        it.failures += 1;
        it.nextAt = this.now() + backoffMs(it.failures);
        this.lastError = message;
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  async forget(id) {
    this.items.delete(id);
    await this.store.delete(id);
  }

  /** Delete every waiting photo from the phone (the juror chose to, on disconnecting). */
  async clear() {
    await this.ready;
    await Promise.all([...this.items.keys()].map((id) => this.forget(id)));
  }

  /** Retry everything now (the juror pressed «Отправить сейчас»). */
  retryNow() {
    for (const it of this.items.values()) {
      it.nextAt = 0;
    }
    return this.pump();
  }

  get status() {
    return {
      pending: this.items.size,
      uploading: this.inFlight.size,
      sent: this.sent,
      dropped: this.dropped.length,
      lastError: this.lastError,
    };
  }
}

/**
 * The photo of a card if it is this phone's first of that card, else null. `shot` resolves to
 * a JPEG, or null when no camera was running (a card opened by link): the card counts as
 * photographed only once a JPEG exists, so a later scan still takes its photo.
 * `photographed` keeps the keys ("TEAM:Q") of the cards already photographed: {get, set}.
 */
export async function firstPhoto(shot, key, photographed) {
  const blob = shot ? await shot : null;
  const done = photographed.get() || [];
  if (!blob || done.includes(key)) {
    return null;
  }
  photographed.set([...done, key]); // before the photo is stored: see photostore.js
  return blob;
}

/** A Blob as base64 (what upload_photo takes). */
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
