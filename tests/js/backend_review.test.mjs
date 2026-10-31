// Backend behaviour settled in the code review of 2026-10-31.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {L, TID, JURY, world, reserveWorld, ev, photo} from './backend_world.mjs';

const rowOf = (sheet, id) => {
  for (let r = 2; r <= sheet.getLastRow(); r++) {
    if (String(sheet.getRange(r, 1).getValues()[0][0]) === id) {
      return r;
    }
  }
  return null;
};

const post = (b, action, extra = {}) => b.post({action, tid: TID, token: JURY, ...extra});

test('buffered writes are flushed before the lock is released, and before rows move', () => {
  const {b} = world();
  vm.runInContext(
    `globalThis.order = [];
     const realFlush = SpreadsheetApp.flush;
     SpreadsheetApp.flush = () => { order.push('flush'); return realFlush(); };
     LockService.getScriptLock = () => ({waitLock() {}, releaseLock() { order.push('release'); }});`,
    b,
  );
  assert.equal(post(b, 'record_events', {events: [ev()]}).ok, true);
  const order = [...vm.runInContext('order', b)];
  assert.deepEqual(order.slice(-2), ['flush', 'release']);
});

test('a token replaced while a request waited for the lock is refused at once', () => {
  const {b} = world();
  vm.runInContext(
    `LockService.getScriptLock = () => ({
       waitLock() {
         const key = 't:${TID}';
         const props = PropertiesService.getScriptProperties();
         const reg = JSON.parse(props.getProperty(key));
         props.setProperty(key, JSON.stringify(Object.assign(reg, {jury_token: 'replaced-jury-token-0123'})));
       },
       releaseLock() {},
     });`,
    b,
  );
  const res = post(b, 'record_events', {events: [ev()]});
  assert.equal(res.ok, false);
  assert.match(res.error, /forbidden/);
});

test('saving tab IDs after waiting for the lock keeps a token replaced meanwhile', () => {
  const {b} = world();
  const props = b.$.props;
  const replaced = 'replaced-board-token-0123';
  vm.runInContext(
    `LockService.getScriptLock = () => ({
       waitLock() {
         const p = PropertiesService.getScriptProperties();
         const reg = JSON.parse(p.getProperty('t:${TID}'));
         p.setProperty('t:${TID}', JSON.stringify(Object.assign(reg, {board_token: '${replaced}'})));
       },
       releaseLock() {},
     });`,
    b,
  );
  post(b, 'record_events', {events: [ev({team_id: 'A02', question: 1})]});
  assert.equal(JSON.parse(props.get(`t:${TID}`)).board_token, replaced);
});

test('a fast clock: a mark from the future counts as now, so a later correct mark beats it', () => {
  const cells = {};
  const ids = new Set(['A01']);
  const now = 1_000_000;
  const fast = {scan_id: 'a', team_id: 'A01', question: 1, status: 'correct', client_ts: now + 3 * 3600 * 1000};
  L.applyEvents(cells, new Set(), [fast], ids, [3], now);
  assert.equal(cells['A01:1'].ts, now);
  const later = {scan_id: 'b', team_id: 'A01', question: 1, status: 'incorrect', client_ts: now + 1000};
  const [outcome] = L.applyEvents(cells, new Set(['a']), [later], ids, [3], now + 2000);
  assert.equal(outcome.applied, true);
  assert.equal(cells['A01:1'].value, 0);
});

test('sentMarks: what was typed reaches phones as its value, unreadable text as NOT_A_MARK', () => {
  assert.deepEqual(L.sentMarks({A: ['+', 'да', 'r', 1, 0, '?', 'R', '', 'x', '–', '—', '✓', '✗', '×']}), {
    A: [1, 1, 'R', 1, 0, '?', 'R', '', L.NOT_A_MARK, 0, 0, 1, 0, 0],
  });
});

