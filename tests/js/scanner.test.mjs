// Scanner web app (web/s): QR decoding, marks, the scanning session, the queue, the camera.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeCard, decodeSetup, sameAccess} from '../../web/s/lib/payload.js';
import {noVerdictLabel, overlay, statusOf} from '../../web/s/lib/marks.js';
import {Session, WARN} from '../../web/s/lib/session.js';
import {identify} from '../../web/s/lib/lookup.js';
import {Queue} from '../../web/s/lib/queue.js';
import {backend, BackendError} from '../../web/s/lib/api.js';

const vectors = (name) => JSON.parse(readFileSync(new URL(`../vectors/${name}`, import.meta.url), 'utf8'));

// ---------- payload: shared vectors with chgk/ids.py ----------

for (const c of vectors('qr_payloads.json').cases) {
  test(`card payload ${c.valid ? 'decodes' : 'is refused'}: ${c.note || c.payload}`, () => {
    const card = decodeCard(c.payload);
    if (!c.valid) {
      return assert.equal(card, null);
    }
    assert.deepEqual(card, {tid: c.tid, teamId: c.team_id, question: c.question, spare: c.spare});
  });
}

for (const c of vectors('jury_links.json').cases) {
  test(`jury link ${c.valid ? 'decodes' : 'is refused'}: ${c.note || c.link}`, () => {
    const setup = decodeSetup(c.link);
    if (!c.valid) {
      return assert.equal(setup, null);
    }
    assert.deepEqual(setup, {tid: c.tid, juryToken: c.jury_token, backendUrl: c.backend_url});
  });
}

test('a card is not a jury link and a jury link is not a card', () => {
  assert.equal(decodeSetup('https://e.github.io/qa-chgk/s/#K7M2Q.A07.27'), null);
  assert.equal(decodeCard('https://e.github.io/qa-chgk/s/#setup=K7M2Q.abcDEF123_-ghiJKL456mno.AKfycbx_Example'), null);
});

// ---------- marks ----------

test('the card sheet offers «Отмена» for a card already entered, «Решить позже» for a new one', () => {
  assert.equal(noVerdictLabel(null), 'Решить позже (карточка получена)');
  assert.equal(noVerdictLabel('correct'), 'Отмена (останется: верно)');
  assert.equal(noVerdictLabel('incorrect'), 'Отмена (останется: неверно)');
  assert.equal(noVerdictLabel('disputed'), 'Отмена (останется: спорно)');
  assert.equal(noVerdictLabel('received'), 'Отмена (останется: получена)');
});

test('overlay: local events over the snapshot, in time order', () => {
  const marks = overlay(
    {A01: ['', 1, '?'], A02: ['', '', '']},
    [
      {team_id: 'A01', question: 3, status: 'correct', client_ts: 20},
      {team_id: 'A01', question: 3, status: 'incorrect', client_ts: 10}, // older: loses
      {team_id: 'A02', question: 1, status: 'received', client_ts: 5},
      {team_id: 'A01', question: 2, status: 'received', client_ts: 30}, // never undoes a judgement
      {team_id: 'R1', question: 1, status: 'correct', client_ts: 1}, // a team not in the snapshot yet
      {team_id: 'A02', question: 9, status: 'correct', client_ts: 1}, // out of range: ignored
    ],
    3,
  );
  assert.deepEqual(marks, {A01: ['', 1, 1], A02: ['R', '', ''], R1: [1, '', '']});
  assert.deepEqual(
    [statusOf(1), statusOf(0), statusOf('?'), statusOf('R'), statusOf('')],
    ['correct', 'incorrect', 'disputed', 'received', null],
  );
});

// ---------- the scanning session ----------

const TID = 'K7M2Q';
const URL_BASE = 'https://e.github.io/qa-chgk/s/#';
const STATE = {
  tournament: {name: 'Кубок', round_sizes: [3, 3]},
  teams: [
    {team_id: '645', name: '42', reserve: false},
    {team_id: '58746', name: 'Фиаско', reserve: false},
    {team_id: 'R1', name: 'R1 · впишите название', reserve: true},
  ],
  marks: {645: ['', '', '', '', '', ''], 58746: ['', '', '', '', '', ''], R1: ['', '', '', '', '', '']},
};

function session(over = {}) {
  let t = 1000;
  let n = 0;
  return new Session({
    tid: TID,
    state: structuredClone(STATE),
    juror: 'Анна',
    device: 'dev1',
    now: () => (t += 10),
    uuid: () => `id${++n}`,
    ...over,
  });
}

test('scan: a numbered card is marked for the question in its QR code', () => {
  const s = session();
  const r = s.scan(`${URL_BASE}${TID}.645.2`);
  assert.equal(r.kind, 'card');
  assert.deepEqual([r.team.name, r.question, r.spare, r.previous, r.warnings], ['42', 2, null, null, []]);
});

test('the current question follows the scans: a later card makes it current, an earlier one only warns', () => {
  const s = session();
  assert.equal(s.current, 1);
  s.scan(`${TID}.645.1`);
  assert.equal(s.current, 1);
  s.scan(`${TID}.645.4`);
  assert.equal(s.current, 4);
  const late = s.scan(`${TID}.58746.2`);
  assert.equal(s.current, 4); // an old card doesn't move it back
  assert.equal(late.question, 2); // and is still for question 2
  assert.deepEqual(
    late.warnings.map((w) => w.code),
    [WARN.EARLIER],
  );
  assert.match(late.warnings[0].text, /Карточка вопроса 2 \(идёт 4\) — отмечается для 2/);
});

test('◀ ▶ can still set the question by hand, within the tournament', () => {
  const s = session();
  assert.equal(s.setQuestion(5), 5);
  assert.equal(s.setQuestion(0), 1);
  assert.equal(s.setQuestion(99), 6);
});

