// Apps Script web app: the only part of chgk that touches Google Sheets and Drive.
// Deploy under any Gmail account (docs/google-account.md); pure logic is in logic.js,
// which shares this file's global scope (the bundle puts both into one Code.gs).

const VERSION = "dev"; // replaced by `chgk backend bundle`
const ROOT_FOLDER = "ЧГК";
// Plus one tab per round, «Тур 1» … «Тур N», right after «Итоги» (see logic.js).
const TABS = { summary: "Итоги", stats: "Stats", teams: "Teams", log: "Log", settings: "Settings", meta: "Meta" };
const TEAMS_HEADER = ["team_id", "name", "city", "logo_file", "reserve"];
const RESERVE_MARK = "да"; // Teams tab, column «reserve»: a deck for a team that turns up unregistered
const LOG_HEADER = ["server_time", "client_time", "scan_id", "source", "juror", "device", "team_id", "question",
  "spare", "status", "value", "applied", "photo"];
const COLORS = { 1: "#d9ead3", 0: "#f4cccc", "?": "#fff2cc", R: "#eeeeee" };
const ROUND_TINTS = ["#cfe2f3", "#fce5cd"]; // header and tab colour, alternating by round
const WIDTHS = { id: 44, name: 180, question: 28, sum: 52 }; // pixels

/** Run once from the editor after deploying: creates the admin token and prints the CLI command. */
function setup() {
  // Google's consent screen lets each permission be unticked; ask for all of them again.
  if (ScriptApp.requireAllScopes) ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty("ADMIN_TOKEN");
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
    props.setProperty("ADMIN_TOKEN", token);
  }
  rootFolder_(); // also triggers the Drive permission prompt now rather than later
  // From the editor getUrl() gives the owner-only /dev test URL; the CLI needs the
  // deployment's /exec URL (Deploy → Manage deployments → Web app URL).
  const service = ScriptApp.getService().getUrl() || "";
  const url = /\/exec$/.test(service) ? service : "<Web app URL ending in /exec>";
  Logger.log("Account: %s\n\nRun on your laptop, with the Web app URL from Deploy → Manage deployments:\n\n" +
    "uv run chgk backend add <name> --url %s --token %s\n", Session.getEffectiveUser().getEmail(), url, token);
}

function doGet() {
  return json_({ ok: true, service: "chgk", version: VERSION });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: "request body is not JSON" });
  }
  try {
    return json_(handle_(body));
  } catch (err) {
    const known = err instanceof RequestError;
    return json_({ ok: false, error: known ? err.message : `server error: ${err && err.message ? err.message : err}` });
  }
}

function handle_(req) {
  validateRequest(req);
  const props = PropertiesService.getScriptProperties();
  if (req.action === "ping") {
    requireAdmin_(props, req);
    return { ok: true, version: VERSION, account: Session.getEffectiveUser().getEmail(), authorized: authorized_() };
  }
  if (req.action === "create_tournament") {
    requireAdmin_(props, req);
    return withLock_(() => createTournament_(props, req));
  }
  const reg = registry_(props, req.tid);
  switch (req.action) {
    case "get_teams":
      requireAdmin_(props, req);
      return { ok: true, teams: readTeams_(open_(reg)) };
    case "set_teams":
      requireAdmin_(props, req);
      return withLock_(() => setTeams_(open_(reg), reg, req.teams));
    case "get_state":
      requireJury_(props, reg, req);
      return readState_(open_(reg), reg);
    case "get_results":
      requireJury_(props, reg, req);
      return readResults_(open_(reg), reg);
    case "record_events":
      requireJury_(props, reg, req);
      return withLock_(() => recordEvents_(open_(reg), reg, req));
    case "get_board":
      requireBoard_(props, reg, req);
      return readBoard_(open_(reg), reg);
    case "set_board_token":
      requireAdmin_(props, req);
      return withLock_(() => {
        reg.board_token = req.board_token;
        props.setProperty("t:" + req.tid, JSON.stringify(reg));
        return { ok: true };
      });
    case "share_view":
      requireAdmin_(props, req);
      shareView_(reg.spreadsheet_id);
      return { ok: true };
  }
  fail("unhandled action");
}