test('an unreadable cell gets its note once, and phones and the board are told', () => {
  const {b, tab} = world();
  const round = tab('Тур 1');
  const row = rowOf(round, 'A01');
  const col = L.questionCell([3, 3], 1).col;
  round.getRange(row, col).setValue('abc');
  let notes = 0;
  const realGet = round.getRange.bind(round);
  round.getRange = (...args) => {
    const range = realGet(...args);
    const setNote = range.setNote.bind(range);
    range.setNote = (n) => {
      notes += 1;
      return setNote(n);
    };
    return range;
  };
  post(b, 'record_events', {events: [ev({team_id: 'A02', question: 2})]});
  post(b, 'record_events', {events: [ev({team_id: 'A02', question: 3})]});
  assert.equal(notes, 1);
  assert.equal(post(b, 'get_state').marks.A01[0], L.NOT_A_MARK);
});

test('a formula typed over is put back by the next request, even with the order unchanged', () => {
  const {b, tab} = world();
  const round = tab('Тур 2');
  const lay = L.roundLayout([3, 3], 2);
  const row = rowOf(round, 'A01');
  const formula = round.getRange(row, lay.sumCol).getFormulas()[0][0];
  round.getRange(row, lay.sumCol).setValue(99);
  post(b, 'record_events', {events: [ev({team_id: 'A02', question: 1, status: 'received'})]});
  const now = rowOf(round, 'A01');
  assert.equal(round.getRange(now, lay.sumCol).getFormulas()[0][0].replace(/\d+/g, 'N'), formula.replace(/\d+/g, 'N'));
});

test('names typed on Teams: rows without an ID keep their own names', () => {
  const {b, tab} = world();
  const teams = tab('Teams');
  const last = teams.getLastRow();
  teams.getRange(last + 1, 2).setValue('Альфа');
  teams.getRange(last + 2, 2).setValue('Бета');
  vm.runInContext('(ss) => propagateNames_(ss, [3, 3], TABS.teams)', b)(b.$.spreadsheets.values().next().value);
  assert.equal(teams.getRange(last + 1, 2).getValues()[0][0], 'Альфа');
  assert.equal(teams.getRange(last + 2, 2).getValues()[0][0], 'Бета');
});

test("set_teams keeps a named reserve team's city and logo; only «да» makes a reserve team", () => {
  const {b, admin, tab} = reserveWorld();
  const teams = tab('Teams');
  const row = rowOf(teams, 'R1');
  teams.getRange(row, 3).setValue('Бостон');
  teams.getRange(row, 4).setValue('owl.png');
  b.post({
    action: 'set_teams',
    tid: TID,
    token: admin,
    teams: [
      {team_id: 'A01', name: '42'},
      {team_id: 'A02', name: 'Фиаско'},
    ],
  });
  const again = rowOf(teams, 'R1');
  assert.deepEqual(
    [teams.getRange(again, 3).getValues()[0][0], teams.getRange(again, 4).getValues()[0][0]],
    ['Бостон', 'owl.png'],
  );
  teams.getRange(rowOf(teams, 'A01'), 5).setValue('нет');
  const listed = b.post({action: 'get_teams', tid: TID, token: admin}).teams;
  assert.equal(listed.find((t) => t.team_id === 'A01').reserve, false);
});

test('a team missing only from «Тур 1» can still be marked in other rounds', () => {
  const {b, tab} = world();
  const round = tab('Тур 1');
  const row = rowOf(round, 'A02');
  round.getRange(row, 1, 1, 6).setValues([['', '', '', '', '', '']]);
  const res = post(b, 'record_events', {events: [ev({team_id: 'A02', question: 4})]});
  assert.equal(res.results[0].error, undefined);
  assert.equal(res.results[0].applied, true);
});

test('get_state says which teams are on the tabs', () => {
  const {b} = reserveWorld();
  const {teams} = post(b, 'get_state');
  assert.equal(teams.find((t) => t.team_id === 'A01').on_tabs, true);
  assert.equal(teams.find((t) => t.team_id === 'R1').on_tabs, false);
});

test('a photo with a time JavaScript has no date for is refused, not retried forever', () => {
  const {b} = world();
  const res = post(b, 'upload_photo', photo({client_ts: 1e17}));
  assert.equal(res.ok, false);
  assert.equal(res.retry, false);
});

