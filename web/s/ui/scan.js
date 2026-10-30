// Scanning: what a code means, the card sheet with the verdicts, the spare card's question, photos.

import {$, beep, sheet, toast} from './dom.js';
import {adoptSetup} from './setup.js';
import {app, K, store} from './state.js';
import {flushSoon, refresh, render} from './sync.js';
import {startTournament} from './tournament.js';
import {showLookup} from './whose.js';

export function handleCode(text) {
  if (app.lookingUp) {
    return showLookup(text);
  }
  if (!app.session || app.openCardResult || app.spareResult) {
    return;
  }
  const r = app.session.scan(text);
  switch (r.kind) {
    case 'setup':
      if (r.setup.tid === app.setup.tid) {
        return toast('Это QR доступа жюри: телефон уже настроен на этот турнир');
      }
      if (adoptSetup(r.setup)) {
        startTournament();
      }
      return;
    case 'other':
      beep('bad');
      return toast('Это не карточка ЧГК', true);
    case 'foreign':
      beep('bad');
      return toast(`Карточка другого турнира (${r.tid}) — не засчитана`, true);
    case 'unknown_team':
      beep('bad');
      toast(`Команда ${r.teamId} не найдена — обновляю список команд…`, true);
      refresh();
      return;
    case 'spare':
    case 'card':
      // The frame the card was read from: its photo, kept once the question is known.
      r.shot = app.camera ? app.camera.captureJpeg() : Promise.resolve(null);
      return r.kind === 'spare' ? openSpare(r) : openCard(r);
  }
}

/** One photo per card per phone (a card scanned again is not photographed again). */
export function keepPhoto(r, shot) {
  const key = `${r.team.team_id}:${r.question}`;
  const done = new Set(store.get(K.photographed(app.setup.tid)) || []);
  if (!shot || done.has(key)) {
    return;
  }
  done.add(key);
  store.set(K.photographed(app.setup.tid), [...done]);
  const photoQueue = app.photos;
  shot.then((blob) => {
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

export function openCard(r) {
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
  beep(r.warnings.length ? 'warn' : 'ok');
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

export function openSpare(r) {
  app.spareResult = r;
  app.spareDigits = '';
  $('sp-team').textContent = r.team.name;
  $('sp-current').textContent = `Вопрос ${app.session.current} — текущий`;
  $('sp-display').textContent = '';
  beep('warn');
  sheet('spare');
}

export function answerSpare(question) {
  const r = app.spareResult;
  if (!(question >= 1 && question <= app.session.total)) {
    $('sp-display').textContent = `1–${app.session.total}?`;
    app.spareDigits = '';
    return;
  }
  app.spareResult = null;
  openCard(Object.assign(app.session.card(r.team.team_id, question, r.spare), {shot: r.shot}));
}
