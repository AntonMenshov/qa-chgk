// Apps Script web app: the only part of chgk that touches Google Sheets and Drive.
// Deploy under any Gmail account (docs/google-account.md); pure logic is in logic.js,
// which shares this file's global scope (the bundle puts both into one Code.gs).

const VERSION = 'dev'; // replaced by `chgk backend bundle`
// Plus one tab per round, «Тур 1» … «Тур N», right after «Итоги» (see logic.js).
const TABS = {
  summary: 'Итоги',
  stats: 'Статистика',
  disputed: 'Спорные',
  teams: 'Teams',
  log: 'Log',
  settings: 'Settings',
  meta: 'Meta',
};
// Hidden, so the view-only link (`…/htmlview`) shows only «Итоги», the round tabs and «Статистика».
// Google hides a tab for everyone: editors open these from the list of sheets (☰).
const HIDDEN_TABS = [TABS.disputed, TABS.teams, TABS.log, TABS.settings, TABS.meta];
const TEAMS_HEADER = ['team_id', 'name', 'city', 'logo_file', 'reserve'];
const RESERVE_MARK = 'да'; // Teams tab, column «reserve»: a deck for a team that turns up unregistered
const LOG_HEADER = [
  'server_time',
  'client_time',
  'scan_id',
  'source',
  'juror',
  'device',
  'team_id',
  'question',
  'spare',
  'status',
  'value',
  'applied',
  'photo',
];
const COLORS = {1: '#d9ead3', 0: '#f4cccc', '?': '#fff2cc', R: '#eeeeee'};
const ROUND_TINTS = ['#cfe2f3', '#fce5cd']; // header and tab colour, alternating by round
const WIDTHS = {id: 44, name: 180, question: 28, sum: 52}; // pixels

/** Run once from the editor after deploying: creates the admin token and prints the CLI command. */
function setup() {
  // Google's consent screen lets each permission be unticked; ask for all of them again.
  if (ScriptApp.requireAllScopes) {
    ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  }
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('ADMIN_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('ADMIN_TOKEN', token);
  }
  rootFolder_(); // also triggers the Drive permission prompt now rather than later
  // From the editor getUrl() gives the owner-only /dev test URL; the CLI needs the
  // deployment's /exec URL (Deploy → Manage deployments → Web app URL).
  const service = ScriptApp.getService().getUrl() || '';
  const url = /\/exec$/.test(service) ? service : '<Web app URL ending in /exec>';
  Logger.log(
    'Account: %s\n\nRun on your laptop, with the Web app URL from Deploy → Manage deployments:\n\n' +
      'uv run chgk backend add <name> --url %s --token %s\n',
    Session.getEffectiveUser().getEmail(),
    url,
    token,
  );
}

function doGet() {
  return json_({ok: true, service: 'chgk', version: VERSION});
}

// ---- per-step timings ----
// Every successful reply carries `timing`: milliseconds per step of this request, plus
// `rest` (our own logic and small calls) and `total` (doPost start to reply). The client's
// own clock minus `total` is Google's part: starting the script and passing the request.

let timing = null;

/** Run fn, adding its milliseconds to step `step` of this request's timing. */
function timed_(step, fn) {
  const start = Date.now();
  try {
    return fn();
  } finally {
    if (timing) {
      timing[step] = (timing[step] || 0) + Date.now() - start;
    }
  }
}

function doPost(e) {
  const start = Date.now();
  timing = {};
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch {
    return json_({ok: false, error: 'request body is not JSON'});
  }
  try {
    const reply = handle_(body);
    const total = Date.now() - start;
    const steps = Object.keys(timing).reduce((sum, step) => sum + timing[step], 0);
    reply.timing = Object.assign({}, timing, {rest: total - steps, total});
    return json_(reply);
  } catch (err) {
    const known = err instanceof RequestError;
    // retry: false — the request itself is wrong, sending it again won't help (the phone's
    // photo queue then drops it instead of retrying).
    return json_({
      ok: false,
      error: known ? err.message : `server error: ${err && err.message ? err.message : err}`,
      retry: !known,
    });
  }
}

function handle_(req) {
  validateRequest(req);
  const props = timed_('access', () => PropertiesService.getScriptProperties());
  if (req.action === 'ping') {
    requireAdmin_(props, req);
    return {
      ok: true,
      version: VERSION,
      account: Session.getEffectiveUser().getEmail(),
      authorized: authorized_(),
      sheets_api: sheetsApi_(),
    };
  }
  if (req.action === 'create_tournament') {
    requireAdmin_(props, req);
    return withLock_(() => createTournament_(props, req));
  }
  const reg = timed_('access', () => registry_(props, req.tid));
  switch (req.action) {
    case 'get_teams':
      requireAdmin_(props, req);
      return {ok: true, teams: readTeams_(open_(reg))};
    case 'set_teams':
      requireAdmin_(props, req);
      return withLock_(() => setTeams_(open_(reg), reg, req.teams));
    case 'get_state':
      requireJury_(props, reg, req);
      return readState_(open_(reg), reg);
    case 'get_results':
      requireJury_(props, reg, req);
      return readResults_(open_(reg), reg);
    case 'record_events':
      requireJury_(props, reg, req);
      return withLock_(() => recordEvents_(open_(reg), reg, req));
    case 'get_board':
      requireBoard_(props, reg, req);
      return readBoard_(open_(reg), reg);
    case 'set_board_token':
      requireAdmin_(props, req);
      return withLock_(() => {
        reg.board_token = req.board_token;
        props.setProperty('t:' + req.tid, JSON.stringify(reg));
        return {ok: true};
      });
    case 'upload_photo':
      requireJury_(props, reg, req);
      return uploadPhoto_(open_(reg), reg, req);
  }
  fail('unhandled action');
}

// ---- access ----

/** False when the owner left some permission (Sheets, Drive, triggers) unticked; null if unknown. */
function authorized_() {
  try {
    const info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
    return info.getAuthorizationStatus() !== ScriptApp.AuthorizationStatus.REQUIRED;
  } catch {
    return null;
  }
}

function requireAdmin_(props, req) {
  if (!tokensEqual(req.token, props.getProperty('ADMIN_TOKEN'))) {
    fail('forbidden: admin token required');
  }
}