test('a card without a «?» costs a photo one batched read under the lock', () => {
  const {b} = world();
  const reads = [];
  const real = vm.runInContext('readMarks_', b);
  vm.runInContext(
    '(f) => { readMarks_ = f; }',
    b,
  )((...args) => {
    reads.push('full');
    return real(...args);
  });
  assert.equal(post(b, 'upload_photo', photo()).ok, true);
  assert.deepEqual(reads, []);
});

test('delete_tournament: folder to the bin, its trigger gone, the tournament forgotten', () => {
  const {b, admin} = world();
  assert.equal(b.$.triggers.length, 1);
  assert.equal(b.post({action: 'delete_tournament', tid: TID, token: admin}).ok, true);
  assert.equal(b.$.triggers.length, 0);
  assert.equal(b.$.props.has(`t:${TID}`), false);
  assert.match(post(b, 'get_state').error, /unknown tournament/);
});

test('the Log and Settings are plain text in a new tournament', () => {
  const {tab} = world();
  assert.equal(tab('Log').formats.get('2,7'), '@');
  assert.equal(tab('Settings').formats.get('1,2'), '@');
});

// ---- the public copy (results.js) ----

function publicCopy(b, ss) {
  const reg = JSON.parse(b.$.props.get(`t:${TID}`));
  return {reg, copy: b.$.spreadsheets.get(reg.public_id), realId: ss.getId()};
}

test('a new tournament: the public copy has only the results tabs and is the shared one', () => {
  const {b, ss} = world();
  const {reg, copy, realId} = publicCopy(b, ss);
  assert.deepEqual(
    copy.getSheets().map((s) => s.getName()),
    ['Итоги', 'Тур 1', 'Тур 2', 'Статистика'],
  );
  assert.equal(b.$.sharing.get(reg.public_id), 'ANYONE_WITH_LINK:VIEW');
  assert.equal(b.$.sharing.get(realId), undefined);
  assert.match(post(b, 'get_board').view_url ?? '', new RegExp(reg.public_id));
});

test('the copy holds values only, and follows the marks at the next poll after the pause', () => {
  const {b, ss} = world();
  const {copy} = publicCopy(b, ss);
  const key = `pub:${TID}`;
  assert.equal(copy.getSheetByName('Итоги').getRange(1, 1).getValues()[0][0], 'ID');
  post(b, 'record_events', {events: [ev({team_id: 'A02', question: 1})]});
  post(b, 'get_state'); // within the pause: nothing yet
  const cell = () => {
    const tab = copy.getSheetByName('Тур 1');
    return tab.getRange(tab.rowOf('A02'), L.questionCell([3, 3], 1).col).getValues()[0][0];
  };
  assert.equal(cell(), '');
  b.$.props.set(key, '0');
  post(b, 'get_state');
  assert.equal(cell(), 1);
  assert.equal(b.$.props.has(`dirty:${TID}`), false);
  const formulas = copy.getSheetByName('Итоги').getRange(2, 1, 2, 5).getFormulas().flat();
  assert.deepEqual(formulas.filter(Boolean), []);
});

test('a failed publication never fails the request', () => {
  const {b, ss} = world();
  const {reg} = publicCopy(b, ss);
  b.$.spreadsheets.delete(reg.public_id);
  b.$.props.set(`pub:${TID}`, '0');
  post(b, 'record_events', {events: [ev()]});
  assert.equal(post(b, 'get_state').ok, true);
});

test('make_public_copy: an older tournament gets one, its real Sheet turns private; a second call changes nothing', () => {
  const {b, admin, ss} = world();
  const reg = JSON.parse(b.$.props.get(`t:${TID}`));
  delete reg.public_id;
  b.$.props.set(`t:${TID}`, JSON.stringify(reg));
  const made = b.post({action: 'make_public_copy', tid: TID, token: admin});
  assert.equal(made.existed, false);
  assert.equal(b.$.sharing.get(ss.getId()), 'PRIVATE:EDIT');
  assert.equal(b.post({action: 'make_public_copy', tid: TID, token: admin}).public_id, made.public_id);
});
