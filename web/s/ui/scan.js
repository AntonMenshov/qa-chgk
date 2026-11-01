// Scanning: what a code means, the card sheet with the verdicts, the spare card's question, photos.

import {$, hideToast, lookingUp, sheet, toast} from './dom.js';
import {sameAccess} from '../lib/payload.js';
import {noVerdictLabel} from '../lib/marks.js';
import {firstPhoto} from '../lib/photos.js';
import {useSetup} from './setup.js';
import {app, K, store} from './state.js';
import {flushSoon, refresh, render} from './sync.js';
import {showLookup} from './whose.js';

export function handleCode(text) {
  if (lookingUp()) {
    return showLookup(text);
  }
  if (!app.session || app.openCardResult || app.spareResult) {
    return;
  }
  const r = app.session.scan(text);
  switch (r.kind) {
    case 'setup':
      if (sameAccess(r.setup, app.setup)) {
        return toast('Это QR доступа жюри: телефон уже настроен на этот турнир');
      }
      useSetup(r.setup);
      return;
    case 'other':
      return toast('Это не карточка ЧГК', true);
    case 'foreign':
      return toast(`Карточка другого турнира (${r.tid}) — не засчитана`, true);
    case 'unknown_team':
      toast(`Команда ${r.teamId} не найдена — обновляю список команд…`, true);
      // The card isn't retried (user decision, code review 2026-10-31): scan it again after the refresh.
      refresh();
      return;
    case 'bad_question':
      return toast(`Карточка вопроса ${r.question}, а в турнире всего ${r.total} — не засчитана`, true);
    case 'spare':
    case 'card':
      // The frame the card was read from: its photo, kept once the question is known. For a card
      // opened by link with the camera running, that's whatever the camera sees, and the real scan
      // takes no photo (accepted, like the rest of card links: app.js).
      r.shot = app.camera && !alreadyPhotographed(r) ? app.camera.captureJpeg() : Promise.resolve(null);
      return r.kind === 'spare' ? openSpare(r) : openCard(r);
  }
}

const photoKey = (r) => `${r.team.team_id}:${r.question}${r.spare ? `:S${r.spare}` : ''}`;

const photographed = {
  get: () => store.get(K.photographed(app.setup.tid)),
  set: (keys) => store.set(K.photographed(app.setup.tid), keys),
};

/** Numbered cards only: a spare's question isn't known yet. Spares a JPEG on every scan of the same card. */
function alreadyPhotographed(r) {
  return r.kind === 'card' && (photographed.get() || []).includes(photoKey(r));
}

/** One photo per card per phone (a card scanned again is not photographed again). */
function keepPhoto(r, shot) {
  const photoQueue = app.photos;
  firstPhoto(shot, photoKey(r), photographed).then((blob) => {
    if (!blob) {
      return;
    }
    const rec = {
      photo_id: crypto.randomUUID(),
      tid: app.setup.tid,
      team_id: r.team.team_id,
      question: r.question,
      client_ts: Date.now(),
      juror: app.session.juror,
      device: app.session.device,
      blob,
    };
    if (r.spare !== null && r.spare !== undefined) {
      rec.spare = r.spare;
    }
    photoQueue.add(rec).then(render);
    render();
  });
}

function openCard(r) {
  app.openCardResult = r;
  app.queue.add(app.session.record(r.team.team_id, r.question, r.spare, 'received'));
  keepPhoto(r, r.shot);
  store.set(K.current(app.setup.tid), app.session.current);
  const round = app.session.roundOf(r.question);
  $('c-team').textContent = r.team.name;
  $('c-meta').textContent =
    `Вопрос ${r.question} · тур ${round}` + (r.spare ? ` · запасная карточка` : '') + ` · ID ${r.team.team_id}`;
  const warn = $('c-warn');
  warn.replaceChildren(...r.warnings.map((w) => Object.assign(document.createElement('li'), {textContent: w.text})));
  $('card').classList.toggle('warn', r.warnings.length > 0);
  $('v-later').textContent = noVerdictLabel(r.previous);
  hideToast(); // the last card's error would read as this card's, over its buttons
  sheet('card');
  render();
}

export function verdict(status) {
  const r = app.openCardResult;
  if (!r) {
    return;
  }
  if (status) {
    app.queue.add(app.session.record(r.team.team_id, r.question, r.spare, status));
  }
  app.openCardResult = null;
  sheet(null);
  render();
  flushSoon();
}

function openSpare(r) {
  app.spareResult = r;
  app.spareDigits = '';
  $('sp-team').textContent = r.team.name;
  $('sp-current').textContent = `Вопрос ${app.session.current} — текущий`;
  $('sp-display').textContent = '';
  sheet('spare');
}

export function answerSpare(question) {
  const r = app.spareResult;
  if (!r) {
    return;
  }
  if (!app.session.byId.has(r.team.team_id)) {
    app.spareResult = null; // its row was deleted from the Sheet while this sheet was open
    sheet(null);
    toast(`Команда ${r.team.team_id} не найдена — не засчитана`, true);
    return;
  }
  if (!(question >= 1 && question <= app.session.total)) {
    $('sp-display').textContent = `1–${app.session.total}?`;
    app.spareDigits = '';
    return;
  }
  app.spareResult = null;
  openCard(Object.assign(app.session.card(r.team.team_id, question, r.spare), {shot: r.shot}));
}
