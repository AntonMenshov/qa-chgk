// Pure backend logic: no Apps Script services here, so it runs unchanged in Node tests.
// In Apps Script all files share one global scope; the export at the bottom is for Node only.

const STATUSES = ["received", "correct", "incorrect", "disputed", "cleared"];
const STATUS_VALUE = { received: "R", correct: 1, incorrect: 0, disputed: "?", cleared: "" };
const APP_STATUSES = ["received", "correct", "incorrect", "disputed"]; // "cleared" only comes from the sheet
const TID_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/;
const TEAM_ID_RE = /^[A-Z][0-9]{2}$/;
const MAX_EVENTS_PER_REQUEST = 500;

class RequestError extends Error {}

function fail(message) {
  throw new RequestError(message);
}

/** Constant-time string comparison for tokens. */
function tokensEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Spreadsheet column letter for a 1-based index: 1 → A, 27 → AA. */
function colLetter(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function totalQuestions(roundSizes) {
  return roundSizes.reduce((a, b) => a + b, 0);
}

function validateRoundSizes(roundSizes) {
  if (!Array.isArray(roundSizes) || roundSizes.length < 1 || roundSizes.length > 20) fail("round_sizes must be a list of 1-20 rounds");
  for (const k of roundSizes) if (!Number.isInteger(k) || k < 1 || k > 100) fail("each round needs 1-100 questions");
}

function validateTeams(teams) {
  if (!Array.isArray(teams)) fail("teams must be a list");
  const seen = new Set();
  for (const t of teams) {
    if (!t || !TEAM_ID_RE.test(t.team_id)) fail(`invalid team_id ${JSON.stringify(t && t.team_id)}`);
    if (seen.has(t.team_id)) fail(`duplicate team_id ${t.team_id}`);
    seen.add(t.team_id);
    if (typeof t.name !== "string" || !t.name.trim()) fail(`team ${t.team_id} has no name`);
  }
}

/** Check the shape of a request body; returns it, or throws RequestError. */
function validateRequest(body) {
  if (!body || typeof body !== "object") fail("request must be a JSON object");
  const action = body.action;
  if (action === "ping") return body;
  if (!TID_RE.test(body.tid || "")) fail("invalid tid");
  switch (action) {
    case "create_tournament":
      if (typeof body.name !== "string" || !body.name.trim()) fail("name is required");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || "")) fail("date must be YYYY-MM-DD");
      validateRoundSizes(body.round_sizes);
      if (typeof body.jury_token !== "string" || body.jury_token.length < 16) fail("jury_token must be at least 16 characters");
      validateTeams(body.teams || []);
      return body;
    case "get_teams":
    case "get_state":
      return body;
    case "set_teams":
      validateTeams(body.teams);
      return body;
    case "record_events":
      if (!Array.isArray(body.events) || body.events.length === 0) fail("events must be a non-empty list");
      if (body.events.length > MAX_EVENTS_PER_REQUEST) fail(`at most ${MAX_EVENTS_PER_REQUEST} events per request`);
      return body;
    default:
      fail(`unknown action ${JSON.stringify(action)}`);
  }
}

/** Validate one scanner event against the tournament; returns an error message or null. */
function eventError(ev, teamIds, roundSizes, nowMs) {
  if (!ev || typeof ev !== "object") return "event must be an object";
  if (typeof ev.scan_id !== "string" || !ev.scan_id || ev.scan_id.length > 64) return "invalid scan_id";
  if (!APP_STATUSES.includes(ev.status)) return `invalid status ${JSON.stringify(ev.status)}`;
  if (!teamIds.has(ev.team_id)) return `unknown team ${JSON.stringify(ev.team_id)}`;
  if (!Number.isInteger(ev.question) || ev.question < 1 || ev.question > totalQuestions(roundSizes)) return "invalid question";
  if (!Number.isFinite(ev.client_ts) || ev.client_ts <= 0 || ev.client_ts > nowMs + 24 * 3600 * 1000) return "invalid client_ts";
  if (ev.spare != null && (!Number.isInteger(ev.spare) || ev.spare < 1)) return "invalid spare";
  return null;
}

/**
 * Last-write-wins for one Results cell. `cell` is {value, ts}; returns the new cell.
 * - "received" only fills an empty cell: re-scanning a card never undoes a judgement.
 * - Any other status replaces the cell if it is at least as new as the cell.
 */
function mergeCell(cell, status, ts) {
  if (status === "received") {
    return cell.value === "" ? { value: "R", ts: Math.max(ts, cell.ts) } : cell;
  }
  if (ts >= cell.ts) return { value: STATUS_VALUE[status], ts };
  return cell;
}