// ---- access ----

/** False when the owner left some permission (Sheets, Drive, triggers) unticked; null if unknown. */
function authorized_() {
  try {
    const info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
    return info.getAuthorizationStatus() !== ScriptApp.AuthorizationStatus.REQUIRED;
  } catch (err) {
    return null;
  }
}

function requireAdmin_(props, req) {
  if (!tokensEqual(req.token, props.getProperty("ADMIN_TOKEN"))) fail("forbidden: admin token required");
}

function requireJury_(props, reg, req) {
  if (!tokensEqual(req.token, reg.jury_token) && !tokensEqual(req.token, props.getProperty("ADMIN_TOKEN"))) {
    fail("forbidden: jury token required");
  }
}

/** The projector board's read-only token; the jury and admin tokens work too. */
function requireBoard_(props, reg, req) {
  if (reg.board_token && tokensEqual(req.token, reg.board_token)) return;
  if (!tokensEqual(req.token, reg.jury_token) && !tokensEqual(req.token, props.getProperty("ADMIN_TOKEN"))) {
    fail("forbidden: board token required");
  }
}

function registry_(props, tid) {
  const raw = props.getProperty("t:" + tid);
  if (!raw) fail(`unknown tournament ${tid}`);
  return JSON.parse(raw);
}

function open_(reg) {
  return SpreadsheetApp.openById(reg.spreadsheet_id);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** New sheets have 1000 × 26 cells; grow before writing beyond that. */
function ensureSize_(sheet, rows, cols) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < cols) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
}