test('a spare card asks for the question; the answer is then treated like a numbered card', () => {
  const s = session();
  s.scan(`${TID}.645.3`);
  const r = s.scan(`${TID}.58746.S2`);
  assert.deepEqual([r.kind, r.team.team_id, r.spare], ['spare', '58746', 2]);
  assert.equal(s.current, 3); // nothing recorded or moved before the juror answers
  const card = s.card('58746', 3, 2);
  assert.deepEqual([card.kind, card.question, card.spare, card.warnings], ['card', 3, 2, []]);
  const ev = s.record('58746', 3, 2, 'received');
  assert.equal(ev.spare, 2);
  assert.equal(s.valueOf('58746', 3), 'R');
});

test('cards of another tournament, unknown teams and other QR codes are refused', () => {
  const s = session();
  assert.deepEqual(s.scan(`${URL_BASE}PU4WR.645.2`), {kind: 'foreign', tid: 'PU4WR'}); // same team and question, old tournament
  assert.deepEqual(s.scan(`${TID}.Z99.2`), {kind: 'unknown_team', teamId: 'Z99'});
  const tooFar = s.scan(`${TID}.645.${s.total + 1}`); // printed for a longer tournament
  assert.deepEqual([tooFar.kind, tooFar.question, tooFar.total], ['bad_question', s.total + 1, s.total]);
  assert.equal(s.current < s.total + 1, true); // never the current question
  assert.deepEqual(s.scan('https://example.com/menu'), {kind: 'other'});
  const setup = s.scan(`${URL_BASE}setup=QHZJ8.abcDEF123_-ghiJKL456mno.AKfycbx_Example-Deployment_ID123`);
  assert.equal(setup.kind, 'setup');
  assert.equal(setup.setup.tid, 'QHZJ8');
  assert.equal(s.current, 1);
});

test('a card already judged warns; one only received does not', () => {
  const s = session();
  s.record('645', 1, null, 'received');
  assert.deepEqual(s.scan(`${TID}.645.1`).warnings, []);
  s.record('645', 1, null, 'correct');
  const again = s.scan(`${TID}.645.1`);
  assert.equal(again.previous, 'correct');
  assert.deepEqual(
    again.warnings.map((w) => [w.code, w.text]),
    [[WARN.ALREADY, 'Уже отмечено: верно']],
  );
});

test('«Чья карточка?»: team, question, round and its mark; nothing recorded, the current question stays', () => {
  const s = session();
  s.record('645', 2, null, 'correct');
  const before = JSON.stringify(s.local);
  assert.deepEqual(identify(`${URL_BASE}${TID}.645.2`, s), {
    tone: 'ok',
    title: '42',
    details: ['Вопрос 2 · тур 1', 'ID 645', 'Отметка: верно'],
  });
  assert.deepEqual(identify(`${TID}.58746.5`, s).details, ['Вопрос 5 · тур 2', 'ID 58746', 'Отметки пока нет']);
  assert.deepEqual([JSON.stringify(s.local), s.current], [before, 1]);
});

test('«Чья карточка?»: spare, unused reserve, foreign, unknown team, question out of range, other QR codes', () => {
  const s = session();
  assert.deepEqual(identify(`${TID}.58746.S3`, s).details, [
    'Запасная карточка №3: номер вопроса вписан от руки',
    'ID 58746',
  ]);
  assert.deepEqual(identify(`${TID}.R1.1`, s).details[1], 'ID R1 · запасной комплект, команда ещё не названа');
  assert.deepEqual(identify(`${URL_BASE}PU4WR.645.2`, s), {
    tone: 'bad',
    title: 'Карточка другого турнира',
    details: [`Турнир PU4WR (здесь ${TID})`, 'Команда ID 645 · Вопрос 2'],
  });
  assert.deepEqual(identify(`${TID}.Z99.2`, s), {
    tone: 'bad',
    title: 'Команда ID Z99',
    details: ['Нет в списке команд этого турнира', 'Вопрос 2'],
  });
  assert.deepEqual(identify(`${TID}.645.7`, s).details[0], 'Вопрос 7, а в турнире всего 6');
  assert.equal(identify('https://example.com/menu', s).title, 'Не карточка ЧГК');
  assert.equal(
    identify(`${URL_BASE}setup=QHZJ8.abcDEF123_-ghiJKL456mno.AKfycbx_Example-Deployment_ID123`, s).title,
    'QR «Доступ жюри»',
  );
  assert.equal(
    identify(
      'https://x.github.io/qa-chgk/b/?grid=5#board=QHZJ8.abcDEF123_-ghiJKL456mno.AKfycbx_Example-Deployment_ID123',
      s,
    ).title,
    'QR табло',
  );
});

test('«Чья карточка?» before setup: only what the QR code holds', () => {
  assert.deepEqual(identify(`${URL_BASE}${TID}.645.2`), {
    tone: 'ok',
    title: 'Команда ID 645',
    details: ['Вопрос 2', `Турнир ${TID}`],
  });
  assert.equal(identify(`${TID}.645.S1`).details[0], 'Запасная карточка №1: номер вопроса вписан от руки');
});

test('events carry everything the backend needs', () => {
  const s = session();
  const ev = s.record('645', 2, null, 'correct');
  assert.deepEqual(Object.keys(ev).sort(), [
    'client_ts',
    'device',
    'juror',
    'question',
    'scan_id',
    'status',
    'team_id',
  ]);
  assert.deepEqual([ev.juror, ev.device, ev.status, ev.question], ['Анна', 'dev1', 'correct', 2]);
});

