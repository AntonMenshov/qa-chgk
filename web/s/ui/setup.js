// Setup: from the jury link (#setup=…) or by scanning its QR here.

import {Camera} from '../lib/camera.js';
import {identify} from '../lib/lookup.js';
import {decodeCard, decodeSetup} from '../lib/payload.js';
import {$, show, unlockAudio} from './dom.js';
import {app, K, store} from './state.js';
import {startTournament} from './tournament.js';

export function adoptSetup(s) {
  const changing = app.setup && app.setup.tid !== s.tid;
  if (changing && app.queue && app.queue.status.pending > 0) {
    if (
      !confirm(
        `На телефоне есть неотправленные отметки турнира ${app.setup.tid} (${app.queue.status.pending}). ` +
          `Они сохранятся и отправятся, когда вы вернётесь к нему. Переключиться на турнир ${s.tid}?`,
      )
    ) {
      return false;
    }
  }
  app.setup = s;
  store.set(K.setup, s);
  return true;
}

export function startSetupScreen(message = '') {
  show('setup');
  $('setup-msg').textContent = message;
  const video = $('setup-video');
  const cam = (app.setupCamera = new Camera(video, (text) => {
    const s = decodeSetup(text);
    if (!s) {
      const card = decodeCard(text) && identify(text);
      $('setup-msg').textContent = card
        ? `Это карточка: ${[card.title, ...card.details].join(' · ')}. Чтобы отмечать, нужен QR «Доступ жюри» с листа жюри.`
        : 'Это не QR-код доступа жюри.';
      return;
    }
    cam.stop();
    adoptSetup(s);
    startTournament();
  }));
  $('setup-start').onclick = async () => {
    unlockAudio();
    try {
      await cam.start();
      $('setup-start').hidden = true;
    } catch (err) {
      $('setup-msg').textContent = `Камера недоступна: ${err.message}. Разрешите доступ к камере в настройках Safari.`;
    }
  };
}

/** A jury link (#app.setup=…) or a card (opened from the iPhone Camera) in the address. */
export function readHash() {
  const hash = location.hash;
  if (hash) {
    history.replaceState(null, '', location.pathname + location.search);
  } // the token must not stay in the address bar
  return {setup: decodeSetup(hash), card: decodeCard(hash) ? hash : null};
}
