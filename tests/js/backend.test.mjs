// The backend (apps_script/) on the fake Apps Script world: setup, tournaments, marks,
// jury edits in the Sheet, teams and reserve decks, the board, sharing.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadBackend} from './fake_apps_script.mjs';
import {L, TID, JURY, TEAMS, world, ev, reserveWorld, ascii} from './backend_world.mjs';

test('setup creates an admin token once and prints the CLI command', () => {
  const b = loadBackend();
  b.setup();
  const token = b.$.props.get('ADMIN_TOKEN');
  b.setup();
  assert.equal(b.$.props.get('ADMIN_TOKEN'), token);
  assert.ok(token.length >= 32);
  assert.match(b.logged[0].join(' '), /chgk backend add/);
});

test('setup asks for every permission; ping reports a missing one', () => {
  const b = loadBackend({allScopes: false});
  b.setup();
  assert.deepEqual(b.$.scopeRequests, ['FULL']);
  const admin = b.$.props.get('ADMIN_TOKEN');
  assert.equal(b.post({action: 'ping', token: admin}).authorized, false);
  const ok = loadBackend();
  ok.setup();
  assert.equal(ok.post({action: 'ping', token: ok.$.props.get('ADMIN_TOKEN')}).authorized, true);
});

test('setup never prints the owner-only /dev URL', () => {
  const b = loadBackend({serviceUrl: 'https://script.google.com/macros/s/AKfycbDEV/dev'});
  b.setup();
  const printed = b.logged[0].join(' ');
  assert.doesNotMatch(printed, /\/dev/);
  assert.match(printed, /<Web app URL ending in \/exec>/);
});

test('doGet is a health check; bad JSON and bad tokens are refused', () => {
  const b = loadBackend();
  b.setup();
  assert.equal(JSON.parse(b.doGet().text).service, 'chgk');
  assert.match(b.doPost({postData: {contents: '{oops'}}).json().error, /not JSON/);
  assert.match(b.post({action: 'ping', token: 'wrong'}).error, /forbidden/);
  assert.equal(b.post({action: 'ping', token: b.$.props.get('ADMIN_TOKEN')}).account, 'me@gmail.com');
  assert.match(b.post({action: 'get_state', tid: TID, token: JURY}).error, /unknown tournament/);
});

