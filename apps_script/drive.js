// Creating a tournament: its Drive folder (Latin names), the Sheet and its tabs, sharing.

/** The «CHGK» folder in My Drive. A trashed one is skipped: Drive still finds it by name. */
function rootFolder_() {
  const root = driveNames('', '', '').root;
  const it = DriveApp.getRootFolder().getFoldersByName(root);
  while (it.hasNext()) {
    const folder = it.next();
    if (!folder.isTrashed()) {
      return folder;
    }
  }
  return DriveApp.getRootFolder().createFolder(root);
}

function createTournament_(props, req) {
  const existing = props.getProperty('t:' + req.tid);
  if (existing) {
    const reg = JSON.parse(existing);
    if (!tokensEqual(reg.jury_token, req.jury_token)) {
      fail(`tournament ${req.tid} already exists`);
    }
    return {ok: true, existed: true, spreadsheet_id: reg.spreadsheet_id, folder_id: reg.folder_id};
  }
  // Latin names in Drive (user rule); the tabs inside the Sheet stay Russian.
  const names = driveNames(req.tid, req.name, req.date);
  const folder = rootFolder_().createFolder(names.folder);
  const photos = folder.createFolder(names.photos);
  const ss = SpreadsheetApp.create(names.spreadsheet);
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  buildTabs_(ss, req);
  shareView_(ss.getId());
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();

  const reg = {
    spreadsheet_id: ss.getId(),
    folder_id: folder.getId(),
    photos_folder_id: photos.getId(),
    jury_token: req.jury_token,
    board_token: req.board_token || null,
    round_sizes: req.round_sizes,
    name: req.name,
    date: req.date,
  };
  props.setProperty('t:' + req.tid, JSON.stringify(reg));
  return {ok: true, existed: false, spreadsheet_id: reg.spreadsheet_id, folder_id: reg.folder_id};
}

function hideServiceTabs_(ss) {
  for (const name of HIDDEN_TABS) {
    const sheet = ss.getSheetByName(name);
    if (sheet && !sheet.isSheetHidden()) {
      sheet.hideSheet();
    }
  }
}

/** Anyone with the link may view the Sheet (the view-only QR on the jury sheet); only the owner edits. */
function shareView_(spreadsheetId) {
  DriveApp.getFileById(spreadsheetId).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
}

function buildTabs_(ss, req) {
  const sizes = req.round_sizes;
  const summary = ss.getSheets()[0].setName(TABS.summary);
  const sl = summaryLayout(sizes);
  ensureSize_(summary, 1, sl.width);
  summary.getRange(1, 1, 1, sl.width).setValues([sl.header]).setFontWeight('bold');
  sizes.forEach((_, i) => {
    const lay = roundLayout(sizes, i + 1);
    const sheet = ss.insertSheet(lay.name, ss.getSheets().length);
    ensureSize_(sheet, 1, lay.width);
    sheet.getRange(1, 1, 1, lay.width).setValues([lay.header]).setFontWeight('bold');
  });

  const stats = ss.insertSheet(TABS.stats, ss.getSheets().length);
  newDisputedTab_(ss);
  const rows = statsRows(sizes);
  stats.getRange(1, 1, rows.length, 4).setValues(rows);
  stats.getRange(1, 1, 1, 4).setFontWeight('bold');
  stats.getRange(2, 4, rows.length - 1, 1).setNumberFormat('0%');

  ss.insertSheet(TABS.teams, ss.getSheets().length)
    .getRange(1, 1, 1, TEAMS_HEADER.length)
    .setValues([TEAMS_HEADER])
    .setFontWeight('bold');
  const log = ss.insertSheet(TABS.log, ss.getSheets().length);
  log.getRange(1, 1, 1, LOG_HEADER.length).setValues([LOG_HEADER]).setFontWeight('bold');
  log.setFrozenRows(1);
  const settings = ss.insertSheet(TABS.settings, ss.getSheets().length);
  settings.getRange(1, 1, 6, 2).setValues([
    ['tid', req.tid],
    ['name', req.name],
    ['date', req.date],
    ['round_sizes', JSON.stringify(sizes)],
    ['created', new Date()],
    ['backend_version', VERSION],
  ]);
  // Per team: last-write time of each mark, and the last value the backend knows (metaLayout).
  const meta = ss.insertSheet(TABS.meta, ss.getSheets().length);
  const ml = metaLayout(totalQuestions(sizes));
  ensureSize_(meta, 1, ml.width);
  meta.getRange(1, 1, 1, ml.width).setValues([ml.header]);

  formatSheets_(ss, sizes); // first: names must land in plain-text cells
  writeTeams_(ss, req.teams || [], req.reserve || []);
  syncTeamRows_(ss, sizes, req.teams || []); // reserve teams get rows only once used
  ss.setActiveSheet(summary);
  refreshDisputed_(ss, sizes);
  hideServiceTabs_(ss);
}