function requireJury_(props, reg, req) {
  if (!tokensEqual(req.token, reg.jury_token) && !tokensEqual(req.token, props.getProperty('ADMIN_TOKEN'))) {
    fail('forbidden: jury token required');
  }
}

/** The projector board's read-only token; the jury and admin tokens work too. */
function requireBoard_(props, reg, req) {
  if (reg.board_token && tokensEqual(req.token, reg.board_token)) {
    return;
  }
  if (!tokensEqual(req.token, reg.jury_token) && !tokensEqual(req.token, props.getProperty('ADMIN_TOKEN'))) {
    fail('forbidden: board token required');
  }
}

function registry_(props, tid) {
  const raw = props.getProperty('t:' + tid);
  if (!raw) {
    fail(`unknown tournament ${tid}`);
  }
  return Object.assign(JSON.parse(raw), {tid});
}

function saveRegistry_(reg) {
  PropertiesService.getScriptProperties().setProperty('t:' + reg.tid, JSON.stringify(reg));
}

/**
 * The tournament's spreadsheet, opened only when something needs it: opening costs ~0.3 s
 * (profiled), and the batched read, the batched write and the one-call sort need only its
 * ID. The methods are the ones the backend uses on a spreadsheet.
 */
function open_(reg) {
  let ss = null;
  const real = () => ss || (ss = timed_('open', () => SpreadsheetApp.openById(reg.spreadsheet_id)));
  return {
    getId: () => reg.spreadsheet_id,
    getSheetByName: (name) => real().getSheetByName(name),
    getSheets: () => real().getSheets(),
    insertSheet: (...args) => real().insertSheet(...args),
    setActiveSheet: (sheet) => real().setActiveSheet(sheet),
  };
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  timed_('lock', () => lock.waitLock(30000));
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** New sheets have 1000 × 26 cells; grow before writing beyond that. */
function ensureSize_(sheet, rows, cols) {
  if (sheet.getMaxRows() < rows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < cols) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
  }
}

function appendRows_(sheet, rows) {
  if (!rows.length) {
    return;
  }
  const first = sheet.getLastRow() + 1;
  ensureSize_(sheet, first + rows.length - 1, rows[0].length);
  sheet.getRange(first, 1, rows.length, rows[0].length).setValues(rows);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---- tournament creation ----

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

// ---- teams ----

function readTeams_(ss) {
  const sheet = ss.getSheetByName(TABS.teams);
  const n = sheet.getLastRow() - 1;
  if (n < 1) {
    return [];
  }
  return teamsFromRows_(sheet.getRange(2, 1, n, TEAMS_HEADER.length).getValues());
}

/** Teams tab rows (from row 2) → [{team_id, name, city, logo_file, reserve, row}]. */
function teamsFromRows_(values) {
  return values
    .map((r, i) => ({
      team_id: String(r[0]).trim(),
      name: String(r[1]).trim(),
      city: String(r[2]).trim(),
      logo_file: String(r[3]).trim(),
      reserve: String(r[4]).trim() !== '',
      row: i + 2,
    }))
    .filter((t) => t.team_id !== '' || t.name !== '');
}

/**
 * The organiser's teams, then the reserve teams. Reserve rows already on the tab are kept
 * (with any name the jury gave them), unless a registered team now has that ID.
 */
function writeTeams_(ss, teams, newReserve) {
  const sheet = ss.getSheetByName(TABS.teams);
  // Plain text, or Sheets turns a team called «42» into a number.
  sheet.getRange(1, 1, sheet.getMaxRows(), TEAMS_HEADER.length).setNumberFormat('@');
  const registered = new Set(teams.map((t) => t.team_id));
  const reserve = readTeams_(ss)
    .filter((t) => t.reserve && !registered.has(t.team_id))
    .concat((newReserve || []).map((id) => ({team_id: id, name: ''})));
  const rows = teams
    .map((t) => [t.team_id, t.name, t.city || '', t.logo_file || '', ''])
    .concat(reserve.map((t) => [t.team_id, t.name, '', '', RESERVE_MARK]));
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, TEAMS_HEADER.length).clearContent();
  }
  if (rows.length) {
    ensureSize_(sheet, rows.length + 1, TEAMS_HEADER.length);
    sheet.getRange(2, 1, rows.length, TEAMS_HEADER.length).setValues(rows);
  }
}

// ---- reserve teams and names ----

/**
 * Put reserve teams on «Итоги», the round tabs and Meta (their first scan, or the jury
 * naming them on the Teams tab). Until then they stay off, so an unused reserve does not
 * share last place with anyone.
 */
function activateReserve_(ss, sizes, ids) {
  const reserve = new Map(
    readTeams_(ss)
      .filter((t) => t.reserve)
      .map((t) => [t.team_id, t]),
  );
  const present = new Set(teamRowsOf_(summaryOf_(ss)).map((t) => t.team_id));
  const add = [...new Set(ids)]
    .filter((id) => reserve.has(id) && !present.has(id))
    .map((id) => ({team_id: id, name: reserve.get(id).name || reservePlaceholder(id)}));
  if (!add.length) {
    return;
  }
  const teamsTab = ss.getSheetByName(TABS.teams);
  add.forEach((t) => {
    if (!reserve.get(t.team_id).name) {
      teamsTab.getRange(reserve.get(t.team_id).row, 2).setValue(t.name);
    }
  });
  syncTeamRows_(ss, sizes, add);
}

/**
 * A name typed in column B of «Итоги», a round tab or Teams goes to every tab. Matched by
 * team ID (rows may have been re-sorted since the edit); a cleared name is put back.
 */
function propagateNames_(ss, sizes, sourceName) {
  const teams = readTeams_(ss);
  const truth = {};
  teams.forEach((t) => {
    truth[t.team_id] = t.name;
  });
  if (sourceName !== TABS.teams) {
    const typed = {};
    teamRowsOf_(ss.getSheetByName(sourceName)).forEach((t) => {
      typed[t.team_id] = t.name;
    });
    nameEdits(typed, truth).forEach((e) => {
      truth[e.team_id] = e.name;
    });
  }
  const teamsTab = ss.getSheetByName(TABS.teams);
  teams.forEach((t) => {
    if (truth[t.team_id] && t.name !== truth[t.team_id]) {
      teamsTab.getRange(t.row, 2).setValue(truth[t.team_id]);
    }
  });
  // A reserve team named on the Teams tab before its first scan joins the tabs now.
  activateReserve_(
    ss,
    sizes,
    teams.filter((t) => t.reserve && truth[t.team_id]).map((t) => t.team_id),
  );
  [summaryOf_(ss)].concat(sizes.map((_, i) => ss.getSheetByName(roundSheetName(i + 1)))).forEach((sheet) => {
    teamRowsOf_(sheet).forEach((t) => {
      const want = truth[t.team_id];
      if (want && String(t.rawName) !== want) {
        sheet.getRange(t.row, 2).setValue(want);
      }
    });
  });
}

