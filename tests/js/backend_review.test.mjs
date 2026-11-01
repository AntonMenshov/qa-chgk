// Backend behaviour settled in the code reviews.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {L, TID, JURY, BOARD, apiWorld, world, reserveWorld, ev, photo} from './backend_world.mjs';

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

test('the one-call sort does «Итоги» first: its keys read the round tabs', () => {
  const {b} = apiWorld();
  const requests = [];
  vm.runInContext(
    '(f) => { const real = Sheets.Spreadsheets.batchUpdate; Sheets.Spreadsheets.batchUpdate = (r, id) => { f(r); return real(r, id); }; }',
    b,
  )((r) => requests.push(...r.requests));
  post(b, 'record_events', {events: [ev({team_id: 'A02', question: 1})]});
  const ids = JSON.parse(b.$.props.get(`t:${TID}`)).sheet_ids;
  const sorts = requests.filter((r) => r.sortRange).map((r) => r.sortRange.range.sheetId);
  assert.deepEqual(sorts, [ids['Итоги'], ids['Тур 1']]);
  assert.equal(requests[0].sortRange.range.sheetId, ids['Итоги']);
});

test('onSheetEdit: a formula typed over is put back at once', () => {
  const {b, tab} = world();
  const round = tab('Тур 1');
  const lay = L.roundLayout([3, 3], 1);
  const row = rowOf(round, 'A01');
  const formula = round.getRange(row, lay.sumCol).getFormulas()[0][0];
  round.getRange(row, lay.sumCol).setValue(99);
  b.onSheetEdit({range: round.getRange(row, lay.sumCol)});
  const now = rowOf(round, 'A01');
  assert.equal(round.getRange(now, lay.sumCol).getFormulas()[0][0].replace(/\d+/g, 'N'), formula.replace(/\d+/g, 'N'));
});

test('onSheetEdit: an edit marks the public copy, and the timer publishes it', () => {
  const {b, ss, tab} = world();
  const {copy} = publicCopy(b, ss);
  const round = tab('Тур 1');
  const col = L.questionCell([3, 3], 1).col;
  round.getRange(rowOf(round, 'A01'), col).setValue('+');
  b.onSheetEdit({range: round.getRange(rowOf(round, 'A01'), col)});
  const pub = copy.getSheetByName('Тур 1');
  assert.equal(pub.getRange(pub.rowOf('A01'), col).getValues()[0][0], ''); // a column of edits publishes once
  assert.equal(b.$.triggers.filter((t) => t === 'publishWaiting').length, 1);
  b.publishWaiting();
  assert.equal(pub.getRange(pub.rowOf('A01'), col).getValues()[0][0], 1);
});

test('onSheetEdit: a changed name reaches the public copy', () => {
  const {b, ss, tab} = world();
  const {copy} = publicCopy(b, ss);
  const summary = tab('Итоги');
  summary.getRange(rowOf(summary, 'A01'), 2).setValue('Новое имя');
  b.onSheetEdit({range: summary.getRange(rowOf(summary, 'A01'), 2)});
  b.publishWaiting();
  const pub = copy.getSheetByName('Тур 2');
  assert.equal(pub.getRange(pub.rowOf('A01'), 2).getValues()[0][0], 'Новое имя');
});

test('a change arms one timer; it publishes without any read, and removes itself', () => {
  const {b, ss} = world();
  const {copy} = publicCopy(b, ss);
  post(b, 'record_events', {events: [ev({team_id: 'A02', question: 1})]});
  post(b, 'record_events', {events: [ev({team_id: 'A02', question: 2})]});
  assert.equal(b.$.triggers.filter((t) => t === 'publishWaiting').length, 1);
  b.publishWaiting();
  assert.equal(b.$.triggers.includes('publishWaiting'), false);
  assert.equal(b.$.props.has(`dirty:${TID}`), false);
  const tab = copy.getSheetByName('Тур 1');
  assert.equal(tab.getRange(tab.rowOf('A02'), L.questionCell([3, 3], 1).col).getValues()[0][0], 1);
});

test('a failed publication stays marked, with a pause before the next try', () => {
  const {b, ss} = world();
  const {reg} = publicCopy(b, ss);
  b.$.spreadsheets.delete(reg.public_id);
  b.$.props.set(`pub:${TID}`, '0');
  post(b, 'record_events', {events: [ev()]});
  post(b, 'get_state');
  assert.equal(b.$.props.has(`dirty:${TID}`), true);
  assert.ok(Number(b.$.props.get(`pub:${TID}`)) > 0);
});