test('create_tournament builds every tab and is idempotent for the same jury token', () => {
  const {b, admin, ss, tab} = world();
  assert.deepEqual(
    ss.getSheets().map((s) => s.getName()),
    ['Итоги', 'Тур 1', 'Тур 2', 'Статистика', 'Спорные', 'Teams', 'Log', 'Settings', 'Meta'],
  );
  assert.equal(tab('Meta').hidden, true);
  assert.deepEqual(tab('Итоги').row(1, 6), ['ID', 'Команда', 'Тур 1', 'Тур 2', 'Итого', 'Место']);
  assert.deepEqual(tab('Итоги').row(3, 6), [
    'A02',
    'Фиаско',
    "=IFERROR(INDEX('Тур 1'!$F:$F,MATCH($A3,'Тур 1'!$A:$A,0)),0)",
    "=IFERROR(INDEX('Тур 2'!$F:$F,MATCH($A3,'Тур 2'!$A:$A,0)),0)",
    '=SUM(C3:D3)',
    L.placeFormula('E', 3),
  ]);
  // Round tabs keep the continuous question numbers.
  assert.deepEqual(tab('Тур 1').row(1, 6), ['ID', 'Команда', 1, 2, 3, 'Сумма']);
  assert.deepEqual(tab('Тур 2').row(1, 6), ['ID', 'Команда', 4, 5, 6, 'Сумма']);
  assert.deepEqual(tab('Тур 2').row(3, 6), ['A02', 'Фиаско', '', '', '', '=COUNTIF(C3:E3,1)']);
  assert.deepEqual(tab('Meta').row(1, 7), ['team_id', 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(tab('Meta').row(3, 1), ['A02']);
  assert.deepEqual(tab('Teams').row(3, 4), ['A02', 'Фиаско', 'Бостон', '']);
  assert.equal(tab('Статистика').getLastRow(), 7);
  assert.deepEqual(tab('Статистика').row(5, 3), [4, 2, "=COUNTIF('Тур 2'!C$2:C,1)"]);
  assert.deepEqual(tab('Спорные').row(1, 8), ['Тур', 'Вопрос', 'Команда', 'Фото', '', '', 'Всего «?»', 0]);
  assert.deepEqual(b.$.triggers, ['onSheetEdit']);
  assert.equal(b.$.root.children[0].name, 'CHGK');

  const again = b.post({
    action: 'create_tournament',
    token: admin,
    tid: TID,
    name: 'Кубок',
    date: '2026-11-15',
    round_sizes: [3, 3],
    jury_token: JURY,
    board_token: 'boardTOKEN_0123456789ab',
    teams: TEAMS,
  });
  assert.equal(again.existed, true);
  const clash = b.post({
    action: 'create_tournament',
    token: admin,
    tid: TID,
    name: 'Кубок',
    date: '2026-11-15',
    round_sizes: [3, 3],
    jury_token: 'another-token-000000',
    board_token: 'boardTOKEN_0123456789ab',
    teams: TEAMS,
  });
  assert.match(clash.error, /already exists/);
});

test('round tabs: narrow centred question columns, a tint per round, a thick line before the sum', () => {
  const {tab} = world({roundSizes: [3, 3, 2]});
  const r1 = tab('Тур 1'); // C-E questions, F Сумма
  assert.deepEqual(
    [3, 4, 5].map((c) => r1.widths.get(c)),
    [28, 28, 28],
  );
  assert.ok(r1.widths.get(2) > 100);
  assert.equal(r1.align.get('5,4'), 'center');
  assert.equal(r1.leftBorders.get('500,6'), 'SOLID_MEDIUM');
  assert.equal(r1.leftBorders.get('2,4'), undefined);
  const tints = ['Тур 1', 'Тур 2', 'Тур 3'].map((n) => tab(n).tabColor);
  assert.equal(tints[0], tints[2]);
  assert.notEqual(tints[0], tints[1]);
  assert.equal(r1.backgrounds.get('1,3'), tints[0]);
  // «Итоги»: each round's column has that round's colour; a line before Итого (F).
  const sum = tab('Итоги');
  assert.deepEqual(
    [3, 4, 5].map((c) => sum.backgrounds.get(`1,${c}`)),
    tints,
  );
  assert.equal(sum.leftBorders.get('10,6'), 'SOLID_MEDIUM');
});

test('set_teams re-applies the formatting', () => {
  const {b, admin, tab} = world();
  tab('Тур 1').widths.clear();
  b.post({action: 'set_teams', tid: TID, token: admin, teams: TEAMS});
  assert.equal(tab('Тур 1').widths.get(3), 28);
});

test('a wide tournament (8 × 15 questions) fits: Meta grows past 26 columns', () => {
  const {tab} = world({roundSizes: new Array(8).fill(15)});
  assert.equal(tab('Итоги').get(1, 2 + 8 + 2), 'Место');
  assert.equal(tab('Тур 8').get(1, 3), 106);
  assert.ok(tab('Meta').getMaxColumns() >= 121);
});

test('record_events writes marks to the round tabs, timestamps and the log; duplicates and bad events are reported', () => {
  const {b, tab} = world();
  const now = Date.now();
  const res = b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [
      ev({scan_id: 'r1', status: 'received', question: 2, client_ts: now - 3000, juror: 'Анна', device: 'iphone'}),
      ev({scan_id: 'j1', status: 'incorrect', question: 2, client_ts: now - 2000}),
      ev({scan_id: 'j2', status: 'disputed', team_id: 'A02', question: 6, client_ts: now - 2000, spare: 1}),
      ev({scan_id: 'bad', team_id: 'Z99'}),
    ],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.results.map((r) => [r.scan_id, r.applied, Boolean(r.error)]),
    [
      ['r1', true, false],
      ['j1', true, false],
      ['j2', true, false],
      ['bad', false, true],
    ],
  );
  assert.equal(tab('Тур 1').get(2, 4), 0); // A01 q2
  assert.equal(tab('Тур 2').get(3, 5), '?'); // A02 q6
  assert.equal(tab('Meta').get(2, 1 + 2), now - 2000); // A01 q2
  assert.equal(tab('Meta').get(3, 1 + 6), now - 2000); // A02 q6
  assert.equal(tab('Log').getLastRow(), 4); // header + 3 valid events
  assert.deepEqual(tab('Log').row(2, 12).slice(2, 12), [
    'r1',
    'app',
    'Анна',
    'iphone',
    'A01',
    2,
    '',
    'received',
    'R',
    true,
  ]);

  // Retried request: everything is a duplicate, nothing is logged twice.
  const retry = b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({scan_id: 'j1', status: 'incorrect', question: 2})],
  });
  assert.equal(retry.results[0].duplicate, true);
  assert.equal(tab('Log').getLastRow(), 4);

  // Re-scanning a judged card does not undo the judgement.
  b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({status: 'received', question: 2, client_ts: now})],
  });
  assert.equal(tab('Тур 1').get(2, 4), 0);
});

