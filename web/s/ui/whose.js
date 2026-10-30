// «Чья карточка?»: cards are only described, nothing is recorded.

import {identify} from '../lib/lookup.js';
import {$, beep, sheet, unlockAudio} from './dom.js';
import {app} from './state.js';

export async function openLookup() {
  unlockAudio();
  $('lookup').className = 'sheet lookup';
  $('lk-title').textContent = 'Наведите камеру на карточку';
  $('lk-details').replaceChildren();
  sheet('lookup');
  app.camera.last = {text: null, seenAt: 0}; // the card already in front of the app.camera counts too
  try {
    await app.camera.start();
    $('start').hidden = true;
  } catch (err) {
    $('lk-title').textContent = `Камера недоступна: ${err.message}`;
  }
}

export function showLookup(text) {
  const r = identify(text, app.session);
  $('lookup').className = `sheet lookup ${r.tone}`;
  $('lk-title').textContent = r.title;
  $('lk-details').replaceChildren(
    ...r.details.map((d) => Object.assign(document.createElement('li'), {textContent: d})),
  );
  beep(r.tone === 'ok' ? 'ok' : 'bad');
}
