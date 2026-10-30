// The numbers the jury sees: round sums, Итого, Место (shared places as "2-3") and «Статистика».
// Formulas are evaluated by tests/js/sheet_formulas.mjs and compared with the reference
// implementation in logic.js, on hand-made cases and on many random tournaments.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadBackend} from './fake_apps_script.mjs';
import {makeEvaluator} from './sheet_formulas.mjs';

const L = createRequire(import.meta.url)('../../apps_script/logic.js');
const TID = 'K7M2Q';
const JURY = 'jury-token-0123456789';

/** Small seeded PRNG, so a failing random case can be reproduced. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 2 ** 32;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)],
  };
}

function teamList(n) {
  return Array.from({length: n}, (_, i) => ({team_id: `A${String(i + 1).padStart(2, '0')}`, name: `Команда ${i + 1}`}));
}

function world(roundSizes, teams) {
  const b = loadBackend();
  b.setup();
  const admin = b.$.props.get('ADMIN_TOKEN');
  const created = b.post({
    action: 'create_tournament',
    token: admin,
    tid: TID,
    name: 'Кубок',
    date: '2026-11-15',
    round_sizes: roundSizes,
    jury_token: JURY,
    teams,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const ss = b.$.spreadsheets.get(created.spreadsheet_id);
  return {b, admin, ss, tab: (name) => ss.getSheetByName(name)};
}

let seq = 0; // scan IDs must be unique across calls, or the backend drops them as duplicates

/** Send marks the way the phone does, in batches; marks = {team_id: [status or null per question]}. */
function sendMarks(b, marks) {
  const events = [];
  const ts = Date.now() - 600000;
  for (const [teamId, statuses] of Object.entries(marks)) {
    statuses.forEach((status, k) => {
      if (status) {
        events.push({scan_id: `e${++seq}`, team_id: teamId, question: k + 1, status, client_ts: ts + seq});
      }
    });
  }
  for (let i = 0; i < events.length; i += 500) {
    const res = b.post({action: 'record_events', tid: TID, token: JURY, events: events.slice(i, i + 500)});
    assert.equal(res.ok, true, JSON.stringify(res));
  }
}

const VALUE = {correct: 1, incorrect: 0, disputed: '?', received: 'R'};
const asValues = (marks) =>
  Object.fromEntries(Object.entries(marks).map(([id, s]) => [id, s.map((x) => (x ? VALUE[x] : ''))]));

function results(b) {
  const res = b.post({action: 'get_results', tid: TID, token: JURY});
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
}

/** «Итоги» and every round tab are in the user's order (see compareStandings / roundSortSpec). */
function assertOrder(ss, roundSizes, teamIds, values, label = '') {
  const expected = L.standings(roundSizes, teamIds, values)
    .sort(L.compareStandings)
    .map((r) => r.team_id);
  assert.deepEqual(ss.getSheetByName('Итоги').ids(), expected, `${label} «Итоги» order`);
  const rows = L.standings(roundSizes, teamIds, values);
  roundSizes.forEach((_, i) => {
    const want = [...rows]
      .sort((a, b) => b.rounds[i] - a.rounds[i] || (a.team_id < b.team_id ? -1 : 1))
      .map((r) => r.team_id);
    assert.deepEqual(ss.getSheetByName(`Тур ${i + 1}`).ids(), want, `${label} «Тур ${i + 1}» order`);
  });
}

function assertMatchesReference(b, roundSizes, teamIds, values, label = '') {
  const res = results(b);
  const expected = L.standings(roundSizes, teamIds, values);
  const got = Object.fromEntries(res.standings.map((r) => [r.team_id, r]));
  for (const e of expected) {
    const g = got[e.team_id];
    assert.ok(g, `${label} ${e.team_id} missing from «Итоги»`);
    assert.deepEqual([g.rounds, g.total, g.place], [e.rounds, e.total, e.place], `${label} ${e.team_id}`);
  }
  assert.equal(res.standings.length, teamIds.length, label);
  // «Статистика»: how many teams took each question, and the share.
  const n = L.totalQuestions(roundSizes);
  for (let q = 1; q <= n; q++) {
    const took = teamIds.filter((id) => values[id][q - 1] === 1).length;
    const s = res.stats[q - 1];
    assert.deepEqual(
      [s.question, s.round, s.took],
      [q, L.questionCell(roundSizes, q).round, took],
      `${label} stats q${q}`,
    );
    assert.ok(Math.abs(s.share - (teamIds.length ? took / teamIds.length : 0)) < 1e-12, `${label} share q${q}`);
  }
  return res;
}

