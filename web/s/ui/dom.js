// The page: which screen or bottom sheet is shown, and toasts.

import {app} from './state.js';

/** @type {(id: string) => any} */
export const $ = (id) => document.getElementById(id);

export function show(id) {
  for (const s of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.screen'))) {
    s.hidden = s.id !== id;
  }
}

export function sheet(id) {
  for (const s of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.sheet'))) {
    s.hidden = s.id !== id;
  }
  app.lookingUp = id === 'lookup'; // any other sheet ends «Чья карточка?»
  // Nothing behind a sheet can act: a card waits for its verdict, a list shows its question.
  $('main').inert = id !== null;
  if (app.camera) {
    id && id !== 'lookup' ? app.camera.pause() : app.camera.resume();
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
