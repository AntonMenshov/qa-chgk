// One read and one write per request (Sheets API), the SpreadsheetApp fallback, timings.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadBackend} from './fake_apps_script.mjs';
import {TID, JURY, TEAMS, seq, ev, photo, apiWorld} from './backend_world.mjs';

test('record_events, get_state and get_board read once; record_events writes once', () => {
  const {b, admin, calls, tab} = apiWorld();
  const post = (events) => calls(() => b.post({action: 'record_events', tid: TID, token: JURY, events}));
  // Marks, Meta, Log and «Спорные» in one write, whatever the batch holds.
  let c = post([
    ev({question: 1, status: 'received'}),
    ev({team_id: 'A02', question: 2, status: 'disputed', photo: 'p.jpg'}),
  ]);
  assert.deepEqual([c.result.ok, c.reads, c.writes], [true, 1, 1]);
  assert.ok(b.$.api.batches.at(-1) >= 6);
  assert.equal(tab('Спорные').get(2, 4), 'p.jpg');
  const third = ev({question: 3, status: 'correct'});
  c = post([third]);
  assert.deepEqual([c.reads, c.writes], [1, 1]);
  c = post([third]); // the phone retries: a duplicate, read only
  assert.deepEqual([c.reads, c.writes], [1, 0]);
  assert.deepEqual(
    [
      calls(() => b.post({action: 'get_state', tid: TID, token: JURY})).reads,
      calls(() => b.post({action: 'get_board', tid: TID, token: JURY})).reads,
    ],
    [1, 1],
  );
  assert.equal(calls(() => b.post({action: 'get_state', tid: TID, token: JURY})).writes, 0);
  // RAW writes store text as given: a formatted Log time, and text that looks like a number
  // (team ID 645, a team called «42»), which SpreadsheetApp would turn into numbers.
  assert.match(tab('Log').get(2, 1), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  b.post({action: 'set_teams', tid: TID, token: admin, teams: [...TEAMS, {team_id: '645', name: '42'}]});
  b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({team_id: '645', question: 6, status: 'disputed'})],
  });
  const log = tab('Log');
  assert.equal(log.get(log.getLastRow(), 7), '645');
  const d = tab('Спорные');
  const row = Array.from({length: d.getLastRow()}, (_, i) => d.row(i + 1, 3)).find((r) => r[1] === 6);
  assert.equal(row[2], '42');
  // A reserve deck's photo is accepted before its first mark.
  assert.equal(
    b.post({action: 'upload_photo', tid: TID, token: JURY, ...photo({team_id: 'R1', question: 1})}).ok,
    true,
  );
});

test('a failing Sheets API (quota: 60 calls a minute per account) falls back: the marks still go in', () => {
  const {b, tab} = apiWorld();
  b.$.api.fail = true;
  const mark = ev({team_id: 'A02', question: 4});
  const res = b.post({action: 'record_events', tid: TID, token: JURY, events: [mark]});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(tab('Тур 2').get(tab('Тур 2').rowOf('A02'), 3), 1);
  assert.equal(b.post({action: 'get_board', tid: TID, token: JURY}).marks.A02[3], 1);
  b.$.api.fail = false;
  // Seen by the next request: the scan ID is known, so a retry from the phone is a duplicate.
  const again = b.post({action: 'record_events', tid: TID, token: JURY, events: [mark]});
  assert.equal(again.results[0].duplicate, true);
});

test('the Log grows past the grid: one slow write adds room, then the API writes again', () => {
  const {b, tab, calls} = apiWorld();
  const log = tab('Log');
  for (let r = 2; r <= 1000; r++) {
    log.set(r, 3, `old-${r}`);
  } // a full game's worth of rows
  const c = calls(() => b.post({action: 'record_events', tid: TID, token: JURY, events: [ev({question: 2})]}));
  assert.equal(c.result.ok, true);
  assert.equal(log.get(1001, 3), `s${seq}`);
  assert.ok(log.getMaxRows() >= 2000);
  const before = b.$.api.batches.length;
  b.post({action: 'record_events', tid: TID, token: JURY, events: [ev({question: 3})]});
  assert.equal(b.$.api.batches.length, before + 1); // the API write went through this time
  assert.equal(log.get(1002, 3), `s${seq}`);
});

test('every reply says how long each step took; the steps add up to the total', () => {
  const {b} = apiWorld();
  const res = b.post({action: 'record_events', tid: TID, token: JURY, events: [ev({question: 2, status: 'disputed'})]});
  const t = res.timing;
  for (const step of ['access', 'lock', 'read', 'write', 'rest', 'total']) {
    assert.equal(typeof t[step], 'number', step);
    assert.ok(t[step] >= 0, step);
  }
  assert.equal(t.open, undefined); // a plain mark doesn't open the spreadsheet
  const steps = Object.keys(t).filter((k) => k !== 'total');
  assert.equal(
    steps.reduce((sum, k) => sum + t[k], 0),
    t.total,
  );
  // A read-only request: no lock, no write; the slow path shows up under its own name.
  const board = b.post({action: 'get_board', tid: TID, token: JURY}).timing;
  assert.deepEqual([board.lock, board.write, typeof board.read], [undefined, undefined, 'number']);
  b.$.api.fail = true;
  const slow = b.post({action: 'get_board', tid: TID, token: JURY}).timing;
  assert.equal(typeof slow.read_fallback, 'number');
  b.$.api.fail = false;
  // Errors carry no timing.
  assert.equal(b.post({action: 'get_board', tid: TID, token: 'wrong-token-0000000'}).timing, undefined);
});

test('ping says whether the Sheets API service is on', () => {
  for (const on of [true, false]) {
    const b = loadBackend({sheetsApi: on});
    b.setup();
    assert.equal(b.post({action: 'ping', token: b.$.props.get('ADMIN_TOKEN')}).sheets_api, on);
  }
});
