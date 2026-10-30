// Apps Script web app: the only part of chgk that touches Google Sheets and Drive.
// Deploy under any Gmail account (docs/google-account.md); pure logic is in logic.js,
// which shares this file's global scope (the bundle puts both into one Code.gs).

const VERSION = "dev"; // replaced by `chgk backend bundle`
const ROOT_FOLDER = "ЧГК";
// Plus one tab per round, «Тур 1» … «Тур N», right after «Итоги» (see logic.js).
const TABS = { summary: "Итоги", stats: "Stats", teams: "Teams", log: "Log", settings: "Settings", meta: "Meta" };
const TEAMS_HEADER = ["team_id", "name", "city", "logo_file"];
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
  // Last-write timestamps: team_id, then one column per question.
  const meta = ss.insertSheet(TABS.meta, ss.getSheets().length);
  const n = totalQuestions(sizes);
  ensureSize_(meta, 1, 1 + n);
  meta.getRange(1, 1, 1, 1 + n).setValues([["team_id"].concat(Array.from({ length: n }, (_, k) => k + 1))]);
  meta.hideSheet();

  formatSheets_(ss, sizes); // first: names must land in plain-text cells
  writeTeams_(ss, req.teams || []);
  syncTeamRows_(ss, sizes, req.teams || []);
  ss.setActiveSheet(summary);
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
  // Plain text, or Sheets turns a team called «42» into a number.
  sheet.getRange(1, 1, sheet.getMaxRows(), TEAMS_HEADER.length).setNumberFormat("@");
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, TEAMS_HEADER.length).clearContent();
  if (teams.length) {
    sheet.getRange(2, 1, teams.length, TEAMS_HEADER.length)
      .setValues(teams.map((t) => [t.team_id, t.name, t.city || "", t.logo_file || ""]));
  }
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
    // Names as plain text, left-aligned: otherwise a team called «42» becomes a number.
    sheet.getRange(1, 2, sheet.getMaxRows(), 1).setNumberFormat("@").setHorizontalAlignment("left");
    sheet.getRange(1, FIRST_MARK_COL, sheet.getMaxRows(), width - FIRST_MARK_COL + 1).setHorizontalAlignment("center");
  };

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
  refreshSummaryFormulas_(ss, sizes);
  const meta = ss.getSheetByName(TABS.meta);
  const inMeta = new Set(teamRowsOf_(meta).map((t) => t.team_id));
  const n = totalQuestions(sizes);
  appendRows_(meta, teams.filter((t) => !inMeta.has(t.team_id))
    .map((t) => [t.team_id].concat(new Array(n).fill(""))));
  return counts;
}

/** Rewrite «Итоги» formulas that differ from the current ones (e.g. Место from older versions). */
function refreshSummaryFormulas_(ss, sizes) {
  const summary = summaryOf_(ss);
  const sl = summaryLayout(sizes);
  const width = sl.width - sl.firstRound + 1;
  teamRowsOf_(summary).forEach((t) => {
    const range = summary.getRange(t.row, sl.firstRound, 1, width);
    const want = summaryRow(sizes, t, t.row).slice(sl.firstRound - 1);
    if (range.getFormulas()[0].some((f, i) => f !== want[i])) range.setValues([want]);
  });
}

function setTeams_(ss, reg, teams) {
  formatSheets_(ss, reg.round_sizes); // also brings Sheets made by older versions up to date
  writeTeams_(ss, teams);
  const counts = syncTeamRows_(ss, reg.round_sizes, teams);
  return { ok: true, appended: counts.appended, renamed: counts.renamed };
}

// ---- marks ----

/** Meta row per team ID; a team without one gets it appended. */
function metaRows_(ss, n) {
  const meta = ss.getSheetByName(TABS.meta);
  const rows = new Map(teamRowsOf_(meta).map((t) => [t.team_id, t.row]));
  const rowOf = (teamId) => {
    if (!rows.has(teamId)) {
      appendRows_(meta, [[teamId].concat(new Array(n).fill(""))]);
      rows.set(teamId, meta.getLastRow());
    }
    return rows.get(teamId);
  };
  return { meta, rows, rowOf };
}

