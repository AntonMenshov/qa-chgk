// Scanner web app: wires the page's buttons to the screens in ui/ and starts it.
// The logic lives in lib/ (tested in Node); ui/ shows it on the page.

import {sameAccess} from './lib/payload.js';
import {$, sheet, show, startCamera, toast} from './ui/dom.js';
import {answerSpare, handleCode, verdict} from './ui/scan.js';
import {adoptSetup, readHash, startSetupScreen, useSetup} from './ui/setup.js';
import {app, forgetLocalData, K, store} from './ui/state.js';
import {flush, refresh, render, renderMissing, renderSync, retryAll} from './ui/sync.js';
import {resumeCamera, startTournament} from './ui/tournament.js';
import {closeLookup, openLookup} from './ui/whose.js';

const FLUSH_EVERY_MS = 1000;

const REFRESH_EVERY_MS = 20000;

function wire() {
  $('start').onclick = () =>
    startCamera(app.camera, $('start'), (err) => toast(`Камера недоступна: ${err.message}`, true));
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
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.keypad button'))) {
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
  $('lk-close').onclick = closeLookup;
  $('m-close').onclick = () => sheet(null);
  $('sync').onclick = () => {
    renderSync();
    sheet('syncinfo');
  };
  $('s-now').onclick = () => {
    retryAll().then(render);
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
      toast(app.refused ?? 'Нет связи — данные не обновлены', true);
    }
  };
  $('settings-close').onclick = () => sheet(null);
  const forgetTournament = () => {
    forgetLocalData(app.setup?.tid);
    store.remove(K.setup);
    location.replace(location.pathname);
  };
  $('forget').onclick = async () => {
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
    const photos = app.photos.status.pending;
    if (photos && confirm(`Удалить с телефона фото, ждущие отправки (${photos})? Их нельзя будет отправить.`)) {
      await app.photos.clear();
    }
    forgetTournament();
  };
  $('loading-reset').onclick = () => {
    if (confirm('Отключить этот турнир? Чтобы вернуться, понадобится QR доступа жюри.')) {
      forgetTournament();
    }
  };
  setInterval(flush, FLUSH_EVERY_MS);
  setInterval(() => {
    app.photos?.pump();
    render();
  }, FLUSH_EVERY_MS);
  setInterval(refresh, REFRESH_EVERY_MS);
  addEventListener('online', () => {
    if (app.queue) {
      retryAll().then(render);
    }
  });
  addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      resumeCamera();
    }
  });
  addEventListener('pageshow', resumeCamera);
}

/** A second tab keeps its own copy of the unsent marks, and saving overwrites the other's: say so. */
function watchForSecondTab() {
  if (!('BroadcastChannel' in globalThis)) {
    return;
  }
  const tabs = new BroadcastChannel('chgk-scanner');
  tabs.onmessage = (e) => {
    if (e.data === 'hello') {
      tabs.postMessage('here');
    }
    app.secondTab = e.data !== 'bye';
    render();
  };
  tabs.postMessage('hello');
  addEventListener('pagehide', () => tabs.postMessage('bye'));
}

async function boot() {
  wire();
  watchForSecondTab();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Safari may reuse the open tab for a link to this page: only the #… part changes. Jurors use the
  // in-app scanner, so a card link stays best effort (user decision, code review 2026-10-31): with a
  // sheet open, before setup or while loading it is dropped with no message: scan it again.
  addEventListener('hashchange', () => {
    const next = readHash();
    if (next.setup) {
      if (app.session && sameAccess(next.setup, app.setup)) {
        return;
      }
      app.setupCamera?.stop();
      useSetup(next.setup);
    } else if (next.card && app.session) {
      handleCode(next.card);
    }
  });
  const from = readHash();
  if (from.setup) {
    show('loading');
    await adoptSetup(from.setup);
  }
  if (!app.setup) {
    return startSetupScreen(from.card ? 'Сначала настройте телефон: отсканируйте QR «Доступ жюри».' : '');
  }
  startTournament(from.card);
}

boot();