test("missing: teams without a card for the current question; an unused reserve team isn't counted", () => {
  const s = session();
  s.scan(`${TID}.645.1`);
  s.record('645', 1, null, 'received');
  assert.deepEqual(
    s.missing().map((t) => t.team_id),
    ['58746'],
  );
  // R1 turns up and hands in a card: from now on it is counted.
  const r = s.scan(`${TID}.R1.2`);
  assert.deepEqual(
    r.warnings.map((w) => w.code),
    [WARN.RESERVE],
  );
  s.record('R1', 2, null, 'received');
  assert.deepEqual(
    s.missing().map((t) => t.team_id),
    ['645', '58746'],
  );
  assert.deepEqual(
    s.missing(1).map((t) => t.team_id),
    ['58746', 'R1'],
  );
});

test('pending and recently sent events stay on screen until a newer snapshot has them', () => {
  const s = session();
  const a = s.record('645', 1, null, 'correct');
  const b = s.record('645', 2, null, 'incorrect');
  s.acked([a.scan_id], 5000);
  // A snapshot fetched before the ack doesn't include `a` yet: keep showing it.
  s.setSnapshot(structuredClone(STATE), 4000);
  assert.deepEqual(s.marks['645'].slice(0, 2), [1, 0]);
  // A snapshot fetched after the ack includes it (here: the jury changed it to «?» in the Sheet since).
  const later = structuredClone(STATE);
  later.marks['645'][0] = '?';
  s.setSnapshot(later, 6000);
  assert.deepEqual(s.marks['645'].slice(0, 2), ['?', 0]); // b is still pending, so still shown
  s.rejected([b.scan_id]);
  assert.deepEqual(s.marks['645'].slice(0, 2), ['?', '']);
});

test('resuming: the current question comes back, else the last question with any mark', () => {
  const state = structuredClone(STATE);
  state.marks['645'][4] = 1;
  assert.equal(session({state}).current, 5);
  assert.equal(session({state, current: 2}).current, 2);
  assert.equal(session({state, current: 99}).current, 5);
});

// ---------- the queue ----------

function memoryStorage() {
  const data = new Map();
  return {
    get: (k) => (data.has(k) ? JSON.parse(data.get(k)) : null),
    set: (k, v) => data.set(k, JSON.stringify(v)),
    data,
  };
}

const ev = (id) => ({scan_id: id, team_id: '645', question: 1, status: 'correct', client_ts: 1});

test('queue: everything pending goes in one request; acked and refused events leave the queue', async () => {
  const storage = memoryStorage();
  const sent = [];
  const q = new Queue({
    storage,
    key: 'q',
    send: async (events) => {
      sent.push(events.map((e) => e.scan_id));
      return {
        results: events.map((e) =>
          e.scan_id === 'b'
            ? {scan_id: 'b', applied: false, error: 'invalid question'}
            : {scan_id: e.scan_id, applied: true, duplicate: false},
        ),
      };
    },
  });
  ['a', 'b', 'c'].forEach((id) => q.add(ev(id)));
  const res = await q.flush();
  assert.deepEqual(sent, [['a', 'b', 'c']]);
  assert.deepEqual(res, {acked: ['a', 'c'], rejected: ['b']});
  assert.deepEqual(q.status, {pending: 0, rejected: 1, failing: false, stuck: false, unsaved: false, lastError: null});
  assert.equal(q.rejected[0].error, 'invalid question');
  assert.equal(await q.flush(), null); // nothing left to send
});

test('queue: survives a reload (saved after every change)', async () => {
  const storage = memoryStorage();
  const q = new Queue({
    storage,
    key: 'q',
    send: async () => {
      throw new Error('offline');
    },
  });
  q.add(ev('a'));
  q.add(ev('b'));
  const again = new Queue({storage, key: 'q', send: async () => ({results: []})});
  assert.deepEqual(
    again.pending.map((e) => e.scan_id),
    ['a', 'b'],
  );
});

test('queue: failures retry with growing pauses; success resets them', async () => {
  let t = 0;
  let online = false;
  const q = new Queue({
    storage: memoryStorage(),
    key: 'q',
    now: () => t,
    send: async (events) => {
      if (!online) {
        throw new Error('нет связи');
      }
      return {results: events.map((e) => ({scan_id: e.scan_id, applied: true}))};
    },
  });
  q.add(ev('a'));
  assert.equal(await q.flush(), null);
  assert.deepEqual([q.status.failing, q.status.lastError, q.nextAttemptAt], [true, 'нет связи', 2000]);
  t = 1000;
  assert.equal(q.due(), false); // waiting
  t = 2000;
  await q.flush();
  assert.equal(q.nextAttemptAt, 2000 + 4000);
  t = 6000;
  await q.flush();
  assert.equal(q.nextAttemptAt, 6000 + 8000);
  for (let i = 0; i < 5; i++) {
    t = q.nextAttemptAt;
    await q.flush();
  }
  assert.equal(q.nextAttemptAt - t, 30000); // capped
  online = true;
  t = q.nextAttemptAt;
  assert.deepEqual(await q.flush(), {acked: ['a'], rejected: []});
  assert.deepEqual(q.status, {pending: 0, rejected: 0, failing: false, stuck: false, unsaved: false, lastError: null});
});

test('queue: events added while a request is in flight wait for the next one', async () => {
  let release;
  const q = new Queue({
    storage: memoryStorage(),
    key: 'q',
    send: (events) =>
      new Promise((resolve) => {
        release = () => resolve({results: events.map((e) => ({scan_id: e.scan_id, applied: true}))});
      }),
  });
  q.add(ev('a'));
  const flushing = q.flush();
  assert.equal(q.due(), false); // one request at a time
  q.add(ev('b'));
  release();
  assert.deepEqual(await flushing, {acked: ['a'], rejected: []});
  assert.deepEqual(
    q.pending.map((e) => e.scan_id),
    ['b'],
  );
});