/** Widths, round tints, borders and mark colours on «Итоги» and the round tabs. Safe to re-run. */
function formatSheets_(ss, sizes) {
  const thick = SpreadsheetApp.BorderStyle.SOLID_MEDIUM;
  const lineBefore = (sheet, col) =>
    sheet.getRange(1, col, sheet.getMaxRows(), 1).setBorder(null, true, null, null, null, null, '#000000', thick);
  const frame = (sheet, width) => {
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(2);
    sheet.setColumnWidth(1, WIDTHS.id);
    sheet.setColumnWidth(2, WIDTHS.name);
    // IDs and names as plain text, left-aligned: otherwise ID 645 or a team called «42» becomes a number.
    sheet.getRange(1, 1, sheet.getMaxRows(), 2).setNumberFormat('@').setHorizontalAlignment('left');
    sheet.getRange(1, FIRST_MARK_COL, sheet.getMaxRows(), width - FIRST_MARK_COL + 1).setHorizontalAlignment('center');
  };

  const meta = ss.getSheetByName(TABS.meta);
  meta.getRange(1, 1, meta.getMaxRows(), 1).setNumberFormat('@');

  const summary = ss.getSheetByName(TABS.summary);
  const sl = summaryLayout(sizes);
  frame(summary, sl.width);
  summary.setColumnWidths(sl.firstRound, sl.width - sl.firstRound + 1, WIDTHS.sum);
  lineBefore(summary, sl.totalCol);

  sizes.forEach((_, i) => {
    const lay = roundLayout(sizes, i + 1);
    const tint = ROUND_TINTS[i % ROUND_TINTS.length];
    summary.getRange(1, sl.firstRound + i).setBackground(tint);

    const sheet = ss.getSheetByName(lay.name);
    frame(sheet, lay.width);
    sheet.setTabColor(tint);
    sheet.getRange(1, lay.firstCol, 1, lay.size).setBackground(tint);
    sheet.setColumnWidths(lay.firstCol, lay.size, WIDTHS.question);
    sheet.setColumnWidth(lay.sumCol, WIDTHS.sum);
    lineBefore(sheet, lay.sumCol);
    const marks = sheet.getRange(2, lay.firstCol, sheet.getMaxRows() - 1, lay.size);
    sheet.setConditionalFormatRules(
      Object.keys(COLORS).map((v) =>
        SpreadsheetApp.newConditionalFormatRule()
          .whenFormulaSatisfied(`=${colLetter(lay.firstCol)}2&""="${v}"`)
          .setBackground(COLORS[v])
          .setRanges([marks])
          .build(),
      ),
    );
  });
}

/** [{team_id, name, rawName, row}] for the rows of a tab that have a team ID in column A. */
function teamRowsOf_(sheet) {
  const n = sheet.getLastRow() - 1;
  if (n < 1) {
    return [];
  }
  return sheet
    .getRange(2, 1, n, 2)
    .getValues()
    .map((r, i) => ({team_id: String(r[0]).trim(), name: String(r[1]), rawName: r[1], row: i + 2}))
    .filter((t) => t.team_id !== '');
}

function summaryOf_(ss) {
  const summary = ss.getSheetByName(TABS.summary);
  if (!summary) {
    fail(`the Sheet has no «${TABS.summary}» tab`);
  }
  return summary;
}

/**
 * Give every team a row on «Итоги», on each round tab and in Meta; rename changed names;
 * re-sort. Returns {appended, renamed} as counted on «Итоги».
 */
function syncTeamRows_(ss, sizes, teams) {
  const tabs = [[summaryOf_(ss), (t, row) => summaryRow(sizes, t, row)]].concat(
    sizes.map((_, i) => {
      const lay = roundLayout(sizes, i + 1);
      return [ss.getSheetByName(lay.name), (t, row) => roundRow(lay, t, row)];
    }),
  );
  let counts = null;
  tabs.forEach(([sheet, rowFor]) => {
    const existing = teamRowsOf_(sheet);
    // Compare raw values: a name stored as the number 42 gets rewritten as the text "42".
    const plan = planTeamRows(
      existing.map((r) => ({team_id: r.team_id, name: r.rawName})),
      teams,
    );
    plan.rename.forEach((t) => sheet.getRange(existing.find((r) => r.team_id === t.team_id).row, 2).setValue(t.name));
    const first = sheet.getLastRow() + 1;
    appendRows_(
      sheet,
      plan.append.map((t, i) => rowFor(t, first + i)),
    );
    counts = counts || {appended: plan.append.length, renamed: plan.rename.length};
  });
  const meta = ss.getSheetByName(TABS.meta);
  const inMeta = new Set(teamRowsOf_(meta).map((t) => t.team_id));
  const ml = metaLayout(totalQuestions(sizes));
  appendRows_(
    meta,
    teams.filter((t) => !inMeta.has(t.team_id)).map((t) => [t.team_id].concat(new Array(ml.width - 1).fill(''))),
  );
  sortTabs_(
    ss,
    sizes,
    sizes.map((_, i) => i + 1),
  );
  return counts;
}

/**
 * Re-sort round tabs (by «Сумма») and «Итоги» (by Итого, then the last round, …), then
 * rewrite any per-row formula that the move left pointing at another row.
 */
