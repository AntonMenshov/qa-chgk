// Loading the tournament: its data (or the last saved copy offline), the queues, the camera.

import {backend} from '../lib/api.js';
import {Camera} from '../lib/camera.js';
import {blobToBase64, PhotoQueue} from '../lib/photos.js';
import {photoStore} from '../lib/photostore.js';
import {Queue} from '../lib/queue.js';
import {Session} from '../lib/session.js';
import {$, show, toast} from './dom.js';
import {handleCode} from './scan.js';
import {app, deviceId, K, store} from './state.js';
import {render} from './sync.js';

export async function startTournament(cardText = null) {
  show('loading');
  $('loading-title').textContent = 'Загрузка турнира…';
  $('loading-msg').textContent = '';
  $('loading-retry').hidden = true;
  $('loading-reset').hidden = true;
  app.call = backend(app.setup.backendUrl, app.setup.juryToken);
  const tid = app.setup.tid;
  let state;
  try {
    state = await app.call('get_state', {tid});
    store.set(K.state(tid), state);
  } catch (err) {
    state = store.get(K.state(tid)); // offline: last known data
    if (!state) {
      $('loading-title').textContent = 'Не удалось загрузить турнир';
      $('loading-msg').textContent = err.message;
      $('loading-retry').hidden = false;
      $('loading-reset').hidden = false;
      $('loading-retry').onclick = () => startTournament(cardText);
      return;
    }
    toast('Нет связи: показаны последние сохранённые данные', true);
  }
  app.queue = new Queue({
    storage: store,
    key: K.queue(tid),
    send: (events) => app.call('record_events', {tid, events}),
  });
  app.session = new Session({
    tid,
    state,
    current: store.get(K.current(tid)),
    juror: store.get(K.juror) || '',
    device: deviceId(),
  });
  app.session.restorePending(app.queue.pending);
  app.photos = new PhotoQueue({
    store: photoStore(tid),
    send: async (rec) => {
      const {blob, ...meta} = rec;
      return app.call('upload_photo', {...meta, image: await blobToBase64(blob)});
    },
  });
  show('main');
  render();
  app.camera ??= new Camera($('video'), handleCode);
  $('start').hidden = app.camera.running; // a new jury QR scanned here: the camera keeps running
  // Opened from the iPhone Camera with a card URL.
  if (cardText) {
    handleCode(cardText);
  }
}