test('queue: an event without an answer stays pending; batches are capped', async () => {
  const sizes = [];
  const q = new Queue({
    storage: memoryStorage(),
    key: 'q',
    batchSize: 2,
    send: async (events) => {
      sizes.push(events.length);
      return {results: [{scan_id: events[0].scan_id, applied: true}]};
    },
  });
  ['a', 'b', 'c'].forEach((id) => q.add(ev(id)));
  await q.flush();
  assert.deepEqual(sizes, [2]);
  assert.deepEqual(
    q.pending.map((e) => e.scan_id),
    ['b', 'c'],
  );
});

// ---------- api ----------

test('api: text/plain POST with the token; backend errors and network errors become BackendError', async () => {
  const calls = [];
  const ok = backend('https://script.google.com/macros/s/X/exec', 'tok', async (url, init) => {
    calls.push({url, init});
    return {status: 200, json: async () => ({ok: true, teams: []})};
  });
  assert.deepEqual(await ok('get_state', {tid: TID}), {ok: true, teams: []});
  assert.equal(calls[0].init.headers['Content-Type'], 'text/plain;charset=utf-8');
  assert.deepEqual(JSON.parse(calls[0].init.body), {action: 'get_state', token: 'tok', tid: TID});

  const refused = backend('u', 't', async () => ({
    status: 200,
    json: async () => ({ok: false, error: 'forbidden: jury token required'}),
  }));
  // A refused token says what to do (the link was replaced), and is retried rather than dropped.
  await assert.rejects(
    refused('get_state'),
    (err) => err instanceof BackendError && /новый QR «Доступ жюри»/.test(err.message) && err.retry,
  );
  const html = backend('u', 't', async () => ({
    status: 200,
    json: async () => {
      throw new SyntaxError('<html>');
    },
  }));
  await assert.rejects(html('get_state'), /не JSON/);
  const offline = backend('u', 't', async () => {
    throw new TypeError('Load failed');
  });
  await assert.rejects(offline('get_state'), /нет связи/);
});

// ---------- the phone's modules end to end against the fake Apps Script backend ----------

import {loadBackend} from './fake_apps_script.mjs';

test('phone flow against the backend: scan, judge, send, refresh; reserve team; old card; foreign card', async () => {
  const b = loadBackend();
  b.setup();
  const admin = b.$.props.get('ADMIN_TOKEN');
  const JURY = 'jury-token-0123456789';
  const created = b.post({
    action: 'create_tournament',
    token: admin,
    tid: TID,
    name: 'Кубок',
    date: '2026-11-15',
    round_sizes: [3, 3],
    jury_token: JURY,
    board_token: 'boardTOKEN_0123456789ab',
    teams: [
      {team_id: '645', name: '42'},
      {team_id: '58746', name: 'Фиаско'},
    ],
    reserve: ['R1'],
  });
  assert.equal(created.ok, true);
  // fetch → doPost, as Google would.
  const fakeFetch = async (url, init) => {
    const out = b.doPost({postData: {contents: init.body}});
    return {status: 200, json: async () => JSON.parse(out.text)};
  };
  const call = backend('https://script.google.com/macros/s/X/exec', JURY, fakeFetch);
  const storage = memoryStorage();
  const s = new Session({tid: TID, state: await call('get_state', {tid: TID}), device: 'dev1'});
  const q = new Queue({storage, key: `queue.${TID}`, send: (events) => call('record_events', {tid: TID, events})});
  const judge = (text, verdict, answer) => {
    let r = s.scan(text);
    if (r.kind === 'spare') {
      r = s.card(r.team.team_id, answer, r.spare);
    }
    assert.equal(r.kind, 'card');
    q.add(s.record(r.team.team_id, r.question, r.spare, 'received'));
    q.add(s.record(r.team.team_id, r.question, r.spare, verdict));
    return r;
  };
  const sync = async () => {
    const res = await q.flush();
    if (res) {
      s.acked(res.acked);
      s.rejected(res.rejected);
    }
    const started = Date.now();
    s.setSnapshot(await call('get_state', {tid: TID}), started);
  };

  judge(`${URL_BASE}${TID}.645.1`, 'correct');
  judge(`${URL_BASE}${TID}.58746.1`, 'incorrect');
  judge(`${URL_BASE}${TID}.R1.1`, 'correct'); // reserve deck R1 turns up
  judge(`${URL_BASE}${TID}.645.S1`, 'disputed', 2); // a spare card for question 2
  const late = judge(`${URL_BASE}${TID}.58746.1`, 'correct'); // the jury changes its mind
  assert.deepEqual(
    late.warnings.map((w) => w.code),
    [WARN.ALREADY],
  ); // a spare card's question 2 never became the current one
  assert.equal(s.scan(`${URL_BASE}PU4WR.645.1`).kind, 'foreign');
  assert.equal(q.status.pending, 10);

  await sync();
  assert.deepEqual(q.status, {pending: 0, rejected: 0, failing: false, stuck: false, unsaved: false, lastError: null});
  assert.deepEqual(s.marks['645'].slice(0, 2), [1, '?']);
  assert.deepEqual(s.marks['58746'][0], 1);
  assert.deepEqual(s.marks.R1[0], 1);
  assert.deepEqual(
    s.teams.map((t) => t.team_id),
    ['58746', '645', 'R1'],
  );
  assert.deepEqual(
    s.missing(2).map((t) => t.team_id),
    ['58746', 'R1'],
  );

  // The Sheet agrees.
  const results = await call('get_results', {tid: TID});
  assert.deepEqual(
    results.standings.map((r) => [r.team_id, r.total, r.place]),
    [
      ['58746', 1, '1-3'],
      ['645', 1, '1-3'],
      ['R1', 1, '1-3'],
    ],
  );
  // Nothing was recorded twice: one Log row per event (duplicates are not logged).
  const log = b.$.spreadsheets.get(created.spreadsheet_id).getSheetByName('Log');
  assert.equal(log.getLastRow() - 1, 10);
});