function sortTabs_(ss, sizes, rounds, m, reg) {
  // With the marks at hand (`m` from readMarks_), a tab already in the right order is left
  // alone: most batches don't change the order.
  const values = {};
  if (m) {
    m.teams.forEach((t) => {
      values[t.team_id] = Array.from({length: m.n}, (_, k) => (m.cells[`${t.team_id}:${k + 1}`] || {value: ''}).value);
    });
  }
  const inOrder = (current, desired) =>
    current.length === desired.length && current.every((id, i) => id === desired[i]);
  // Each tab to sort, with (given `m`) the rows its teams are on now.
  const tabs = [];
  rounds.forEach((round) => {
    const lay = roundLayout(sizes, round);
    let rows = null;
    if (m) {
      const current = Object.keys(values)
        .filter((id) => m.where[`${id}:${lay.first}`])
        .sort((a, b) => m.where[`${a}:${lay.first}`].row - m.where[`${b}:${lay.first}`].row);
      if (inOrder(current, roundOrder(sizes, round, current, values))) {
        return;
      }
      rows = current.map((id) => m.where[`${id}:${lay.first}`].row);
    }
    tabs.push({
      name: lay.name,
      width: lay.width,
      spec: roundSortSpec(lay),
      firstFormulaCol: lay.sumCol,
      rowFor: (t, row) => roundRow(lay, t, row),
      rows,
    });
  });
  // Without `m` (set_teams, new rows) «Итоги» is always re-sorted, which also rewrites any formula that differs.
  const sl = summaryLayout(sizes);
  const summaryTab = {
    name: TABS.summary,
    width: sl.width,
    spec: summarySortSpec(sizes),
    firstFormulaCol: sl.firstRound,
    rowFor: (t, row) => summaryRow(sizes, t, row),
    rows: null,
  };
  if (m) {
    const current = m.summaryRows.map((t) => t.team_id);
    if (!inOrder(current, summaryOrder(sizes, current, values))) {
      tabs.push(Object.assign(summaryTab, {rows: m.summaryRows.map((t) => t.row)}));
    }
  } else {
    tabs.push(summaryTab);
  }
  if (!tabs.length) {
    return;
  }
  if (m && m.sortKeysOk && reg && sheetsApi_() && sortWithApi_(ss, reg, tabs)) {
    return;
  }
  // The slow way: per tab, read the formulas and fix the wrong ones, sort, fix them again.
  tabs.forEach((tab) => {
    const sheet = tab.name === TABS.summary ? summaryOf_(ss) : ss.getSheetByName(tab.name);
    const want = (t, row) => tab.rowFor(t, row).slice(tab.firstFormulaCol - 1);
    timed_('sort_formulas', () => refreshFormulas_(sheet, tab.firstFormulaCol, want));
    timed_('sort_range', () => {
      if (sheet.getLastRow() > 2) {
        sheet.getRange(2, 1, sheet.getLastRow() - 1, tab.width).sort(tab.spec);
      }
    });
    timed_('sort_formulas', () => refreshFormulas_(sheet, tab.firstFormulaCol, want));
  });
}

/**
 * Sort tabs in one Sheets API call. Per tab: sort the team rows, then rewrite the formula
 * columns (a moved formula may point at its old row); they depend only on the row number,
 * so they are not read. Not written before the sort: seen live, a formula written earlier
 * in the same call is not yet calculated when sortRange runs, so every key looks blank and
 * the rows end up in ID order; hence the caller's m.sortKeysOk check. Needs the teams on
 * rows 2…n+1 with no gaps; otherwise, or when the call fails (quota; a cached tab ID that
 * no longer exists, then dropped), returns false and the caller sorts the slow way.
 */
function sortWithApi_(ss, reg, tabs) {
  const contiguous = tabs.every((tab) =>
    tab.rows
      .slice()
      .sort((a, b) => a - b)
      .every((row, i) => row === i + 2),
  );
  if (!contiguous) {
    return false;
  }
  try {
    const ids = sheetIds_(
      ss,
      reg,
      tabs.map((tab) => tab.name),
    );
    const requests = [];
    tabs.forEach((tab) => {
      const n = tab.rows.length;
      if (!n) {
        return;
      }
      const sheetId = ids[tab.name];
      const formulas = {
        start: {sheetId, rowIndex: 1, columnIndex: tab.firstFormulaCol - 1},
        rows: Array.from({length: n}, (_, i) => ({
          values: tab
            .rowFor({team_id: '', name: ''}, i + 2)
            .slice(tab.firstFormulaCol - 1)
            .map((f) => ({userEnteredValue: {formulaValue: f}})),
        })),
        fields: 'userEnteredValue',
      };
      if (n > 1) {
        requests.push({
          sortRange: {
            range: {sheetId, startRowIndex: 1, endRowIndex: n + 1, startColumnIndex: 0, endColumnIndex: tab.width},
            sortSpecs: tab.spec.map((s) => ({
              dimensionIndex: s.column - 1,
              sortOrder: s.ascending === false ? 'DESCENDING' : 'ASCENDING',
            })),
          },
        });
      }
      requests.push({updateCells: formulas});
    });
    if (requests.length) {
      timed_('sort', () => Sheets.Spreadsheets.batchUpdate({requests}, ss.getId()));
    }
    return true;
  } catch {
    if (reg.sheet_ids) {
      delete reg.sheet_ids;
      saveRegistry_(reg);
    }
    return false;
  }
}

/** Tab IDs ("gid") by name, cached in the tournament's registry; fetched with one API call when a name is missing. */
function sheetIds_(ss, reg, names) {
  if (!reg.sheet_ids || !names.every((name) => typeof reg.sheet_ids[name] === 'number')) {
    const res = timed_('sheet_ids', () =>
      Sheets.Spreadsheets.get(ss.getId(), {fields: 'sheets.properties(sheetId,title)'}),
    );
    reg.sheet_ids = {};
    res.sheets.forEach((t) => {
      reg.sheet_ids[t.properties.title] = t.properties.sheetId;
    });
    saveRegistry_(reg);
  }
  names.forEach((name) => {
    if (typeof reg.sheet_ids[name] !== 'number') {
      fail(`the Sheet has no «${name}» tab`);
    }
  });
  return reg.sheet_ids;
}

/** Rewrite the formula cells from `firstCol` on every team row where they differ from `want(team, row)`. */
function refreshFormulas_(sheet, firstCol, want) {
  const teams = teamRowsOf_(sheet);
  if (!teams.length) {
    return;
  }
  const width = want(teams[0], teams[0].row).length;
  const last = teams[teams.length - 1].row;
  const formulas = sheet.getRange(2, firstCol, last - 1, width).getFormulas();
  teams.forEach((t) => {
    const w = want(t, t.row);
    if (formulas[t.row - 2].some((f, i) => f !== w[i])) {
      sheet.getRange(t.row, firstCol, 1, width).setValues([w]);
    }
  });
}

