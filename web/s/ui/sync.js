// Sending and refreshing, and what the main screen and the sync panel show.

import {STATUS_LABEL} from '../lib/marks.js';
import {$, toast} from './dom.js';
import {app, K, store} from './state.js';

const REFRESH_AFTER_SEND_MS = 1500;

export async function flush() {
  if (!app.queue || !app.queue.due()) {
    return;
  }
  const res = await app.queue.flush();
  if (res) {
    app.session.acked(res.acked);
    app.session.rejected(res.rejected);
    if (res.rejected.length) {
      toast(`Отклонено сервером: ${res.rejected.length}. Нажмите на статус отправки.`, true);
    }
    clearTimeout(app.refreshTimer);
    app.refreshTimer = setTimeout(refresh, REFRESH_AFTER_SEND_MS);
  }
  render();
}

export function flushSoon() {
  setTimeout(flush, 50);
}

/** Fetch the tournament's state; true if it arrived. */
export async function refresh() {
  if (!app.call || !app.session) {
    return false;
  }
  const started = Date.now();
  try {
    const state = await app.call('get_state', {tid: app.setup.tid});
    store.set(K.state(app.setup.tid), state);
    app.session.setSnapshot(state, started);
    render();
    return true;
  } catch {
    // offline: keep showing what we have; the sync pill says so
    return false;
  }
}

export function render() {
  if (!app.session) {
    return;
  }
  $('t-name').textContent = app.session.name;
  $('q-num').textContent = app.session.current;
  $('q-round').textContent = `тур ${app.session.roundOf(app.session.current)}`;
  const missing = app.session.missing();
  const m = $('missing-open');
  m.textContent = missing.length ? `Нет карточек: ${missing.length} ›` : 'Все карточки этого вопроса получены';
  m.classList.toggle('none', missing.length === 0);
  const st = app.queue.status;
  const pill = $('sync');
  pill.className = 'pill ' + (st.failing || st.rejected ? 'error' : st.pending ? 'pending' : 'ok');
  pill.textContent = st.rejected
    ? `⚠ отклонено: ${st.rejected}`
    : st.failing
      ? `⚠ нет связи · ${st.pending}`
      : st.pending
        ? `⏳ ${st.pending}`
        : '✓ отправлено';
  const ph = app.photos ? app.photos.status : {pending: 0};
  if (ph.pending) {
    pill.textContent += ` · фото ${ph.pending}`;
  }
}

export function renderMissing() {
  const list = app.session.missing();
  $('m-title').textContent = `Вопрос ${app.session.current}: нет карточек — ${list.length}`;
  $('m-list').replaceChildren(
    ...list.map((t) => {
      const li = document.createElement('li');
      li.textContent = t.name;
      li.append(Object.assign(document.createElement('small'), {textContent: `ID ${t.team_id}`}));
      return li;
    }),
  );
}

export function renderSync() {
  const st = app.queue.status;
  $('s-summary').textContent = st.pending
    ? `Ждут отправки: ${st.pending}.`
    : st.rejected
      ? 'Отправлено всё, кроме отклонённых (ниже).'
      : 'Все отметки отправлены.';
  $('s-error').textContent = st.lastError ? `Последняя ошибка: ${st.lastError}. Повтор — автоматически.` : '';
  $('s-rejected').replaceChildren(
    ...app.queue.rejected.map(({event, error}) => {
      const li = document.createElement('li');
      const team = app.session.byId.get(event.team_id);
      li.textContent = `${team ? team.name : event.team_id} · вопрос ${event.question} · ${STATUS_LABEL[event.status] || event.status}`;
      li.append(Object.assign(document.createElement('small'), {textContent: `Отклонено: ${error}`}));
      return li;
    }),
  );
  $('s-clear').hidden = app.queue.rejected.length === 0;
  const ph = app.photos.status;
  $('s-photos').textContent =
    `Фото карточек: отправлено ${ph.sent}` +
    (ph.pending ? `, ждут отправки ${ph.pending}` : '') +
    (ph.dropped ? `, отклонено ${ph.dropped}` : '') +
    (ph.pending && ph.lastError ? `. Последняя ошибка: ${ph.lastError}` : '.');
}