// ---------- camera: when a code in view is reported ----------

import {Camera} from '../../web/s/lib/camera.js';

test('camera: a card is reported once while in view; again after it was away; the next card at once', () => {
  globalThis.document ??= {createElement: () => ({getContext: () => ({})})};
  const reported = [];
  const cam = new Camera({}, (text) => reported.push(text));
  cam.seen('A', 0);
  cam.seen('A', 100);
  cam.seen('A', 200); // still lying there
  assert.deepEqual(reported, ['A']);
  cam.pause(); // the juror is judging A, A stays in view
  cam.seen('A', 1000);
  cam.seen('B', 1100); // the next card is already held up: not while paused
  cam.seen('A', 2500);
  cam.resume();
  cam.seen('A', 2600); // A never left: not again
  assert.deepEqual(reported, ['A']);
  cam.seen('B', 2700); // B at once
  assert.deepEqual(reported, ['A', 'B']);
  cam.seen('A', 2800); // back to A: a different card than the last one, so reported
  cam.missed = 5; // frames decoded without it
  cam.seen('A', 5000); // gone from 2800 to 5000: reported again
  assert.deepEqual(reported, ['A', 'B', 'A', 'A']);
});

test('the phone reads standard QR codes only: a phantom Micro QR next to a card can never count', async () => {
  // zxing's "QRCode" is the whole family; a real QR corner can form a valid Micro QR (TID SP7EM).
  const {READER_OPTIONS} = await import('../../web/s/lib/camera.js');
  assert.deepEqual([...READER_OPTIONS.formats], ['QRCodeModel2']);
  assert.equal(READER_OPTIONS.maxNumberOfSymbols, 1);
});