function setTeams_(ss, reg, teams) {
  formatSheets_(ss, reg.round_sizes); // safe to re-run
  writeTeams_(ss, teams);
  const counts = syncTeamRows_(ss, reg.round_sizes, teams);
  refreshDisputed_(ss, reg.round_sizes); // names may have changed
  return {ok: true, appended: counts.appended, renamed: counts.renamed};
}

// ---- one read and one write per request ----
// With the «Google Sheets API» advanced service on (editor: Services + → Google Sheets API),
// a request reads everything it needs in one Values.batchGet and writes in one
// Values.batchUpdate (profiled: ~8 separate reads and 3 single-cell writes per mark were
// most of a request's 4-5 s). Without it, or when a call fails (quota: 60 per minute per
// account; a tab too small or missing), the same work goes through SpreadsheetApp.

const SHEETS_API_GROW = 1000; // rows added at a time when a write runs past a tab's grid

/** True when the advanced service is on. */
function sheetsApi_() {
  return typeof Sheets !== 'undefined' && Boolean(Sheets.Spreadsheets && Sheets.Spreadsheets.Values);
}

/** A1 range on a named tab; `rows` null = down to the last row. */
function a1_(name, row, col, rows, cols) {
  const end = rows ? row + rows - 1 : '';
  return `'${name.replace(/'/g, "''")}'!${colLetter(col)}${row}:${colLetter(col + cols - 1)}${end}`;
}

/**
 * Read blocks {name, row, col, cols, rows?} at once. Each comes back as rows padded to
 * `cols` with "", trailing empty rows dropped; row k of a block is sheet row `row + k`.
 */
function readBlocks_(ss, specs) {
  const pad = (rows, cols) => rows.map((r) => Array.from({length: cols}, (_, i) => (i < r.length ? r[i] : '')));
  if (sheetsApi_()) {
    try {
      const res = timed_('read', () =>
        Sheets.Spreadsheets.Values.batchGet(ss.getId(), {
          ranges: specs.map((b) => a1_(b.name, b.row, b.col, b.rows, b.cols)),
          valueRenderOption: 'UNFORMATTED_VALUE',
        }),
      );
      return specs.map((b, i) => pad(res.valueRanges[i].values || [], b.cols));
    } catch {
      // quota or a transient error: read the slow way below
    }
  }
  return timed_('read_fallback', () => readBlocksSlowly_(ss, specs));
}

function readBlocksSlowly_(ss, specs) {
  return specs.map((b) => {
    const sheet = b.name === TABS.summary ? summaryOf_(ss) : ss.getSheetByName(b.name);
    if (!sheet) {
      fail(`the Sheet has no «${b.name}» tab`);
    }
    const last = b.rows ? b.row + b.rows - 1 : sheet.getLastRow();
    if (last < b.row) {
      return [];
    }
    const rows = sheet.getRange(b.row, b.col, last - b.row + 1, b.cols).getValues();
    while (rows.length && rows[rows.length - 1].every((v) => v === '')) {
      rows.pop();
    }
    return rows;
  });
}

/** Collects value writes; flush() sends them in one call (RAW: "42" stays text, "?" stays "?"). */
function writer_(ss) {
  const data = [];
  return {
    set(name, row, col, values) {
      if (values.length) {
        data.push({name, row, col, values});
      }
    },
    get size() {
      return data.length;
    },
    flush() {
      if (!data.length) {
        return;
      }
      const batch = data.splice(0, data.length);
      if (sheetsApi_()) {
        try {
          timed_('write', () =>
            Sheets.Spreadsheets.Values.batchUpdate(
              {
                valueInputOption: 'RAW',
                data: batch.map((d) => ({
                  range: a1_(d.name, d.row, d.col, d.values.length, d.values[0].length),
                  values: d.values,
                })),
              },
              ss.getId(),
            ),
          );
          return;
        } catch {
          // a tab too small (Log grows all game) or no «Спорные» (older Sheets): the slow way grows or creates it
        }
      }
      timed_('write_fallback', () => writeSlowly_(ss, batch));
    },
  };
}

function writeSlowly_(ss, batch) {
  batch.forEach((d) => {
    const sheet = ss.getSheetByName(d.name);
    if (!sheet) {
      fail(`the Sheet has no «${d.name}» tab`);
    }
    const lastRow = d.row + d.values.length - 1;
    if (sheet.getMaxRows() < lastRow) {
      ensureSize_(sheet, lastRow + SHEETS_API_GROW, 1);
    }
    ensureSize_(sheet, 1, d.col + d.values[0].length - 1);
    sheet.getRange(d.row, d.col, d.values.length, d.values[0].length).setValues(d.values);
  });
}

/** Log time as text in the script's time zone (the Sheets API takes no Date objects). */
function logTime_(ms) {
  scriptTimeZone = scriptTimeZone || Session.getScriptTimeZone(); // once per request: it showed in the timings
  return Utilities.formatDate(new Date(ms), scriptTimeZone, 'yyyy-MM-dd HH:mm:ss');
}

let scriptTimeZone = null;

/**
 * Every mark: "TEAM:Q" → {value, ts}, where it sits now, and the last value the backend
 * knows; all in one read. Rows are matched by team ID, so the tabs may have been re-sorted
 * in between. `with_.teams` adds the Teams tab (m.teamsTab), `with_.log` the Log (m.log:
 * scan IDs, photos, next free row). Writes go to `m.w`, sent by `m.w.flush()`.
 */
