// Shared by the backend test files: a tournament on the fake Apps Script world
// (fake_apps_script.mjs), events, photos, and a world that counts Sheets API calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadBackend} from './fake_apps_script.mjs';

export const L = createRequire(import.meta.url)('../../apps_script/logic.js');

export const TID = 'K7M2Q';

export const JURY = 'jury-token-0123456789';

export const TEAMS = [
  {team_id: 'A01', name: '42'},
  {team_id: 'A02', name: 'Фиаско', city: 'Бостон'},
];

export function world({roundSizes = [3, 3], teams = TEAMS} = {}) {
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

export let seq = 0;

export const ev = (over = {}) => ({
  scan_id: `s${++seq}`,
  status: 'correct',
  team_id: 'A01',
  question: 1,
  client_ts: Date.now() - 60000,
  ...over,
});

export function reserveWorld() {
  const b = loadBackend();
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
    reserve: ['R1', 'R2'],
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const ss = b.$.spreadsheets.get(created.spreadsheet_id);
  return {b, admin, ss, tab: (name) => ss.getSheetByName(name)};
}

export const JPEG = Buffer.from([
  0xff,
  0xd8,
  0xff,
  0xe0,
  ...Array.from({length: 300}, (_, i) => i % 256),
  0xff,
  0xd9,
]).toString('base64');

export const photo = (over = {}) => ({
  photo_id: `photo-${++seq}-abcdef`,
  team_id: 'A02',
  question: 5,
  client_ts: Date.UTC(2026, 10, 15, 19, 15, 2),
  juror: 'Анна',
  device: 'dev1',
  image: JPEG,
  ...over,
});

export const ascii = (name) => /^[\x20-\x7E]+$/.test(name);

export const withoutTiming = (reply) => {
  const copy = Object.assign({}, reply);
  delete copy.timing;
  return copy;
};

export function apiWorld() {
  const b = loadBackend({sheetsApi: true});
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
  const ss = b.$.spreadsheets.get(created.spreadsheet_id);
  const calls = (fn) => {
    const before = {reads: b.$.api.reads, writes: b.$.api.writes};
    const result = fn();
    return {result, reads: b.$.api.reads - before.reads, writes: b.$.api.writes - before.writes};
  };
  return {b, admin, ss, tab: (name) => ss.getSheetByName(name), calls};
}
