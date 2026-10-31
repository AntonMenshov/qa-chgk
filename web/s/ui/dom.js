// The page: which screen or bottom sheet is shown, toasts, and sounds (iOS has no vibration for web pages).

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

let audio = null;

export function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state !== 'running') {
      audio.resume().catch(() => {});
    }
  } catch {
    audio = null;
  }
}

export function beep(kind) {
  // Stopped (a phone lock, a call): tones queued now would all play at once on resume.
  if (audio?.state !== 'running') {
    return;
  }
  try {
    playTones(kind);
  } catch {
    // a sound must never get in the way of a card
  }
}

function playTones(kind) {
  const tones =
    kind === 'warn'
      ? [
          [440, 0],
          [440, 0.18],
        ]
      : kind === 'bad'
        ? [
            [220, 0],
            [220, 0.2],
            [220, 0.4],
          ]
        : [[1046, 0]];
  for (const [freq, at] of tones) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(audio.destination);
    osc.start(audio.currentTime + at);
    osc.stop(audio.currentTime + at + 0.12);
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