function appendRows_(sheet, rows) {
  if (!rows.length) return;
  const first = sheet.getLastRow() + 1;
  ensureSize_(sheet, first + rows.length - 1, rows[0].length);
  sheet.getRange(first, 1, rows.length, rows[0].length).setValues(rows);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---- tournament creation ----

/** The «ЧГК» folder in My Drive. A trashed one is skipped: Drive still finds it by name. */
function rootFolder_() {
  const it = DriveApp.getRootFolder().getFoldersByName(ROOT_FOLDER);
  while (it.hasNext()) {
    const folder = it.next();
    if (!folder.isTrashed()) return folder;
  }
  return DriveApp.getRootFolder().createFolder(ROOT_FOLDER);
}

function createTournament_(props, req) {
  const existing = props.getProperty("t:" + req.tid);
  if (existing) {
    const reg = JSON.parse(existing);
    if (!tokensEqual(reg.jury_token, req.jury_token)) fail(`tournament ${req.tid} already exists`);
    return { ok: true, existed: true, spreadsheet_id: reg.spreadsheet_id, folder_id: reg.folder_id };
  }
  const folder = rootFolder_().createFolder(`${req.date} ${req.name} (${req.tid})`);
  const photos = folder.createFolder("Фото");
  const ss = SpreadsheetApp.create(`${req.name} ${req.date} (${req.tid})`);
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  buildTabs_(ss, req);
  shareView_(ss.getId());
  ScriptApp.newTrigger("onSheetEdit").forSpreadsheet(ss).onEdit().create();

  const reg = {
    spreadsheet_id: ss.getId(), folder_id: folder.getId(), photos_folder_id: photos.getId(),
    jury_token: req.jury_token, board_token: req.board_token || null, round_sizes: req.round_sizes, name: req.name, date: req.date,
  };
  props.setProperty("t:" + req.tid, JSON.stringify(reg));
  return { ok: true, existed: false, spreadsheet_id: reg.spreadsheet_id, folder_id: reg.folder_id };
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
  summary.getRange(1, 1, 1, sl.width).setValues([sl.header]).setFontWeight("bold");
  sizes.forEach((_, i) => {
    const lay = roundLayout(sizes, i + 1);
    const sheet = ss.insertSheet(lay.name, ss.getSheets().length);
    ensureSize_(sheet, 1, lay.width);
    sheet.getRange(1, 1, 1, lay.width).setValues([lay.header]).setFontWeight("bold");
  });

  const stats = ss.insertSheet(TABS.stats, ss.getSheets().length);
  const rows = statsRows(sizes);
  stats.getRange(1, 1, rows.length, 4).setValues(rows);
  stats.getRange(1, 1, 1, 4).setFontWeight("bold");
  stats.getRange(2, 4, rows.length - 1, 1).setNumberFormat("0%");

  ss.insertSheet(TABS.teams, ss.getSheets().length)
    .getRange(1, 1, 1, TEAMS_HEADER.length).setValues([TEAMS_HEADER]).setFontWeight("bold");
  const log = ss.insertSheet(TABS.log, ss.getSheets().length);
  log.getRange(1, 1, 1, LOG_HEADER.length).setValues([LOG_HEADER]).setFontWeight("bold");
  log.setFrozenRows(1);
  const settings = ss.insertSheet(TABS.settings, ss.getSheets().length);
  settings.getRange(1, 1, 6, 2).setValues([
    ["tid", req.tid], ["name", req.name], ["date", req.date], ["round_sizes", JSON.stringify(sizes)],
    ["created", new Date()], ["backend_version", VERSION],
  ]);
  // Per team: last-write time of each mark, and the last value the backend knows (metaLayout).
  const meta = ss.insertSheet(TABS.meta, ss.getSheets().length);
  const ml = metaLayout(totalQuestions(sizes));
  ensureSize_(meta, 1, ml.width);
  meta.getRange(1, 1, 1, ml.width).setValues([ml.header]);
  meta.hideSheet();

  formatSheets_(ss, sizes); // first: names must land in plain-text cells
  writeTeams_(ss, req.teams || [], req.reserve || []);
  syncTeamRows_(ss, sizes, req.teams || []); // reserve teams get rows only once used
  ss.setActiveSheet(summary);
}

// ---- teams ----

function readTeams_(ss) {
  const sheet = ss.getSheetByName(TABS.teams);
  const n = sheet.getLastRow() - 1;
  if (n < 1) return [];
  return sheet.getRange(2, 1, n, TEAMS_HEADER.length).getValues()
    .map((r, i) => ({
      team_id: String(r[0]).trim(), name: String(r[1]).trim(), city: String(r[2]).trim(),
      logo_file: String(r[3]).trim(), reserve: String(r[4]).trim() !== "", row: i + 2,
    }))
    .filter((t) => t.team_id !== "" || t.name !== "");
}

/**
 * The organiser's teams, then the reserve teams. Reserve rows already on the tab are kept
 * (with any name the jury gave them), unless a registered team now has that ID.
 */
function writeTeams_(ss, teams, newReserve) {
  const sheet = ss.getSheetByName(TABS.teams);
  // Plain text, or Sheets turns a team called «42» into a number.
  sheet.getRange(1, 1, sheet.getMaxRows(), TEAMS_HEADER.length).setNumberFormat("@");
  const registered = new Set(teams.map((t) => t.team_id));
  const reserve = readTeams_(ss).filter((t) => t.reserve && !registered.has(t.team_id))
    .concat((newReserve || []).map((id) => ({ team_id: id, name: "" })));
  const rows = teams.map((t) => [t.team_id, t.name, t.city || "", t.logo_file || "", ""])
    .concat(reserve.map((t) => [t.team_id, t.name, "", "", RESERVE_MARK]));
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, TEAMS_HEADER.length).clearContent();
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
  const reserve = new Map(readTeams_(ss).filter((t) => t.reserve).map((t) => [t.team_id, t]));
  const present = new Set(teamRowsOf_(summaryOf_(ss)).map((t) => t.team_id));
  const add = [...new Set(ids)].filter((id) => reserve.has(id) && !present.has(id))
    .map((id) => ({ team_id: id, name: reserve.get(id).name || reservePlaceholder(id) }));
  if (!add.length) return;
  const teamsTab = ss.getSheetByName(TABS.teams);
  add.forEach((t) => { if (!reserve.get(t.team_id).name) teamsTab.getRange(reserve.get(t.team_id).row, 2).setValue(t.name); });
  syncTeamRows_(ss, sizes, add);
}

