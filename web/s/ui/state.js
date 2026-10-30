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
};

export function deviceId() {
  let id = store.get(K.device);
  if (!id) {
    id = crypto.randomUUID();
    store.set(K.device, id);
  }
  return id;
}