// ---------- placeLabels: the reference ----------

test('placeLabels: hand-made cases', () => {
  const cases = [
    [[], []],
    [[0], [1]],
    [[7], [1]],
    [
      [3, 2, 1],
      [1, 2, 3],
    ],
    [
      [1, 2, 3],
      [3, 2, 1],
    ],
    [
      [3, 3],
      ['1-2', '1-2'],
    ],
    [
      [0, 0, 0, 0],
      ['1-4', '1-4', '1-4', '1-4'],
    ],
    [
      [2, 1, 1, 0],
      [1, '2-3', '2-3', 4],
    ], // the example tournament
    [
      [5, 3, 3, 1],
      [1, '2-3', '2-3', 4],
    ],
    [
      [2, 5, 2, 5, 0],
      ['3-4', '1-2', '3-4', '1-2', 5],
    ],
    [
      [9, 7, 7, 7, 4, 1],
      [1, '2-4', '2-4', '2-4', 5, 6],
    ],
    [
      [4, 4, 4, 1, 1],
      ['1-3', '1-3', '1-3', '4-5', '4-5'],
    ],
    [
      [10, 9, 8, 8],
      [1, 2, '3-4', '3-4'],
    ],
    [
      [1, 1, 2],
      ['2-3', '2-3', 1],
    ],
  ];
  for (const [totals, places] of cases) {
    assert.deepEqual(L.placeLabels(totals), places, JSON.stringify(totals));
  }
});

test('placeLabels: 25 different totals give 1…25; 25 equal give 1-25', () => {
  const totals = Array.from({length: 25}, (_, i) => 30 - i);
  assert.deepEqual(
    L.placeLabels(totals),
    Array.from({length: 25}, (_, i) => i + 1),
  );
  assert.deepEqual(new Set(L.placeLabels(new Array(25).fill(12))), new Set(['1-25']));
});

test('placeLabels: properties hold on 2000 random lists', () => {
  const r = rng(7);
  for (let k = 0; k < 2000; k++) {
    const totals = Array.from({length: r.int(1, 30)}, () => r.int(0, r.pick([1, 3, 10, 45])));
    const labels = L.placeLabels(totals);
    totals.forEach((t, i) => {
      const above = totals.filter((x) => x > t).length;
      const same = totals.filter((x) => x === t).length;
      const [lo, hi] = String(labels[i]).split('-').map(Number);
      assert.equal(lo, above + 1);
      assert.equal(hi === undefined ? lo : hi, above + same);
      assert.equal(typeof labels[i] === 'number', same === 1); // shared places are always "a-b"
    });
    // The places partition 1…N: every position belongs to exactly one group.
    const covered = new Set();
    new Set(labels.map(String)).forEach((label) => {
      const [lo, hi = lo] = label.split('-').map(Number);
      for (let p = lo; p <= hi; p++) {
        assert.ok(!covered.has(p));
        covered.add(p);
      }
    });
    assert.equal(covered.size, totals.length);
  }
});

test("standings: only 1 counts; 0, ?, R and blanks don't", () => {
  const rows = L.standings([3, 2], ['A01', 'A02', 'A03'], {
    A01: [1, '?', 'R', 1, 0],
    A02: [0, 0, 0, '', ''],
    A03: [1, 1, '', '?', 1],
  });
  assert.deepEqual(
    rows.map((r) => [r.team_id, r.rounds, r.total, r.place]),
    [
      ['A01', [1, 1], 2, 2],
      ['A02', [0, 0], 0, 3],
      ['A03', [2, 1], 3, 1],
    ],
  );
  assert.deepEqual(L.standings([2], ['A01'], {}), [{team_id: 'A01', rounds: [0], total: 0, place: 1}]);
});