/**
 * A name typed in column B of «Итоги», a round tab or Teams goes to every tab. Matched by
 * team ID (rows may have been re-sorted since the edit); a cleared name is put back.
 */
function propagateNames_(ss, sizes, sourceName) {
  const teams = readTeams_(ss);
  const truth = {};
  teams.forEach((t) => { truth[t.team_id] = t.name; });
  if (sourceName !== TABS.teams) {
    const typed = {};
    teamRowsOf_(ss.getSheetByName(sourceName)).forEach((t) => { typed[t.team_id] = t.name; });
    nameEdits(typed, truth).forEach((e) => { truth[e.team_id] = e.name; });
  }
  const teamsTab = ss.getSheetByName(TABS.teams);
  teams.forEach((t) => { if (truth[t.team_id] && t.name !== truth[t.team_id]) teamsTab.getRange(t.row, 2).setValue(truth[t.team_id]); });
  // A reserve team named on the Teams tab before its first scan joins the tabs now.
  activateReserve_(ss, sizes, teams.filter((t) => t.reserve && truth[t.team_id]).map((t) => t.team_id));
  [summaryOf_(ss)].concat(sizes.map((_, i) => ss.getSheetByName(roundSheetName(i + 1)))).forEach((sheet) => {
    teamRowsOf_(sheet).forEach((t) => {
      const want = truth[t.team_id];
      if (want && String(t.rawName) !== want) sheet.getRange(t.row, 2).setValue(want);
    });
  });
}

/** Widths, round tints, borders and mark colours on «Итоги» and the round tabs. Safe to re-run. */
function formatSheets_(ss, sizes) {
  const thick = SpreadsheetApp.BorderStyle.SOLID_MEDIUM;
  const lineBefore = (sheet, col) =>
    sheet.getRange(1, col, sheet.getMaxRows(), 1).setBorder(null, true, null, null, null, null, "#000000", thick);
  const frame = (sheet, width) => {
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(2);
    sheet.setColumnWidth(1, WIDTHS.id);
    sheet.setColumnWidth(2, WIDTHS.name);
    // IDs and names as plain text, left-aligned: otherwise ID 645 or a team called «42» becomes a number.
    sheet.getRange(1, 1, sheet.getMaxRows(), 2).setNumberFormat("@").setHorizontalAlignment("left");
    sheet.getRange(1, FIRST_MARK_COL, sheet.getMaxRows(), width - FIRST_MARK_COL + 1).setHorizontalAlignment("center");
  };

  const meta = ss.getSheetByName(TABS.meta);
  meta.getRange(1, 1, meta.getMaxRows(), 1).setNumberFormat("@");

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
    sheet.setConditionalFormatRules(Object.keys(COLORS).map((v) =>
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied(`=${colLetter(lay.firstCol)}2&""="${v}"`)
        .setBackground(COLORS[v]).setRanges([marks]).build()));
  });
}

/** [{team_id, name, row}] for the rows of a tab that have a team ID in column A. */
function teamRowsOf_(sheet) {
  const n = sheet.getLastRow() - 1;
  if (n < 1) return [];
  return sheet.getRange(2, 1, n, 2).getValues()
    .map((r, i) => ({ team_id: String(r[0]).trim(), name: String(r[1]), rawName: r[1], row: i + 2 }))
    .filter((t) => t.team_id !== "");
}

function summaryOf_(ss) {
  const summary = ss.getSheetByName(TABS.summary);
  if (!summary) fail("this tournament's Sheet uses an older layout (one Results tab): create the tournament again");
  return summary;
}