/**
 * Apply a batch of events to an in-memory view of the Results matrix.
 * `cells` maps "TEAM:Q" → {value, ts}; `seen` is a Set of already-applied scan_ids.
 * Mutates both; returns one outcome per event (same order).
 */
function applyEvents(cells, seen, events, teamIds, roundSizes, nowMs) {
  return events.map((ev) => {
    const error = eventError(ev, teamIds, roundSizes, nowMs);
    if (error) return { scan_id: ev && ev.scan_id, applied: false, duplicate: false, error };
    if (seen.has(ev.scan_id)) return { scan_id: ev.scan_id, applied: false, duplicate: true };
    seen.add(ev.scan_id);
    const key = `${ev.team_id}:${ev.question}`;
    const before = cells[key] || { value: "", ts: 0 };
    const after = mergeCell(before, ev.status, ev.client_ts);
    cells[key] = after;
    return { scan_id: ev.scan_id, applied: after !== before, duplicate: false };
  });
}

/** What a juror typed into a Results cell → status, or null if it isn't a valid mark. */
function normalizeCellInput(raw) {
  const v = String(raw == null ? "" : raw).trim().toLowerCase();
  if (v === "") return "cleared";
  if (["1", "+", "да", "верно"].includes(v)) return "correct";
  if (["0", "-", "−", "нет", "неверно"].includes(v)) return "incorrect";
  if (v === "?") return "disputed";
  if (v === "r" || v === "р") return "received"; // Latin or Cyrillic
  return null;
}

/** Results tab layout: column positions and the header row. */
function resultsLayout(roundSizes) {
  const n = totalQuestions(roundSizes);
  const firstQ = 3; // A: ID, B: Команда
  const firstRound = firstQ + n;
  const totalCol = firstRound + roundSizes.length;
  const placeCol = totalCol + 1;
  const header = ["ID", "Команда"];
  for (let q = 1; q <= n; q++) header.push(q);
  roundSizes.forEach((_, i) => header.push(`Тур ${i + 1}`));
  header.push("Итого", "Место");
  return { n, firstQ, firstRound, totalCol, placeCol, width: placeCol, header };
}

/** Per round: its question columns and its total column (1-based), for borders and tints. */
function roundBands(roundSizes) {
  const L = resultsLayout(roundSizes);
  let col = L.firstQ;
  return roundSizes.map((size, i) => {
    const band = { round: i + 1, firstCol: col, size, totalCol: L.firstRound + i };
    col += size;
    return band;
  });
}

/** One Results row for a team at sheet row `row` (1-based): IDs, empty marks, formulas. */
function resultsRow(roundSizes, team, row) {
  const L = resultsLayout(roundSizes);
  const cells = [team.team_id, team.name];
  for (let q = 0; q < L.n; q++) cells.push("");
  let start = L.firstQ;
  for (const size of roundSizes) {
    cells.push(`=COUNTIF(${colLetter(start)}${row}:${colLetter(start + size - 1)}${row},1)`);
    start += size;
  }
  cells.push(`=SUM(${colLetter(L.firstRound)}${row}:${colLetter(L.totalCol - 1)}${row})`);
  const tc = colLetter(L.totalCol);
  cells.push(`=RANK(${tc}${row},${tc}$2:${tc})`);
  return cells;
}

/** Stats tab rows: one per question with how many teams took it. */
function statsRows(roundSizes) {
  const L = resultsLayout(roundSizes);
  const rows = [["Вопрос", "Тур", "Взяли", "Доля"]];
  let q = 1;
  roundSizes.forEach((size, i) => {
    for (let k = 0; k < size; k++, q++) {
      const col = colLetter(L.firstQ + q - 1);
      const r = rows.length + 1;
      rows.push([q, i + 1, `=COUNTIF(Results!${col}$2:${col},1)`, `=IFERROR(C${r}/COUNTA(Results!$A$2:$A),0)`]);
    }
  });
  return rows;
}

/** Which teams need new Results rows and which names changed, given the IDs already there. */
function planTeamRows(existingRows, teams) {
  const byId = new Map(existingRows.map((r) => [r.team_id, r.name]));
  const append = teams.filter((t) => !byId.has(t.team_id));
  const rename = teams.filter((t) => byId.has(t.team_id) && byId.get(t.team_id) !== t.name);
  return { append, rename };
}

if (typeof module !== "undefined") {
  module.exports = {
    STATUSES, STATUS_VALUE, RequestError, tokensEqual, colLetter, totalQuestions, validateRequest,
    eventError, mergeCell, applyEvents, normalizeCellInput, resultsLayout, roundBands, resultsRow, statsRows, planTeamRows,
  };
}