// ---------- the formula evaluator itself ----------

test('evaluator: the functions and operators the backend uses', () => {
  const {ss, tab} = world([2], teamList(1));
  const s = tab('Статистика');
  const put = (r, c, v) => s.set(r, c, v);
  [
    [1, 3],
    [2, 5],
    [3, 5],
    [4, 'R'],
    [5, ''],
  ].forEach(([r, v]) => put(20 + r, 10, v));
  const cases = {
    '=1+2*3': 7,
    '=(1+2)*3': 9,
    '=-2+5': 3,
    '="a"&"-"&3': 'a-3',
    '=SUM(J21:J25)': 13,
    '=SUM(J21:J25,1)': 14,
    '=COUNTIF(J21:J25,5)': 2,
    '=COUNTIF(J21:J25,"r")': 1,
    '=COUNTA(J21:J25)': 4,
    '=RANK(J21,J21:J25)': 3,
    '=RANK(J22,J21:J25)': 1,
    '=RANK(J21,J21:J25,1)': 1,
    '=RANK(J22,J21:J25,1)': 2,
    '=INDEX(J21:J25,2)': 5,
    '=MATCH(5,J21:J25,0)': 2,
    '=IFERROR(MATCH(9,J21:J25,0),-1)': -1,
    '=IF(2>1,"yes","no")': 'yes',
    '=IF(COUNTIF(J21:J25,5)>1,RANK(J22,J21:J25)&"-"&(RANK(J22,J21:J25)+COUNTIF(J21:J25,J22)-1),0)': '1-2',
    '=IFERROR(1/0,"div")': 'div',
    '=COUNTIF(J$21:J,5)': 2,
    "=SUM('Тур 1'!C2:D2)": 0,
  };
  const value = makeEvaluator(ss);
  Object.entries(cases).forEach(([formula, expected], i) => {
    put(40 + i, 1, formula);
    assert.deepEqual(value(s, 40 + i, 1), expected, formula);
  });
});

// ---------- the Sheet's formulas, end to end ----------

test('the example tournament: 42 = 2, Фиаско = 1, Совхоз Победа = 1, Звезды сошлись = 0 → 1, 2-3, 2-3, 4', () => {
  const teams = [
    {team_id: 'A01', name: '42'},
    {team_id: 'A02', name: 'Фиаско'},
    {team_id: 'A03', name: 'Совхоз Победа'},
    {team_id: 'A04', name: 'Звезды сошлись'},
  ];
  const {b, tab} = world([12, 12, 12], teams);
  const blank = () => new Array(36).fill(null);
  const marks = {A01: blank(), A02: blank(), A03: blank(), A04: blank()};
  marks.A01[0] = marks.A01[1] = 'correct';
  marks.A02[0] = 'incorrect';
  marks.A02[1] = 'correct';
  marks.A03[0] = 'disputed';
  marks.A03[12] = 'correct';
  marks.A04[0] = 'received';
  sendMarks(b, marks);
  const res = assertMatchesReference(b, [12, 12, 12], ['A01', 'A02', 'A03', 'A04'], asValues(marks));
  // Фиаско and Совхоз Победа share 2-3; Совхоз Победа is higher: equal in round 3, better in round 2.
  assert.deepEqual(
    res.standings.map((r) => [r.name, r.rounds, r.total, r.place]),
    [
      ['42', [2, 0, 0], 2, 1],
      ['Совхоз Победа', [0, 1, 0], 1, '2-3'],
      ['Фиаско', [1, 0, 0], 1, '2-3'],
      ['Звезды сошлись', [0, 0, 0], 0, 4],
    ],
  );
  assert.equal(tab('Итоги').value(tab('Итоги').rowOf('A03'), 7), '2-3'); // Место (G)
  assert.equal(tab('Тур 2').value(tab('Тур 2').rowOf('A03'), 15), 1); // «Сумма» for round 2
  assert.deepEqual(tab('Тур 1').ids(), ['A01', 'A02', 'A03', 'A04']); // 2, 1, 0, 0
  assert.deepEqual(tab('Тур 2').ids(), ['A03', 'A01', 'A02', 'A04']); // 1, then 0s in ID order
});