/** Give every team a row on «Итоги», on each round tab and in Meta; rename changed names. */
function syncTeamRows_(ss, sizes, teams) {
  const tabs = [[summaryOf_(ss), (t, row) => summaryRow(sizes, t, row)]].concat(sizes.map((_, i) => {
    const lay = roundLayout(sizes, i + 1);
    return [ss.getSheetByName(lay.name), (t, row) => roundRow(lay, t, row)];
  }));
  let counts = null;
  tabs.forEach(([sheet, rowFor]) => {
    const existing = teamRowsOf_(sheet);
    // Compare raw values: a name stored as the number 42 gets rewritten as the text "42".
    const plan = planTeamRows(existing.map((r) => ({ team_id: r.team_id, name: r.rawName })), teams);
    plan.rename.forEach((t) => sheet.getRange(existing.find((r) => r.team_id === t.team_id).row, 2).setValue(t.name));
    const first = sheet.getLastRow() + 1;
    appendRows_(sheet, plan.append.map((t, i) => rowFor(t, first + i)));
    counts = counts || { appended: plan.append.length, renamed: plan.rename.length };
  });
  const meta = ss.getSheetByName(TABS.meta);
  const inMeta = new Set(teamRowsOf_(meta).map((t) => t.team_id));
  const ml = metaLayout(totalQuestions(sizes));
  appendRows_(meta, teams.filter((t) => !inMeta.has(t.team_id))
    .map((t) => [t.team_id].concat(new Array(ml.width - 1).fill(""))));
  sortTabs_(ss, sizes, sizes.map((_, i) => i + 1));
  return counts;
}

/**
 * Re-sort round tabs (by «Сумма») and «Итоги» (by Итого, then the last round, …), then
 * rewrite any per-row formula that the move left pointing at another row.
 */
function sortTabs_(ss, sizes, rounds, m) {
  // With the marks at hand (`m` from readMarks_), a tab already in the right order is left
  // alone: most batches don't change the order, and Range.sort plus the formula checks
  // are the slow part of a request.
  const values = {};
  if (m) {
    m.teams.forEach((t) => {
      values[t.team_id] = Array.from({ length: m.n }, (_, k) => (m.cells[`${t.team_id}:${k + 1}`] || { value: "" }).value);
    });
  }
  const inOrder = (current, desired) => current.length === desired.length && current.every((id, i) => id === desired[i]);
  // Formulas are made right before sorting too, since the sort keys are their results.
  const sortTab = (sheet, width, spec, firstFormulaCol, rowFor) => {
    const want = (t, row) => rowFor(t, row).slice(firstFormulaCol - 1);
    refreshFormulas_(sheet, firstFormulaCol, want);
    if (sheet.getLastRow() > 2) sheet.getRange(2, 1, sheet.getLastRow() - 1, width).sort(spec);
    refreshFormulas_(sheet, firstFormulaCol, want);
  };
  rounds.forEach((round) => {
    const lay = roundLayout(sizes, round);
    if (m) {
      const current = Object.keys(values).filter((id) => m.where[`${id}:${lay.first}`])
        .sort((a, b) => m.where[`${a}:${lay.first}`].row - m.where[`${b}:${lay.first}`].row);
      if (inOrder(current, roundOrder(sizes, round, current, values))) return;
    }
    sortTab(ss.getSheetByName(lay.name), lay.width, roundSortSpec(lay), lay.sumCol, (t, row) => roundRow(lay, t, row));
  });
  // Also upgrades «Итоги» formulas written by older versions (e.g. Место as a plain RANK).
  const sl = summaryLayout(sizes);
  const summary = summaryOf_(ss);
  if (m) {
    const current = teamRowsOf_(summary).map((t) => t.team_id);
    if (inOrder(current, summaryOrder(sizes, current, values))) return;
  }
  sortTab(summary, sl.width, summarySortSpec(sizes), sl.firstRound, (t, row) => summaryRow(sizes, t, row));
}

