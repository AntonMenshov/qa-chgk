// Card photos (upload_photo): saved in the tournament's Photos folder, linked from the Log.

/**
 * One card's photo from a phone: saved as a JPEG in the tournament's Photos folder (Latin
 * name), then logged (source «photo») with its link, which «Спорные» shows for a «?».
 * The Drive save (~2 s) runs outside the lock, so marks never wait for photos. Idempotent
 * by photo_id: a phone retrying after a lost reply doesn't save it twice.
 */
function uploadPhoto_(ss, reg, req) {
  if (req.question > totalQuestions(reg.round_sizes)) {
    fail(`invalid question ${req.question}`);
  }
  const scanCol = LOG_HEADER.indexOf('scan_id') + 1;
  const [logged, teams] = readBlocks_(ss, [
    {name: TABS.log, row: 2, col: scanCol, cols: 1},
    {name: TABS.teams, row: 2, col: 1, cols: 1},
  ]);
  // Teams lists every team, reserve decks included (a photo may arrive before their first mark).
  if (!teams.some((r) => String(r[0]).trim() === req.team_id)) {
    fail(`unknown team ${req.team_id}`);
  }
  if (logged.some((r) => String(r[0]) === req.photo_id)) {
    return {ok: true, photo_id: req.photo_id, duplicate: true};
  }
  const stamp = Utilities.formatDate(new Date(req.client_ts), scriptTimeZone_(), 'yyyyMMdd-HHmmss');
  const name = photoFileName(reg.tid, req.team_id, req.question, req.spare, stamp, req.photo_id);
  const url = timed_('drive', () => {
    const blob = Utilities.newBlob(Utilities.base64Decode(req.image), 'image/jpeg', name);
    return DriveApp.getFolderById(reg.photos_folder_id).createFile(blob).getUrl();
  });
  return withLock_(() => {
    const m = readMarks_(ss, reg, {log: true});
    if (m.log.seen.has(req.photo_id)) {
      return {ok: true, photo_id: req.photo_id, duplicate: true};
    }
    const before = disputedBefore_(m);
    const now = logTime_(Date.now());
    appendLog_(m, [
      [
        now,
        logTime_(req.client_ts),
        req.photo_id,
        'photo',
        req.juror || '',
        req.device || '',
        req.team_id,
        req.question,
        req.spare || '',
        '',
        '',
        '',
        url,
      ],
    ]);
    // A «?» shows its photo on «Спорные» at once (the set of «?» didn't change).
    if (markValues_(m)[`${req.team_id}:${req.question}`] === '?') {
      m.w.set(TABS.disputed, 1, 1, disputedBlock_(m, markValues_(m), m.log.photos, before.rows));
    }
    m.w.flush();
    return {ok: true, photo_id: req.photo_id, url};
  });
}
