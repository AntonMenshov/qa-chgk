// Creating a tournament: its Drive folder (Latin names), the Sheet and its tabs, sharing.

/** The «CHGK» folder in My Drive. A trashed one is skipped: Drive still finds it by name. */
const MAX_TRIGGERS = 20;

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
    return {
      ok: true,
      existed: true,
      spreadsheet_id: reg.spreadsheet_id,
      public_id: reg.public_id,
      folder_id: reg.folder_id,
    };
  }
  // Phones keep unsent marks and photos by this ID, so a new tournament under it would inherit them.
  if (props.getProperty(`used:${req.tid}`)) {
    fail(`tournament ID ${req.tid} belonged to a deleted tournament: give config.py another tid, or none`);
  }
  if (ScriptApp.getProjectTriggers().length >= MAX_TRIGGERS) {
    fail(`Google allows ${MAX_TRIGGERS} triggers and all are in use: \`chgk delete\` old tournaments`); // before any file is made
  }
  // Latin names in Drive (user rule); the tabs inside the Sheet stay Russian.
  const names = driveNames(req.tid, req.name, req.date);
  const folder = rootFolder_().createFolder(names.folder);
  const photos = folder.createFolder(names.photos);
  const ss = SpreadsheetApp.create(names.spreadsheet);
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  buildTabs_(ss, req);
  const publicId = createPublicCopy_(ss, {folder_id: folder.getId(), round_sizes: req.round_sizes}, names.results);
  try {
    ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
  } catch (err) {
    fail(`could not add the Sheet's edit trigger (Google allows 20): \`chgk delete\` old tournaments. ${err.message}`);
  }

  const reg = {
    spreadsheet_id: ss.getId(),
    public_id: publicId,
    folder_id: folder.getId(),
    photos_folder_id: photos.getId(),
    jury_token: req.jury_token,
    board_token: req.board_token,
    round_sizes: req.round_sizes,
    name: req.name,
    date: req.date,
  };
  props.setProperty('t:' + req.tid, JSON.stringify(reg));
  publish_(ss, Object.assign({tid: req.tid}, reg), props);
  return {ok: true, existed: false, spreadsheet_id: reg.spreadsheet_id, public_id: publicId, folder_id: reg.folder_id};
}

/** `chgk delete`: the Drive folder to the bin, the Sheet's edit trigger removed, the tournament forgotten. */
function deleteTournament_(props, reg) {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getTriggerSourceId() === reg.spreadsheet_id)
    .forEach((t) => ScriptApp.deleteTrigger(t));
  try {
    DriveApp.getFolderById(reg.folder_id).setTrashed(true);
  } catch {
    // deleted by hand already
  }
  ['t:', 'pub:', 'dirty:'].forEach((prefix) => props.deleteProperty(prefix + reg.tid));
  props.setProperty(`used:${reg.tid}`, '1'); // phones and cards remember this ID: createTournament_
  return {ok: true};
}

function hideServiceTabs_(ss) {
  for (const name of HIDDEN_TABS) {
    const sheet = ss.getSheetByName(name);
    if (sheet && !sheet.isSheetHidden()) {
      sheet.hideSheet();
    }
  }
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
  // Plain text, or a slow write turns team ID 007 into 7 and a juror's «=…» into a formula.
  log.getRange(1, 1, log.getMaxRows(), LOG_HEADER.length).setNumberFormat('@');
  log.getRange(1, 1, 1, LOG_HEADER.length).setValues([LOG_HEADER]).setFontWeight('bold');
  log.setFrozenRows(1);
  const settings = ss.insertSheet(TABS.settings, ss.getSheets().length);
  settings.getRange(1, 1, 6, 2).setNumberFormat('@'); // or a TID such as 01234 comes back as a number
  settings.getRange(1, 1, 6, 2).setValues([
    ['tid', req.tid],
    ['name', req.name],
    ['date', req.date],
    ['round_sizes', JSON.stringify(sizes)],
    ['created', new Date().toISOString()],
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