/** Rewrite the formula cells from `firstCol` on every team row where they differ from `want(team, row)`. */
function refreshFormulas_(sheet, firstCol, want) {
  const teams = teamRowsOf_(sheet);
  if (!teams.length) return;
  const width = want(teams[0], teams[0].row).length;
  const last = teams[teams.length - 1].row;
  const formulas = sheet.getRange(2, firstCol, last - 1, width).getFormulas();
  teams.forEach((t) => {
    const w = want(t, t.row);
    if (formulas[t.row - 2].some((f, i) => f !== w[i])) sheet.getRange(t.row, firstCol, 1, width).setValues([w]);
  });
}

function setTeams_(ss, reg, teams) {
  formatSheets_(ss, reg.round_sizes); // also brings Sheets made by older versions up to date
  writeTeams_(ss, teams);
  const counts = syncTeamRows_(ss, reg.round_sizes, teams);
  return { ok: true, appended: counts.appended, renamed: counts.renamed };
}

// ---- marks ----

/** Meta rows by team ID (a missing team gets a row), and its column layout. */
function metaRows_(ss, n) {
  const meta = ss.getSheetByName(TABS.meta);
  const ml = metaLayout(n);
  ensureSize_(meta, 1, ml.width);
  const rows = new Map(teamRowsOf_(meta).map((t) => [t.team_id, t.row]));
  const rowOf = (teamId) => {
    if (!rows.has(teamId)) {
      appendRows_(meta, [[teamId].concat(new Array(ml.width - 1).fill(""))]);
      rows.set(teamId, meta.getLastRow());
    }
    return rows.get(teamId);
  };
  return { meta, ml, rows, rowOf };
}

/**
 * Every mark: "TEAM:Q" → {value, ts}, where it sits now, and the last value the backend
 * knows. Rows are matched by team ID, so the tabs may have been re-sorted in between.
 */
function readMarks_(ss, reg) {
  const sizes = reg.round_sizes;
  const n = totalQuestions(sizes);
  // ID order (the order of the cards), not the standings order of «Итоги».
  const teams = teamRowsOf_(summaryOf_(ss)).map((t) => ({ team_id: t.team_id, name: t.name }))
    .sort((a, b) => (a.team_id < b.team_id ? -1 : a.team_id > b.team_id ? 1 : 0));
  const cells = {};
  const where = {};
  sizes.forEach((_, i) => {
    const lay = roundLayout(sizes, i + 1);
    const sheet = ss.getSheetByName(lay.name);
    const last = sheet.getLastRow();
    if (last < 2) return;
    sheet.getRange(2, 1, last - 1, lay.sumCol - 1).getValues().forEach((r, j) => {
      const id = String(r[0]).trim();
      if (!id) return;
      for (let k = 0; k < lay.size; k++) {
        const key = `${id}:${lay.first + k}`;
        cells[key] = { value: r[lay.firstCol - 1 + k], ts: 0 };
        where[key] = { sheet, row: j + 2, col: lay.firstCol + k, round: i + 1 };
      }
    });
  });

  const m = metaRows_(ss, n);
  const known = {};
  // Sheets from before the known-value columns: start from what is on the tabs now.
  const upgrade = m.meta.getRange(1, m.ml.knownCol(1)).getValue() !== "v1";
  if (upgrade) m.meta.getRange(1, 1, 1, m.ml.width).setValues([m.ml.header]);
  const lastMeta = m.meta.getLastRow();
  if (lastMeta >= 2) {
    m.meta.getRange(2, 1, lastMeta - 1, m.ml.width).getValues().forEach((r, j) => {
      const id = String(r[0]).trim();
      for (let q = 1; q <= n; q++) {
        const key = `${id}:${q}`;
        if (!cells[key]) continue;
        cells[key].ts = Number(r[m.ml.tsCol(q) - 1]) || 0;
        known[key] = upgrade ? cells[key].value : r[m.ml.knownCol(q) - 1];
      }
      if (upgrade) {
        const row = Array.from({ length: n }, (_, k) => (cells[`${id}:${k + 1}`] || { value: "" }).value);
        m.meta.getRange(j + 2, m.ml.knownCol(1), 1, n).setValues([row]);
      }
    });
  }
  return { sizes, n, teams, cells, where, known, meta: m };
}

