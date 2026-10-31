// The page: which screen or bottom sheet is shown, toasts, and sounds (iOS has no vibration for web pages).

import {app} from './state.js';

export const $ = (id) => document.getElementById(id);

export function show(id) {
  for (const s of document.querySelectorAll('.screen')) {
    s.hidden = s.id !== id;
  }
}

export function sheet(id) {
  for (const s of document.querySelectorAll('.sheet')) {
    s.hidden = s.id !== id;
  }
  app.lookingUp = id === 'lookup'; // any other sheet ends «Чья карточка?»
  // A card waits for its verdict: nothing behind it can open another sheet over it.
  $('main').inert = id === 'card' || id === 'spare';
  if (app.camera) {
    id && id !== 'lookup' ? app.camera.pause() : app.camera.resume();
  }
}

let audio = null;

export function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') {
      audio.resume();
    }
  } catch {
    audio = null;
  }
}

export function beep(kind) {
  if (!audio) {
    return;
  }
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