function readMarks_(ss, reg, with_) {
  const opts = with_ || {};
  const sizes = reg.round_sizes;
  const n = totalQuestions(sizes);
  const ml = metaLayout(n);
  const lays = sizes.map((_, i) => roundLayout(sizes, i + 1));
  const logFirst = LOG_HEADER.indexOf('scan_id') + 1;
  const logCols = LOG_HEADER.length - logFirst + 1;
  const sl = summaryLayout(sizes);
  // With the computed sort keys: «Итоги» up to Итого, round tabs up to «Сумма».
  const specs = [
    {name: TABS.summary, row: 2, col: 1, cols: sl.totalCol},
    {name: TABS.meta, row: 1, col: 1, cols: ml.width},
  ].concat(lays.map((lay) => ({name: lay.name, row: 2, col: 1, cols: lay.sumCol})));
  if (opts.teams) {
    specs.push({name: TABS.teams, row: 2, col: 1, cols: TEAMS_HEADER.length});
  }
  if (opts.log) {
    specs.push({name: TABS.log, row: 2, col: logFirst, cols: logCols});
  }
  const blocks = readBlocks_(ss, specs);
  const w = writer_(ss);

  // «Итоги» as it is now, row by row (sortTabs_ checks its order without reading it again).
  const summaryRows = [];
  blocks[0].forEach((r, j) => {
    const id = String(r[0]).trim();
    if (id) {
      summaryRows.push({team_id: id, row: j + 2});
    }
  });
  // ID order (the order of the cards), not the standings order of «Итоги».
  const teams = blocks[0]
    .map((r) => ({team_id: String(r[0]).trim(), name: String(r[1])}))
    .filter((t) => t.team_id !== '')
    .sort((a, b) => (a.team_id < b.team_id ? -1 : a.team_id > b.team_id ? 1 : 0));
  const cells = {};
  const where = {};
  // The sort keys as the Sheet computed them must agree with the marks read with them; a
  // formula overwritten by hand makes them disagree, and then sortTabs_ takes the slow way,
  // which repairs formulas before sorting (the one-call sort can't: see sortWithApi_).
  let sortKeysOk = true;
  const roundSums = {};
  lays.forEach((lay, i) => {
    blocks[2 + i].forEach((r, j) => {
      const id = String(r[0]).trim();
      if (!id) {
        return;
      }
      let took = 0;
      for (let k = 0; k < lay.size; k++) {
        const key = `${id}:${lay.first + k}`;
        cells[key] = {value: r[lay.firstCol - 1 + k], ts: 0};
        where[key] = {name: lay.name, row: j + 2, col: lay.firstCol + k, round: i + 1};
        took += cells[key].value === 1 ? 1 : 0;
      }
      (roundSums[id] = roundSums[id] || [])[i] = took;
      sortKeysOk = sortKeysOk && r[lay.sumCol - 1] === took;
    });
  });
  blocks[0].forEach((r) => {
    const id = String(r[0]).trim();
    if (id) {
      const sums = lays.map((_, i) => (roundSums[id] || [])[i] || 0);
      sums.forEach((sum, i) => {
        sortKeysOk = sortKeysOk && r[sl.firstRound - 1 + i] === sum;
      });
      sortKeysOk = sortKeysOk && r[sl.totalCol - 1] === sums.reduce((a, b) => a + b, 0);
    }
  });

  const metaBlock = blocks[1];
  const known = {};
  const rows = new Map();
  metaBlock.slice(1).forEach((r, j) => {
    const id = String(r[0]).trim();
    if (!id) {
      return;
    }
    rows.set(id, j + 2);
    for (let q = 1; q <= n; q++) {
      const key = `${id}:${q}`;
      if (!cells[key]) {
        continue;
      }
      cells[key].ts = Number(r[ml.tsCol(q) - 1]) || 0;
      known[key] = r[ml.knownCol(q) - 1];
    }
  });
  const meta = {ml, rows, next: Math.max(metaBlock.length, 1) + 1};

  const m = {sizes, n, teams, summaryRows, cells, where, known, meta, w, sortKeysOk};
  const extra = blocks.slice(2 + lays.length); // the optional blocks, in the order requested
  if (opts.teams) {
    m.teamsTab = teamsFromRows_(extra.shift());
  }
  if (opts.log) {
    const logRows = extra.shift();
    const at = (name) => LOG_HEADER.indexOf(name) + 1 - logFirst;
    const photos = {};
    logRows.forEach((r) => {
      const photo = String(r[at('photo')]).trim();
      if (photo) {
        photos[`${String(r[at('team_id')]).trim()}:${Number(r[at('question')])}`] = photo;
      }
    });
    m.log = {seen: new Set(logRows.map((r) => String(r[0]))), photos, next: logRows.length + 2};
  }
  return m;
}

/** Meta row of a team; a team without one gets the next free row (written with the rest). */
function metaRowOf_(m, teamId) {
  if (!m.meta.rows.has(teamId)) {
    const row = m.meta.next++;
    m.w.set(TABS.meta, row, 1, [[teamId].concat(new Array(m.meta.ml.width - 1).fill(''))]);
    m.meta.rows.set(teamId, row);
  }
  return m.meta.rows.get(teamId);
}

/** Store a mark's value and time: on its round tab (if `toTab`) and in Meta. */
function writeMark_(m, key, cell, toTab) {
  const at = m.where[key];
  if (toTab) {
    m.w.set(at.name, at.row, at.col, [[cell.value]]);
  }
  const [teamId, q] = key.split(':');
  const row = metaRowOf_(m, teamId);
  m.w.set(TABS.meta, row, m.meta.ml.tsCol(Number(q)), [[cell.ts]]);
  m.w.set(TABS.meta, row, m.meta.ml.knownCol(Number(q)), [[cell.value]]);
  m.known[key] = cell.value;
}

/** Queue Log rows after the last one; their scan IDs and photos count from now on. */
function appendLog_(m, rows) {
  if (!rows.length) {
    return;
  }
  m.w.set(TABS.log, m.log.next, 1, rows);
  const col = (name) => LOG_HEADER.indexOf(name);
  rows.forEach((r) => {
    m.log.seen.add(String(r[col('scan_id')]));
    if (r[col('photo')]) {
      m.log.photos[`${r[col('team_id')]}:${r[col('question')]}`] = r[col('photo')];
    }
  });
  m.log.next += rows.length;
}

/**
 * Pick up jury edits on the round tabs (see sheetEdits): normalise them («+» → 1),
 * time-stamp and log them. Returns the rounds that changed. Needs `m` read with the Log.
 */
function applySheetEdits_(ss, m, user) {
  const current = {};
  Object.keys(m.cells).forEach((key) => {
    current[key] = m.cells[key].value;
  });
  const now = Date.now();
  const rows = [];
  const rounds = new Set();
  sheetEdits(current, m.known).forEach((edit) => {
    const at = m.where[edit.key];
    // Notes are not values: these go through SpreadsheetApp (jury edits are rare).
    const range = ss.getSheetByName(at.name).getRange(at.row, at.col);
    if (edit.status === null) {
      timed_('notes', () => range.setNote('Непонятное значение: используйте 1, 0, ? или R'));
      return;
    }
    timed_('notes', () => range.clearNote());
    m.cells[edit.key] = {value: edit.value, ts: now};
    writeMark_(m, edit.key, m.cells[edit.key], edit.raw !== edit.value);
    rounds.add(at.round);
    const [teamId, q] = edit.key.split(':');
    rows.push([
      logTime_(now),
      logTime_(now),
      `sheet-${now}-${edit.key}`,
      'sheet',
      user,
      '',
      teamId,
      Number(q),
      '',
      edit.status,
      edit.value,
      true,
      '',
    ]);
  });
  appendLog_(m, rows);
  return rounds;
}