test('make_public_copy on one that has a copy still makes the real Sheet private', () => {
  const {b, admin, ss} = world();
  b.$.sharing.set(ss.getId(), 'ANYONE_WITH_LINK:VIEW');
  assert.equal(b.post({action: 'make_public_copy', tid: TID, token: admin}).existed, true);
  assert.equal(b.$.sharing.get(ss.getId()), 'PRIVATE:EDIT');
});

test("a deleted tournament's ID is refused for a new one", () => {
  const {b, admin} = world();
  b.post({action: 'delete_tournament', tid: TID, token: admin});
  const again = b.post({
    action: 'create_tournament',
    token: admin,
    tid: TID,
    name: 'Кубок',
    date: '2026-11-15',
    round_sizes: [3],
    jury_token: JURY,
    board_token: 'another-board-token-0123',
    teams: [],
  });
  assert.equal(again.ok, false);
  assert.match(again.error, /deleted tournament/);
});

test('a publication that keeps failing stops arming timers after an hour; reads still try', () => {
  const {b, ss} = world();
  const {reg} = publicCopy(b, ss);
  b.$.spreadsheets.delete(reg.public_id);
  b.$.props.set(`dirty:${TID}`, String(Date.now() - 2 * 3600 * 1000));
  b.$.props.set(`pub:${TID}`, '0');
  post(b, 'get_state');
  assert.equal(b.$.props.has(`dirty:${TID}`), true);
  assert.equal(b.$.triggers.includes('publishWaiting'), false);
});

test('the timer finding the lock busy arms another: the last marks are not lost', () => {
  const {b, ss} = world();
  publicCopy(b, ss);
  post(b, 'record_events', {events: [ev()]});
  const lock = b.LockService;
  b.LockService = {
    getScriptLock: () => ({
      waitLock() {
        throw new Error('busy');
      },
      tryLock: () => false,
      releaseLock() {},
    }),
  };
  b.publishWaiting();
  b.LockService = lock;
  assert.equal(b.$.props.has(`dirty:${TID}`), true);
  assert.equal(b.$.triggers.filter((t) => t === 'publishWaiting').length, 1);
});

test('rows deleted from the real Sheet all go from the public copy, however many', () => {
  const {b, ss} = world();
  const {reg, copy} = publicCopy(b, ss);
  const pub = copy.getSheetByName('Статистика');
  pub.getRange(40, 1).setValue('old row');
  b.publish_(ss, Object.assign({tid: TID}, reg), b.PropertiesService.getScriptProperties());
  assert.equal(pub.getRange(40, 1).getValues()[0][0], '');
});

