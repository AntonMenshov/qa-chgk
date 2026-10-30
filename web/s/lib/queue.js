// Every mark goes into this queue first, saved on the phone, and is sent from here in
// batches: one request carries everything pending (a request costs ~1–4 s). A failed
// send is retried with growing pauses. Events are idempotent (scan_id), so a retry after
// a lost reply never counts twice.

const BACKOFF_MS = [2000, 4000, 8000, 15000, 30000];

export class Queue {
  /**
   * @param {object} o
   * @param {{get(key): any, set(key, value): void}} o.storage  JSON storage (localStorage wrapper)
   * @param {string} o.key                 storage key, one per tournament
   * @param {(events) => Promise<{results: Array}>} o.send  record_events call
   * @param {() => number} [o.now]
   * @param {number} [o.batchSize]
   */
  constructor({storage, key, send, now = Date.now, batchSize = 200}) {
    Object.assign(this, {storage, key, send, now, batchSize});
    const saved = storage.get(key) || {};
    this.pending = saved.pending || [];
    this.rejected = saved.rejected || [];
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.lastError = null;
    this.inFlight = false;
  }

  save() {
    this.storage.set(this.key, {pending: this.pending, rejected: this.rejected});
  }

  add(event) {
    this.pending.push(event);
    this.save();
  }

  /** Whether flush() would send now. */
  due() {
    return !this.inFlight && this.pending.length > 0 && this.now() >= this.nextAttemptAt;
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
    let reply;
    try {
      reply = await this.send(batch);
    } catch (err) {
      this.failures += 1;
      this.lastError = String(err && err.message ? err.message : err);
      this.nextAttemptAt = this.now() + BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length) - 1];
      return null;
    } finally {
      this.inFlight = false;
    }
    this.failures = 0;
    this.lastError = null;
    this.nextAttemptAt = 0;
    const byId = new Map((reply.results || []).map((r) => [r.scan_id, r]));
    const acked = [];
    const rejected = [];
    const sent = new Set();
    for (const event of batch) {
      const r = byId.get(event.scan_id);
      if (!r) {
        continue;
      } // no answer for it: stays pending
      sent.add(event.scan_id);
      if (r.error) {
        this.rejected.push({event, error: r.error});
        rejected.push(event.scan_id);
      } else {
        acked.push(event.scan_id);
      }
    }
    this.pending = this.pending.filter((e) => !sent.has(e.scan_id));
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
      lastError: this.lastError,
    };
  }
}
