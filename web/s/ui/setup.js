// Setup: from the jury link (#setup=…) or by scanning its QR here.

import {backend} from '../lib/api.js';
import {Camera} from '../lib/camera.js';
import {identify} from '../lib/lookup.js';
import {decodeCard, decodeSetup, sameAccess} from '../lib/payload.js';
import {photoStore} from '../lib/photostore.js';
import {$, offerReload, show, startSetupCamera, toast} from './dom.js';
import {app, K, store} from './state.js';
import {startTournament} from './tournament.js';

/** Marks and photos of the tournament this phone is on that haven't reached the server. */
async function unsent(tid) {
  const marks = (store.get(K.queue(tid))?.pending ?? []).length;
  const photos = (await photoStore(tid).all()).length;
  return marks + photos;
}

/**
 * Take on a jury link (SPEC §7.4). A link is tried before it is saved, so an old printed QR
 * never replaces a working key. Switching tournament is rare and the unsent marks and photos
 * stay behind, so it asks first. False: this phone stays as it was.
 */
export async function adoptSetup(s) {
  const old = app.setup;
  if (old && !sameAccess(old, s)) {
    const waiting = old.tid === s.tid ? 0 : await unsent(old.tid);
    if (
      waiting > 0 &&
      !confirm(
        `На телефоне есть неотправленные отметки или фото турнира ${old.tid} (${waiting}). ` +
          `Они сохранятся и отправятся, когда вы вернётесь к нему. Переключиться на турнир ${s.tid}?`,
      )
    ) {
      return false;
    }
    if (
      old.tid === s.tid &&
      old.backendUrl !== s.backendUrl &&
      !confirm('Этот QR ведёт на другой сервер. Перейти на него?')
    ) {
      return false;
    }
    try {
      await backend(s.backendUrl, s.juryToken)('get_state', {tid: s.tid});
    } catch (err) {
      toast(
        err.refused ? 'Этот QR уже не действует: телефон остался со своим ключом' : `QR не принят: ${err.message}`,
        true,
      );
      return false;
    }
  }
  if (!store.set(K.setup, s)) {
    toast('Телефон не смог сохранить новый QR: память заполнена', true);
    return false;
  }
  app.setup = s;
  return true;
}

/**
 * A jury link scanned or opened while the app runs. A phone already on a tournament reloads:
 * nothing of the old tournament (timers, replies under way, an open card) can reach the new one.
 */
export async function useSetup(s) {
  if (app.switching) {
    return;
  }
  app.switching = true;
  const running = Boolean(app.setup); // also still loading: a second load must not race the first
  let taken;
  try {
    taken = await adoptSetup(s);
  } finally {
    app.switching = false;
  }
  if (!taken) {
    if (app.setupCamera && !app.setupCamera.wanted) {
      $('setup-start').hidden = false; // the screen stays, and whoever brought this QR stopped its camera
    }
    return;
  }
  if (running) {
    store.set(K.notice, 'Новый QR принят');
    location.reload();
  } else {
    startTournament();
  }
}

function setupCameraTrouble(message, needsReload = false) {
  $('setup-start').hidden = false;
  if (needsReload) {
    if (!offerReload(message)) {
      $('setup-msg').textContent = `${message}: без перезагрузки сканер не заработает. Кнопка предложит её снова.`;
    }
    return;
  }
  $('setup-msg').textContent = `${message}: нажмите кнопку ещё раз.`;
}

export function startSetupScreen(message = '') {
  show('setup');
  $('setup-msg').textContent = message;
  const video = $('setup-video');
  const cam = (app.setupCamera = new Camera(
    video,
    (text) => {
      const s = decodeSetup(text);
      if (!s) {
        const card = decodeCard(text) && identify(text);
        $('setup-msg').textContent = card
          ? `Это карточка: ${[card.title, ...card.details].join(' · ')}. Чтобы отмечать, нужен QR «Доступ жюри» с листа жюри.`
          : 'Это не QR-код доступа жюри.';
        return;
      }
      cam.stop();
      useSetup(s);
    },
    setupCameraTrouble,
  ));
  $('setup-start').onclick = startSetupCamera;
}

/** A jury link (#setup=…) or a card (opened from the iPhone Camera) in the address. */
export function readHash() {
  const hash = location.hash;
  // The token must not stay in the address bar.
  if (hash) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  return {setup: decodeSetup(hash), card: decodeCard(hash) ? hash : null};
}
