// Card photos on the phone (web/s/lib/photos.js): kept first, uploaded two at a time in
// the background, retried with growing pauses, dropped only when the server says the
// photo itself is wrong; independent of the marks queue.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PhotoQueue, blobToBase64, firstPhoto} from '../../web/s/lib/photos.js';
import {memoryStore, photoStore} from '../../web/s/lib/photostore.js';
import {BackendError} from '../../web/s/lib/api.js';

const rec = (n, over = {}) => ({
  photo_id: `photo-${n}-0000`,
  tid: 'K7M2Q',
  team_id: 'A01',
  question: n,
  client_ts: 1000 + n,
  blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, n])], {type: 'image/jpeg'}),
  ...over,
});

/** A send() the test answers by hand: calls[i].ok() / .fail(err). */
function manualSend() {
  const calls = [];
  const send = (r) =>
    new Promise((resolve, reject) => {
      calls.push({rec: r, ok: () => resolve({ok: true}), fail: (err) => reject(err)});
    });
  return {calls, send};
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('uploads two at a time, oldest first; the rest wait for a free slot', async () => {
  const store = memoryStore();
  for (const n of [3, 1, 2]) {
    await store.put(rec(n)); // three photos waiting (e.g. taken while offline)
  }
  const {calls, send} = manualSend();
  const q = new PhotoQueue({store, send});
  q.pump();
  await settle();
  assert.deepEqual(
    calls.map((c) => c.rec.question),
    [1, 2],
  );
  assert.deepEqual([q.status.pending, q.status.uploading], [3, 2]);
  q.pump(); // no free slot: nothing more starts
  await settle();
  assert.equal(calls.length, 2);
  calls[0].ok();
  await settle();
  q.pump();
  await settle();
  assert.deepEqual(
    calls.map((c) => c.rec.question),
    [1, 2, 3],
  );
  calls[1].ok();
  calls[2].ok();
  await settle();
  assert.deepEqual([q.status.pending, q.status.uploading, q.status.sent], [0, 0, 3]);
});

test('a failed upload is retried after a growing pause; success resets nothing else', async () => {
  let t = 0;
  const {calls, send} = manualSend();
  const q = new PhotoQueue({store: memoryStore(), send, now: () => t});
  q.add(rec(1));
  await settle();
  calls[0].fail(new BackendError('нет связи с сервером'));
  await settle();
  assert.equal(q.status.lastError, 'нет связи с сервером');
  q.pump();
  await settle();
  assert.equal(calls.length, 1); // not before the pause (2 s)
  t = 2000;
  q.pump();
  await settle();
  assert.equal(calls.length, 2);
  calls[1].fail(new Error('Quota exceeded'));
  await settle();
  t = 5999;
  q.pump();
  await settle();
  assert.equal(calls.length, 2); // second pause: 4 s
  t = 6000;
  q.pump();
  await settle();
  calls[2].ok();
  await settle();
  assert.deepEqual([q.status.pending, q.status.sent, q.status.lastError], [0, 1, null]);
});

test('a photo the server refuses as wrong (retry: false) is dropped, not retried', async () => {
  const {calls, send} = manualSend();
  const store = memoryStore();
  const q = new PhotoQueue({store, send});
  q.add(rec(1));
  await settle();
  calls[0].fail(new BackendError('image must be a base64 JPEG', false));
  await settle();
  assert.deepEqual([q.status.pending, q.status.dropped], [0, 1]);
  assert.equal(q.dropped[0].error, 'image must be a base64 JPEG');
  assert.equal(q.dropped[0].rec.blob, undefined); // the image itself is not kept
  assert.deepEqual(await store.all(), []);
  q.pump();
  await settle();
  assert.equal(calls.length, 1);
});

test('photos are kept on the phone until sent: a reload picks them up again', async () => {
  const store = memoryStore();
  const first = new PhotoQueue({store, send: () => new Promise(() => {})}); // never answers (app closed)
  first.add(rec(1)); // not awaited: add() waits for the upload, which never ends here
  first.add(rec(2));
  await settle();
  assert.equal((await store.all()).length, 2);
  const {calls, send} = manualSend();
  const second = new PhotoQueue({store, send});
  second.pump(); // not awaited: it ends when the uploads are answered below
  await settle();
  assert.deepEqual(
    calls.map((c) => c.rec.question),
    [1, 2],
  );
  calls[0].ok();
  calls[1].ok();
  await settle();
  assert.deepEqual(await store.all(), []);
});

test('«Отправить сейчас» retries waiting photos at once', async () => {
  const {calls, send} = manualSend();
  const q = new PhotoQueue({store: memoryStore(), send, now: () => 0}); // the pause would last forever
  q.add(rec(1));
  await settle();
  calls[0].fail(new Error('offline'));
  await settle();
  q.retryNow();
  await settle();
  assert.equal(calls.length, 2);
});

test('blobToBase64 gives what upload_photo expects (a JPEG starts with /9j/)', async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({length: 70000}, (_, i) => i % 256)]);
  const text = await blobToBase64(new Blob([bytes]));
  assert.ok(text.startsWith('/9j/'));
  assert.deepEqual(new Uint8Array(Buffer.from(text, 'base64')), bytes); // large input, in chunks
});