// ---- card photos (Phase 4) ----

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
  scriptTimeZone = scriptTimeZone || Session.getScriptTimeZone();
  const stamp = Utilities.formatDate(new Date(req.client_ts), scriptTimeZone, 'yyyyMMdd-HHmmss');
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

// ---- «Спорные»: every undecided «?» (user request) ----

/** {"TEAM:Q": mark} from readMarks_. */
function markValues_(m) {
  const values = {};
  Object.keys(m.cells).forEach((key) => {
    values[key] = m.cells[key].value;
  });
  return values;
}

// A-D the list, E-F empty, G-H the counts (user request: well clear of the photo links).
const DISPUTED_WIDTH = 8;
const DISPUTED_COUNTS_COL = 7;
const DISPUTED_WIDTHS = [50, 70, 200, 360, 30, 30, 200, 70]; // pixels, A-H

function newDisputedTab_(ss) {
  const sheet = ss.insertSheet(TABS.disputed, ss.getSheets().length);
  sheet.hideSheet();
  formatDisputedTab_(sheet);
  return sheet;
}

/** Column widths and formats of «Спорные». */
function formatDisputedTab_(sheet) {
  ensureSize_(sheet, 1, DISPUTED_WIDTH);
  DISPUTED_WIDTHS.forEach((width, i) => sheet.setColumnWidth(i + 1, width));
  const rows = sheet.getMaxRows();
  // Team names (C and G) as plain text, or a team called «42» becomes a number.
  sheet.getRange(1, 3, rows, 1).setNumberFormat('@');
  sheet.getRange(1, DISPUTED_COUNTS_COL, rows, 1).setNumberFormat('@');
  // A long photo link is cut at its column's edge instead of running over the next ones.
  sheet.getRange(1, 4, rows, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
}

/** «Спорные» as one block of rows, DISPUTED_WIDTH wide, at least `minRows` long (blank rows clear old ones). */
function disputedBlock_(m, values, photos, minRows) {
  const names = {};
  m.teams.forEach((t) => {
    names[t.team_id] = t.name;
  });
  const {list, summary} = disputedSheet(m.sizes, names, values, photos);
  const n = Math.max(list.length, summary.length, minRows || 0);
  return Array.from({length: n}, (_, i) => (list[i] || ['', '', '', '']).concat(['', ''], summary[i] || ['', '']));
}

/** Rewrite «Спорные» completely. Needs `m` read with the Log. */
function writeDisputed_(ss, m) {
  const sheet = ss.getSheetByName(TABS.disputed);
  const block = disputedBlock_(m, markValues_(m), m.log.photos, 0);
  const last = sheet.getLastRow();
  if (last > 0) {
    sheet.getRange(1, 1, last, DISPUTED_WIDTH).clearContent();
  }
  ensureSize_(sheet, block.length, DISPUTED_WIDTH);
  sheet.getRange(1, 1, block.length, DISPUTED_WIDTH).setValues(block);
  sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  sheet.getRange(1, DISPUTED_COUNTS_COL, block.length, 1).setFontWeight('bold');
}

/** What «Спорные» shows now, from the values the backend knows (a jury edit is already on the tab). */
function disputedBefore_(m) {
  return {keys: disputedKeys(m.known).join(), rows: disputedBlock_(m, m.known, {}, 0).length};
}

/**
 * Queue a rewrite of «Спорные» with the request's other writes, only when the set of «?»
 * marks changed (most requests leave it alone). The block is padded to the old length, so
 * rows of «?» that went away are cleared.
 */
function updateDisputed_(m, before) {
  if (disputedKeys(markValues_(m)).join() === before.keys) {
    return;
  }
  m.w.set(TABS.disputed, 1, 1, disputedBlock_(m, markValues_(m), m.log.photos, before.rows));
}

/** Full rewrite after SpreadsheetApp writes (names, teams). */
function refreshDisputed_(ss, sizes) {
  SpreadsheetApp.flush(); // the batched read must see them
  writeDisputed_(ss, readMarks_(ss, {round_sizes: sizes}, {log: true}));
}

function readState_(ss, reg) {
  const m = readMarks_(ss, reg, {teams: true});
  const reserve = m.teamsTab.filter((t) => t.reserve);
  const reserveIds = new Set(reserve.map((t) => t.team_id));
  const present = new Set(m.teams.map((t) => t.team_id));
  // Phones need reserve IDs too, to accept those cards before their first scan.
  const teams = m.teams
    .map((t) => ({team_id: t.team_id, name: t.name, reserve: reserveIds.has(t.team_id)}))
    .concat(
      reserve
        .filter((t) => !present.has(t.team_id))
        .map((t) => ({team_id: t.team_id, name: t.name || reservePlaceholder(t.team_id), reserve: true})),
    );
  const marks = {};
  teams.forEach((t) => {
    marks[t.team_id] = Array.from({length: m.n}, (_, k) => {
      const cell = m.cells[`${t.team_id}:${k + 1}`];
      return cell ? cell.value : '';
    });
  });
  return {
    ok: true,
    tournament: {name: reg.name, date: reg.date, round_sizes: reg.round_sizes},
    teams: teams,
    marks: marks,
  };
}

/**
 * What the projector board needs: the teams on the tabs (not unused reserves) and every
 * mark. The board decides which rounds to show and computes places from those alone.
 */
function readBoard_(ss, reg) {
  const m = readMarks_(ss, reg);
  const marks = {};
  m.teams.forEach((t) => {
    marks[t.team_id] = Array.from({length: m.n}, (_, k) => {
      const cell = m.cells[`${t.team_id}:${k + 1}`];
      return cell ? cell.value : '';
    });
  });
  return {
    ok: true,
    tournament: {name: reg.name, date: reg.date, round_sizes: reg.round_sizes},
    teams: m.teams,
    marks,
    // The view-only table, for its QR code on the board (the same link as on the jury sheet).
    view_url: `https://docs.google.com/spreadsheets/d/${reg.spreadsheet_id}/htmlview`,
  };
}

/** «Итоги» and «Статистика» as Google computed them, to check the formulas live (tests). */
function readResults_(ss, reg) {
  const sizes = reg.round_sizes;
  const summary = summaryOf_(ss);
  const sl = summaryLayout(sizes);
  const last = summary.getLastRow();
  const standings =
    last < 2
      ? []
      : summary
          .getRange(2, 1, last - 1, sl.width)
          .getValues()
          .filter((r) => String(r[0]).trim() !== '')
          .map((r) => ({
            team_id: String(r[0]).trim(),
            name: String(r[1]),
            rounds: r.slice(sl.firstRound - 1, sl.totalCol - 1),
            total: r[sl.totalCol - 1],
            place: r[sl.placeCol - 1],
          }));
  const n = totalQuestions(sizes);
  const stats = ss
    .getSheetByName(TABS.stats)
    .getRange(2, 1, n, 4)
    .getValues()
    .map((r) => ({question: r[0], round: r[1], took: r[2], share: r[3]}));
  return {ok: true, standings, stats};
}

function recordEvents_(ss, reg, req) {
  let m = readMarks_(ss, reg, {teams: true, log: true});
  // A reserve team's first valid scan puts it on the tabs (rare: then read again).
  const reserveIds = new Set(m.teamsTab.filter((t) => t.reserve).map((t) => t.team_id));
  const nowMs = Date.now();
  const activate = req.events
    .filter(
      (ev) =>
        ev &&
        reserveIds.has(ev.team_id) &&
        !m.where[`${ev.team_id}:1`] &&
        !eventError(ev, new Set([ev.team_id]), reg.round_sizes, nowMs),
    )
    .map((ev) => ev.team_id);
  if (activate.length) {
    timed_('reserve', () => {
      activateReserve_(ss, reg.round_sizes, activate);
      SpreadsheetApp.flush();
    });
    m = readMarks_(ss, reg, {teams: true, log: true});
  }
  const disputedBefore = disputedBefore_(m);
  // Jury edits first, so they get their time before app marks are compared with them.
  const rounds = applySheetEdits_(ss, m, '');
  const cells = m.cells;
  const before = Object.assign({}, cells);
  // Teams with rows on the round tabs can be marked. Unused reserve teams count as known,
  // so their invalid events report the real problem (their valid ones activated them above).
  const teamIds = new Set(
    m.teams
      .map((t) => t.team_id)
      .filter((id) => m.where[`${id}:1`])
      .concat([...reserveIds]),
  );

  const outcomes = applyEvents(cells, m.log.seen, req.events, teamIds, reg.round_sizes, Date.now());

  // Write only the cells that changed, so a juror editing the sheet at the same moment is not overwritten.
  Object.keys(cells).forEach((key) => {
    if (cells[key] === before[key]) {
      return;
    }
    writeMark_(m, key, cells[key], true);
    rounds.add(m.where[key].round);
  });

  const now = logTime_(Date.now());
  const logRows = [];
  req.events.forEach((ev, k) => {
    const o = outcomes[k];
    if (o.error || o.duplicate) {
      return;
    }
    logRows.push([
      now,
      logTime_(ev.client_ts),
      ev.scan_id,
      'app',
      ev.juror || '',
      ev.device || '',
      ev.team_id,
      ev.question,
      ev.spare || '',
      ev.status,
      STATUS_VALUE[ev.status],
      o.applied,
      ev.photo || '',
    ]);
  });
  appendLog_(m, logRows);
  updateDisputed_(m, disputedBefore);
  m.w.flush(); // before sorting: the rows above are where the read found them
  if (rounds.size) {
    sortTabs_(ss, reg.round_sizes, [...rounds], m, reg);
  }
  return {ok: true, results: outcomes};
}

/**
 * Installable onEdit trigger. Marks on a round tab: found by comparing every mark with the
 * last known value (not by e.range, whose row may hold another team by now if the tab was
 * re-sorted), then the tabs are re-sorted. Names in column B of «Итоги», a round tab or
 * Teams: copied to every tab by team ID.
 */
function onSheetEdit(e) {
  const sheet = e.range.getSheet();
  const name = sheet.getName();
  const isRound = /^Тур \d+$/.test(name);
  if (!isRound && name !== TABS.summary && name !== TABS.teams) {
    return;
  }
  if (e.range.getRow() + e.range.getNumRows() - 1 < 2) {
    return;
  } // header only
  const ss = sheet.getParent();
  const settings = ss.getSheetByName(TABS.settings).getRange(1, 1, 6, 2).getValues();
  const sizes = JSON.parse(settings.find((r) => r[0] === 'round_sizes')[1]);
  const tid = String((settings.find((r) => r[0] === 'tid') || [])[1] || '');
  // Columns never move, so the columns still tell what was touched.
  const first = e.range.getColumn();
  const last = first + e.range.getNumColumns() - 1;
  const touchesNames = first <= 2 && last >= 2;
  let touchesMarks = false;
  for (let c = first; c <= last && isRound; c++) {
    if (questionAt(sizes, name, 2, c) !== null) {
      touchesMarks = true;
    }
  }
  if (!touchesNames && !touchesMarks) {
    return;
  }
  const user = e.user && e.user.getEmail ? e.user.getEmail() : '';

  withLock_(() => {
    if (touchesNames) {
      propagateNames_(ss, sizes, name);
      refreshDisputed_(ss, sizes);
    }
    if (touchesMarks) {
      SpreadsheetApp.flush(); // names written just above must be in the batched read
      const m = readMarks_(ss, {round_sizes: sizes}, {log: true});
      const disputedBefore = disputedBefore_(m);
      const rounds = applySheetEdits_(ss, m, user);
      updateDisputed_(m, disputedBefore);
      m.w.flush();
      if (rounds.size) {
        let reg = null;
        try {
          reg = registry_(PropertiesService.getScriptProperties(), tid);
        } catch {
          // a Sheet the backend doesn't know (copied?): sort the slow way
        }
        sortTabs_(ss, sizes, [...rounds], m, reg);
      }
    }
  });
}