/** Every mark as "TEAM:Q" → {value, ts}, plus where each one sits on its round tab. */
function readMarks_(ss, reg) {
  const sizes = reg.round_sizes;
  const n = totalQuestions(sizes);
  const teams = teamRowsOf_(summaryOf_(ss)).map((t) => ({ team_id: t.team_id, name: t.name }));
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
        where[key] = { sheet, row: j + 2, col: lay.firstCol + k };
      }
    });
  });
  const m = metaRows_(ss, n);
  const lastMeta = m.meta.getLastRow();
  if (lastMeta >= 2) {
    m.meta.getRange(2, 1, lastMeta - 1, 1 + n).getValues().forEach((r) => {
      for (let q = 1; q <= n; q++) {
        const cell = cells[`${String(r[0]).trim()}:${q}`];
        if (cell) cell.ts = Number(r[q]) || 0;
      }
    });
  }
  return { n, teams, cells, where, meta: m };
}

function readState_(ss, reg) {
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
    marks: marks,
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
  const m = readMarks_(ss, reg);
  const cells = m.cells;
  const before = Object.assign({}, cells);
  const log = ss.getSheetByName(TABS.log);
  const nLog = log.getLastRow() - 1;
  const seen = new Set(nLog > 0 ? log.getRange(2, 3, nLog, 1).getValues().map((r) => String(r[0])) : []);
  // Only teams with rows on the round tabs can be marked.
  const teamIds = new Set(m.teams.map((t) => t.team_id).filter((id) => m.where[`${id}:1`]));

  const outcomes = applyEvents(cells, seen, req.events, teamIds, reg.round_sizes, Date.now());

  // Write only the cells that changed, so a juror editing the sheet at the same moment is not overwritten.
  Object.keys(cells).forEach((key) => {
    if (cells[key] === before[key]) return;
    const at = m.where[key];
    at.sheet.getRange(at.row, at.col).setValue(cells[key].value);
    const [teamId, q] = key.split(":");
    m.meta.meta.getRange(m.meta.rowOf(teamId), 1 + Number(q)).setValue(cells[key].ts);
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

/** Installable onEdit trigger on each tournament sheet: jury edits on round tabs are logged and time-stamped. */
function onSheetEdit(e) {
  const sheet = e.range.getSheet();
  const name = sheet.getName();
  if (!/^Тур \d+$/.test(name)) return;
  const ss = sheet.getParent();
  const settings = ss.getSheetByName(TABS.settings).getRange(1, 1, 6, 2).getValues();
  const sizes = JSON.parse(settings.find((r) => r[0] === "round_sizes")[1]);
  const user = e.user && e.user.getEmail ? e.user.getEmail() : "";

  withLock_(() => {
    const meta = metaRows_(ss, totalQuestions(sizes));
    const log = ss.getSheetByName(TABS.log);
    const now = Date.now();
    const rows = [];
    const values = e.range.getValues();
    values.forEach((rowValues, dr) => rowValues.forEach((raw, dc) => {
      const row = e.range.getRow() + dr;
      const col = e.range.getColumn() + dc;
      const q = questionAt(sizes, name, row, col);
      if (q === null) return;
      const teamId = String(sheet.getRange(row, 1).getValue()).trim();
      if (!teamId) return;
      const cell = sheet.getRange(row, col);
      const status = normalizeCellInput(raw);
      if (status === null) {
        cell.setNote("Непонятное значение: используйте 1, 0, ? или R");
        return;
      }
      cell.clearNote();
      const value = STATUS_VALUE[status];
      if (raw !== value) cell.setValue(value);
      meta.meta.getRange(meta.rowOf(teamId), 1 + q).setValue(now);
      rows.push([new Date(now), new Date(now), `sheet-${now}-${row}-${col}`, "sheet", user, "", teamId, q, "", status, value, true, ""]);
    }));
    appendRows_(log, rows);
  });
}