test("rows are found by team ID: sorting a round tab doesn't misplace marks", () => {
  const {b, tab} = world();
  const r2 = tab('Тур 2');
  // The jury sorts «Тур 2» so that A02 comes first.
  const [row2, row3] = [r2.row(2, 6), r2.row(3, 6)];
  row3.forEach((v, c) => r2.set(2, c + 1, v));
  row2.forEach((v, c) => r2.set(3, c + 1, v));
  b.post({action: 'record_events', tid: TID, token: JURY, events: [ev({team_id: 'A02', question: 4})]});
  assert.deepEqual(r2.row(2, 3), ['A02', 'Фиаско', 1]); // and A02 now leads «Тур 2»
  assert.deepEqual(r2.row(3, 3), ['A01', '42', '']);
  assert.deepEqual(b.post({action: 'get_state', tid: TID, token: JURY}).marks.A02, ['', '', '', 1, '', '']);
});

test('record_events needs the jury (or admin) token', () => {
  const {b, admin} = world();
  assert.match(b.post({action: 'record_events', tid: TID, token: 'nope', events: [ev()]}).error, /forbidden/);
  assert.equal(b.post({action: 'record_events', tid: TID, token: admin, events: [ev()]}).ok, true);
});

test('get_state returns teams and marks for the scanner', () => {
  const {b} = world();
  b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({question: 3}), ev({team_id: 'A02', question: 5})],
  });
  const state = b.post({action: 'get_state', tid: TID, token: JURY});
  assert.deepEqual(state.tournament.round_sizes, [3, 3]);
  assert.deepEqual(
    state.teams.map((t) => t.team_id),
    ['A01', 'A02'],
  );
  assert.deepEqual(state.marks.A01, ['', '', 1, '', '', '']);
  assert.deepEqual(state.marks.A02, ['', '', '', '', 1, '']);
});

test('set_teams adds rows on every tab for new teams and renames changed ones', () => {
  const {b, admin, tab} = world();
  const res = b.post({
    action: 'set_teams',
    tid: TID,
    token: admin,
    teams: [
      {team_id: 'A01', name: '42 (новое имя)'},
      {team_id: 'A02', name: 'Фиаско'},
      {team_id: 'A03', name: 'Совхоз Победа'},
    ],
  });
  assert.deepEqual([res.appended, res.renamed], [1, 1]);
  for (const name of ['Итоги', 'Тур 1', 'Тур 2']) {
    const t = tab(name);
    assert.equal(t.get(t.rowOf('A01'), 2), '42 (новое имя)', name);
    assert.equal(t.get(t.rowOf('A03'), 2), 'Совхоз Победа', name);
  }
  const s3 = tab('Итоги').rowOf('A03');
  assert.equal(tab('Итоги').get(s3, 5), `=SUM(C${s3}:D${s3})`);
  const r3 = tab('Тур 2').rowOf('A03');
  assert.equal(tab('Тур 2').get(r3, 6), `=COUNTIF(C${r3}:E${r3},1)`);
  assert.equal(tab('Meta').rowOf('A03'), 4);
  assert.deepEqual(
    b.post({action: 'get_teams', tid: TID, token: admin}).teams.map((t) => t.team_id),
    ['A01', 'A02', 'A03'],
  );
  // Marks for the new team work straight away.
  assert.equal(
    b.post({action: 'record_events', tid: TID, token: JURY, events: [ev({team_id: 'A03', question: 6})]}).results[0]
      .applied,
    true,
  );
  assert.equal(tab('Тур 2').get(tab('Тур 2').rowOf('A03'), 5), 1);
  assert.deepEqual(tab('Тур 2').ids(), ['A03', 'A01', 'A02']);
});