/** Store a mark's value and time: on its round tab (if `toTab`) and in Meta. */
function writeMark_(m, key, cell, toTab) {
  const at = m.where[key];
  if (toTab) at.sheet.getRange(at.row, at.col).setValue(cell.value);
  const [teamId, q] = key.split(":");
  const row = m.meta.rowOf(teamId);
  m.meta.meta.getRange(row, m.meta.ml.tsCol(Number(q))).setValue(cell.ts);
  m.meta.meta.getRange(row, m.meta.ml.knownCol(Number(q))).setValue(cell.value);
  m.known[key] = cell.value;
}

/**
 * Pick up jury edits on the round tabs (see sheetEdits): normalise them («+» → 1),
 * time-stamp and log them. Returns the rounds that changed.
 */
function applySheetEdits_(ss, m, user) {
  const current = {};
  Object.keys(m.cells).forEach((key) => { current[key] = m.cells[key].value; });
  const now = Date.now();
  const rows = [];
  const rounds = new Set();
  sheetEdits(current, m.known).forEach((edit) => {
    const at = m.where[edit.key];
    const range = at.sheet.getRange(at.row, at.col);
    if (edit.status === null) {
      range.setNote("Непонятное значение: используйте 1, 0, ? или R");
      return;
    }
    range.clearNote();
    m.cells[edit.key] = { value: edit.value, ts: now };
    writeMark_(m, edit.key, m.cells[edit.key], edit.raw !== edit.value);
    rounds.add(at.round);
    const [teamId, q] = edit.key.split(":");
    rows.push([new Date(now), new Date(now), `sheet-${now}-${edit.key}`, "sheet", user, "", teamId, Number(q), "",
      edit.status, edit.value, true, ""]);
  });
  appendRows_(ss.getSheetByName(TABS.log), rows);
  return rounds;
}

function readState_(ss, reg) {
  const m = readMarks_(ss, reg);
  const reserve = readTeams_(ss).filter((t) => t.reserve);
  const reserveIds = new Set(reserve.map((t) => t.team_id));
  const present = new Set(m.teams.map((t) => t.team_id));
  // Phones need reserve IDs too, to accept those cards before their first scan.
  const teams = m.teams.map((t) => ({ team_id: t.team_id, name: t.name, reserve: reserveIds.has(t.team_id) }))
    .concat(reserve.filter((t) => !present.has(t.team_id))
      .map((t) => ({ team_id: t.team_id, name: t.name || reservePlaceholder(t.team_id), reserve: true })));
  const marks = {};
  teams.forEach((t) => {
    marks[t.team_id] = Array.from({ length: m.n }, (_, k) => {
      const cell = m.cells[`${t.team_id}:${k + 1}`];
      return cell ? cell.value : "";
    });
  });
  return {
    ok: true,
    tournament: { name: reg.name, date: reg.date, round_sizes: reg.round_sizes },
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
    marks[t.team_id] = Array.from({ length: m.n }, (_, k) => {
      const cell = m.cells[`${t.team_id}:${k + 1}`];
      return cell ? cell.value : "";
    });
  });
  return {
    ok: true,
    tournament: { name: reg.name, date: reg.date, round_sizes: reg.round_sizes },
    teams: m.teams,
    marks,
  };
}

/** «Итоги» and Stats as Google computed them: for the board, and to check the formulas live. */
function readResults_(ss, reg) {
  const sizes = reg.round_sizes;
  const summary = summaryOf_(ss);
  const sl = summaryLayout(sizes);
  const last = summary.getLastRow();
  const standings = last < 2 ? [] : summary.getRange(2, 1, last - 1, sl.width).getValues()
    .filter((r) => String(r[0]).trim() !== "")
    .map((r) => ({
      team_id: String(r[0]).trim(), name: String(r[1]),
      rounds: r.slice(sl.firstRound - 1, sl.totalCol - 1), total: r[sl.totalCol - 1], place: r[sl.placeCol - 1],
    }));
  const n = totalQuestions(sizes);
  const stats = ss.getSheetByName(TABS.stats).getRange(2, 1, n, 4).getValues()
    .map((r) => ({ question: r[0], round: r[1], took: r[2], share: r[3] }));
  return { ok: true, standings, stats };
}

