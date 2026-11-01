// Projector board: shows the standings after each round, only when the person at the
// projector laptop reveals it (→ / space / button). Read-only: its link carries a board
// token that can't change marks. The logic is in lib/board.js (tested in Node).

import {decodeBoard, encodeBoardLink} from '../s/lib/payload.js';
import {backend} from '../s/lib/api.js';
import {storage} from '../s/lib/storage.js';
import {boardModel} from './lib/board.js';
import {qrNode} from './lib/qr.js';

const REFRESH_EVERY_MS = 15000;
/** @type {(id: string) => any} */
const $ = (id) => document.getElementById(id);
const store = storage();
const access = decodeBoard(location.hash);
// Links made by the CLI always carry ?grid=; 5 is board_grid_max_teams's default.
const gridParam = new URLSearchParams(location.search).get('grid');
const gridMax = /^\d+$/.test(gridParam ?? '') ? Number(gridParam) : 5;
const key = (name) => `chgk.board.${name}.${access ? access.tid : ''}`;
// A phone in the hall (no mouse, no arrow keys): the same page, with what fits a small screen.
const touch = matchMedia('(hover: none)').matches;

let data = null;
let revealed = Number(store.get(key('revealed')) || 0);
let view = store.get(key('view')) ?? (touch ? 'compact' : null); // null = by team count
let showQr = store.get(key('qr')) ?? !touch; // QR codes of the table and of the board (Q)
let lastOk = null;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

function roundsWord(n) {
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'тура' : 'туров'}`;
}

/**
 * The two QR codes for the audience: the view-only table and this board (the same links
 * as on page 2 of the jury sheet). `big` on the title screen, a narrow column beside the
 * results otherwise.
 */
function qrCodes(big) {
  const boardLink = encodeBoardLink(location.origin + location.pathname, access, gridMax);
  const codes = [
    data.view_url ? ['Результаты: таблица', data.view_url] : null,
    ['Табло на телефоне', boardLink],
  ].filter(Boolean);
  return el(
    'aside',
    {className: `qrs${big ? ' big' : ''}`},
    ...codes.map(([caption, link]) => {
      const box = el('div', {className: 'code'});
      try {
        box.replaceChildren(qrNode(link));
      } catch (err) {
        console.error(err); // the codes are extras: the results still go up
      }
      box.dataset.link = link;
      return el('figure', {}, box, el('figcaption', {textContent: caption}));
    }),
  );
}

function titleScreen(m) {
  return el(
    'section',
    {className: 'title'},
    el('h1', {textContent: m.name}),
    el('div', {className: 'date', textContent: m.date ? m.date.split('-').reverse().join('.') : ''}),
    el('div', {className: 'wait', textContent: 'Результаты появятся после первого тура'}),
    el('div', {
      className: 'hint',
      textContent: touch ? 'Нажмите «Показать тур 1» внизу экрана' : '→ или пробел — показать тур 1',
    }),
    showQr ? qrCodes(true) : null,
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
        const kind = {'+': 'plus', '×': 'wrong', '?': 'maybe', '•': 'no-card'}[mark];
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
        // «после 1 тура» reads «после 1-го тура»; other counts stay as numbers.
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
  // On a phone the buttons stay on screen: the stage, centred, stays clear of them.
  const height = touch ? innerHeight - 2 * ($('controls').offsetHeight + 12) : innerHeight * 0.9;
  const scale = Math.min((innerWidth * 0.96) / w, height / h, 4);
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
    $('next').textContent = 'Загрузка…';
    $('view').textContent = 'Сетка';
    for (const id of ['next', 'prev', 'view']) {
      $(id).disabled = true;
    }
    return fit();
  }
  const m = boardModel(data, revealed, {gridMax, view});
  revealed = m.revealed;
  const results = m.revealed === 0 ? titleScreen(m) : table(m);
  stage.replaceChildren(
    m.revealed > 0 && showQr ? el('div', {className: 'with-qr'}, results, qrCodes(false)) : results,
  );
  $('qr').classList.toggle('off', !showQr);
  $('view').disabled = false;
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

let loading = false;

async function load() {
  // One at a time, so an older reply can't replace a newer one; a hidden page asks when shown again.
  if (!access || loading || document.hidden) {
    return;
  }
  loading = true;
  try {
    data = await backend(access.backendUrl, access.boardToken)('get_board', {tid: access.tid});
    lastOk = new Date();
    $('status').hidden = true;
  } catch (err) {
    $('status').hidden = false;
    $('status').textContent = err.refused
      ? err.message
      : lastOk
        ? `Нет связи — данные на ${lastOk.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'})}`
        : `Не удалось загрузить: ${err.message}`;
    return;
  } finally {
    loading = false;
  }
  render(); // outside the try: a drawing error is not a connection problem
}

function toggleQr() {
  showQr = !showQr;
  store.set(key('qr'), showQr);
  render();
}

let idleTimer = null;
function wake() {
  $('controls').classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => $('controls').classList.add('idle'), 3000);
}

// A board link opened into this tab only changes the #… (no reload): load the board it names.
addEventListener('hashchange', () => {
  const next = decodeBoard(location.hash);
  if (
    next &&
    !(
      access &&
      next.tid === access.tid &&
      next.boardToken === access.boardToken &&
      next.backendUrl === access.backendUrl
    )
  ) {
    location.reload();
  }
});

$('full').hidden = !document.documentElement.requestFullscreen; // an iPhone has none
$('next').onclick = () => setRevealed(revealed + 1);
$('prev').onclick = () => setRevealed(revealed - 1);
$('view').onclick = toggleView;
$('qr').onclick = toggleQr;
$('full').onclick = () =>
  document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
// A mouse click must not leave focus on its button: Space would press it again instead of showing
// the next round, and the controls would never fade. Keyboard use (detail 0) keeps its focus.
$('controls').addEventListener('click', (e) => {
  if (e.detail) {
    e.target.closest('button')?.blur();
  }
});
addEventListener('keydown', (e) => {
  // A held key would reveal several rounds at once; Cmd+F and the like stay the browser's.
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) {
    return;
  }
  if (e.target.closest?.('button') && [' ', 'Enter'].includes(e.key)) {
    return; // a focused button does its own job
  }
  if (['ArrowRight', ' ', 'PageDown', 'Enter'].includes(e.key)) {
    setRevealed(revealed + 1);
  } else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) {
    setRevealed(revealed - 1);
  } else if (e.key === 'g' || e.key === 'G' || e.key === 'п' || e.key === 'П') {
    toggleView();
  } else if (e.key === 'q' || e.key === 'Q' || e.key === 'й' || e.key === 'Й') {
    toggleQr();
  } else if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') {
    $('full').click();
  } else {
    return;
  }
  e.preventDefault();
});
addEventListener('resize', fit);
addEventListener('mousemove', wake);
addEventListener('keydown', wake);
wake();
render();
load();
setInterval(load, REFRESH_EVERY_MS);
addEventListener('visibilitychange', load);
