// «Чья карточка?»: cards are only described, nothing is recorded.

import {identify} from '../lib/lookup.js';
import {$, beep, sheet, toast, unlockAudio} from './dom.js';
import {app} from './state.js';

export async function openLookup() {
  unlockAudio();
  $('lookup').className = 'sheet lookup';
  $('lk-title').textContent = 'Наведите камеру на карточку';
  $('lk-details').replaceChildren();
  sheet('lookup');
  app.camera.forgetLast(); // the card already in front of the camera counts too
  try {
    await app.camera.start();
    $('start').hidden = true;
  } catch (err) {
    if (app.lookingUp) {
      $('lk-title').textContent = `Камера недоступна: ${err.message}`;
    } else {
      toast(`Камера недоступна: ${err.message}`, true);
    }
  }
}

export function showLookup(text) {
  const r = identify(text, app.session);
  $('lookup').className = `sheet lookup ${r.tone}`;
  $('lk-title').textContent = r.title;
  $('lk-details').replaceChildren(
    ...r.details.map((d) => Object.assign(document.createElement('li'), {textContent: d})),
  );
  beep(r.tone);
}