function recordEvents_(ss, reg, req) {
  // A reserve team's first valid scan puts it on the tabs.
  const reserveIds = new Set(readTeams_(ss).filter((t) => t.reserve).map((t) => t.team_id));
  const nowMs = Date.now();
  activateReserve_(ss, reg.round_sizes, req.events
    .filter((ev) => ev && reserveIds.has(ev.team_id) && !eventError(ev, new Set([ev.team_id]), reg.round_sizes, nowMs))
    .map((ev) => ev.team_id));
  const m = readMarks_(ss, reg);
  // Jury edits first, so they get their time before app marks are compared with them.
  const rounds = applySheetEdits_(ss, m, "");
  const cells = m.cells;
  const before = Object.assign({}, cells);
  const log = ss.getSheetByName(TABS.log);
  const nLog = log.getLastRow() - 1;
  const seen = new Set(nLog > 0 ? log.getRange(2, 3, nLog, 1).getValues().map((r) => String(r[0])) : []);
  // Teams with rows on the round tabs can be marked. Unused reserve teams count as known,
  // so their invalid events report the real problem (their valid ones activated them above).
  const teamIds = new Set(m.teams.map((t) => t.team_id).filter((id) => m.where[`${id}:1`]).concat([...reserveIds]));

  const outcomes = applyEvents(cells, seen, req.events, teamIds, reg.round_sizes, Date.now());

  // Write only the cells that changed, so a juror editing the sheet at the same moment is not overwritten.
  Object.keys(cells).forEach((key) => {
    if (cells[key] === before[key]) return;
    writeMark_(m, key, cells[key], true);
    rounds.add(m.where[key].round);
  });

  const now = new Date();
  const logRows = [];
  req.events.forEach((ev, k) => {
    const o = outcomes[k];
    if (o.error || o.duplicate) return;
    logRows.push([now, new Date(ev.client_ts), ev.scan_id, "app", ev.juror || "", ev.device || "", ev.team_id,
      ev.question, ev.spare || "", ev.status, STATUS_VALUE[ev.status], o.applied, ev.photo || ""]);
  });
  appendRows_(log, logRows);
  if (rounds.size) sortTabs_(ss, reg.round_sizes, [...rounds], m);
  return { ok: true, results: outcomes };
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
  if (!isRound && name !== TABS.summary && name !== TABS.teams) return;
  if (e.range.getRow() + e.range.getNumRows() - 1 < 2) return; // header only
  const ss = sheet.getParent();
  const settings = ss.getSheetByName(TABS.settings).getRange(1, 1, 6, 2).getValues();
  const sizes = JSON.parse(settings.find((r) => r[0] === "round_sizes")[1]);
  // Columns never move, so the columns still tell what was touched.
  const first = e.range.getColumn();
  const last = first + e.range.getNumColumns() - 1;
  const touchesNames = first <= 2 && last >= 2;
  let touchesMarks = false;
  for (let c = first; c <= last && isRound; c++) if (questionAt(sizes, name, 2, c) !== null) touchesMarks = true;
  if (!touchesNames && !touchesMarks) return;
  const user = e.user && e.user.getEmail ? e.user.getEmail() : "";

  withLock_(() => {
    if (touchesNames) propagateNames_(ss, sizes, name);
    if (touchesMarks) {
      const m = readMarks_(ss, { round_sizes: sizes });
      const rounds = applySheetEdits_(ss, m, user);
      if (rounds.size) sortTabs_(ss, sizes, [...rounds], m);
    }
  });
}
