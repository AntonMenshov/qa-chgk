// Every mark goes into this queue first, saved on the phone, and is sent from here in
// batches: one request carries up to 200 pending events (a request costs ~1–2 s). A failed
// send is retried with growing pauses. Events are idempotent (scan_id), so a retry after
// a lost reply never counts twice.

const BACKOFF_MS = [2000, 4000, 8000, 15000, 30000];

/** The pause after this many failures in a row; the marks and the photos use the same. */
export const backoffMs = (failures) => BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1];

export const errorText = (err) => String(err?.message || err);

export class Queue {
  /**
   * @param {object} o
   * @param {{get(key): any, set(key, value): boolean|void}} o.storage  JSON storage (localStorage wrapper)
   * @param {string} o.key                 storage key, one per tournament
   * @param {(events) => Promise<{results: Array}>} o.send  record_events call
   * @param {() => number} [o.now]
   * @param {number} [o.batchSize]
   */
  constructor({storage, key, send, now = Date.now, batchSize = 200}) {
    this.storage = storage;
    this.key = key;
    this.send = send;
    this.now = now;
    this.batchSize = batchSize;
    const saved = storage.get(key) || {};
    this.pending = saved.pending || [];
    this.rejected = saved.rejected || [];
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.lastError = null;
    this.unsaved = false; // the phone couldn't save the queue: marks are in memory only
    this.stuck = false; // the server refuses the batch itself: a person has to look
    this.lastRefused = false; // the token was refused: a new QR helps
    this.inFlight = false;
  }

  save() {
    this.unsaved = this.storage.set(this.key, {pending: this.pending, rejected: this.rejected}) === false;
  }

  add(event) {
    this.pending.push(event);
    this.save();
  }

  /** Whether flush() would send now. */
  due() {
    return !this.inFlight && this.pending.length > 0 && this.now() >= this.nextAttemptAt;
  }

  /** Send at the next chance, whatever pause a failure left. */
  retryNow() {
    this.nextAttemptAt = 0;
  }

  /**
   * Send one batch if due. Returns {acked, rejected} (scan_ids) or null if nothing was
   * sent. Never throws: a failure is kept in lastError and retried later.
   */
  async flush() {
    if (!this.due()) {
      return null;
    }
    const batch = this.pending.slice(0, this.batchSize);
    this.inFlight = true;
    const byId = new Map();
    try {
      const reply = await this.send(batch);
      for (const r of reply?.results ?? []) {
        byId.set(r.scan_id, r);
      }
      if (!batch.some((e) => byId.has(e.scan_id))) {
        throw new Error('сервер не ответил ни по одной отметке');
      }
    } catch (err) {
      this.failures += 1;
      this.stuck = err?.retry === false;
      this.lastRefused = err?.refused === true;
      this.lastError = errorText(err);
      this.nextAttemptAt = this.now() + backoffMs(this.failures);
      return null;
    } finally {
      this.inFlight = false;
    }
    this.failures = 0;
    this.lastError = null;
    this.stuck = false;
    this.lastRefused = false;
    this.nextAttemptAt = 0;
    const acked = [];
    const rejected = [];
    for (const event of batch) {
      const r = byId.get(event.scan_id);
      if (!r) {
        continue; // no answer for it: stays pending
      }
      if (r.error) {
        this.rejected.push({event, error: r.error});
        rejected.push(event.scan_id);
      } else {
        acked.push(event.scan_id);
      }
    }
    const answered = new Set([...acked, ...rejected]);
    this.pending = this.pending.filter((e) => !answered.has(e.scan_id));
    this.save();
    return {acked, rejected};
  }

  /** Forget refused events once the juror has seen them. */
  clearRejected() {
    this.rejected = [];
    this.save();
  }

  get status() {
    return {
      pending: this.pending.length,
      rejected: this.rejected.length,
      failing: this.failures > 0,
      stuck: this.stuck,
      unsaved: this.unsaved,
      lastError: this.lastError,
    };
  }
}
