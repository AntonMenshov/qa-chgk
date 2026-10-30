// Apps Script web app: the only part of chgk that touches Google Sheets and Drive.
// Deploy under any Gmail account (docs/google-account.md); pure logic is in logic.js,
// which shares this file's global scope (the bundle puts both into one Code.gs).

const VERSION = "dev"; // replaced by `chgk backend bundle`
const ROOT_FOLDER = "ЧГК";
const TABS = { results: "Results", stats: "Stats", teams: "Teams", log: "Log", settings: "Settings", meta: "Meta" };
const TEAMS_HEADER = ["team_id", "name", "city", "logo_file"];
const LOG_HEADER = ["server_time", "client_time", "scan_id", "source", "juror", "device", "team_id", "question",
  "spare", "status", "value", "applied", "photo"];
const COLORS = { 1: "#d9ead3", 0: "#f4cccc", "?": "#fff2cc", R: "#eeeeee" };

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
    case "record_events":
      requireJury_(props, reg, req);
      return withLock_(() => recordEvents_(open_(reg), reg, req));
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

function rootFolder_() {
  const it = DriveApp.getRootFolder().getFoldersByName(ROOT_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(ROOT_FOLDER);
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
  ScriptApp.newTrigger("onSheetEdit").forSpreadsheet(ss).onEdit().create();

  const reg = {
    spreadsheet_id: ss.getId(), folder_id: folder.getId(), photos_folder_id: photos.getId(),
    jury_token: req.jury_token, round_sizes: req.round_sizes, name: req.name, date: req.date,
  };
  props.setProperty("t:" + req.tid, JSON.stringify(reg));
  return { ok: true, existed: false, spreadsheet_id: reg.spreadsheet_id, folder_id: reg.folder_id };
}

function buildTabs_(ss, req) {
  const lay = resultsLayout(req.round_sizes);
  const results = ss.getSheets()[0].setName(TABS.results);
  ensureSize_(results, 1, lay.width);
  results.getRange(1, 1, 1, lay.width).setValues([lay.header]).setFontWeight("bold");
  results.setFrozenRows(1);
  results.setFrozenColumns(2);
  const marks = results.getRange(2, lay.firstQ, results.getMaxRows() - 1, lay.n);
  results.setConditionalFormatRules(Object.keys(COLORS).map((v) =>
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=${colLetter(lay.firstQ)}2&""="${v}"`)
      .setBackground(COLORS[v]).setRanges([marks]).build()));

  const stats = ss.insertSheet(TABS.stats);
  const rows = statsRows(req.round_sizes);
  stats.getRange(1, 1, rows.length, 4).setValues(rows);
  stats.getRange(1, 1, 1, 4).setFontWeight("bold");
  stats.getRange(2, 4, rows.length - 1, 1).setNumberFormat("0%");

  ss.insertSheet(TABS.teams).getRange(1, 1, 1, TEAMS_HEADER.length).setValues([TEAMS_HEADER]).setFontWeight("bold");
  const log = ss.insertSheet(TABS.log);
  log.getRange(1, 1, 1, LOG_HEADER.length).setValues([LOG_HEADER]).setFontWeight("bold");
  log.setFrozenRows(1);
  const settings = ss.insertSheet(TABS.settings);
  settings.getRange(1, 1, 6, 2).setValues([
    ["tid", req.tid], ["name", req.name], ["date", req.date], ["round_sizes", JSON.stringify(req.round_sizes)],
    ["created", new Date()], ["backend_version", VERSION],
  ]);
  const meta = ss.insertSheet(TABS.meta); // last-write timestamps, same shape as the marks block
  ensureSize_(meta, 1, lay.n);
  meta.hideSheet();

  writeTeams_(ss, req.teams || []);
  appendResultRows_(ss, req.round_sizes, req.teams || []);
  ss.setActiveSheet(results);
}

// ---- teams ----

function readTeams_(ss) {
  const sheet = ss.getSheetByName(TABS.teams);
  const n = sheet.getLastRow() - 1;
  if (n < 1) return [];
  return sheet.getRange(2, 1, n, TEAMS_HEADER.length).getValues()
    .filter((r) => r.some((v) => String(v).trim() !== ""))
    .map((r) => ({ team_id: String(r[0]).trim(), name: String(r[1]).trim(), city: String(r[2]).trim(), logo_file: String(r[3]).trim() }));
}

function writeTeams_(ss, teams) {
  const sheet = ss.getSheetByName(TABS.teams);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, TEAMS_HEADER.length).clearContent();
  if (teams.length) {
    sheet.getRange(2, 1, teams.length, TEAMS_HEADER.length)
      .setValues(teams.map((t) => [t.team_id, t.name, t.city || "", t.logo_file || ""]));
  }
}

function resultTeamRows_(results) {
  const n = results.getLastRow() - 1;
  if (n < 1) return [];
  return results.getRange(2, 1, n, 2).getValues().map((r) => ({ team_id: String(r[0]), name: String(r[1]) }));
}

function appendResultRows_(ss, roundSizes, teams) {
  if (!teams.length) return;
  const results = ss.getSheetByName(TABS.results);
  const first = results.getLastRow() + 1;
  appendRows_(results, teams.map((t, i) => resultsRow(roundSizes, t, first + i)));
  const meta = ss.getSheetByName(TABS.meta);
  ensureSize_(meta, first - 1 + teams.length, resultsLayout(roundSizes).n);
}

function setTeams_(ss, reg, teams) {
  writeTeams_(ss, teams);
  const results = ss.getSheetByName(TABS.results);
  const existing = resultTeamRows_(results);
  const plan = planTeamRows(existing, teams);
  plan.rename.forEach((t) => {
    const row = existing.findIndex((r) => r.team_id === t.team_id) + 2;
    results.getRange(row, 2).setValue(t.name);
  });
  appendResultRows_(ss, reg.round_sizes, plan.append);
  return { ok: true, appended: plan.append.length, renamed: plan.rename.length };
}

// ---- marks ----

function readMarks_(ss, reg) {
  const lay = resultsLayout(reg.round_sizes);
  const results = ss.getSheetByName(TABS.results);
  const teams = resultTeamRows_(results);
  const values = teams.length ? results.getRange(2, lay.firstQ, teams.length, lay.n).getValues() : [];
  const stamps = teams.length ? ss.getSheetByName(TABS.meta).getRange(1, 1, teams.length, lay.n).getValues() : [];
  return { lay, results, teams, values, stamps };
}

function readState_(ss, reg) {
  const m = readMarks_(ss, reg);
  const marks = {};
  m.teams.forEach((t, i) => { marks[t.team_id] = m.values[i]; });
  return {
    ok: true,
    tournament: { name: reg.name, date: reg.date, round_sizes: reg.round_sizes },
    teams: m.teams,
    marks: marks,
  };
}

function recordEvents_(ss, reg, req) {
  const m = readMarks_(ss, reg);
  const cells = {};
  m.teams.forEach((t, i) => {
    for (let q = 1; q <= m.lay.n; q++) {
      cells[`${t.team_id}:${q}`] = { value: m.values[i][q - 1], ts: Number(m.stamps[i][q - 1]) || 0 };
    }
  });
  const before = Object.assign({}, cells);
  const log = ss.getSheetByName(TABS.log);
  const nLog = log.getLastRow() - 1;
  const seen = new Set(nLog > 0 ? log.getRange(2, 3, nLog, 1).getValues().map((r) => String(r[0])) : []);

  const outcomes = applyEvents(cells, seen, req.events, new Set(m.teams.map((t) => t.team_id)), reg.round_sizes, Date.now());

  // Write only the cells that changed, so a juror editing the sheet at the same moment is not overwritten.
  const meta = ss.getSheetByName(TABS.meta);
  const rowOf = new Map(m.teams.map((t, i) => [t.team_id, i]));
  Object.keys(cells).forEach((key) => {
    if (cells[key] === before[key]) return;
    const [teamId, q] = key.split(":");
    const i = rowOf.get(teamId);
    m.results.getRange(i + 2, m.lay.firstQ + Number(q) - 1).setValue(cells[key].value);
    meta.getRange(i + 1, Number(q)).setValue(cells[key].ts);
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
  return { ok: true, results: outcomes };
}

/** Installable onEdit trigger on each tournament sheet: jury edits in Results are logged and time-stamped. */
function onSheetEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== TABS.results) return;
  const ss = sheet.getParent();
  const settings = ss.getSheetByName(TABS.settings).getRange(1, 1, 6, 2).getValues();
  const roundSizes = JSON.parse(settings.find((r) => r[0] === "round_sizes")[1]);
  const lay = resultsLayout(roundSizes);
  const user = e.user && e.user.getEmail ? e.user.getEmail() : "";

  withLock_(() => {
    const meta = ss.getSheetByName(TABS.meta);
    const log = ss.getSheetByName(TABS.log);
    const now = Date.now();
    const rows = [];
    const values = e.range.getValues();
    values.forEach((rowValues, dr) => rowValues.forEach((raw, dc) => {
      const row = e.range.getRow() + dr;
      const col = e.range.getColumn() + dc;
      const q = col - lay.firstQ + 1;
      if (row < 2 || q < 1 || q > lay.n) return;
      const cell = sheet.getRange(row, col);
      const status = normalizeCellInput(raw);
      if (status === null) {
        cell.setNote("Непонятное значение: используйте 1, 0, ? или R");
        return;
      }
      cell.clearNote();
      const value = STATUS_VALUE[status];
      if (raw !== value) cell.setValue(value);
      meta.getRange(row - 1, q).setValue(now);
      const teamId = String(sheet.getRange(row, 1).getValue());
      rows.push([new Date(now), new Date(now), `sheet-${now}-${row}-${col}`, "sheet", user, "", teamId, q, "", status, value, true, ""]);
    }));
    appendRows_(log, rows);
  });
}
