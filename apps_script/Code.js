// Apps Script web app: the only part of chgk that touches Google Sheets and Drive.
// Deploy under any Gmail account (docs/google-account.md). This file: constants, setup,
// request handling and access. The rest, by topic, in the files listed in bundle.json
// (pure logic in logic.js), which `chgk backend bundle` joins into one Code.gs.

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

// Every action: who may call it (admin, jury or board; each stronger token works too),
// whether it holds the script lock while it writes, and what it does. `noTournament`:
// it runs before any tournament exists. logic.js validateRequest checks each action's body.
const ACTIONS = {
  ping: {
    who: 'admin',
    noTournament: true,
    run: () => ({
      ok: true,
      version: VERSION,
      account: Session.getEffectiveUser().getEmail(),
      authorized: authorized_(),
      sheets_api: sheetsApi_(),
    }),
  },
  create_tournament: {
    who: 'admin',
    noTournament: true,
    lock: true,
    run: (req, reg, props) => createTournament_(props, req),
  },
  get_teams: {who: 'admin', run: (req, reg) => ({ok: true, teams: readTeams_(open_(reg))})},
  set_teams: {who: 'admin', lock: true, run: (req, reg) => setTeams_(open_(reg), reg, req.teams)},
  get_state: {who: 'jury', run: (req, reg) => readState_(open_(reg), reg)},
  get_results: {who: 'jury', run: (req, reg) => readResults_(open_(reg), reg)},
  record_events: {who: 'jury', lock: true, run: (req, reg) => recordEvents_(open_(reg), reg, req)},
  upload_photo: {who: 'jury', run: (req, reg) => uploadPhoto_(open_(reg), reg, req)}, // locks only its Log write
  get_board: {who: 'board', run: (req, reg) => readBoard_(open_(reg), reg)},
};

function handle_(req) {
  validateRequest(req);
  const action = ACTIONS[req.action];
  if (!action) {
    fail('unhandled action');
  }
  const props = timed_('access', () => PropertiesService.getScriptProperties());
  const reg = action.noTournament ? null : timed_('access', () => registry_(props, req.tid));
  requireToken_(action.who, props, reg, req);
  const run = () => action.run(req, reg, props);
  return action.lock ? withLock_(run) : run();
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

/** The admin token works everywhere, the jury's for jury and board actions, the board's for board ones. */
function requireToken_(who, props, reg, req) {
  const accepted = [props.getProperty('ADMIN_TOKEN')];
  if (who !== 'admin') {
    accepted.push(reg.jury_token);
  }
  if (who === 'board') {
    accepted.push(reg.board_token);
  }
  if (!accepted.some((token) => tokensEqual(req.token, token))) {
    fail(`forbidden: ${who} token required`);
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