test('onSheetEdit: jury edits on a round tab are normalised, time-stamped and logged; nonsense gets a note', () => {
  const {b, tab} = world();
  const r2 = tab('Тур 2');
  r2.set(3, 4, '+'); // A02, question 5
  b.onSheetEdit({range: r2.getRange(3, 4), user: {getEmail: () => 'judge@gmail.com'}});
  assert.equal(r2.get(r2.rowOf('A02'), 4), 1);
  assert.equal(r2.rowOf('A02'), 2); // sorted to the top of «Тур 2»
  assert.ok(tab('Meta').get(tab('Meta').rowOf('A02'), 1 + 5) > 0);
  assert.deepEqual(tab('Log').row(2, 11).slice(3, 11), ['sheet', 'judge@gmail.com', '', 'A02', 5, '', 'correct', 1]);

  const a01 = r2.rowOf('A01');
  r2.set(a01, 3, 'maybe');
  b.onSheetEdit({range: r2.getRange(a01, 3)});
  assert.match(r2.notes.get(`${r2.rowOf('A01')},3`), /Непонятное/);
  assert.equal(r2.get(r2.rowOf('A01'), 3), 'maybe');
  assert.equal(tab('Log').getLastRow(), 2);

  // Names, sums, headers and other tabs are ignored.
  b.onSheetEdit({range: r2.getRange(2, 2)});
  b.onSheetEdit({range: r2.getRange(2, 6)});
  b.onSheetEdit({range: r2.getRange(1, 3)});
  b.onSheetEdit({range: tab('Итоги').getRange(2, 3)});
  assert.equal(tab('Log').getLastRow(), 2);

  // A later app event older than the jury's edit does not overwrite it.
  b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({team_id: 'A02', status: 'incorrect', question: 5, client_ts: Date.now() - 3600000})],
  });
  assert.equal(r2.get(r2.rowOf('A02'), 4), 1);
});

test('a jury edit is credited to the right team even if a batch re-sorts the tab before the trigger runs', () => {
  const {b, tab} = world({
    teams: [
      {team_id: 'A01', name: '42'},
      {team_id: 'A02', name: 'Фиаско'},
      {team_id: 'A03', name: 'Совхоз Победа'},
    ],
  });
  const r1 = tab('Тур 1');
  // The juror types «+» for A01, question 1, in row 2 ...
  assert.equal(r1.rowOf('A01'), 2);
  r1.set(2, 3, '+');
  // ... but before the edit trigger runs, a batch from the phone gives A03 two points and
  // re-sorts «Тур 1»: row 2 now holds A03.
  b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({team_id: 'A03', question: 2}), ev({team_id: 'A03', question: 3})],
  });
  assert.equal(r1.rowOf('A03'), 2);
  // The late trigger still points at row 2.
  b.onSheetEdit({range: r1.getRange(2, 3), user: {getEmail: () => 'judge@gmail.com'}});

  const marks = b.post({action: 'get_state', tid: TID, token: JURY}).marks;
  assert.deepEqual(marks.A01.slice(0, 3), [1, '', '']);
  assert.deepEqual(marks.A03.slice(0, 3), ['', 1, 1]);
  const sheetLog = Array.from({length: tab('Log').getLastRow() - 1}, (_, i) => tab('Log').row(i + 2, 8)).filter(
    (r) => r[3] === 'sheet',
  );
  assert.deepEqual(
    sheetLog.map((r) => [r[6], r[7]]),
    [['A01', 1]],
  ); // logged once, for A01
  assert.ok(tab('Meta').get(tab('Meta').rowOf('A01'), 2) > 0);
  assert.equal(tab('Meta').get(tab('Meta').rowOf('A03'), 2), '');
});