test('a new tournament stops before making any file when no trigger is left', () => {
  const {b, admin} = world();
  for (let i = b.$.triggers.length; i < 20; i++) {
    b.$.triggers.push('onSheetEdit');
  }
  const before = b.$.spreadsheets.size;
  const res = b.post({
    action: 'create_tournament',
    token: admin,
    tid: 'NEW1',
    name: 'x',
    date: '2026-11-15',
    round_sizes: [1],
    jury_token: JURY,
    board_token: BOARD,
    teams: [],
    reserve: [],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /20 triggers/);
  assert.equal(b.$.spreadsheets.size, before);
});

test('the reserve mark is read in any case', () => {
  const {b} = world();
  assert.equal(b.teamsFromRows_([['R1', 'x', '', '', 'Да']])[0].reserve, true);
  assert.equal(b.teamsFromRows_([['A1', 'x', '', '', '']])[0].reserve, false);
});

test('onSheetEdit: a typed-over Место is put back, though the sort keys look right', () => {
  const {b, tab} = world();
  const summary = tab('Итоги');
  const lay = L.summaryLayout([3, 3]);
  const row = rowOf(summary, 'A01');
  summary.getRange(row, lay.placeCol).setValue(5);
  b.onSheetEdit({range: summary.getRange(row, lay.placeCol)});
  assert.match(String(summary.getRange(row, lay.placeCol).getFormulas()[0][0]), /^=/);
});

test('onSheetEdit: an edit stays marked for the public copy even if the sort fails', () => {
  const {b, tab} = world();
  const round = tab('Тур 1');
  const col = L.questionCell([3, 3], 1).col;
  round.getRange(rowOf(round, 'A01'), col).setValue('+');
  const sort = b.sortTabs_;
  b.sortTabs_ = () => {
    throw new Error('quota');
  };
  assert.throws(() => b.onSheetEdit({range: round.getRange(rowOf(round, 'A01'), col)}));
  b.sortTabs_ = sort;
  assert.equal(b.$.props.has(`dirty:${TID}`), true);
});

test('onSheetEdit: a note beside the table sorts and repairs nothing', () => {
  const {b, tab} = world();
  const round = tab('Тур 1');
  const beyond = L.roundLayout([3, 3], 1).sumCol + 2;
  round.getRange(2, beyond).setValue('заметка');
  const sort = b.sortTabs_;
  b.sortTabs_ = () => assert.fail('nothing to sort');
  b.onSheetEdit({range: round.getRange(2, beyond)});
  b.sortTabs_ = sort;
});

test('onSheetEdit: a paste over marks and «Сумма» gets its formula back, even when the number is right', () => {
  const {b, tab} = world();
  const round = tab('Тур 1');
  const lay = L.roundLayout([3, 3], 1);
  const row = rowOf(round, 'A01');
  round.getRange(row, lay.sumCol).setValue(0);
  b.onSheetEdit({range: round.getRange(row, lay.firstCol, 1, lay.size + 1)});
  const now = rowOf(round, 'A01');
  assert.match(String(round.getRange(now, lay.sumCol).getFormulas()[0][0]), /^=COUNTIF/);
});

test('onSheetEdit: a name edit stays marked for the public copy even if a later step fails', () => {
  const {b, tab} = world();
  const summary = tab('Итоги');
  summary.getRange(rowOf(summary, 'A01'), 2).setValue('Новое имя');
  const refresh = b.refreshDisputed_;
  b.refreshDisputed_ = () => {
    throw new Error('quota');
  };
  assert.throws(() => b.onSheetEdit({range: summary.getRange(rowOf(summary, 'A01'), 2)}));
  b.refreshDisputed_ = refresh;
  assert.equal(b.$.props.has(`dirty:${TID}`), true);
});

test('onSheetEdit: a note under the table in a computed column stays there, and sorts nothing', () => {
  const {b, tab} = world();
  const round = tab('Тур 1');
  const sumCol = L.roundLayout([3, 3], 1).sumCol;
  const below = round.getLastRow() + 4;
  round.getRange(below, sumCol).setValue('проверить');
  const sort = b.sortTabs_;
  b.sortTabs_ = () => assert.fail('nothing to sort');
  b.onSheetEdit({range: round.getRange(below, sumCol)});
  b.sortTabs_ = sort;
});

test('the slow sort leaves a note under the table where it is', () => {
  const {b, ss, tab} = world();
  const round = tab('Тур 1');
  const sumCol = L.roundLayout([3, 3], 1).sumCol;
  const below = round.getLastRow() + 4;
  round.getRange(below, sumCol).setValue('проверить');
  b.sortTabs_(ss, [3, 3], [1], null, null);
  assert.equal(round.getRange(below, sumCol).getValues()[0][0], 'проверить');
});

test('the slow sort calculates what the tab before it wrote: every sort comes right after a flush', () => {
  const {b, ss} = world();
  vm.runInContext(
    `globalThis.order = [];
     const realFlush = SpreadsheetApp.flush;
     SpreadsheetApp.flush = () => { order.push('flush'); return realFlush(); };
     const realTimed = timed_;
     timed_ = (name, run) => { order.push(name); return realTimed(name, run); };`,
    b,
  );
  b.sortTabs_(ss, [3, 3], [1, 2], null, null);
  const order = [...vm.runInContext('order', b)];
  const sorts = order.flatMap((step, i) => (step === 'sort_range' ? [order[i - 1]] : []));
  assert.deepEqual(sorts, ['flush', 'flush', 'flush']); // two rounds and «Итоги»
});

test('onSheetEdit: a failing mark for the public copy does not stop the edit', () => {
  const {b, tab} = world();
  const round = tab('Тур 1');
  const col = L.questionCell([3, 3], 1).col;
  const row = rowOf(round, 'A01');
  round.getRange(row, col).setValue('+');
  const mark = b.markUnpublished_;
  b.markUnpublished_ = () => {
    throw new Error('too many times');
  };
  b.onSheetEdit({range: round.getRange(row, col)});
  b.markUnpublished_ = mark;
  const now = rowOf(round, 'A01');
  assert.equal(round.getRange(now, col).getValues()[0][0], 1);
});

test('computedColumnsAt: only the real tabs have computed columns', () => {
  assert.deepEqual(L.computedColumnsAt([3, 3], 'Тур 1'), {
    first: L.roundLayout([3, 3], 1).sumCol,
    last: L.roundLayout([3, 3], 1).width,
  });
  assert.equal(L.computedColumnsAt([3, 3], 'Тур 9'), null);
  assert.equal(L.computedColumnsAt([3, 3], 'Teams'), null);
});