test('api: a server refusal carries retry: false; a network error and a server error retry', async () => {
  const {backend} = await import('../../web/s/lib/api.js');
  const reply = (body) => async () => ({json: async () => body, status: 200});
  const refused = await backend(
    'u',
    't',
    reply({ok: false, error: 'invalid team_id', retry: false}),
  )('x').catch((e) => e);
  assert.deepEqual([refused.message, refused.retry], ['invalid team_id', false]);
  const server = await backend('u', 't', reply({ok: false, error: 'server error: Drive'}))('x').catch((e) => e);
  assert.equal(server.retry, true); // no `retry` in the reply: retry
  const down = await backend('u', 't', async () => {
    throw new Error('offline');
  })('x').catch((e) => e);
  assert.equal(down.retry, true);
});

test('a card counts as photographed only once a photo exists (no camera yet: a later scan takes it)', async () => {
  let keys = [];
  const photographed = {get: () => keys, set: (k) => (keys = k)};
  const jpeg = {size: 1};
  assert.equal(await firstPhoto(Promise.resolve(null), 'A01:3', photographed), null); // opened by link, no camera
  assert.deepEqual(keys, []);
  assert.equal(await firstPhoto(null, 'A01:3', photographed), null);
  assert.equal(await firstPhoto(Promise.resolve(jpeg), 'A01:3', photographed), jpeg); // scanned with the camera
  assert.deepEqual(keys, ['A01:3']);
  assert.equal(await firstPhoto(Promise.resolve({size: 2}), 'A01:3', photographed), null); // scanned again
  assert.equal(await firstPhoto(Promise.resolve(jpeg), 'A01:4', photographed), jpeg);
});

test('an IndexedDB transaction that aborts (e.g. the quota at commit) falls back to memory, never hangs', async () => {
  // A fake IndexedDB whose every transaction aborts, firing only `abort` (no `error`, no `complete`).
  const db = {
    transaction: () => {
      const tx = {
        objectStore: () => ({put: () => ({}), getAll: () => ({}), delete: () => ({})}),
      };
      setTimeout(() => tx.onabort && tx.onabort());
      return tx;
    },
  };
  const indexedDB = {
    open: () => {
      const req = {result: db};
      setTimeout(() => req.onsuccess());
      return req;
    },
  };
  const store = photoStore('T1', indexedDB);
  const rec = {photo_id: 'p1', tid: 'T1'};
  await store.put(rec); // would hang without onabort
  assert.deepEqual(await store.all(), [rec]); // kept in memory instead
});
