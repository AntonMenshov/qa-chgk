// Card photos (upload_photo): saved to Drive, logged, shown on «Спорные».
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {L, TID, JURY, world, ev, JPEG, photo} from './backend_world.mjs';

test('upload_photo saves the JPEG in Photos under a Latin name and logs its link', () => {
  const {b, tab} = world();
  const p = photo();
  const res = b.post({action: 'upload_photo', tid: TID, token: JURY, ...p});
  assert.equal(res.ok, true, JSON.stringify(res));
  const photos = b.$.root.children[0].children[0].children.find((f) => f.name === 'Photos');
  assert.equal(photos.files.length, 1);
  const file = photos.files[0];
  assert.equal(file.name, `${TID}_A02_q005_20261115-191502_${p.photo_id.slice(0, 8)}.jpg`);
  assert.ok(/^[\x20-\x7E]+$/.test(file.name));
  assert.deepEqual([file.contentType, file.size], ['image/jpeg', Buffer.from(JPEG, 'base64').length]);
  assert.equal(res.url, file.getUrl());
  assert.equal(typeof res.timing.drive, 'number');
  const log = tab('Log');
  const row = log.row(log.getLastRow(), 13);
  assert.deepEqual(row.slice(2, 9), [p.photo_id, 'photo', 'Анна', 'dev1', 'A02', 5, '']);
  assert.equal(row[12], file.getUrl());
  // A spare card's photo carries its spare number in the name.
  const spare = b.post({action: 'upload_photo', tid: TID, token: JURY, ...photo({question: 2, spare: 3})});
  assert.match(photos.files[1].name, /_q002_S3_/);
  assert.equal(spare.ok, true);
});

test('the same photo sent twice (a retry after a lost reply) is saved once', () => {
  const {b, tab} = world();
  const p = photo();
  assert.equal(b.post({action: 'upload_photo', tid: TID, token: JURY, ...p}).ok, true);
  const again = b.post({action: 'upload_photo', tid: TID, token: JURY, ...p});
  assert.deepEqual([again.ok, again.duplicate], [true, true]);
  const photos = b.$.root.children[0].children[0].children.find((f) => f.name === 'Photos');
  assert.equal(photos.files.length, 1);
  assert.equal(tab('Log').getLastRow(), 2);
});

test('a photo of a «?» card shows on «Спорные» at once; other photos leave «Спорные» alone', () => {
  const {b, tab} = world();
  b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({team_id: 'A02', question: 5, status: 'disputed'})],
  });
  const d = tab('Спорные');
  assert.deepEqual(d.row(2, 4), [2, 5, 'Фиаско', '']);
  d.set(30, 1, 'marker'); // would be cleared by a rewrite
  b.post({action: 'upload_photo', tid: TID, token: JURY, ...photo({team_id: 'A01', question: 1})}); // not a «?»
  assert.equal(d.get(30, 1), 'marker');
  const res = b.post({action: 'upload_photo', tid: TID, token: JURY, ...photo()});
  assert.deepEqual(d.row(2, 4), [2, 5, 'Фиаско', res.url]);
  // And a later mark change keeps the link (it comes from the Log).
  b.post({
    action: 'record_events',
    tid: TID,
    token: JURY,
    events: [ev({team_id: 'A01', question: 2, status: 'disputed'})],
  });
  assert.deepEqual(d.row(3, 4), [2, 5, 'Фиаско', res.url]);
});

test('upload_photo checks what it gets; a wrong request is not worth retrying, a Drive failure is', () => {
  const {b, tab} = world();
  const bad = (over, pattern) => {
    const res = b.post({action: 'upload_photo', tid: TID, token: JURY, ...photo(over)});
    assert.equal(res.ok, false, JSON.stringify(over));
    assert.match(res.error, pattern);
    assert.equal(res.retry, false, JSON.stringify(over));
  };
  bad({image: Buffer.from('GIF89a....').toString('base64')}, /base64 JPEG/);
  bad({image: '/9j/ not base64!'}, /base64 JPEG/);
  bad({image: '/9j/' + 'A'.repeat(L.MAX_PHOTO_CHARS)}, /too large/);
  bad({team_id: 'a-01'}, /team_id/);
  bad({team_id: 'Z99'}, /unknown team Z99/); // not in this tournament: not saved
  bad({question: 0}, /question/);
  bad({question: 7}, /invalid question 7/); // 6 questions in this tournament
  bad({spare: 0}, /spare/);
  bad({photo_id: 'short'}, /photo_id/);
  // Tokens: the jury's (or admin); not the board's or none.
  b.post({
    action: 'set_board_token',
    tid: TID,
    token: b.$.props.get('ADMIN_TOKEN'),
    board_token: 'board-token-0123456789',
  });
  assert.match(
    b.post({action: 'upload_photo', tid: TID, token: 'board-token-0123456789', ...photo()}).error,
    /forbidden/,
  );
  assert.match(b.post({action: 'upload_photo', tid: TID, ...photo()}).error, /forbidden/);
  // Drive fails: a server error the phone retries; nothing was logged.
  const photos = b.$.root.children[0].children[0].children.find((f) => f.name === 'Photos');
  photos.registry.failCreateFile = true;
  const down = b.post({action: 'upload_photo', tid: TID, token: JURY, ...photo()});
  assert.deepEqual([down.ok, down.retry], [false, true]);
  assert.equal(tab('Log').getLastRow(), 1);
});

test('photos and marks share the Log without getting in each other’s way', () => {
  const {b, tab} = world();
  const p = photo({team_id: 'A01', question: 1});
  b.post({action: 'upload_photo', tid: TID, token: JURY, ...p});
  const mark = ev({team_id: 'A01', question: 1});
  const res = b.post({action: 'record_events', tid: TID, token: JURY, events: [mark]});
  assert.deepEqual([res.results[0].applied, res.results[0].duplicate], [true, false]);
  assert.equal(tab('Тур 1').get(tab('Тур 1').rowOf('A01'), 3), 1);
  // Photo IDs and scan IDs are both UUIDs from the phone and share one seen-set.
  const dup = b.post({action: 'record_events', tid: TID, token: JURY, events: [{...mark, scan_id: p.photo_id}]});
  assert.equal(dup.results[0].duplicate, true); // same ID: a duplicate, whatever logged it
});
