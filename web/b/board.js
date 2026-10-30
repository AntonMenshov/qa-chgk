// Projector board: shows the standings after each round, only when the person at the
// projector laptop reveals it (→ / space / button). Read-only: its link carries a board
// token that can't change marks. The logic is in lib/board.js (tested in Node).

import {decodeBoard} from '../s/lib/payload.js';
import {backend} from '../s/lib/api.js';
import {storage} from '../s/lib/storage.js';
import {boardModel} from './lib/board.js';

const REFRESH_EVERY_MS = 15000;
const $ = (id) => document.getElementById(id);
const store = storage();
const access = decodeBoard(location.hash);
const gridMax = Number(new URLSearchParams(location.search).get('grid') ?? 5);
const key = (name) => `chgk.board.${name}.${access ? access.tid : ''}`;

let data = null;
let revealed = Number(store.get(key('revealed')) || 0);
let view = store.get(key('view')); // null = by team count
let lastOk = null;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

function roundsWord(n) {
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'тура' : 'туров'}`;
}

function titleScreen(m) {
  return el(
    'section',
    {className: 'title'},
    el('h1', {textContent: m.name}),
    el('div', {className: 'date', textContent: m.date ? m.date.split('-').reverse().join('.') : ''}),
    el('div', {className: 'wait', textContent: 'Результаты появятся после первого тура'}),
    el('div', {className: 'hint', textContent: '→ или пробел — показать тур 1'}),
  );
}

function table(m) {
  const grid = m.view === 'grid';
  const head1 = el('tr', {className: 'rounds'}, el('th'), el('th'));
  const head2 = el('tr', {}, el('th', {textContent: 'Место'}), el('th', {className: 'team', textContent: 'Команда'}));
  if (!grid) {
    head1.append(el('th'));
    head2.append(el('th', {textContent: 'Итого'}));
  }
  for (const g of m.groups) {
    head1.append(
      el('th', {colSpan: g.questions.length + 1, className: `r${g.round} edge`, textContent: `Тур ${g.round}`}),
    );
    g.questions.forEach((q, i) =>
      head2.append(el('th', {className: `r${g.round}${i === 0 ? ' edge' : ''}`, textContent: q})),
    );
    head2.append(el('th', {className: `r${g.round}`, textContent: 'Σ'}));
  }
  if (grid) {
    head1.append(el('th'));
    head2.append(el('th', {textContent: 'Итого'}));
  }
  const body = m.rows.map((r) => {
    const tr = el(
      'tr',
      {},
      el('td', {className: 'place', textContent: r.place}),
      el('td', {className: 'team', textContent: r.name}),
    );
    const total = el('td', {className: 'total', textContent: r.total});
    if (!grid) {
      tr.append(total);
    }
    for (const g of m.groups) {
      g.questions.forEach((q, i) => {
        const mark = r.marks[q];
        const kind = mark === '+' ? 'plus' : mark === '?' ? 'maybe' : 'minus';
        tr.append(el('td', {className: `q ${kind} r${g.round}${i === 0 ? ' edge' : ''}`, textContent: mark}));
      });
      tr.append(el('td', {className: `sum r${g.round}`, textContent: r.sums[g.round - 1]}));
    }
    if (grid) {
      tr.append(total);
    }
    return tr;
  });
  const foot = el('tr', {}, el('td'), el('td', {className: 'label', textContent: 'Взяли'}));
  if (!grid) {
    foot.append(el('td'));
  }
  for (const g of m.groups) {
    g.questions.forEach((q, i) =>
      foot.append(el('td', {className: `r${g.round}${i === 0 ? ' edge' : ''}`, textContent: m.took[q]})),
    );
    foot.append(el('td', {className: `r${g.round}`}));
  }
  if (grid) {
    foot.append(el('td'));
  }
  return el(
    'section',
    {},
    el(
      'div',
      {className: 'head'},
      el('h1', {textContent: m.name}),
      el('div', {
        className: 'after',
        textContent: `после ${roundsWord(m.revealed).replace(/^1 /, '1-го ')} из ${m.rounds}`,
      }),
    ),
    el(
      'table',
      {className: m.rows.length > 12 ? 'dense' : ''},
      el('thead', {}, head1, head2),
      el('tbody', {}, ...body),
      el('tfoot', {}, foot),
    ),
  );
}

/** Scale the stage so the whole board fills the screen. */
function fit() {
  const stage = $('stage');
  stage.style.transform = 'translate(-50%, -50%)';
  const w = stage.offsetWidth;
  const h = stage.offsetHeight;
  if (!w || !h) {
    return;
  }
  const scale = Math.min((innerWidth * 0.96) / w, (innerHeight * 0.9) / h, 4);
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
}

function render() {
  const stage = $('stage');
  if (!access) {
    stage.replaceChildren(
      el(
        'section',
        {className: 'title'},
        el('h1', {textContent: 'Табло'}),
        el('div', {className: 'wait', textContent: 'Откройте ссылку табло со второй страницы листа жюри.'}),
      ),
    );
    $('controls').hidden = true;
    return fit();
  }
  if (!data) {
    stage.replaceChildren(
      el('section', {className: 'title'}, el('div', {className: 'wait', textContent: 'Загрузка…'})),
    );
    return fit();
  }
  const m = boardModel(data, revealed, {gridMax, view});
  revealed = m.revealed;
  stage.replaceChildren(m.revealed === 0 ? titleScreen(m) : table(m));
  $('prev').disabled = m.revealed === 0;
  $('next').disabled = m.revealed >= m.rounds;
  $('next').textContent = m.revealed >= m.rounds ? 'Все туры показаны' : `Показать тур ${m.revealed + 1} ›`;
  $('view').textContent = m.view === 'grid' ? 'Кратко' : 'Сетка';
  fit();
}

function setRevealed(n) {
  if (!data) {
    return;
  }
  revealed = Math.min(Math.max(0, n), data.tournament.round_sizes.length);
  store.set(key('revealed'), revealed);
  render();
}

function toggleView() {
  if (!data) {
    return;
  }
  const current = boardModel(data, revealed, {gridMax, view}).view;
  view = current === 'grid' ? 'compact' : 'grid';
  store.set(key('view'), view);
  render();
}

async function load() {
  if (!access) {
    return;
  }
  try {
    data = await backend(access.backendUrl, access.boardToken)('get_board', {tid: access.tid});
    lastOk = new Date();
    $('status').hidden = true;
    render();
  } catch (err) {
    $('status').hidden = false;
    $('status').textContent = lastOk
      ? `Нет связи — данные на ${lastOk.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'})}`
      : `Не удалось загрузить: ${err.message}`;
  }
}

let idleTimer = null;
function wake() {
  $('controls').classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => $('controls').classList.add('idle'), 3000);
}

$('next').onclick = () => setRevealed(revealed + 1);
$('prev').onclick = () => setRevealed(revealed - 1);
$('view').onclick = toggleView;
$('full').onclick = () =>
  document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
addEventListener('keydown', (e) => {
  if (['ArrowRight', ' ', 'PageDown', 'Enter'].includes(e.key)) {
    setRevealed(revealed + 1);
  } else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) {
    setRevealed(revealed - 1);
  } else if (e.key === 'g' || e.key === 'G' || e.key === 'п' || e.key === 'П') {
    toggleView();
  } else if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') {
    $('full').click();
  } else {
    return;
  }
  e.preventDefault();
});
addEventListener('resize', fit);
addEventListener('mousemove', wake);
wake();
render();
load();
setInterval(load, REFRESH_EVERY_MS);
