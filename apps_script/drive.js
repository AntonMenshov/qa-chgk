// Creating a tournament: its Drive folder (Latin names), the Sheet and its tabs, sharing.

const MAX_TRIGGERS = 20;
const SETTINGS_ROWS = 6;

/** The «CHGK» folder in My Drive. A trashed one is skipped: Drive still finds it by name. */
function rootFolder_() {
  const it = DriveApp.getRootFolder().getFoldersByName(DRIVE_ROOT);
  while (it.hasNext()) {
    const folder = it.next();
    if (!folder.isTrashed()) {
      return folder;
    }
  }
  return DriveApp.getRootFolder().createFolder(DRIVE_ROOT);
}

function createTournament_(props, req) {
  const existing = props.getProperty('t:' + req.tid);
  if (existing) {
    const reg = JSON.parse(existing);
    if (!tokensEqual(reg.jury_token, req.jury_token)) {
      fail(`tournament ${req.tid} already exists`, 'id_taken');
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
    fail(`tournament ID ${req.tid} belonged to a deleted tournament: give config.py another tid, or none`, 'id_taken');
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
  HIDDEN_TABS.forEach((name) => ss.getSheetByName(name).hideSheet());
}

function buildTabs_(ss, req) {
  const sizes = req.round_sizes;
  const summary = ss.getSheets()[0].setName(TABS.summary);
  let tabs = 1;
  const addTab = (name) => ss.insertSheet(name, tabs++);
  const sl = summaryLayout(sizes);
  ensureSize_(summary, 1, sl.width);
  summary.getRange(1, 1, 1, sl.width).setValues([sl.header]).setFontWeight('bold');
  sizes.forEach((_, i) => {
    const lay = roundLayout(sizes, i + 1);
    const sheet = addTab(lay.name);
    ensureSize_(sheet, 1, lay.width);
    sheet.getRange(1, 1, 1, lay.width).setValues([lay.header]).setFontWeight('bold');
  });

  const stats = addTab(TABS.stats);
  formatDisputedTab_(addTab(TABS.disputed));
  const rows = statsRows(sizes);
  stats.getRange(1, 1, rows.length, 4).setValues(rows);
  stats.getRange(1, 1, 1, 4).setFontWeight('bold');
  stats.getRange(2, 4, rows.length - 1, 1).setNumberFormat('0%');

  addTab(TABS.teams).getRange(1, 1, 1, TEAMS_HEADER.length).setValues([TEAMS_HEADER]).setFontWeight('bold');
  const log = addTab(TABS.log);
  // Plain text, or a slow write turns team ID 007 into 7 and a juror's «=…» into a formula.
  log.getRange(1, 1, log.getMaxRows(), LOG_HEADER.length).setNumberFormat('@');
  log.getRange(1, 1, 1, LOG_HEADER.length).setValues([LOG_HEADER]).setFontWeight('bold');
  log.setFrozenRows(1);
  const settings = addTab(TABS.settings);
  settings.getRange(1, 1, SETTINGS_ROWS, 2).setNumberFormat('@'); // or a TID such as 01234 comes back as a number
  settings.getRange(1, 1, SETTINGS_ROWS, 2).setValues([
    ['tid', req.tid],
    ['name', req.name],
    ['date', req.date],
    ['round_sizes', JSON.stringify(sizes)],
    ['created', new Date().toISOString()],
    ['backend_version', VERSION],
  ]);
  // Per team: last-write time of each mark, and the last value the backend knows (metaLayout).
  const meta = addTab(TABS.meta);
  const ml = metaLayout(totalQuestions(sizes));
  ensureSize_(meta, 1, ml.width);
  meta.getRange(1, 1, 1, ml.width).setValues([ml.header]);

  formatSheets_(ss, sizes); // first: names must land in plain-text cells
  writeTeams_(ss, req.teams || [], req.reserve || []);
  syncTeamRows_(ss, sizes, req.teams || []); // reserve teams get rows only once used
  ss.setActiveSheet(summary);
  putDisputed_(ss, disputedBlock_({sizes, teams: []}, {}, {}, 0)); // new: its headings and zero counts
  hideServiceTabs_(ss);
}