test('offline: every module the scanner loads is in the service worker cache', () => {
  const root = new URL('../../web/s/', import.meta.url);
  const sw = readFileSync(new URL('sw.js', root), 'utf8');
  const cached = new Set([...sw.matchAll(/'([^']+\.(?:js|html|css|wasm|png|webmanifest))'/g)].map((m) => m[1]));
  const seen = new Set();
  const walk = (file) => {
    const url = new URL(file, root);
    const rel = url.pathname.slice(root.pathname.length) || url.pathname;
    const key = url.pathname.startsWith(root.pathname) ? rel : `../${url.pathname.split('/web/')[1]}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const source = readFileSync(url, 'utf8');
    for (const m of source.matchAll(/^import [^'"]*['"]([^'"]+)['"]/gm)) {
      walk(new URL(m[1], url).href);
    }
  };
  walk(new URL('app.js', root).href);
  const missing = [...seen].filter((f) => !cached.has(f));
  assert.deepEqual(missing, []);
  assert.ok(seen.size >= 15, `found only ${seen.size} modules`); // app.js, ui/, lib/, shared/logic.js
});

test('app.js starts the scanner once (a second boot doubled the timers and the first load)', () => {
  const source = readFileSync(new URL('../../web/s/app.js', import.meta.url), 'utf8');
  assert.equal(source.match(/^boot\(\);$/gm).length, 1);
});

test('api: a request the server never answers fails after the time limit, and can be retried', async () => {
  const {backend: make, BackendError: Err, REQUEST_TIMEOUT_MS} = await import('../../web/s/lib/api.js');
  assert.ok(REQUEST_TIMEOUT_MS >= 30000 && REQUEST_TIMEOUT_MS <= 60000);
  let seenSignal = null;
  const hangs = (url, init) =>
    new Promise((resolve, reject) => {
      seenSignal = init.signal;
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const started = Date.now();
  const err = await make('u', 't', hangs, 30)('record_events').catch((e) => e);
  assert.ok(err instanceof Err);
  assert.equal(err.retry, true);
  assert.match(err.message, /не ответил/);
  assert.equal(seenSignal.aborted, true);
  assert.ok(Date.now() - started < 1000);
  // A queue that sent it treats it like any failure: the event stays pending for a retry.
  const {Queue} = await import('../../web/s/lib/queue.js');
  const memory = new Map();
  const q = new Queue({
    storage: {get: (k) => memory.get(k), set: (k, v) => memory.set(k, v)},
    key: 'q',
    send: () => make('u', 't', hangs, 20)('record_events'),
  });
  q.add({scan_id: 'a', team_id: 'A01', question: 1, status: 'correct', client_ts: 1});
  assert.equal(await q.flush(), null);
  assert.deepEqual([q.status.pending, q.status.failing, q.inFlight], [1, true, false]);
});

test('the same tournament with a new jury token (a replaced link) is a new access the phone takes on', () => {
  const a = {tid: TID, juryToken: 'old-jury-token-0123456', backendUrl: 'https://script.google.com/macros/s/X/exec'};
  assert.equal(sameAccess(a, {...a}), true);
  assert.equal(sameAccess(a, {...a, juryToken: 'new-jury-token-0123456'}), false);
  assert.equal(sameAccess(a, {...a, backendUrl: 'https://script.google.com/macros/s/Y/exec'}), false);
  assert.equal(sameAccess(a, {...a, tid: 'QHZJ8'}), false);
  assert.equal(sameAccess(a, null), false);
});

// ---------- found by the code review ----------

test('api: a reply that stalls after its headers fails at the time limit too', async () => {
  const stalls = async (url, init) => ({
    status: 200,
    json: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  const err = await backend('u', 't', stalls, 20)('record_events').catch((e) => e);
  assert.ok(err instanceof BackendError);
  assert.match(err.message, /не ответил/);
  assert.equal(err.retry, true);
});

test('api: a connection lost while reading is «нет связи», a null reply a server error', async () => {
  const lost = async () => ({
    status: 200,
    json: async () => {
      throw new TypeError('Load failed');
    },
  });
  await assert.rejects(backend('u', 't', lost)('x'), /нет связи/);
  const nothing = async () => ({status: 200, json: async () => null});
  const err = await backend('u', 't', nothing)('x').catch((e) => e);
  assert.ok(err instanceof BackendError);
  assert.equal(err.name, 'BackendError');
  assert.match(err.message, /ошибка сервера/);
});

test('api: a payload cannot replace the action or the token', async () => {
  let sent = null;
  const call = backend('u', 'real', async (url, init) => {
    sent = JSON.parse(init.body);
    return {status: 200, json: async () => ({ok: true})};
  });
  await call('upload_photo', {action: 'other', token: 'old', image: 'x'});
  assert.deepEqual(sent, {action: 'upload_photo', token: 'real', image: 'x'});
});

test('statusOf: a cell holding the name of an Object method is no status', () => {
  assert.equal(statusOf('constructor'), null);
  assert.equal(statusOf('toString'), null);
  assert.equal(statusOf(1), 'correct');
});

test('session: a shorter tournament in a new state brings the current question back in range', () => {
  const teams = [{team_id: 'A01', name: 'A'}];
  const state = (sizes) => ({tournament: {name: 'T', round_sizes: sizes}, teams, marks: {}});
  const s = new Session({tid: 'T', state: state([10, 10]), current: 18});
  s.setSnapshot(state([6, 6]), 0);
  assert.equal(s.current, 12);
});

test('camera: a failing onCode does not end the decoding loop', async () => {
  const seen = [];
  const original = console.error;
  console.error = () => {};
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  const camera = Object.create(Camera.prototype);
  Object.assign(camera, {running: true, paused: false, last: {text: null, seenAt: 0}});
  const codes = ['a', 'b'];
  camera.decodeFrame = async () => codes.shift() ?? null;
  camera.onCode = (text) => {
    seen.push(text);
    if (text === 'b') {
      camera.running = false;
    }
    if (text === 'a') {
      throw new Error('a bad card');
    }
  };
  await camera.loop();
  console.error = original;
  delete globalThis.requestAnimationFrame;
  assert.deepEqual(seen, ['a', 'b']);
});

test('camera: a code decoded just as the camera stopped is not reported', async () => {
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  const seen = [];
  const camera = Object.create(Camera.prototype);
  Object.assign(camera, {running: true, paused: false, last: {text: null, seenAt: 0}, onCode: (t) => seen.push(t)});
  camera.decodeFrame = async () => {
    camera.running = false;
    return 'a';
  };
  await camera.loop();
  delete globalThis.requestAnimationFrame;
  assert.deepEqual(seen, []);
});

test('storage: a browser that blocks localStorage only loses persistence', async () => {
  const {storage} = await import('../../web/s/lib/storage.js');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError');
    },
  });
  try {
    const s = storage();
    s.set('k', 1);
    assert.equal(s.get('k'), 1); // in memory, until a reload
    s.remove('k');
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'localStorage', descriptor);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test('offline: every file the service worker lists exists, the wasm is listed, other caches are left alone', () => {
  const root = new URL('../../web/s/', import.meta.url);
  const sw = readFileSync(new URL('sw.js', root), 'utf8');
  const files = [...sw.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const file of files.filter((f) => f !== './')) {
    assert.ok(readFileSync(new URL(file, root)).length > 0, file);
  }
  const wasm = readFileSync(new URL('lib/camera.js', root), 'utf8').match(/const WASM = '([^']+)'/)[1];
  assert.ok(files.includes(wasm));
  assert.match(sw, /k\.startsWith\('chgk-scanner-'\) && k !== CACHE/);
});

test('api: a refused token is told apart from being offline', async () => {
  const refused = async () => ({
    status: 200,
    json: async () => ({ok: false, error: 'forbidden: jury token required', retry: true}),
  });
  const err = await backend('u', 't', refused)('x').catch((e) => e);
  assert.equal(err.refused, true);
  assert.equal(err.retry, true);
  const other = async () => ({status: 200, json: async () => ({ok: false, error: 'server error', retry: true})});
  assert.equal((await backend('u', 't', other)('x').catch((e) => e)).refused, false);
});

function memoryQueue(send) {
  const memory = new Map();
  return new Queue({storage: {get: (k) => memory.get(k), set: (k, v) => memory.set(k, v)}, key: 'q', send});
}

test('queue: a batch the server refuses stays, says so, and retries; a retryable failure is not «stuck»', async () => {
  const q = memoryQueue(async () => {
    throw new BackendError('invalid tid', false);
  });
  q.add({scan_id: 'a'});
  assert.equal(await q.flush(), null);
  assert.deepEqual([q.status.pending, q.status.stuck, q.status.lastError], [1, true, 'invalid tid']);
  q.retryNow();
  assert.equal(q.due(), true);
  q.send = async () => {
    throw new BackendError('нет связи');
  };
  await q.flush();
  assert.equal(q.status.stuck, false);
});

test('queue: a reply answering none of the batch counts as a failure, with its pause', async () => {
  for (const reply of [{ok: true}, {results: []}, null, {results: [{scan_id: 'other'}]}]) {
    const q = memoryQueue(async () => reply);
    q.add({scan_id: 'a'});
    assert.equal(await q.flush(), null);
    assert.equal(q.status.failing, true);
    assert.equal(q.due(), false);
    assert.equal(q.status.pending, 1);
  }
});

test('session: marks are computed once until something changes', () => {
  const teams = [{team_id: 'A01', name: 'A'}];
  const s = new Session({
    tid: 'T',
    state: {tournament: {name: 'T', round_sizes: [3]}, teams, marks: {}},
    uuid: () => 'x',
  });
  const first = s.marks;
  assert.equal(s.marks, first);
  s.record('A01', 1, null, 'correct');
  assert.notEqual(s.marks, first);
  assert.equal(s.valueOf('A01', 1), 1);
  s.rejected(['x']);
  assert.equal(s.valueOf('A01', 1), '');
});

test('session: a spare card never moves the current question; a numbered card does', () => {
  const teams = [{team_id: 'A01', name: 'A'}];
  const s = new Session({tid: 'T', state: {tournament: {name: 'T', round_sizes: [40]}, teams, marks: {}}, current: 3});
  assert.equal(s.card('A01', 31, 1).kind, 'card');
  assert.equal(s.current, 3);
  s.card('A01', 4, null);
  assert.equal(s.current, 4);
});

test('session: a reserve team on the tabs is playing before its first mark', () => {
  const teams = [
    {team_id: 'R1', name: 'Сова', reserve: true, on_tabs: true},
    {team_id: 'R2', name: 'R2 · впишите название', reserve: true, on_tabs: false},
  ];
  const s = new Session({tid: 'T', state: {tournament: {name: 'T', round_sizes: [3]}, teams, marks: {}}, current: 1});
  assert.deepEqual(
    s.missing().map((t) => t.team_id),
    ['R1'],
  );
  assert.deepEqual(s.card('R1', 1, null).warnings, []);
  assert.equal(s.card('R2', 1, null).warnings[0].code, WARN.RESERVE);
});

function fakeStream() {
  const track = {
    readyState: 'live',
    stop() {
      this.readyState = 'ended';
    },
  };
  return {track, getTracks: () => [track]};
}

function fakeCamera() {
  globalThis.ZXingWASM ??= {prepareZXingModule: async () => {}};
  const opened = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          const stream = fakeStream();
          opened.push(stream);
          return stream;
        },
      },
    },
  });
  const camera = Object.create(Camera.prototype);
  Object.assign(camera, {
    video: {play: async () => {}},
    running: true,
    starting: null,
    wanted: false,
    onTrouble: () => {},
  });
  return {camera, opened};
}

test('camera: two starts open one stream; a stream that ended is opened again', async () => {
  const {camera, opened} = fakeCamera();
  await Promise.all([camera.start(), camera.start()]);
  assert.equal(opened.length, 1);
  await camera.start();
  assert.equal(opened.length, 1);
  opened[0].track.readyState = 'ended';
  await camera.start();
  assert.equal(opened.length, 2);
});

test('camera: stopped while waiting for the camera: the new stream is closed at once', async () => {
  const {camera, opened} = fakeCamera();
  const starting = camera.start();
  camera.stop();
  await starting;
  assert.equal(opened[0].track.readyState, 'ended');
  assert.equal(camera.stream, null);
});

test('camera: a decoder that keeps failing is reported once', async () => {
  const trouble = [];
  const camera = Object.create(Camera.prototype);
  Object.assign(camera, {
    running: true,
    paused: true,
    failures: 29,
    last: {text: null, seenAt: 0},
    onTrouble: (m) => trouble.push(m),
  });
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  let calls = 0;
  camera.decodeFrame = async () => {
    calls += 1;
    if (calls === 2) {
      camera.running = false;
    }
    throw new Error('wasm');
  };
  await camera.loop();
  delete globalThis.requestAnimationFrame;
  assert.deepEqual(trouble, ['Сканер не читает кадры']);
});

test('offline: the service worker waits 3 s for the network; only a page falls back to index.html', () => {
  const sw = readFileSync(new URL('../../web/s/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /NETWORK_LIMIT_MS = 3000/);
  assert.match(sw, /request\.mode === 'navigate' \? await caches\.match\('index\.html'\)/);
});

test('camera: a stalled loop or a hidden page is no sign the card left', () => {
  const reported = [];
  const cam = new Camera({}, (text) => reported.push(text));
  cam.seen('A', 0);
  cam.seen('A', 60000); // a minute later, but no frame was decoded without it
  assert.deepEqual(reported, ['A']);
});

test('camera: a failed play closes the stream; stop clears the picture and the last card', async () => {
  const {camera, opened} = fakeCamera();
  camera.video.play = async () => {
    throw new Error('NotAllowedError');
  };
  await assert.rejects(camera.start(), /NotAllowedError/);
  assert.equal(opened[0].track.readyState, 'ended');
  assert.equal(camera.stream, null);
  camera.video.play = async () => {};
  await camera.start();
  camera.last = {text: 'A', seenAt: 1};
  camera.stop();
  assert.equal(camera.video.srcObject, null);
  assert.equal(camera.last.text, null);
});

test('render: an unchanged screen is left alone; a change is drawn', async () => {
  const writes = [];
  const element = (id) => ({
    id,
    hidden: true,
    classList: {toggle() {}},
    set textContent(v) {
      writes.push(id);
    },
    get textContent() {
      return '';
    },
  });
  const elements = new Map();
  const realDocument = globalThis.document;
  globalThis.document = {
    getElementById: (id) => elements.get(id) ?? elements.set(id, element(id)).get(id),
    createElement: () => ({}),
  };
  try {
    const {render} = await import('../../web/s/ui/sync.js');
    const {app} = await import('../../web/s/ui/state.js');
    const teams = [{team_id: 'A01', name: 'A'}];
    app.session = new Session({
      tid: 'T',
      state: {tournament: {name: 'T', round_sizes: [3]}, teams, marks: {}},
      uuid: () => 'x',
    });
    app.queue = memoryQueue(async () => ({results: []}));
    render();
    assert.ok(writes.includes('t-name'));
    writes.length = 0;
    render();
    assert.deepEqual(writes, []);
    app.queue.add({scan_id: 'a'});
    render();
    assert.ok(writes.includes('sync'));
  } finally {
    globalThis.document = realDocument;
  }
});

test('storage: full: cached tournaments go first; still full: set says so; blocked: values last in memory', async () => {
  const {storage} = await import('../../web/s/lib/storage.js');
  const values = new Map([
    ['chgk.state.A', '{}'],
    ['chgk.queue.A', '{}'],
  ]);
  let room = 2;
  const backing = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      if (!values.has(k) && values.size >= room) {
        throw new Error('QuotaExceededError');
      }
      values.set(k, v);
    },
    removeItem: (k) => values.delete(k),
    key: (i) => [...values.keys()][i],
    get length() {
      return values.size;
    },
  };
  const s = storage(backing, (key) => key.startsWith('chgk.state.'));
  assert.equal(s.set('chgk.queue.B', [1]), true);
  assert.equal(values.has('chgk.state.A'), false);
  assert.equal(values.has('chgk.queue.A'), true);
  room = 0;
  assert.equal(s.set('chgk.queue.C', [1]), false);
  s.set('chgk.queue.B', undefined);
  assert.equal(values.has('chgk.queue.B'), false);

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError');
    },
  });
  try {
    const blocked = storage();
    blocked.set('k', 1);
    assert.equal(blocked.get('k'), 1);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'localStorage', descriptor);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test('queue: a mark the phone could not save is reported, and clears once saving works', () => {
  let ok = false;
  const q = new Queue({storage: {get: () => null, set: () => ok}, key: 'q', send: async () => ({results: []})});
  q.add({scan_id: 'a'});
  assert.equal(q.status.unsaved, true);
  ok = true;
  q.add({scan_id: 'b'});
  assert.equal(q.status.unsaved, false);
});

test('camera: «Чья карточка?» closed with nothing read: the card in view is no new scan', () => {
  const reported = [];
  const cam = new Camera({}, (text) => reported.push(text));
  cam.seen('A', performance.now());
  cam.forgetLast();
  cam.restoreLast();
  cam.seen('A', performance.now());
  assert.deepEqual(reported, ['A']);
  cam.forgetLast();
  cam.seen('B', performance.now()); // read during the lookup: it stays the last
  cam.restoreLast();
  assert.equal(cam.last.text, 'B');
});

test('lookup: an unreadable cell or an unnamed reserve deck is a warning, not «ok»', () => {
  const teams = [
    {team_id: 'A01', name: 'А'},
    {team_id: 'R1', name: 'R1', reserve: true, on_tabs: false},
  ];
  const s = new Session({
    tid: 'T',
    state: {tournament: {name: 'T', round_sizes: [3]}, teams, marks: {A01: ['!', '', '']}},
  });
  assert.equal(identify('x#T.A01.1', s).tone, 'warn');
  assert.equal(identify('x#T.A01.2', s).tone, 'ok');
  assert.equal(identify('x#T.R1.1', s).tone, 'warn');
});

test('forgetLocalData: cached data goes, unsent marks stay', async () => {
  const {forgetLocalData, K, store} = await import('../../web/s/ui/state.js');
  store.set(K.state('Z'), {});
  store.set(K.current('Z'), 3);
  store.set(K.photographed('Z'), ['a']);
  store.set(K.queue('Z'), {pending: [{scan_id: 'a'}], rejected: []});
  store.set(K.juror, 'Анна');
  forgetLocalData('Z');
  assert.equal(store.get(K.juror), null); // the next person's marks must not carry it
  assert.equal(store.get(K.state('Z')), null);
  assert.equal(store.get(K.photographed('Z')), null);
  assert.equal(store.get(K.queue('Z')).pending.length, 1);
  store.set(K.queue('Z'), {pending: [], rejected: []});
  forgetLocalData('Z');
  assert.equal(store.get(K.queue('Z')), null);
});

test('camera: a restart counts decoder failures afresh, and a first start that fails is not wanted', async () => {
  const camera = Object.create(Camera.prototype);
  Object.assign(camera, {wanted: false, starting: null, failures: 40});
  camera.open = async () => {
    throw new Error('denied');
  };
  await assert.rejects(camera.start());
  assert.equal(camera.failures, 0);
  assert.equal(camera.wanted, false);
  camera.wanted = true; // it ran: an interruption is worth another try when the juror comes back
  await assert.rejects(camera.start());
  assert.equal(camera.wanted, true);
});

test('camera: stopped while it was starting, it does not come on', async () => {
  let granted;
  const track = {readyState: 'live', stop() {}};
  globalThis.navigator ??= {};
  const devices = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            granted = () => resolve({getTracks: () => [track]});
          }),
      },
    },
  });
  const camera = Object.create(Camera.prototype);
  Object.assign(camera, {
    wanted: false,
    starting: null,
    running: false,
    failures: 0,
    last: {text: null, seenAt: 0},
    video: {},
  });
  camera.loop = () => assert.fail('it must not scan');
  const starting = camera.start();
  await new Promise((r) => setTimeout(r, 0));
  camera.stop();
  granted();
  await starting;
  if (devices) {
    Object.defineProperty(globalThis, 'navigator', devices);
  }
  assert.equal(camera.running, false);
});
