// «Спорные»: every undecided «?» with its photo, and the counts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadBackend} from './fake_apps_script.mjs';
import {TID, JURY, TEAMS, world, ev, photo, withoutTiming} from './backend_world.mjs';

test('«Спорные» lists every «?» with its round, question, team and photo, and the counts; it follows the marks', () => {
  const {b, tab} = world();
  const post = (events) => assert.equal(b.post({action: 'record_events', tid: TID, token: JURY, events}).ok, true);
  post([
    ev({team_id: 'A02', question: 5, status: 'disputed'}),
    ev({team_id: 'A01', question: 2, status: 'disputed'}),
    ev({team_id: 'A01', question: 5, status: 'disputed'}),
    ev({team_id: 'A02', question: 1, status: 'correct'}),
  ]);
  const link = b.post({action: 'upload_photo', tid: TID, token: JURY, ...photo({team_id: 'A02', question: 5})}).url;
  assert.ok(link);
  const d = tab('Спорные');
  assert.equal(d.hidden, true); // not on the view-only link
  const list = () => Array.from({length: d.getLastRow()}, (_, i) => d.row(i + 1, 4)).filter((r) => r[0] !== '');
  assert.deepEqual(list(), [
    ['Тур', 'Вопрос', 'Команда', 'Фото'],
    [1, 2, '42', ''],
    [2, 5, '42', ''],
    [2, 5, 'Фиаско', link],
  ]);
  const summary = () =>
    Array.from({length: d.getLastRow()}, (_, i) => [d.get(i + 1, 7), d.get(i + 1, 8)]).filter((r) => r[0] !== '');
  assert.deepEqual(summary(), [
    ['Всего «?»', 3],
    ['Тур', '«?»'],
    ['Тур 1', 1],
    ['Тур 2', 2],
    ['Команда', '«?»'],
    ['42', 2],
    ['Фиаско', 1],
  ]);

  // The jury decides one in the Sheet (trigger): it leaves the list and the counts.
  const r2 = tab('Тур 2');
  r2.set(r2.rowOf('A01'), 4, '1');
  b.onSheetEdit({range: r2.getRange(r2.rowOf('A01'), 4)});
  assert.deepEqual(list().slice(1), [
    [1, 2, '42', ''],
    [2, 5, 'Фиаско', link],
  ]);
  assert.deepEqual(summary()[0], ['Всего «?»', 2]);
  // ... and from the phone: the last one in round 1 goes, no stale rows stay behind.
  post([ev({team_id: 'A01', question: 2, status: 'incorrect'})]);
  assert.deepEqual(list().slice(1), [[2, 5, 'Фиаско', link]]);
  assert.deepEqual(summary(), [
    ['Всего «?»', 1],
    ['Тур', '«?»'],
    ['Тур 1', 0],
    ['Тур 2', 1],
    ['Команда', '«?»'],
    ['Фиаско', 1],
  ]);
  // A renamed team is renamed there too.
  const summaryTab = tab('Итоги');
  summaryTab.set(summaryTab.rowOf('A02'), 2, 'Фиаско-2');
  b.onSheetEdit({range: summaryTab.getRange(summaryTab.rowOf('A02'), 2)});
  assert.equal(list()[1][2], 'Фиаско-2');
});

test('«Спорные» keeps its counts clear of the photo links: two empty columns, a wide clipped link column', () => {
  const {b, tab, admin} = world();
  const d = tab('Спорные');
  assert.deepEqual([d.widths.get(4), d.widths.get(5), d.widths.get(6)], [360, 30, 30]);
  assert.equal(d.wraps.get('2,4'), 'CLIP');
  b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({team_id: 'A02', question: 5, status: 'disputed'})],
  });
  assert.deepEqual(d.row(2, 8), [2, 5, 'Фиаско', '', '', '', '', '']); // E-F stay empty
  assert.deepEqual(d.row(3, 8).slice(4), ['', '', 'Тур', '«?»']);
  // A full rewrite (a name changed) keeps the layout.
  b.post({action: 'set_teams', tid: TID, token: admin, teams: TEAMS});
  assert.deepEqual(d.row(1, 8), ['Тур', 'Вопрос', 'Команда', 'Фото', '', '', 'Всего «?»', 1]);
});

test('a request that changes no «?» leaves «Спорные» untouched', () => {
  const {b, tab} = world();
  b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({team_id: 'A02', question: 3, status: 'disputed'})],
  });
  const d = tab('Спорные');
  d.set(30, 1, 'marker'); // would be cleared by a rewrite
  b.post({action: 'record_events', tid: TID, token: JURY, events: [ev({question: 1, status: 'correct'})]});
  assert.equal(d.get(30, 1), 'marker');
});

test('the same marks, places and «Спорные» with the Sheets API off (the slow path)', () => {
  const run = (sheetsApi) => {
    const b = loadBackend({sheetsApi});
    b.setup();
    const admin = b.$.props.get('ADMIN_TOKEN');
    const created = b.post({
      action: 'create_tournament',
      token: admin,
      tid: TID,
      name: 'Кубок',
      date: '2026-11-15',
      round_sizes: [3, 3],
      jury_token: JURY,
      teams: TEAMS,
      reserve: ['R1'],
    });
    let k = 0;
    const e = (over) => ({
      scan_id: `x${++k}`,
      status: 'correct',
      team_id: 'A01',
      question: 1,
      client_ts: 1700000000000 + k,
      ...over,
    });
    for (const events of [
      [e({}), e({team_id: 'A02', question: 4, status: 'disputed'})],
      [e({team_id: 'R1', question: 2}), e({team_id: 'A02', question: 5})],
      [e({team_id: 'A01', question: 4, status: 'disputed'})],
    ]) {
      assert.equal(b.post({action: 'record_events', tid: TID, token: JURY, events}).ok, true);
    }
    const ss = b.$.spreadsheets.get(created.spreadsheet_id);
    const dump = (name) => {
      const t = ss.getSheetByName(name);
      return Array.from({length: t.getLastRow()}, (_, i) => t.row(i + 1, 7));
    };
    return {
      tabs: ['Итоги', 'Тур 1', 'Тур 2', 'Спорные'].map(dump),
      state: withoutTiming(b.post({action: 'get_state', tid: TID, token: JURY})),
      results: withoutTiming(b.post({action: 'get_results', tid: TID, token: JURY})),
      api: b.$.api,
    };
  };
  const fast = run(true);
  const slow = run(false);
  assert.deepEqual(fast.tabs, slow.tabs);
  assert.deepEqual(fast.state, slow.state);
  assert.deepEqual(fast.results, slow.results);
  assert.ok(fast.api.reads > 0 && slow.api.reads === 0);
});
