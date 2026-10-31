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
  if (app.queue.lastRefused) {
    app.refused = app.queue.lastError;
  }
  if (res) {
    app.refused = null;
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

/** Fetch the tournament's state; true if it arrived. Only one at a time. */
export function refresh() {
  if (!app.call || !app.session) {
    return Promise.resolve(false);
  }
  app.refreshing ??= fetchState().finally(() => {
    app.refreshing = null;
  });
  return app.refreshing;
}

async function fetchState() {
  const started = Date.now();
  try {
    const state = await app.call('get_state', {tid: app.setup.tid});
    store.set(K.state(app.setup.tid), state);
    app.session.setSnapshot(state, started);
    app.refused = null;
    render();
    return true;
  } catch (err) {
    if (err.refused) {
      app.refused = err.message;
      render();
    }
    return false; // offline: keep showing what we have; the sync pill says so
  }
}

/** Send everything now (the juror's button, or the connection came back). */
export function retryAll() {
  app.queue.retryNow();
  return Promise.all([flush(), app.photos.retryNow()]);
}

export function render() {
  if (!app.session) {
    return;
  }
  const list = app.session.missing();
  const view = JSON.stringify([
    app.session.name,
    app.session.current,
    list.map((t) => [t.team_id, t.name]),
    app.queue.status,
    app.queue.rejected.length,
    app.photos?.status,
    app.refused,
    app.secondTab,
  ]);
  if (view === app.rendered) {
    return; // the timers call this every second or so: nothing changed, nothing to touch
  }
  app.rendered = view;
  $('t-name').textContent = app.session.name;
  $('q-num').textContent = app.session.current;
  $('q-round').textContent = `тур ${app.session.roundOf(app.session.current)}`;
  const m = $('missing-open');
  m.textContent = list.length ? `Нет карточек: ${list.length} ›` : 'Все карточки этого вопроса получены';
  m.classList.toggle('none', list.length === 0);
  const st = app.queue.status;
  const pill = $('sync');
  const bad = app.refused || st.failing || st.rejected;
  pill.className = 'pill ' + (bad ? 'error' : st.pending ? 'pending' : 'ok');
  const parts = [
    st.rejected ? `отклонено: ${st.rejected}` : '',
    app.refused ? 'ключ заменён' : st.stuck ? 'не принято сервером' : st.failing ? 'нет связи' : '',
    st.pending ? `${bad ? '' : '⏳ '}${st.pending}` : '',
  ].filter(Boolean);
  pill.textContent = parts.length ? `${bad ? '⚠ ' : ''}${parts.join(' · ')}` : '✓ отправлено';
  const ph = app.photos ? app.photos.status : {pending: 0};
  if (ph.pending) {
    pill.textContent += ` · фото ${ph.pending}`;
  }
  const banner = $('banner');
  banner.textContent =
    app.refused ?? (app.secondTab ? 'Сканер открыт в другой вкладке: оставьте одну, чтобы отметки не потерялись.' : '');
  banner.hidden = !banner.textContent;
  // A list on screen follows the marks.
  if (!$('missing').hidden) {
    renderMissing();
  }
  if (!$('syncinfo').hidden) {
    renderSync();
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
  $('s-error').textContent = st.stuck
    ? `Сервер не принимает отметки: ${st.lastError}. Они сохранены на телефоне: позовите организатора.`
    : st.lastError
      ? `Последняя ошибка: ${st.lastError}. Повтор — автоматически.`
      : '';
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