test('ties: everyone level, two groups, a tie for last, a single team', () => {
  const scenarios = [
    {name: 'all zero', sizes: [3], totals: [0, 0, 0, 0, 0], places: ['1-5', '1-5', '1-5', '1-5', '1-5']},
    {name: 'all full', sizes: [2, 2], totals: [4, 4, 4], places: ['1-3', '1-3', '1-3']},
    {name: 'two groups', sizes: [3, 3], totals: [5, 5, 2, 2, 2, 1], places: ['1-2', '1-2', '3-5', '3-5', '3-5', 6]},
    {name: 'tie for last', sizes: [4], totals: [4, 3, 1, 1], places: [1, 2, '3-4', '3-4']},
    {name: 'single team', sizes: [5], totals: [3], places: [1]},
  ];
  for (const sc of scenarios) {
    const teams = teamList(sc.totals.length);
    const {b} = world(sc.sizes, teams);
    const n = L.totalQuestions(sc.sizes);
    const marks = Object.fromEntries(
      teams.map((t, i) => [t.team_id, Array.from({length: n}, (_, q) => (q < sc.totals[i] ? 'correct' : 'incorrect'))]),
    );
    sendMarks(b, marks);
    const res = assertMatchesReference(
      b,
      sc.sizes,
      teams.map((t) => t.team_id),
      asValues(marks),
      sc.name,
    );
    assert.deepEqual(
      res.standings.map((r) => r.place),
      sc.places,
      sc.name,
    );
  }
});

test('a team with no marks at all still gets 0 and a place', () => {
  const teams = teamList(3);
  const {b} = world([2, 2], teams);
  const marks = {
    A01: ['correct', 'correct', null, null],
    A02: [null, null, null, null],
    A03: ['correct', null, null, null],
  };
  sendMarks(b, marks);
  const res = assertMatchesReference(b, [2, 2], ['A01', 'A02', 'A03'], asValues(marks));
  assert.deepEqual(
    res.standings.map((r) => [r.team_id, r.total, r.place]),
    [
      ['A01', 2, 1],
      ['A03', 1, 2],
      ['A02', 0, 3],
    ],
  );
});

test('a jury edit (? → 1) moves the team up and splits a shared place', () => {
  const teams = teamList(3);
  const {b, tab} = world([3], teams);
  const marks = {A01: ['correct', 'disputed', null], A02: ['correct', null, null], A03: [null, null, null]};
  sendMarks(b, marks);
  assert.deepEqual(
    results(b).standings.map((r) => r.place),
    ['1-2', '1-2', 3],
  );
  const r1 = tab('Тур 1');
  r1.write(2, 4, '+'); // A01, question 2
  b.onSheetEdit({range: r1.getRange(2, 4)});
  assert.deepEqual(
    results(b).standings.map((r) => [r.total, r.place]),
    [
      [2, 1],
      [1, 2],
      [0, 3],
    ],
  );
});

test('sorting round tabs and «Итоги» by hand does not change any number', () => {
  const sizes = [3, 3, 3];
  const teams = teamList(6);
  const {b, tab} = world(sizes, teams);
  const r = rng(99);
  const marks = Object.fromEntries(
    teams.map((t) => [t.team_id, Array.from({length: 9}, () => r.pick(['correct', 'incorrect', null]))]),
  );
  sendMarks(b, marks);
  const ids = teams.map((t) => t.team_id);
  const before = assertMatchesReference(b, sizes, ids, asValues(marks));

  // Reverse the team rows of «Тур 2», as if the jury sorted it Z→A (values only, formulas
  // in «Сумма» are rewritten for their new row, as Sheets does when sorting).
  const t2 = tab('Тур 2');
  const rows = Array.from({length: 6}, (_, i) => t2.row(i + 2, 5)).reverse();
  rows.forEach((row, i) => {
    row.forEach((v, c) => t2.set(i + 2, c + 1, v));
    t2.set(i + 2, 6, `=COUNTIF(C${i + 2}:E${i + 2},1)`);
  });
  const after = assertMatchesReference(b, sizes, ids, asValues(marks), 'sorted');
  assert.deepEqual(after.standings, before.standings);
});

