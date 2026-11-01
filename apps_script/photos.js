// Card photos (upload_photo): saved in the tournament's Photos folder, linked from the Log.

/**
 * One card's photo from a phone: saved as a JPEG in the tournament's Photos folder, then logged
 * (source «photo») with its link, which «Спорные» shows for a «?». The Drive save (~2 s) runs
 * outside the lock. A photo_id is logged once: a retry may leave an extra file in Drive, never linked.
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
    const at = questionCell(reg.round_sizes, req.question);
    const [logRows, tab] = readBlocks_(ss, [LOG_BLOCK, {name: at.name, row: 2, col: 1, cols: at.col}]);
    const m = {log: logFromRows_(logRows), w: writer_(ss)};
    if (m.log.seen.has(req.photo_id)) {
      return {ok: true, photo_id: req.photo_id, duplicate: true};
    }
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
    m.w.flush();
    // A «?» shows its photo on «Спорные» at once (the set of «?» didn't change).
    const row = tab.find((r) => String(r[0]).trim() === req.team_id);
    if (row && row[at.col - 1] === '?') {
      const full = readMarks_(ss, reg, {log: true});
      queueDisputed_(full, full.known);
      full.w.flush();
    }
    return {ok: true, photo_id: req.photo_id, url};
  });
}
