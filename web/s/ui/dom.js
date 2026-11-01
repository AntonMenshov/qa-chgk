// The page: which screen or bottom sheet is shown, and toasts.

import {app} from './state.js';

/** @type {(id: string) => any} */
export const $ = (id) => document.getElementById(id);

function showOnly(selector, id) {
  for (const s of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(selector))) {
    s.hidden = s.id !== id;
  }
}

export function show(id) {
  showOnly('.screen', id);
}

/** «Чья карточка?» is open: scans are only shown, never recorded. */
export const lookingUp = () => !$('lookup').hidden;

export function sheet(id) {
  showOnly('.sheet', id);
  // Nothing behind a sheet can act: a card waits for its verdict, a list shows its question.
  $('main').inert = id !== null;
  if (id && id !== 'lookup') {
    app.camera?.pause();
  } else {
    app.camera?.resume();
  }
}

let toastTimer = null;

export function toast(text, bad = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

export function hideToast() {
  clearTimeout(toastTimer);
  $('toast').hidden = true;
}

/** Start a camera; `onFail` says why not. A failed start released it, so its start button comes back. */
export async function startCamera(camera, button, onFail) {
  try {
    await camera.start();
    button.hidden = camera.wanted; // stopped while it was starting: it is not on
  } catch (err) {
    button.hidden = false;
    onFail(err);
  }
}

/** Only a reload fetches the decoder again, and an installed app has no reload button. Reloading, if accepted. */
export function offerReload(message) {
  const marks = app.queue?.status.unsaved
    ? 'Отметки, которые телефон не смог сохранить, пропадут.'
    : 'Неотправленные отметки сохранятся.';
  if (!confirm(`${message}. Перезагрузить приложение? ${marks}`)) {
    return false;
  }
  location.reload();
  return true;
}