test('teams added later (chgk teams) get correct sums and push places down', () => {
  const sizes = [2, 2];
  const {b, admin} = world(sizes, teamList(2));
  sendMarks(b, {A01: ['correct', null, null, null], A02: [null, null, null, null]});
  const all = teamList(4);
  b.post({action: 'set_teams', tid: TID, token: admin, teams: all});
  const marks = {
    A01: ['correct', null, null, null],
    A02: [null, null, null, null],
    A03: ['correct', 'correct', 'correct', null],
    A04: ['correct', null, null, null],
  };
  sendMarks(b, {A03: marks.A03, A04: marks.A04});
  const res = assertMatchesReference(
    b,
    sizes,
    all.map((t) => t.team_id),
    asValues(marks),
  );
  assert.deepEqual(
    res.standings.map((r) => [r.team_id, r.place]),
    [
      ['A03', 1],
      ['A01', '2-3'],
      ['A04', '2-3'],
      ['A02', 4],
    ],
  );
});

test('random tournaments: «Итоги», round sums, places and «Статистика» match the reference (80 cases)', () => {
  const r = rng(2026);
  for (let k = 0; k < 80; k++) {
    const sizes = Array.from({length: r.int(1, 5)}, () => r.pick([1, 2, 3, 6, 12, 15]));
    const teams = teamList(r.int(1, 25));
    const n = L.totalQuestions(sizes);
    // Low variety on purpose, so ties are common.
    const pCorrect = r.pick([0, 0.1, 0.5, 0.9, 1]);
    const marks = Object.fromEntries(
      teams.map((t) => [
        t.team_id,
        Array.from({length: n}, () => {
          const x = r.next();
          if (x < pCorrect) {
            return 'correct';
          }
          return r.pick(['incorrect', 'disputed', 'received', null]);
        }),
      ]),
    );
    const {b, ss} = world(sizes, teams);
    sendMarks(b, marks);
    const label = `case ${k} ${JSON.stringify(sizes)}×${teams.length}`;
    assertMatchesReference(
      b,
      sizes,
      teams.map((t) => t.team_id),
      asValues(marks),
      label,
    );
    assertOrder(
      ss,
      sizes,
      teams.map((t) => t.team_id),
      asValues(marks),
      label,
    );
  }
});

// ---------- team names that look like numbers ----------

test('a team called «42» stays text on every tab', () => {
  const teams = [
    {team_id: 'A01', name: '42'},
    {team_id: 'A02', name: '1984'},
    {team_id: 'A03', name: 'Фиаско'},
  ];
  const {b, tab} = world([3], teams);
  for (const name of ['Итоги', 'Тур 1', 'Teams']) {
    assert.equal(tab(name).get(2, 2), '42', name);
    assert.equal(tab(name).get(3, 2), '1984', name);
    assert.equal(tab(name).formats.get('2,2'), '@', name);
  }
  assert.equal(tab('Итоги').align.get('2,2'), 'left');
  assert.deepEqual(
    b.post({action: 'get_state', tid: TID, token: JURY}).teams.map((t) => t.name),
    ['42', '1984', 'Фиаско'],
  );
});

test('a name already stored as the number 42 (older Sheets) is rewritten as text by set_teams', () => {
  const teams = [{team_id: 'A01', name: '42'}];
  const {b, admin, tab} = world([3], teams);
  for (const name of ['Итоги', 'Тур 1']) {
    tab(name).formats.clear();
    tab(name).set(2, 2, 42);
  }
  b.post({action: 'set_teams', tid: TID, token: admin, teams});
  for (const name of ['Итоги', 'Тур 1']) {
    assert.equal(tab(name).get(2, 2), '42', name);
  }
});

