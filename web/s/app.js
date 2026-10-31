// Scanner web app: wires the page's buttons to the screens in ui/ and starts it.
// The logic lives in lib/ (tested in Node); ui/ shows it on the page.

import {sameAccess} from './lib/payload.js';
import {$, sheet, toast, unlockAudio} from './ui/dom.js';
import {answerSpare, handleCode, verdict} from './ui/scan.js';
import {adoptSetup, readHash, startSetupScreen} from './ui/setup.js';
import {app, K, store} from './ui/state.js';
import {flush, refresh, render, renderMissing, renderSync} from './ui/sync.js';
import {startTournament} from './ui/tournament.js';
import {openLookup} from './ui/whose.js';

const FLUSH_EVERY_MS = 1000;

const REFRESH_EVERY_MS = 20000;

function wire() {
  $('start').onclick = async () => {
    unlockAudio();
    try {
      await app.camera.start();
      $('start').hidden = true;
    } catch (err) {
      toast(`Камера недоступна: ${err.message}`, true);
    }
  };
  const stepQuestion = (step) => {
    app.session.setQuestion(app.session.current + step);
    store.set(K.current(app.setup.tid), app.session.current);
    render();
  };
  $('q-prev').onclick = () => stepQuestion(-1);
  $('q-next').onclick = () => stepQuestion(1);
  $('v-correct').onclick = () => verdict('correct');
  $('v-incorrect').onclick = () => verdict('incorrect');
  $('v-disputed').onclick = () => verdict('disputed');
  $('v-later').onclick = () => verdict(null);
  $('sp-current').onclick = () => answerSpare(app.session.current);
  $('sp-cancel').onclick = () => {
    app.spareResult = null;
    sheet(null);
  };
  for (const b of document.querySelectorAll('.keypad button')) {
    b.onclick = () => {
      const k = b.dataset.k;
      if (k === 'ok') {
        return answerSpare(Number(app.spareDigits));
      }
      app.spareDigits =
        k === 'back' ? app.spareDigits.slice(0, -1) : (app.spareDigits + k).replace(/^0+/, '').slice(0, 3);
      $('sp-display').textContent = app.spareDigits;
    };
  }
  $('missing-open').onclick = () => {
    renderMissing();
    sheet('missing');
  };
  $('lookup-open').onclick = openLookup;
  $('lk-close').onclick = () => sheet(null); // a card still in view counts only after it leaves the frame and returns
  $('m-close').onclick = () => sheet(null);
  $('sync').onclick = () => {
    renderSync();
    sheet('syncinfo');
  };
  $('s-now').onclick = async () => {
    app.queue.nextAttemptAt = 0;
    await Promise.all([flush(), app.photos.retryNow()]);
    renderSync();
    render();
  };
  $('s-clear').onclick = () => {
    app.queue.clearRejected();
    renderSync();
    render();
  };
  $('s-close').onclick = () => sheet(null);
  $('settings-open').onclick = () => {
    $('juror').value = store.get(K.juror) || '';
    $('about').textContent =
      `Турнир ${app.setup.tid} · ${app.session.name}. Сервер: ${app.setup.backendUrl.replace(/^https:\/\//, '').slice(0, 48)}…`;
    sheet('settings');
  };
  $('juror').oninput = () => {
    store.set(K.juror, $('juror').value.trim());
    app.session.juror = $('juror').value.trim();
  };
  $('refresh').onclick = async () => {
    if (await refresh()) {
      toast('Данные обновлены');
    } else {
      toast('Нет связи — данные не обновлены', true);
    }
  };
  $('settings-close').onclick = () => sheet(null);
  const forgetTournament = () => {
    store.remove(K.setup);
    location.replace(location.pathname);
  };
  $('forget').onclick = () => {
    const pending = app.queue.status.pending + app.photos.status.pending;
    if (
      !confirm(
        pending
          ? `Есть неотправленные отметки или фото: ${pending}. Они останутся на телефоне. Отключить турнир?`
          : 'Отключить этот турнир на телефоне?',
      )
    ) {
      return;
    }
    forgetTournament();
  };
  $('loading-reset').onclick = forgetTournament;
  setInterval(flush, FLUSH_EVERY_MS);
  setInterval(() => app.photos && app.photos.pump().then(render), FLUSH_EVERY_MS);
  setInterval(refresh, REFRESH_EVERY_MS);
  addEventListener('online', () => {
    if (app.queue) {
      app.queue.nextAttemptAt = 0;
      flush();
    }
  });
}

function boot() {
  wire();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Safari may reuse the open tab for a link to this page: only the #… part changes.
  addEventListener('hashchange', () => {
    const next = readHash();
    if (next.setup) {
      if (app.session && sameAccess(next.setup, app.setup)) {
        return;
      }
      if (adoptSetup(next.setup)) {
        if (app.setupCamera) {
          app.setupCamera.stop();
        }
        startTournament();
      }
    } else if (next.card && app.session) {
      handleCode(next.card);
    }
  });
  const from = readHash();
  if (from.setup) {
    adoptSetup(from.setup);
  }
  if (!app.setup) {
    return startSetupScreen(from.card ? 'Сначала настройте телефон: отсканируйте QR «Доступ жюри».' : '');
  }
  startTournament(from.card);
}

boot();