test('a jury edit not yet seen by its trigger still beats an older scan that syncs late', () => {
  const {b, tab} = world();
  const r1 = tab('Тур 1');
  // Scanned «?» a while ago.
  b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({status: 'disputed', question: 1, client_ts: Date.now() - 600000})],
  });
  // The jury decides «1» in the Sheet; its trigger has not run yet ...
  r1.set(r1.rowOf('A01'), 3, 1);
  // ... when a phone that was offline sends an «incorrect» it scanned before the decision.
  b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({status: 'incorrect', question: 1, client_ts: Date.now() - 60000})],
  });
  assert.equal(r1.get(r1.rowOf('A01'), 3), 1);
  const log = Array.from({length: tab('Log').getLastRow() - 1}, (_, i) => tab('Log').row(i + 2, 12));
  assert.deepEqual(
    log.map((r) => [r[3], r[9], r[11]]),
    [
      ['app', 'disputed', true],
      ['sheet', 'correct', true],
      ['app', 'incorrect', false],
    ],
  );
});

test('a scan synced late does not refill a cell the jury cleared after it', () => {
  const {b, tab} = world();
  const r1 = tab('Тур 1');
  const scannedAt = Date.now() - 600000;
  b.post({action: 'record_events', tid: TID, token: JURY, events: [ev({question: 1, status: 'correct'})]});
  r1.set(r1.rowOf('A01'), 3, ''); // the jury clears the mark: a decision
  b.onSheetEdit({range: r1.getRange(r1.rowOf('A01'), 3, 1, 1), user: null});
  const late = ev({question: 1, status: 'received', client_ts: scannedAt});
  const reply = b.post({action: 'record_events', tid: TID, token: JURY, events: [late]});
  assert.equal(reply.results[0].applied, false);
  assert.equal(r1.get(r1.rowOf('A01'), 3), '');
  const again = ev({question: 1, status: 'received', client_ts: Date.now() + 1000});
  b.post({action: 'record_events', tid: TID, token: JURY, events: [again]});
  assert.equal(r1.get(r1.rowOf('A01'), 3), 'R'); // scanned again after the clear: it counts
});

test("an event whose team row is gone from its round's tab is refused alone; the batch goes in", () => {
  const {b, tab} = world();
  const r2 = tab('Тур 2');
  const row = r2.rowOf('A02');
  for (let col = 1; col <= 26; col++) {
    r2.set(row, col, ''); // the jury deletes A02's row on «Тур 2»
  }
  const reply = b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({team_id: 'A01', question: 1}), ev({team_id: 'A02', question: 4}), ev({team_id: 'A02', question: 1})],
  });
  assert.equal(reply.ok, true);
  assert.deepEqual(
    reply.results.map((r) => [r.applied, r.error || '']),
    [
      [true, ''],
      [false, "no row for A02 on its round's tab"],
      [true, ''],
    ],
  );
  assert.equal(tab('Тур 1').get(tab('Тур 1').rowOf('A01'), 3), 1); // ev() is «correct» by default
});

test('a mark pasted over several cells is picked up for every team', () => {
  const {b, tab} = world();
  const r1 = tab('Тур 1');
  [
    [2, 3],
    [2, 4],
    [3, 3],
  ].forEach(([r, c]) => r1.set(r, c, '1'));
  b.onSheetEdit({range: r1.getRange(2, 3, 2, 2)});
  const marks = b.post({action: 'get_state', tid: TID, token: JURY}).marks;
  assert.deepEqual(
    [marks.A01.slice(0, 2), marks.A02.slice(0, 2)],
    [
      [1, 1],
      [1, ''],
    ],
  );
  assert.equal(tab('Log').getLastRow(), 4);
});

test('reserve teams wait on the Teams tab: not on «Итоги», round tabs or Meta, not in the places', () => {
  const {b, tab} = reserveWorld();
  assert.deepEqual(tab('Teams').row(4, 5), ['R1', '', '', '', 'да']);
  assert.deepEqual(tab('Teams').row(5, 5), ['R2', '', '', '', 'да']);
  for (const name of ['Итоги', 'Тур 1', 'Тур 2', 'Meta']) {
    assert.deepEqual(tab(name).ids(), ['A01', 'A02'], name);
  }
  const state = b.post({action: 'get_state', tid: TID, token: JURY});
  assert.deepEqual(
    state.teams.map((t) => [t.team_id, t.name, t.reserve]),
    [
      ['A01', '42', false],
      ['A02', 'Фиаско', false],
      ['R1', 'R1 · впишите название', true],
      ['R2', 'R2 · впишите название', true],
    ],
  );
  assert.deepEqual(state.marks.R1, ['', '', '', '', '', '']);
  b.post({action: 'record_events', tid: TID, token: JURY, events: [ev({question: 1})]});
  assert.deepEqual(
    b.post({action: 'get_results', tid: TID, token: JURY}).standings.map((r) => [r.team_id, r.place]),
    [
      ['A01', 1],
      ['A02', 2],
    ],
  ); // an unused reserve does not share last place
});

