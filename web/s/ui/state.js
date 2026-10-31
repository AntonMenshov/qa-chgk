// The scanner's shared state: the tournament this phone works on, its queues and camera,
// what is on screen. The ui/ modules read and change it through `app`.

import {storage} from '../lib/storage.js';

export const store = storage();

export const K = {
  setup: 'chgk.setup',
  device: 'chgk.device',
  juror: 'chgk.juror',
  state: (tid) => `chgk.state.${tid}`,
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
  lookingUp: false, // «Чья карточка?»: scans are only shown, never recorded
  refreshTimer: null,
  setupCamera: null,
  switching: false, // a jury link is being tried: another scan of it waits
  refused: null, // the backend refused this phone's token: what to do about it
  secondTab: false, // the scanner is open in another tab of this phone
  refreshing: null, // the get_state under way: one at a time, so an older reply can't replace a newer one
};

export function deviceId() {
  let id = store.get(K.device);
  if (!id) {
    id = crypto.randomUUID();
    store.set(K.device, id);
  }
  return id;
}
