// «Чья карточка?»: cards are only described, nothing is recorded.

import {identify} from '../lib/lookup.js';
import {$, lookingUp, sheet, startCamera, toast} from './dom.js';
import {app} from './state.js';

export async function openLookup() {
  $('lookup').className = 'sheet lookup';
  $('lk-title').textContent = 'Наведите камеру на карточку';
  $('lk-details').replaceChildren();
  sheet('lookup');
  app.camera.forgetLast(); // the card already in front of the camera counts too
  await startCamera((err) => {
    if (lookingUp()) {
      $('lk-title').textContent = `Камера недоступна: ${err.message}`;
    } else {
      toast(`Камера недоступна: ${err.message}`, true);
    }
  });
}

export function closeLookup() {
  app.camera.restoreLast(); // a card still in view counts only after it leaves the frame and returns
  sheet(null);
}

export function showLookup(text) {
  const r = identify(text, app.session);
  $('lookup').className = `sheet lookup ${r.tone}`;
  $('lk-title').textContent = r.title;
  $('lk-details').replaceChildren(
    ...r.details.map((d) => Object.assign(document.createElement('li'), {textContent: d})),
  );
}
