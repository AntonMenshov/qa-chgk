// Projector board logic (web/b/lib/board.js) and its link (web/s/lib/payload.js).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {decodeBoard, decodeSetup} from '../../web/s/lib/payload.js';
import {boardModel, cellMark, compareStandings, placeLabels} from '../../web/b/lib/board.js';

const L = createRequire(import.meta.url)('../../apps_script/logic.js');
const vectors = JSON.parse(readFileSync(new URL('../vectors/board_links.json', import.meta.url), 'utf8'));

for (const c of vectors.cases) {
  test(`board link ${c.valid ? 'decodes' : 'is refused'}: ${c.note || c.link}`, () => {
    const access = decodeBoard(c.link);
    if (!c.valid) {
      return assert.equal(access, null);
    }
    assert.deepEqual(access, {tid: c.tid, boardToken: c.board_token, backendUrl: c.backend_url});
  });
}

test('a board link is not a jury link', () => {
  assert.equal(decodeSetup(vectors.cases[0].link), null);
});

test('cellMark: + taken; − wrong or no card; ? not decided', () => {
  assert.deepEqual([1, 0, '', '?', 'R', undefined].map(cellMark), ['+', '−', '−', '?', '?', '−']);
});

const data = (sizes, marks, names = {}) => ({
  tournament: {name: 'Кубок', date: '2026-11-15', round_sizes: sizes},
  teams: Object.keys(marks).map((id) => ({team_id: id, name: names[id] || `Команда ${id}`})),
  marks,
});

// Four teams, rounds of 3: A has the most after round 1, C overtakes in round 2.
const FOUR = data([3, 3, 3], {
  A01: [1, 1, 1, 0, 0, 0, 1, 1, 1],
  A02: [1, 0, 0, 1, 0, 0, '', '', ''],
  A03: [0, 1, 0, 1, 1, 1, '?', 'R', 0],
  A04: [0, 0, 0, 1, 0, '', '', '', ''],
});

test('before any round is revealed: the title screen (no columns, no places from marks)', () => {
  const m = boardModel(FOUR, 0, {gridMax: 5});
  assert.deepEqual([m.revealed, m.groups, m.rounds], [0, [], 3]);
  assert.ok(m.rows.every((r) => r.total === 0 && r.sums.length === 0));
});

test('after round 1 only round 1 counts: marks already in for round 2 stay hidden', () => {
  const m = boardModel(FOUR, 1, {gridMax: 5});
  assert.equal(m.view, 'grid');
  assert.deepEqual(m.groups, [{round: 1, questions: [1, 2, 3]}]);
  assert.deepEqual(
    m.rows.map((r) => [r.team_id, r.total, r.place]),
    [
      ['A01', 3, 1],
      ['A02', 1, '2-3'],
      ['A03', 1, '2-3'],
      ['A04', 0, 4],
    ],
  );
  assert.deepEqual(Object.keys(m.rows[0].marks).map(Number), [1, 2, 3]);
  assert.deepEqual(m.took, {1: 2, 2: 2, 3: 1});
});

test('after round 2: totals and places from rounds 1-2; a tie goes to the better last round', () => {
  const m = boardModel(FOUR, 2, {gridMax: 5});
  // A01 3+0=3, A03 1+3=4, A02 1+1=2, A04 0+1=1
  assert.deepEqual(
    m.rows.map((r) => [r.team_id, r.sums, r.total, r.place]),
    [
      ['A03', [1, 3], 4, 1],
      ['A01', [3, 0], 3, 2],
      ['A02', [1, 1], 2, 3],
      ['A04', [0, 1], 1, 4],
    ],
  );
  assert.deepEqual(
    m.groups.map((g) => g.round),
    [1, 2],
  ); // grid: every revealed round
  // Equal totals: the better last round goes higher, the place stays shared.
  const tie = boardModel(data([2, 2], {A01: [1, 1, 0, 0], A02: [0, 0, 1, 1], A03: [1, 0, 1, 0]}), 2, {gridMax: 5});
  assert.deepEqual(
    tie.rows.map((r) => [r.team_id, r.place]),
    [
      ['A02', '1-3'],
      ['A03', '1-3'],
      ['A01', '1-3'],
    ],
  );
});

test('after the last round: «?» and «R» show as ?, an empty cell as −, and none of them count', () => {
  const m = boardModel(FOUR, 3, {gridMax: 5});
  const a03 = m.rows.find((r) => r.team_id === 'A03');
  assert.deepEqual([a03.marks[7], a03.marks[8], a03.marks[9]], ['?', '?', '−']);
  assert.deepEqual(a03.sums, [1, 3, 0]);
  assert.equal(m.took[7], 1);
  assert.equal(boardModel(FOUR, 99, {gridMax: 5}).revealed, 3); // can't reveal more than exist
});

test("more teams than gridMax: total plus the last revealed round's grid; G forces either view", () => {
  const m = boardModel(FOUR, 2, {gridMax: 3});
  assert.equal(m.view, 'compact');
  assert.deepEqual(m.groups, [{round: 2, questions: [4, 5, 6]}]);
  assert.deepEqual(m.rows[0].sums, [1, 3]); // all round sums are still known
  assert.equal(boardModel(FOUR, 2, {gridMax: 3, view: 'grid'}).view, 'grid');
  assert.equal(boardModel(FOUR, 2, {gridMax: 5, view: 'compact'}).groups.length, 1);
  assert.equal(boardModel(FOUR, 4, {gridMax: 4}).view, 'grid'); // exactly gridMax teams: grid
});

test("places and order agree with the Sheet's rules (logic.js) on 500 random tournaments", () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let k = 0; k < 500; k++) {
    const sizes = Array.from({length: 1 + Math.floor(rnd() * 4)}, () => 1 + Math.floor(rnd() * 5));
    const n = sizes.reduce((a, b) => a + b, 0);
    const p = [0.1, 0.5, 0.9][Math.floor(rnd() * 3)];
    const marks = {};
    for (let t = 0; t < 1 + Math.floor(rnd() * 12); t++) {
      marks[`A${String(t + 1).padStart(2, '0')}`] = Array.from({length: n}, () =>
        rnd() < p ? 1 : [0, '', '?', 'R'][Math.floor(rnd() * 4)],
      );
    }
    const revealed = 1 + Math.floor(rnd() * sizes.length);
    const m = boardModel(data(sizes, marks), revealed, {gridMax: 5});
    const shown = sizes.slice(0, revealed);
    const cut = Object.fromEntries(
      Object.entries(marks).map(([id, v]) => [
        id,
        v.slice(
          0,
          shown.reduce((a, b) => a + b, 0),
        ),
      ]),
    );
    const ref = L.standings(shown, Object.keys(marks), cut).sort(L.compareStandings);
    assert.deepEqual(
      m.rows.map((r) => [r.team_id, r.total, r.place]),
      ref.map((r) => [r.team_id, r.total, r.place]),
      `case ${k}`,
    );
  }
  assert.deepEqual(placeLabels([3, 3, 1]), L.placeLabels([3, 3, 1]));
  assert.equal(
    compareStandings({team_id: 'A', total: 2, rounds: [2, 0]}, {team_id: 'B', total: 2, rounds: [0, 2]}) > 0,
    true,
  );
});
