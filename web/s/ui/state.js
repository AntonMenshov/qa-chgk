// The jury token is stored for the whole origin (<user>.github.io), so any other page published
// there could read it. Accepted (user decision, code review 2026-10-31): the owner publishes those
// pages too, and a leaked link can be replaced (`chgk replace-token`).
//
// The scanner's shared state: the tournament this phone works on, its queues and camera,
// what is on screen. The ui/ modules read and change it through `app`.

import {storage} from '../lib/storage.js';

const CACHED_STATE = 'chgk.state.';

export const store = storage(undefined, (key) => key.startsWith(CACHED_STATE));

export const K = {
  setup: 'chgk.setup',
  device: 'chgk.device',
  juror: 'chgk.juror',
  state: (tid) => `${CACHED_STATE}${tid}`,
  current: (tid) => `chgk.current.${tid}`,
  queue: (tid) => `chgk.queue.${tid}`,
  photographed: (tid) => `chgk.photographed.${tid}`,
  notice: 'chgk.notice', // said once after the reload that takes on a new QR
};

export const app = {
  setup: store.get(K.setup), // {tid, juryToken, backendUrl}
  call: null, // backend(...) for the current tournament
  session: null,
  queue: null,
  photos: null, // card photos waiting to upload
  camera: null,
  openCardResult: null, // the card on screen, waiting for a verdict
  spareResult: null, // the spare card on screen, waiting for its question
  spareDigits: '',
  refreshTimer: null,
  setupCamera: null,
  switching: false, // a jury link is being tried: another scan of it waits
  refused: null, // the backend refused this phone's token: what to do about it
  secondTab: false, // the scanner is open in another tab of this phone
  rendered: null, // what the main screen shows now (render() skips an unchanged one)
  refreshing: null, // the get_state under way: one at a time, so an older reply can't replace a newer one
};

/** «Отключить турнир»: what is kept for it can be fetched again; unsent or refused marks stay. */
export function forgetLocalData(tid) {
  if (!tid) {
    return;
  }
  // The juror's name too: the phone may pass to someone else, whose marks must not carry it.
  [K.state(tid), K.current(tid), K.photographed(tid), K.juror].forEach((key) => store.remove(key));
  const queue = store.get(K.queue(tid));
  if (!queue?.pending?.length && !queue?.rejected?.length) {
    store.remove(K.queue(tid));
  }
}

export function deviceId() {
  let id = store.get(K.device);
  if (!id) {
    id = crypto.randomUUID();
    store.set(K.device, id);
  }
  return id;
}
