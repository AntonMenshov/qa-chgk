// Who may call which backend action: the ACTIONS table in Code.js.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {TID, JURY, BOARD, TEAMS, world, ev, photo} from './backend_world.mjs';

const actionsOf = (b) => vm.runInContext('ACTIONS', b);

// A valid body for every action (validateRequest runs before the token check). A new
// action without one here fails the first test, so it can't skip the token checks below.
const BODIES = {
  ping: () => ({}),
  create_tournament: () => ({
    tid: 'ZZ234',
    name: 'Другой',
    date: '2026-12-01',
    round_sizes: [3],
    jury_token: 'another-jury-token-0123',
    board_token: 'another-board-token-0123',
    teams: TEAMS,
  }),
  get_teams: () => ({tid: TID}),
  set_teams: () => ({tid: TID, teams: TEAMS}),
  get_state: () => ({tid: TID}),
  get_results: () => ({tid: TID}),
  record_events: () => ({tid: TID, events: [ev()]}),
  upload_photo: () => ({tid: TID, ...photo()}),
  get_board: () => ({tid: TID}),
};

// The access rule, written here on its own: the table must match it, so a weakened
// table entry fails the tests instead of quietly changing what they expect.
const WHO = {
  ping: 'admin',
  create_tournament: 'admin',
  get_teams: 'admin',
  set_teams: 'admin',
  get_state: 'jury',
  get_results: 'jury',
  record_events: 'jury',
  upload_photo: 'jury',
  get_board: 'board',
};

// Each level also takes every stronger token.
const ACCEPTED = {admin: ['admin'], jury: ['admin', 'jury'], board: ['admin', 'jury', 'board']};

test('the table, the request checks (logic.js) and these tests list the same actions', () => {
  const {b} = world();
  const table = Object.keys(actionsOf(b)).sort();
  assert.deepEqual(Object.keys(BODIES).sort(), table);
  assert.deepEqual(Object.keys(WHO).sort(), table);
  const logic = readFileSync(new URL('../../apps_script/logic.js', import.meta.url), 'utf8');
  const validate = logic.slice(logic.indexOf('export function validateRequest'));
  const body = validate.slice(0, validate.indexOf('\nexport function'));
  const checked = ['ping', ...[...body.matchAll(/case '(\w+)':/g)].map((m) => m[1])].sort();
  assert.deepEqual(checked, table);
  for (const [name, action] of Object.entries(actionsOf(b))) {
    assert.equal(action.who, WHO[name], `${name}: the table says ${action.who}`);
  }
});

test('every action takes exactly its own and stronger tokens; a refused request changes nothing', () => {
  for (const name of Object.keys(WHO)) {
    const tokens = {admin: null, jury: JURY, board: BOARD, none: undefined, wrong: 'wrong-token-0123456789'};
    for (const [label, given] of Object.entries(tokens)) {
      const {b, admin, tab} = world();
      const token = label === 'admin' ? admin : given;
      const logRows = tab('Log').getLastRow();
      const props = b.$.props.size;
      const res = b.post({action: name, token, ...BODIES[name]()});
      if (ACCEPTED[WHO[name]].includes(label)) {
        assert.equal(res.ok, true, `${name} with the ${label} token: ${res.error}`);
      } else {
        assert.equal(res.ok, false, `${name} with the ${label} token was accepted`);
        assert.equal(res.error, `forbidden: ${WHO[name]} token required`, name);
        assert.equal(tab('Log').getLastRow(), logRows, `${name}: the Log changed`);
        assert.equal(b.$.props.size, props, `${name}: the properties changed`);
      }
    }
  }
});

test('the actions that write hold the lock; reads never wait for it', () => {
  const {b} = world();
  const locked = Object.entries(actionsOf(b))
    .filter(([, a]) => a.lock)
    .map(([name]) => name);
  assert.deepEqual(locked.sort(), ['create_tournament', 'record_events', 'set_teams']);
  const LOCKS_ITSELF = ['upload_photo']; // saves to Drive first, then locks only for its Log write
  for (const name of Object.keys(BODIES)) {
    const {b: fresh, admin} = world();
    const res = fresh.post({action: name, token: admin, ...BODIES[name]()});
    assert.equal(res.ok, true, `${name}: ${res.error}`);
    const expected = locked.includes(name) || LOCKS_ITSELF.includes(name);
    assert.equal('lock' in res.timing, expected, `${name}: timing ${JSON.stringify(res.timing)}`);
  }
});

test('a tournament action names an unknown tournament before it looks at the token', () => {
  const {b} = world();
  for (const [name, action] of Object.entries(actionsOf(b))) {
    if (!action.noTournament) {
      const res = b.post({action: name, token: 'wrong-token-0123456789', ...BODIES[name](), tid: 'ZZ234'});
      assert.match(res.error, /unknown tournament ZZ234/, name);
    }
  }
});