test("a reserve team's first scan puts it on every tab with a placeholder name", () => {
  const {b, tab} = reserveWorld();
  const res = b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({team_id: 'R1', question: 2}), ev({team_id: 'R2', question: 99})],
  }); // R2's event is invalid
  assert.deepEqual(
    res.results.map((r) => r.applied),
    [true, false],
  );
  assert.equal(res.results[1].error, 'invalid question'); // not «unknown team»: R2 is a known reserve
  for (const name of ['Итоги', 'Тур 1', 'Тур 2', 'Meta']) {
    assert.ok(tab(name).ids().includes('R1'), name);
  }
  for (const name of ['Итоги', 'Тур 1']) {
    assert.ok(!tab(name).ids().includes('R2'), name);
  }
  const t1 = tab('Тур 1');
  assert.deepEqual(t1.row(t1.rowOf('R1'), 4), ['R1', 'R1 · впишите название', '', 1]);
  assert.equal(tab('Teams').get(4, 2), 'R1 · впишите название');
  assert.deepEqual(
    b.post({action: 'get_results', tid: TID, token: JURY}).standings.map((r) => [r.team_id, r.total, r.place]),
    [
      ['R1', 1, 1],
      ['A01', 0, '2-3'],
      ['A02', 0, '2-3'],
    ],
  );
});

test('the jury types the real name over the placeholder on «Итоги»: every tab and Teams follow', () => {
  const {b, tab} = reserveWorld();
  b.post({action: 'record_events', tid: TID, token: JURY, events: [ev({team_id: 'R1', question: 2})]});
  const sum = tab('Итоги');
  const row = sum.rowOf('R1');
  sum.write(row, 2, 'Новенькие');
  b.onSheetEdit({range: sum.getRange(row, 2)});
  for (const name of ['Итоги', 'Тур 1', 'Тур 2']) {
    assert.equal(tab(name).get(tab(name).rowOf('R1'), 2), 'Новенькие', name);
  }
  assert.deepEqual(tab('Teams').row(4, 5), ['R1', 'Новенькие', '', '', 'да']);
  assert.equal(
    b.post({action: 'get_state', tid: TID, token: JURY}).teams.find((t) => t.team_id === 'R1').name,
    'Новенькие',
  );
});

test('a name typed on a round tab is matched by ID even if the tab was re-sorted before the trigger ran', () => {
  const {b, tab} = reserveWorld();
  b.post({action: 'record_events', tid: TID, token: JURY, events: [ev({team_id: 'R1', question: 4})]});
  const t1 = tab('Тур 1');
  const row = t1.rowOf('R1'); // R1 is last on «Тур 1» (0 points there)
  t1.write(row, 2, 'Новенькие');
  // A batch moves A02 to the top of «Тур 1» before the trigger runs.
  b.post({action: 'record_events', tid: TID, token: JURY, events: [ev({team_id: 'A02', question: 1})]});
  b.onSheetEdit({range: t1.getRange(row, 2)});
  for (const name of ['Итоги', 'Тур 1', 'Тур 2', 'Teams']) {
    const t = tab(name);
    assert.equal(t.get(t.rowOf('R1'), 2), 'Новенькие', name);
    assert.equal(t.get(t.rowOf('A02'), 2), 'Фиаско', name);
  }
});

test('a reserve team named on the Teams tab before its first scan joins the tabs with that name', () => {
  const {b, tab} = reserveWorld();
  tab('Teams').write(5, 2, 'Опоздавшие'); // R2
  b.onSheetEdit({range: tab('Teams').getRange(5, 2)});
  for (const name of ['Итоги', 'Тур 1', 'Тур 2']) {
    assert.equal(tab(name).get(tab(name).rowOf('R2'), 2), 'Опоздавшие', name);
  }
  assert.ok(!tab('Итоги').ids().includes('R1'));
});

