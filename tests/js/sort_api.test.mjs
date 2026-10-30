// Sorting «Итоги» and the round tabs in one Sheets API call (sortWithApi_ in sort.js):
// per tab, the team rows are sorted, then the formula columns rewritten. These tests hold
// it to the slow SpreadsheetApp sort, to the Sheet's own rules (logic.js), and check every
// way it hands over to the slow sort.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadBackend} from './fake_apps_script.mjs';
import * as L from '../../apps_script/logic.js';

const TID = 'K7M2Q';
const JURY = 'jury-token-0123456789';
const SIZES = [3, 3, 3];
// Rating numbers and assigned IDs, and a team called «42» (must stay text).
const TEAMS = [
  {team_id: '645', name: '42'},
  {team_id: '58746', name: 'Фиаско'},
  {team_id: '40400', name: 'Совхоз Победа'},
  {team_id: 'A01', name: 'Звезды сошлись'},
  {team_id: 'A02', name: 'Синие зайцы'},
];

function world({sheetsApi = true, teams = TEAMS, sizes = SIZES} = {}) {
  const b = loadBackend({sheetsApi});
  b.setup();
  const admin = b.$.props.get('ADMIN_TOKEN');
  const created = b.post({
    action: 'create_tournament',
    token: admin,
    tid: TID,
    name: 'Кубок',
    date: '2026-11-15',
    round_sizes: sizes,
    jury_token: JURY,
    teams,
    reserve: ['R1', 'R2'],
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const ss = b.$.spreadsheets.get(created.spreadsheet_id);
  let seq = 0;
  const ev = (over) => ({
    scan_id: `e${++seq}`,
    status: 'correct',
    team_id: '645',
    question: 1,
    client_ts: 1700000000000 + seq,
    ...over,
  });
  const post = (events) => {
    const res = b.post({action: 'record_events', tid: TID, token: JURY, events});
    assert.equal(res.ok, true, JSON.stringify(res));
    return res;
  };
  const tab = (name) => ss.getSheetByName(name);
  const registry = () => JSON.parse(b.$.props.get(`t:${TID}`));
  const setRegistry = (reg) => b.$.props.set(`t:${TID}`, JSON.stringify(reg));
  /** A jury edit typed into a round tab, then the onEdit trigger, as in Sheets. */
  const juryEdit = (teamId, q, value) => {
    const at = L.questionCell(sizes, q);
    const sheet = tab(at.name);
    const row = sheet.rowOf(teamId);
    sheet.set(row, at.col, value);
    b.onSheetEdit({range: sheet.getRange(row, at.col), user: {getEmail: () => 'judge@gmail.com'}});
  };
  const appSorts = () => ss.sheets.reduce((n, t) => n + (t.appSorts || 0), 0);
  // create_tournament (and a reserve team's first scan) lay out rows with the slow sort.
  const createdSorts = appSorts();
  return {b, ss, tab, ev, post, registry, setRegistry, juryEdit, appSorts, createdSorts, sizes};
}

const sortTabNames = (sizes) => ['Итоги'].concat(sizes.map((_, i) => `Тур ${i + 1}`));

/** Every stored cell (values and formulas) and note of the tabs the sort touches, plus «Спорные». */
function dump(w) {
  const out = {};
  for (const name of sortTabNames(w.sizes).concat(['Спорные'])) {
    const t = w.tab(name);
    out[name] = {cells: [...t.cells.entries()].sort(), notes: [...t.notes.entries()].sort()};
  }
  return out;
}

/** The checks any sorted Sheet must pass: right order, every row's own formulas, numbers as the reference. */
function assertSorted(w, label = '') {
  const {b, tab, sizes} = w;
  const state = b.post({action: 'get_state', tid: TID, token: JURY});
  const onTabs = new Set(tab('Итоги').ids());
  const ids = state.teams.map((t) => t.team_id).filter((id) => onTabs.has(id));
  const values = {};
  ids.forEach((id) => {
    values[id] = state.marks[id];
  });
  // «Итоги»: the Sheet's order and places, computed by logic.js from the marks alone.
  const ref = L.standings(sizes, ids, values).sort(L.compareStandings);
  assert.deepEqual(
    tab('Итоги').ids(),
    ref.map((r) => r.team_id),
    `${label} «Итоги» order`,
  );
  const results = b.post({action: 'get_results', tid: TID, token: JURY}).standings;
  assert.deepEqual(
    results.map((r) => [r.team_id, r.total, r.place]),
    ref.map((r) => [r.team_id, r.total, r.place]),
    `${label} «Итоги» numbers`,
  );
  const sl = L.summaryLayout(sizes);
  tab('Итоги')
    .ids()
    .forEach((id, i) => {
      const row = i + 2;
      const want = L.summaryRow(sizes, {team_id: id, name: ''}, row).slice(sl.firstRound - 1);
      assert.deepEqual(
        tab('Итоги')
          .row(row, sl.width)
          .slice(sl.firstRound - 1),
        want,
        `${label} «Итоги» row ${row}`,
      );
    });
  // Round tabs: order by «Сумма», then ID; each row's «Сумма» counts its own row.
  sizes.forEach((_, i) => {
    const lay = L.roundLayout(sizes, i + 1);
    const t = tab(lay.name);
    const current = t.ids();
    assert.deepEqual(current, L.roundOrder(sizes, i + 1, current, values), `${label} ${lay.name} order`);
    current.forEach((id, j) => {
      const row = j + 2;
      assert.equal(t.get(row, lay.sumCol), L.roundRow(lay, {team_id: id, name: ''}, row)[lay.sumCol - 1]);
      const took = values[id].slice(lay.first - 1, lay.first - 1 + lay.size).filter((v) => v === 1).length;
      assert.equal(t.value(row, lay.sumCol), took, `${label} ${lay.name} «Сумма» of ${id}`);
    });
  });
}

test('a mark that changes the order: one API call sorts the tabs; no slow sort, the spreadsheet is not opened', () => {
  const w = world();
  const {b, post, ev} = w;
  const before = {updates: b.$.api.updates, opens: b.$.api.opens, sorts: w.appSorts(), gets: b.$.api.gets};
  // 58746 takes question 4: «Тур 2» and «Итоги» are now out of order, «Тур 1» and «Тур 3» are not.
  const res = post([ev({team_id: '58746', question: 4})]);
  assert.equal(b.$.api.updates - before.updates, 1);
  assert.deepEqual(
    [...b.$.api.requests.at(-1)],
    // Per tab: sort, then the formulas. Not before the sort: a formula written earlier in the
    // same call isn't calculated yet when sortRange runs (seen live; the fake does the same).
    ['sortRange', 'updateCells', 'sortRange', 'updateCells'],
  );
  assert.equal(w.appSorts(), before.sorts);
  assert.equal(b.$.api.opens, before.opens);
  assert.equal(b.$.api.sortRanges, 2);
  assert.equal(b.$.api.gets - before.gets, 1); // tab IDs, the first time only
  assert.equal(typeof res.timing.sort, 'number');
  assert.equal(res.timing.sort_range, undefined);
  assert.equal(res.timing.open, undefined);
  assert.equal(w.tab('Тур 2').ids()[0], '58746');
  assert.equal(w.tab('Итоги').ids()[0], '58746');
  assertSorted(w);
});

test('a mark that keeps the order sends no sort call at all', () => {
  const w = world();
  w.post([w.ev({team_id: '40400', question: 1})]); // 40400 first everywhere it counts
  const updates = w.b.$.api.updates;
  w.post([w.ev({team_id: '40400', question: 2})]); // still first
  w.post([w.ev({team_id: 'A02', question: 3, status: 'incorrect'})]); // a 0 changes no sum
  w.post([w.ev({team_id: 'A01', question: 5, status: 'disputed'})]); // nor does «?»
  assert.equal(w.b.$.api.updates, updates);
  assertSorted(w);
});

test('tab IDs are fetched once and kept in the registry', () => {
  const w = world();
  assert.equal(w.registry().sheet_ids, undefined);
  w.post([w.ev({team_id: 'A02', question: 1})]);
  const ids = w.registry().sheet_ids;
  for (const name of sortTabNames(SIZES)) {
    assert.equal(ids[name], w.tab(name).sheetId, name);
  }
  const gets = w.b.$.api.gets;
  w.post([w.ev({team_id: 'A01', question: 4}), w.ev({team_id: 'A01', question: 5})]);
  w.post([
    w.ev({team_id: '645', question: 7}),
    w.ev({team_id: '645', question: 8}),
    w.ev({team_id: '645', question: 9}),
  ]);
  assert.equal(w.b.$.api.gets, gets);
  assertSorted(w);
});

test('a cached tab ID that no longer exists: this sort is done the slow way, the cache is dropped and refilled next time', () => {
  const w = world();
  w.post([w.ev({team_id: 'A02', question: 1})]);
  const reg = w.registry();
  reg.sheet_ids['Тур 2'] = 9999; // e.g. the tab was deleted and made again by hand
  w.setRegistry(reg);
  const sorts = w.appSorts();
  w.post([w.ev({team_id: '58746', question: 4})]);
  assert.ok(w.appSorts() > sorts, 'slow sort used');
  assert.equal(w.registry().sheet_ids, undefined);
  assertSorted(w, 'after the slow sort');
  const gets = w.b.$.api.gets;
  const slow = w.appSorts();
  w.post([w.ev({team_id: 'A01', question: 4}), w.ev({team_id: 'A01', question: 5})]);
  assert.equal(w.b.$.api.gets, gets + 1);
  assert.equal(w.appSorts(), slow, 'back to the API sort');
  assertSorted(w, 'after the API sort');
});

test('the sort call fails (quota): the slow sort gives the same tabs; nothing is lost', () => {
  const fast = world();
  const slow = world();
  slow.b.$.api.failUpdates = true; // reads and value writes still work
  for (const w of [fast, slow]) {
    w.post([w.ev({team_id: 'A02', question: 1}), w.ev({team_id: 'A02', question: 2})]);
    w.post([w.ev({team_id: '58746', question: 4}), w.ev({team_id: '40400', question: 7, status: 'disputed'})]);
  }
  assert.ok(slow.appSorts() > slow.createdSorts);
  assert.equal(fast.appSorts(), fast.createdSorts);
  assert.deepEqual(dump(slow), dump(fast));
  assertSorted(slow);
  assert.equal(slow.registry().sheet_ids, undefined); // dropped after the failed call
});

test('a «Сумма» formula overwritten by hand: the slow sort repairs it before sorting, so the sort uses the real sums', () => {
  const w = world();
  const t1 = w.tab('Тур 1');
  const lay = L.roundLayout(SIZES, 1);
  // Someone typed 99 over A01's «Сумма»: with it, A01 would sort to the top.
  t1.set(t1.rowOf('A01'), lay.sumCol, 99);
  const sorts = w.appSorts();
  w.post([w.ev({team_id: 'A02', question: 1})]); // changes the order of «Тур 1»
  assert.ok(w.appSorts() > sorts, 'the sort keys disagree with the marks: slow sort');
  assert.equal(t1.ids()[0], 'A02');
  assert.notEqual(t1.ids()[0], 'A01');
  assertSorted(w);
});

test('«Итоги» formulas overwritten by hand (Место as a plain RANK) are repaired by the next sort', () => {
  const w = world();
  const sum = w.tab('Итоги');
  const sl = L.summaryLayout(SIZES);
  for (let row = 2; row <= sum.getLastRow(); row++) {
    sum.set(
      row,
      sl.placeCol,
      `=RANK(${L.colLetter(sl.totalCol)}${row},${L.colLetter(sl.totalCol)}$2:${L.colLetter(sl.totalCol)})`,
    );
  }
  w.post([w.ev({team_id: 'A02', question: 1})]);
  for (let row = 2; row <= sum.getLastRow(); row++) {
    assert.equal(sum.get(row, sl.placeCol), L.placeFormula(L.colLetter(sl.totalCol), row));
  }
  assertSorted(w);
});

test('a gap in the team rows (a row cleared by hand): the slow sort, which reads the tab, is used', () => {
  const w = world();
  const t1 = w.tab('Тур 1');
  const lay = L.roundLayout(SIZES, 1);
  // Move the last team of «Тур 1» two rows down, leaving an empty row in between.
  const last = t1.getLastRow();
  for (let c = 1; c <= lay.width; c++) {
    t1.set(last + 2, c, t1.get(last, c));
    t1.set(last, c, '');
  }
  t1.set(last + 2, lay.sumCol, L.roundRow(lay, {team_id: '', name: ''}, last + 2)[lay.sumCol - 1]);
  const sorts = w.appSorts();
  w.post([w.ev({team_id: 'A02', question: 1})]);
  assert.ok(w.appSorts() > sorts);
  assert.deepEqual(t1.ids().length, TEAMS.length);
  assertSorted(w);
});

test('a jury edit in the Sheet (the trigger) sorts with the API too; a Sheet the registry does not know sorts the slow way', () => {
  const w = world();
  w.post([w.ev({team_id: 'A02', question: 1, status: 'disputed'})]);
  const updates = w.b.$.api.updates;
  const sorts = w.appSorts();
  w.juryEdit('A02', 1, '+'); // «?» → 1 moves A02 up
  assert.equal(w.b.$.api.updates, updates + 1);
  assert.equal(w.appSorts(), sorts);
  assert.equal(w.tab('Тур 1').ids()[0], 'A02');
  assertSorted(w, 'trigger, API');

  // The Settings tab names a TID the backend has no registry for (a copied Sheet).
  const settings = w.tab('Settings');
  for (let r = 1; r <= settings.getLastRow(); r++) {
    if (settings.get(r, 1) === 'tid') {
      settings.set(r, 2, 'ZZZZZ');
    }
  }
  w.juryEdit('58746', 4, '1');
  assert.ok(w.appSorts() > sorts);
  assertSorted(w, 'trigger, slow');
});

test('ties: equal sums keep the ID order on round tabs; on «Итоги» the last round decides, places stay shared', () => {
  const w = world();
  // 645 and A01: 1 in round 1 each; 58746: 1 in round 2; totals 1, 1, 1.
  w.post([
    w.ev({team_id: 'A01', question: 2}),
    w.ev({team_id: '645', question: 1}),
    w.ev({team_id: '58746', question: 5}),
  ]);
  assert.deepEqual(w.tab('Тур 1').ids().slice(0, 2), ['645', 'A01']); // string order of the IDs
  assert.deepEqual(w.tab('Итоги').ids().slice(0, 3), ['58746', '645', 'A01']); // better last round first
  const results = w.b.post({action: 'get_results', tid: TID, token: JURY}).standings;
  assert.deepEqual(
    results.slice(0, 3).map((r) => r.place),
    ['1-3', '1-3', '1-3'],
  );
  assertSorted(w);
});

test('text stays text through the sort: a team called «42», IDs like 645', () => {
  const w = world();
  w.post([
    w.ev({team_id: '645', question: 1}),
    w.ev({team_id: '645', question: 4}),
    w.ev({team_id: '645', question: 7}),
  ]);
  for (const name of sortTabNames(SIZES)) {
    const t = w.tab(name);
    const row = t.rowOf('645');
    assert.equal(row, 2, name);
    assert.equal(t.get(row, 1), '645', name);
    assert.equal(t.get(row, 2), '42', name);
  }
});

test('one team: formulas are written, nothing to sort', () => {
  const w = world({teams: [{team_id: 'A01', name: 'Одна'}]});
  w.post([w.ev({team_id: 'A01', question: 1})]);
  assertSorted(w);
  // A second team arrives (reserve R1 scanned), then the order changes: both rows sorted.
  w.post([w.ev({team_id: 'R1', question: 4}), w.ev({team_id: 'R1', question: 5})]);
  assert.deepEqual(w.tab('Итоги').ids(), ['R1', 'A01']);
  assertSorted(w);
});

test("a reserve team's first scan and a re-sort in one request: its new rows are sorted with the API", () => {
  const w = world();
  w.post([w.ev({team_id: 'A02', question: 1})]);
  const updates = w.b.$.api.updates;
  w.post([w.ev({team_id: 'R2', question: 1}), w.ev({team_id: 'R2', question: 2}), w.ev({team_id: 'R2', question: 4})]);
  assert.ok(w.b.$.api.updates > updates);
  assert.equal(w.tab('Итоги').ids()[0], 'R2');
  assert.equal(w.tab('Итоги').ids().length, TEAMS.length + 1); // R1 not used: not on the tabs
  assertSorted(w);
});

test('random tournaments: the one-call sort leaves exactly the same tabs as the slow sort, after every request', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  for (let k = 0; k < 25; k++) {
    const sizes = Array.from({length: 1 + Math.floor(rnd() * 3)}, () => 1 + Math.floor(rnd() * 4));
    const n = sizes.reduce((a, b) => a + b, 0);
    const teams = Array.from({length: 1 + Math.floor(rnd() * 7)}, (_, i) => ({
      team_id: pick([`A${String(i + 1).padStart(2, '0')}`, String(100 + i * 37), `B${i}`]),
      name: pick(['42', `Команда ${i}`, 'Фиаско']),
    })).filter((t, i, all) => all.findIndex((u) => u.team_id === t.team_id) === i);
    const fast = world({sizes, teams});
    const slow = world({sizes, teams, sheetsApi: false});
    const ids = teams.map((t) => t.team_id).concat(['R1']);
    for (let step = 0; step < 8; step++) {
      const events = Array.from({length: 1 + Math.floor(rnd() * 4)}, () => ({
        team_id: pick(ids),
        question: 1 + Math.floor(rnd() * n),
        status: pick(['correct', 'correct', 'incorrect', 'disputed', 'received']),
      }));
      const edit =
        rnd() < 0.3
          ? {teamId: pick(teams).team_id, q: 1 + Math.floor(rnd() * n), value: pick(['1', '0', '+', '?'])}
          : null;
      for (const w of [fast, slow]) {
        w.post(events.map((e) => w.ev(e)));
        if (edit) {
          w.juryEdit(edit.teamId, edit.q, edit.value);
        }
      }
      assert.deepEqual(dump(fast), dump(slow), `tournament ${k}, step ${step}`);
    }
    assertSorted(fast, `tournament ${k}`);
    if (!fast.tab('Итоги').ids().includes('R1')) {
      assert.equal(fast.appSorts(), fast.createdSorts, `tournament ${k}: every re-sort went through the API`);
    }
  }
});