test('set_teams upgrades «Итоги» formulas from older versions (Место was a plain RANK)', () => {
  const teams = teamList(3);
  const {b, admin, tab} = world([2], teams);
  const sum = tab('Итоги'); // A ID, B name, C Тур 1, D Итого, E Место
  sendMarks(b, {A01: ['correct', null], A02: ['correct', null], A03: [null, null]});
  for (const row of [2, 3, 4]) {
    sum.set(row, 5, `=RANK(D${row},D$2:D)`);
  }
  assert.deepEqual(
    results(b).standings.map((r) => r.place),
    [1, 1, 3],
  ); // the old behaviour
  b.post({action: 'set_teams', tid: TID, token: admin, teams});
  assert.deepEqual(
    results(b).standings.map((r) => r.place),
    ['1-2', '1-2', 3],
  );
  assert.equal(sum.get(2, 5), L.placeFormula('D', 2));
});

// ---------- order of rows ----------

test('compareStandings: total, then the last round, then the one before, then ID', () => {
  const row = (teamId, rounds) => ({team_id: teamId, rounds, total: rounds.reduce((a, b) => a + b, 0)});
  const rows = [
    row('A01', [5, 3, 2]), // 10, last round 2
    row('A02', [2, 4, 4]), // 10, last round 4 → above A01
    row('A03', [4, 2, 4]), // 10, last round 4, round 2: 2 < 4 → below A02
    row('A04', [6, 6, 0]), // 12 → first
    row('A05', [3, 3, 4]), // 10, 4, round 2: 3 → between A02 and A03
    row('A06', [3, 3, 4]), // identical to A05 → ID order
    row('A07', [0, 0, 0]),
  ];
  assert.deepEqual(
    [...rows].sort(L.compareStandings).map((r) => r.team_id),
    ['A04', 'A02', 'A05', 'A06', 'A03', 'A01', 'A07'],
  );
  // Places stay shared: the order inside a tie does not change the place.
  assert.deepEqual(L.placeLabels([10, 10, 10, 12, 10, 10, 0]), ['2-6', '2-6', '2-6', 1, '2-6', '2-6', 7]);
});

test('summarySortSpec / roundSortSpec point at the right columns', () => {
  // [3, 3, 2]: A ID, B name, C-E rounds, F Итого, G Место
  assert.deepEqual(L.summarySortSpec([3, 3, 2]), [
    {column: 6, ascending: false},
    {column: 5, ascending: false},
    {column: 4, ascending: false},
    {column: 3, ascending: false},
    {column: 1, ascending: true},
  ]);
  assert.deepEqual(L.roundSortSpec(L.roundLayout([3, 3, 2], 3)), [
    {column: 5, ascending: false},
    {column: 1, ascending: true},
  ]);
});

test('«Итоги» in the Sheet: equal totals ordered by the last round, then the round before', () => {
  const sizes = [3, 3, 3];
  const teams = teamList(6);
  const {b, ss} = world(sizes, teams);
  const plan = {
    // correct answers per round → order
    A01: [3, 1, 1], // 5, last 1
    A02: [1, 1, 3], // 5, last 3, round 2: 1
    A03: [2, 0, 3], // 5, last 3, round 2: 0 < 1 → after A02
    A04: [0, 2, 3], // 5, last 3, round 2: 2 → before A02
    A05: [3, 3, 3], // 9 → first
    A06: [0, 0, 0],
  };
  const marks = Object.fromEntries(
    Object.entries(plan).map(([id, per]) => [
      id,
      per.flatMap((k) => [0, 1, 2].map((q) => (q < k ? 'correct' : 'incorrect'))),
    ]),
  );
  sendMarks(b, marks);
  const res = assertMatchesReference(
    b,
    sizes,
    teams.map((t) => t.team_id),
    asValues(marks),
  );
  assert.deepEqual(
    res.standings.map((r) => [r.team_id, r.total, r.place]),
    [
      ['A05', 9, 1],
      ['A04', 5, '2-5'],
      ['A02', 5, '2-5'],
      ['A03', 5, '2-5'],
      ['A01', 5, '2-5'],
      ['A06', 0, 6],
    ],
  );
  assertOrder(
    ss,
    sizes,
    teams.map((t) => t.team_id),
    asValues(marks),
  );
  assert.deepEqual(ss.getSheetByName('Тур 1').ids(), ['A01', 'A05', 'A03', 'A02', 'A04', 'A06']);
});