test('renaming a registered team anywhere renames it everywhere; a cleared name is put back', () => {
  const {b, tab} = reserveWorld();
  const t2 = tab('Тур 2');
  t2.write(t2.rowOf('A02'), 2, 'Фиаско-2');
  b.onSheetEdit({range: t2.getRange(t2.rowOf('A02'), 2)});
  for (const name of ['Итоги', 'Тур 1', 'Тур 2', 'Teams']) {
    assert.equal(tab(name).get(tab(name).rowOf('A02'), 2), 'Фиаско-2', name);
  }
  const sum = tab('Итоги');
  sum.write(sum.rowOf('A01'), 2, '');
  b.onSheetEdit({range: sum.getRange(sum.rowOf('A01'), 2)});
  assert.equal(sum.get(sum.rowOf('A01'), 2), '42');
  // «42» typed as a name stays text.
  sum.write(sum.rowOf('A02'), 2, '42');
  b.onSheetEdit({range: sum.getRange(sum.rowOf('A02'), 2)});
  assert.equal(tab('Тур 1').get(tab('Тур 1').rowOf('A02'), 2), '42');
});

test('set_teams keeps reserve rows and the names the jury gave them', () => {
  const {b, admin, tab} = reserveWorld();
  b.post({action: 'record_events', tid: TID, token: JURY, events: [ev({team_id: 'R1', question: 2})]});
  const sum = tab('Итоги');
  sum.write(sum.rowOf('R1'), 2, 'Новенькие');
  b.onSheetEdit({range: sum.getRange(sum.rowOf('R1'), 2)});
  b.post({action: 'set_teams', tid: TID, token: admin, teams: [...TEAMS, {team_id: 'A03', name: 'Совхоз Победа'}]});
  assert.deepEqual(tab('Teams').ids(), ['A01', 'A02', 'A03', 'R1', 'R2']);
  assert.deepEqual(tab('Teams').row(tab('Teams').rowOf('R1'), 5), ['R1', 'Новенькие', '', '', 'да']);
  const teams = b.post({action: 'get_teams', tid: TID, token: admin}).teams;
  assert.deepEqual(
    teams.filter((t) => t.reserve).map((t) => t.team_id),
    ['R1', 'R2'],
  );
});

test('reserve IDs are checked', () => {
  const b = loadBackend();
  b.setup();
  const admin = b.$.props.get('ADMIN_TOKEN');
  const create = (reserve) =>
    b.post({
      action: 'create_tournament',
      token: admin,
      tid: TID,
      name: 'Кубок',
      date: '2026-11-15',
      round_sizes: [3],
      jury_token: JURY,
      board_token: 'boardTOKEN_0123456789ab',
      teams: TEAMS,
      reserve,
    });
  assert.match(create(['A01']).error, /already used/);
  assert.match(create(['R1', 'R1']).error, /already used/);
  assert.match(create(['r1']).error, /invalid reserve/);
  assert.match(create('R1').error, /list/);
});

test('a trashed CHGK folder is not reused: new tournaments go to a fresh one', () => {
  const {b, admin} = world();
  const first = b.$.root.children[0];
  assert.equal(first.children.length, 1);
  first.trashed = true; // the organiser cleaned up Drive
  const res = b.post({
    action: 'create_tournament',
    token: admin,
    tid: 'Z2345',
    name: 'Кубок',
    date: '2026-11-16',
    round_sizes: [3],
    jury_token: JURY,
    board_token: 'boardTOKEN_0123456789ab',
    teams: TEAMS,
  });
  assert.equal(res.ok, true);
  assert.equal(b.$.root.children.length, 2);
  assert.equal(first.children.length, 1);
  assert.equal(b.$.root.children[1].children[0].name, '2026-11-16 Kubok (Z2345)');
});