test('a jury edit re-sorts its round tab and «Итоги»', () => {
  const teams = teamList(3);
  const {b, ss, tab} = world([2, 2], teams);
  sendMarks(b, {
    A01: ['correct', null, null, null],
    A02: ['correct', 'correct', null, null],
    A03: [null, null, null, null],
  });
  assert.deepEqual(tab('Итоги').ids(), ['A02', 'A01', 'A03']);
  const r2 = tab('Тур 2');
  const row = r2.rowOf('A03');
  r2.set(row, 3, '+');
  r2.set(row, 4, 1); // the juror gives A03 both round-2 questions
  b.onSheetEdit({range: r2.getRange(row, 3, 1, 2)});
  assert.deepEqual(tab('Тур 2').ids(), ['A03', 'A01', 'A02']);
  assert.deepEqual(tab('Итоги').ids(), ['A03', 'A02', 'A01']); // 2 and 2: A03 better in the last round
  const res = results(b);
  assert.deepEqual(
    res.standings.map((r) => [r.team_id, r.place]),
    [
      ['A03', '1-2'],
      ['A02', '1-2'],
      ['A01', 3],
    ],
  );
  assertOrder(ss, [2, 2], ['A01', 'A02', 'A03'], {A01: [1, '', '', ''], A02: [1, 1, '', ''], A03: ['', '', 1, 1]});
});

// ---------- jury edits are found by comparing with the last known value ----------

test('sheetEdits: only changed marks; typed variants are normalised; nonsense has no status', () => {
  const edits = L.sheetEdits(
    {'A01:1': 1, 'A01:2': '+', 'A01:3': '', 'A02:1': 'maybe', 'A02:2': '?', 'A02:3': 'р'},
    {'A01:1': 1, 'A01:2': '', 'A01:3': 1, 'A02:1': '', 'A02:2': '?'},
  );
  assert.deepEqual(
    edits.map((e) => [e.key, e.status, e.value]),
    [
      ['A01:2', 'correct', 1],
      ['A01:3', 'cleared', ''],
      ['A02:1', null, null],
      ['A02:3', 'received', 'R'],
    ],
  );
  assert.deepEqual(L.sheetEdits({'A01:1': 1}, {'A01:1': 1}), []);
  assert.deepEqual(L.metaLayout(2).header, ['team_id', 1, 2, 'v1', 'v2']);
  assert.deepEqual([L.metaLayout(2).tsCol(2), L.metaLayout(2).knownCol(1)], [3, 4]);
});

// ---------- team IDs given by the organiser ----------

test('numeric team IDs (rating numbers) stay text on every tab and work end to end', () => {
  const teams = [
    {team_id: '645', name: '42'},
    {team_id: '58746', name: 'Фиаско'},
    {team_id: '40400', name: 'Совхоз Победа'},
    {team_id: 'A01', name: 'Звезды сошлись'},
  ];
  const {b, ss, tab} = world([3, 3], teams);
  for (const name of ['Итоги', 'Тур 1', 'Тур 2', 'Teams', 'Meta']) {
    const ids = tab(name).ids();
    assert.deepEqual([...ids].sort(), ['40400', '58746', '645', 'A01'], name);
    assert.ok(
      ids.every((id) => typeof id === 'string'),
      `${name}: ${JSON.stringify(ids)}`,
    );
  }
  const marks = {
    645: ['correct', 'correct', null, null, null, null],
    58746: ['correct', null, null, null, null, null],
    40400: [null, null, null, 'correct', null, null],
    A01: [null, null, null, null, null, null],
  };
  sendMarks(b, marks);
  const ids = teams.map((t) => t.team_id);
  const res = assertMatchesReference(b, [3, 3], ids, asValues(marks));
  assertOrder(ss, [3, 3], ids, asValues(marks));
  assert.deepEqual(
    res.standings.map((r) => [r.team_id, r.name, r.place]),
    [
      ['645', '42', 1],
      ['40400', 'Совхоз Победа', '2-3'],
      ['58746', 'Фиаско', '2-3'],
      ['A01', 'Звезды сошлись', 4],
    ],
  );
  assert.deepEqual(b.post({action: 'get_state', tid: TID, token: JURY}).marks['58746'], [1, '', '', '', '', '']);
  // A jury edit on a team with a numeric ID.
  const r2 = tab('Тур 2');
  r2.set(r2.rowOf('58746'), 4, '+');
  b.onSheetEdit({range: r2.getRange(r2.rowOf('58746'), 4)});
  // 2 and 2: 58746 scored in the last round, 645 did not.
  assert.deepEqual(
    results(b).standings.map((r) => [r.team_id, r.place]),
    [
      ['58746', '1-2'],
      ['645', '1-2'],
      ['40400', 3],
      ['A01', 4],
    ],
  );
});

test('team IDs are checked: 1-8 digits or capital Latin letters, no duplicates', () => {
  const b = loadBackend();
  b.setup();
  const admin = b.$.props.get('ADMIN_TOKEN');
  const create = (teams) =>
    b.post({
      action: 'create_tournament',
      token: admin,
      tid: TID,
      name: 'Кубок',
      date: '2026-11-15',
      round_sizes: [3],
      jury_token: JURY,
      teams,
    });
  for (const bad of ['a01', 'A-1', 'ABCDEFGHI', '', '58 746', 'А01']) {
    assert.match(create([{team_id: bad, name: 'X'}]).error, /invalid team_id/, bad);
  }
  assert.match(
    create([
      {team_id: '645', name: 'X'},
      {team_id: '645', name: 'Y'},
    ]).error,
    /duplicate/,
  );
  assert.equal(
    create([
      {team_id: '7', name: 'X'},
      {team_id: 'ABCD1234', name: 'Y'},
    ]).ok,
    true,
  );
});

// ---------- sorting only when the order changes (speed) ----------

test("a batch that doesn't change the order doesn't sort; one that does, sorts", () => {
  const teams = teamList(3);
  const {b, ss, tab} = world([2, 2], teams);
  const sorts = () => ['Итоги', 'Тур 1', 'Тур 2'].map((n) => tab(n).sorts || 0);
  const before = sorts();
  // A01 takes question 1: it was already first (ID order), so nothing moves.
  sendMarks(b, {A01: ['correct', null, null, null]});
  assert.deepEqual(sorts(), before);
  // A wrong answer and a «?» change no sums: still no sort.
  sendMarks(b, {A02: ['incorrect', 'disputed', null, null]});
  assert.deepEqual(sorts(), before);
  // A03 takes two questions in round 2: «Тур 2» and «Итоги» must re-sort, «Тур 1» not.
  sendMarks(b, {A03: [null, null, 'correct', 'correct']});
  const after = sorts();
  assert.deepEqual([after[0] > before[0], after[1] === before[1], after[2] > before[2]], [true, true, true]);
  assertOrder(ss, [2, 2], ['A01', 'A02', 'A03'], {A01: [1, '', '', ''], A02: [0, '?', '', ''], A03: ['', '', 1, 1]});
});

test('roundOrder / summaryOrder agree with the tabs after many random batches', () => {
  const r = rng(5);
  for (let k = 0; k < 15; k++) {
    const sizes = [r.int(1, 4), r.int(1, 4)];
    const teams = teamList(r.int(2, 9));
    const {b, ss} = world(sizes, teams);
    const n = L.totalQuestions(sizes);
    const all = Object.fromEntries(teams.map((t) => [t.team_id, new Array(n).fill(null)]));
    for (let batch = 0; batch < 4; batch++) {
      const marks = {};
      teams.forEach((t) => {
        marks[t.team_id] = Array.from({length: n}, (_, q) => {
          if (r.next() < 0.3) {
            all[t.team_id][q] = r.pick(['correct', 'incorrect']);
            return all[t.team_id][q];
          }
          return null;
        });
      });
      sendMarks(b, marks);
      assertOrder(
        ss,
        sizes,
        teams.map((t) => t.team_id),
        asValues(all),
        `case ${k} batch ${batch}`,
      );
    }
  }
});