test('Drive gets Latin names only: CHGK / <date> <name> (<TID>) with Photos and the Sheet; tabs stay Russian', () => {
  const {b, ss, tab} = world();
  const root = b.$.root.children[0];
  const folder = root.children[0];
  assert.deepEqual(
    [root.name, folder.name, folder.children.map((f) => f.name), folder.files.map((f) => f.name)],
    ['CHGK', '2026-11-15 Kubok (K7M2Q)', ['Photos'], ['Kubok 2026-11-15 (K7M2Q)', 'Kubok 2026-11-15 (K7M2Q) results']],
  );
  assert.ok([root.name, folder.name, folder.children[0].name, ss.name].every(ascii));
  assert.ok(tab('Итоги') && tab('Тур 1') && tab('Статистика'));
});

test("get_board: the board token reads teams and marks but can't write; unused reserves are left out", () => {
  const b = loadBackend();
  b.setup();
  const admin = b.$.props.get('ADMIN_TOKEN');
  const BOARD = 'board-token-0123456789';
  b.post({
    action: 'create_tournament',
    token: admin,
    tid: TID,
    name: 'Кубок',
    date: '2026-11-15',
    round_sizes: [3, 3],
    jury_token: JURY,
    board_token: BOARD,
    teams: TEAMS,
    reserve: ['R1', 'R2'],
  });
  b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({question: 2}), ev({team_id: 'R1', question: 1})],
  });
  const board = b.post({action: 'get_board', tid: TID, token: BOARD});
  assert.equal(board.ok, true, JSON.stringify(board));
  assert.deepEqual(board.tournament, {name: 'Кубок', date: '2026-11-15', round_sizes: [3, 3]});
  assert.equal(
    board.view_url,
    `https://docs.google.com/spreadsheets/d/${JSON.parse(b.$.props.get(`t:${TID}`)).public_id}/htmlview`,
  );
  assert.deepEqual(
    board.teams.map((t) => t.team_id),
    ['A01', 'A02', 'R1'],
  ); // R2 never played
  assert.deepEqual(board.marks.A01, ['', 1, '', '', '', '']);
  assert.equal(b.post({action: 'get_board', tid: TID, token: JURY}).ok, true);
  assert.match(b.post({action: 'get_board', tid: TID, token: 'board-token-WRONG-0000'}).error, /forbidden/);
  // Read-only: the board token is refused everywhere else.
  assert.match(b.post({action: 'record_events', tid: TID, token: BOARD, events: [ev()]}).error, /forbidden/);
  assert.match(b.post({action: 'get_state', tid: TID, token: BOARD}).error, /forbidden/);
});

test('only the public copy is shared with anyone with the link; the real Sheet stays private', () => {
  const {b} = world();
  const reg = JSON.parse(b.$.props.get(`t:${TID}`));
  assert.equal(b.$.sharing.get(reg.public_id), 'ANYONE_WITH_LINK:VIEW');
  assert.equal(b.$.sharing.get(reg.spreadsheet_id), undefined);
  assert.match(b.post({action: 'share_view', tid: TID, token: JURY}).error, /unknown action/); // no such action: sharing is part of create_tournament
});

test('only «Итоги», the round tabs and «Статистика» are visible (the view-only link shows visible tabs only)', () => {
  const {b, admin} = world();
  const ss = b.$.spreadsheets.get(JSON.parse(b.$.props.get(`t:${TID}`)).spreadsheet_id);
  const visible = () =>
    ss
      .getSheets()
      .filter((s) => !s.isSheetHidden())
      .map((s) => s.getName());
  assert.deepEqual(visible(), ['Итоги', 'Тур 1', 'Тур 2', 'Статистика']);
  // The backend works with the hidden tabs.
  assert.equal(b.post({action: 'record_events', tid: TID, token: JURY, events: [ev({question: 1})]}).ok, true);
  assert.equal(b.post({action: 'set_teams', tid: TID, token: admin, teams: TEAMS}).ok, true);
  assert.ok(ss.getSheetByName('Log').getLastRow() > 1);
});

test('set_board_token is gone: the board token is set at creation and changed only by replace_token', () => {
  const {b, admin} = world();
  const NEW = 'new-board-token-abcdefgh';
  assert.match(b.post({action: 'set_board_token', tid: TID, token: admin, board_token: NEW}).error, /unknown action/);
  assert.match(b.post({action: 'get_board', tid: TID, token: NEW}).error, /forbidden/);
});
