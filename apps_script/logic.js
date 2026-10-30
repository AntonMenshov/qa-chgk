// Pure backend logic: no Apps Script services here, so it runs unchanged in Node tests.
// In Apps Script all files share one global scope; the export at the bottom is for Node only.

const STATUSES = ['received', 'correct', 'incorrect', 'disputed', 'cleared'];
const STATUS_VALUE = {received: 'R', correct: 1, incorrect: 0, disputed: '?', cleared: ''};
const APP_STATUSES = ['received', 'correct', 'incorrect', 'disputed']; // "cleared" only comes from the sheet
const TID_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/;
const TEAM_ID_RE = /^[0-9A-Z]{1,8}$/; // e.g. a rating.chgk.info number (58746) or A07
const MAX_EVENTS_PER_REQUEST = 500;

class RequestError extends Error {}

function fail(message) {
  throw new RequestError(message);
}

/** Constant-time string comparison for tokens. */
function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Spreadsheet column letter for a 1-based index: 1 → A, 27 → AA. */
function colLetter(n) {
  let s = '';
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
  if (!Array.isArray(roundSizes) || roundSizes.length < 1 || roundSizes.length > 20) {
    fail('round_sizes must be a list of 1-20 rounds');
  }
  for (const k of roundSizes) {
    if (!Number.isInteger(k) || k < 1 || k > 100) {
      fail('each round needs 1-100 questions');
    }
  }
}

function validateTeams(teams) {
  if (!Array.isArray(teams)) {
    fail('teams must be a list');
  }
  const seen = new Set();
  for (const t of teams) {
    if (!t || !TEAM_ID_RE.test(t.team_id)) {
      fail(`invalid team_id ${JSON.stringify(t && t.team_id)}`);
    }
    if (seen.has(t.team_id)) {
      fail(`duplicate team_id ${t.team_id}`);
    }
    seen.add(t.team_id);
    if (typeof t.name !== 'string' || !t.name.trim()) {
      fail(`team ${t.team_id} has no name`);
    }
  }
}

/** Reserve teams (decks for teams that turn up unregistered): IDs only, none clashing with a team. */
function validateReserve(reserve, teams) {
  if (!Array.isArray(reserve)) {
    fail('reserve must be a list of team IDs');
  }
  const taken = new Set(teams.map((t) => t.team_id));
  for (const id of reserve) {
    if (!TEAM_ID_RE.test(id)) {
      fail(`invalid reserve team_id ${JSON.stringify(id)}`);
    }
    if (taken.has(id)) {
      fail(`reserve team_id ${id} is already used`);
    }
    taken.add(id);
  }
}

/** Name shown for a reserve team from its first scan until the jury types the real one. */
function reservePlaceholder(teamId) {
  return `${teamId} · впишите название`;
}

/** Names typed on a tab ({id: name}) that differ from the Teams tab; blanks are ignored. */
function nameEdits(source, truth) {
  return Object.keys(source)
    .filter((id) => String(source[id]).trim() !== '' && String(source[id]).trim() !== String(truth[id] || ''))
    .map((id) => ({team_id: id, name: String(source[id]).trim()}));
}

function validateToken(token, name) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,}$/.test(token)) {
    fail(`${name} must be at least 16 URL-safe characters`);
  }
}

/** Check the shape of a request body; returns it, or throws RequestError. */
function validateRequest(body) {
  if (!body || typeof body !== 'object') {
    fail('request must be a JSON object');
  }
  const action = body.action;
  if (action === 'ping') {
    return body;
  }
  if (!TID_RE.test(body.tid || '')) {
    fail('invalid tid');
  }
  switch (action) {
    case 'create_tournament':
      if (typeof body.name !== 'string' || !body.name.trim()) {
        fail('name is required');
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) {
        fail('date must be YYYY-MM-DD');
      }
      validateRoundSizes(body.round_sizes);
      if (typeof body.jury_token !== 'string' || body.jury_token.length < 16) {
        fail('jury_token must be at least 16 characters');
      }
      validateTeams(body.teams || []);
      validateReserve(body.reserve || [], body.teams || []);
      if (body.board_token !== undefined) {
        validateToken(body.board_token, 'board_token');
      }
      return body;
    case 'get_teams':
    case 'get_state':
    case 'get_results':
    case 'get_board':
      return body;
    case 'set_board_token':
      validateToken(body.board_token, 'board_token');
      return body;
    case 'share_view':
      return body;
    case 'set_teams':
      validateTeams(body.teams);
      return body;
    case 'record_events':
      if (!Array.isArray(body.events) || body.events.length === 0) {
        fail('events must be a non-empty list');
      }
      if (body.events.length > MAX_EVENTS_PER_REQUEST) {
        fail(`at most ${MAX_EVENTS_PER_REQUEST} events per request`);
      }
      return body;
    default:
      fail(`unknown action ${JSON.stringify(action)}`);
  }
}

/** Validate one scanner event against the tournament; returns an error message or null. */
function eventError(ev, teamIds, roundSizes, nowMs) {
  if (!ev || typeof ev !== 'object') {
    return 'event must be an object';
  }
  if (typeof ev.scan_id !== 'string' || !ev.scan_id || ev.scan_id.length > 64) {
    return 'invalid scan_id';
  }
  if (!APP_STATUSES.includes(ev.status)) {
    return `invalid status ${JSON.stringify(ev.status)}`;
  }
  if (!teamIds.has(ev.team_id)) {
    return `unknown team ${JSON.stringify(ev.team_id)}`;
  }
  if (!Number.isInteger(ev.question) || ev.question < 1 || ev.question > totalQuestions(roundSizes)) {
    return 'invalid question';
  }
  if (!Number.isFinite(ev.client_ts) || ev.client_ts <= 0 || ev.client_ts > nowMs + 24 * 3600 * 1000) {
    return 'invalid client_ts';
  }
  if (ev.spare != null && (!Number.isInteger(ev.spare) || ev.spare < 1)) {
    return 'invalid spare';
  }
  return null;
}

/**
 * Last-write-wins for one mark cell. `cell` is {value, ts}; returns the new cell.
 * - "received" only fills an empty cell: re-scanning a card never undoes a judgement.
 * - Any other status replaces the cell if it is at least as new as the cell.
 */
function mergeCell(cell, status, ts) {
  if (status === 'received') {
    return cell.value === '' ? {value: 'R', ts: Math.max(ts, cell.ts)} : cell;
  }
  if (ts >= cell.ts) {
    return {value: STATUS_VALUE[status], ts};
  }
  return cell;
}

/**
 * Apply a batch of events to an in-memory view of all marks.
 * `cells` maps "TEAM:Q" → {value, ts}; `seen` is a Set of already-applied scan_ids.
 * Mutates both; returns one outcome per event (same order).
 */
function applyEvents(cells, seen, events, teamIds, roundSizes, nowMs) {
  return events.map((ev) => {
    const error = eventError(ev, teamIds, roundSizes, nowMs);
    if (error) {
      return {scan_id: ev && ev.scan_id, applied: false, duplicate: false, error};
    }
    if (seen.has(ev.scan_id)) {
      return {scan_id: ev.scan_id, applied: false, duplicate: true};
    }
    seen.add(ev.scan_id);
    const key = `${ev.team_id}:${ev.question}`;
    const before = cells[key] || {value: '', ts: 0};
    const after = mergeCell(before, ev.status, ev.client_ts);
    cells[key] = after;
    return {scan_id: ev.scan_id, applied: after !== before, duplicate: false};
  });
}

/** What a juror typed into a mark cell → status, or null if it isn't a valid mark. */
function normalizeCellInput(raw) {
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  if (v === '') {
    return 'cleared';
  }
  if (['1', '+', 'да', 'верно'].includes(v)) {
    return 'correct';
  }
  if (['0', '-', '−', 'нет', 'неверно'].includes(v)) {
    return 'incorrect';
  }
  if (v === '?') {
    return 'disputed';
  }
  if (v === 'r' || v === 'р') {
    return 'received';
  } // Latin or Cyrillic
  return null;
}

// Sheet layout: an «Итоги» summary tab, then one tab per round («Тур 1», «Тур 2», …).
// Every tab starts with A: ID, B: Команда; rows are found by team ID, never by position.

const FIRST_MARK_COL = 3;

function roundSheetName(round) {
  return `Тур ${round}`;
}

/** Round tab `round` (1-based): its question numbers, columns and header row. */
function roundLayout(roundSizes, round) {
  const first = roundSizes.slice(0, round - 1).reduce((a, b) => a + b, 0) + 1;
  const size = roundSizes[round - 1];
  const sumCol = FIRST_MARK_COL + size;
  const header = ['ID', 'Команда'];
  for (let k = 0; k < size; k++) {
    header.push(first + k);
  }
  header.push('Сумма');
  return {round, name: roundSheetName(round), first, size, firstCol: FIRST_MARK_COL, sumCol, width: sumCol, header};
}

/** One row of a round tab for a team at sheet row `row` (1-based): IDs, empty marks, the round sum. */
function roundRow(lay, team, row) {
  const cells = [team.team_id, team.name];
  for (let k = 0; k < lay.size; k++) {
    cells.push('');
  }
  cells.push(`=COUNTIF(${colLetter(lay.firstCol)}${row}:${colLetter(lay.sumCol - 1)}${row},1)`);
  return cells;
}

/** Where question q's marks live: round, tab name and column. */
function questionCell(roundSizes, q) {
  let first = 1;
  for (let r = 1; r <= roundSizes.length; r++) {
    if (q >= first && q < first + roundSizes[r - 1]) {
      return {round: r, name: roundSheetName(r), col: FIRST_MARK_COL + q - first};
    }
    first += roundSizes[r - 1];
  }
  return null;
}

/** The question a cell holds the mark for, or null (names, sums, headers, other tabs). */
function questionAt(roundSizes, sheetName, row, col) {
  const m = /^Тур (\d+)$/.exec(sheetName);
  if (!m || row < 2) {
    return null;
  }
  const round = Number(m[1]);
  if (round < 1 || round > roundSizes.length) {
    return null;
  }
  const lay = roundLayout(roundSizes, round);
  const k = col - lay.firstCol;
  return k >= 0 && k < lay.size ? lay.first + k : null;
}

/** «Итоги» tab: one column per round, then Итого and Место. */
function summaryLayout(roundSizes) {
  const firstRound = FIRST_MARK_COL;
  const totalCol = firstRound + roundSizes.length;
  const header = ['ID', 'Команда'].concat(
    roundSizes.map((_, i) => roundSheetName(i + 1)),
    ['Итого', 'Место'],
  );
  return {firstRound, totalCol, placeCol: totalCol + 1, width: totalCol + 1, header};
}

/** One «Итоги» row: each round's sum looked up by team ID, so sorting a round tab is harmless. */
function summaryRow(roundSizes, team, row) {
  const L = summaryLayout(roundSizes);
  const cells = [team.team_id, team.name];
  roundSizes.forEach((_, i) => {
    const lay = roundLayout(roundSizes, i + 1);
    const tab = `'${lay.name}'`;
    const sum = colLetter(lay.sumCol);
    cells.push(`=IFERROR(INDEX(${tab}!$${sum}:$${sum},MATCH($A${row},${tab}!$A:$A,0)),0)`);
  });
  cells.push(`=SUM(${colLetter(L.firstRound)}${row}:${colLetter(L.totalCol - 1)}${row})`);
  cells.push(placeFormula(colLetter(L.totalCol), row));
  return cells;
}

/**
 * Место for the total in `col` at `row`: a number, or "2-3" when teams share the place.
 * Same result as placeLabels(); the tests evaluate both on many tournaments.
 */
function placeFormula(col, row) {
  const all = `${col}$2:${col}`;
  const me = `${col}${row}`;
  const rank = `RANK(${me},${all})`;
  const same = `COUNTIF(${all},${me})`;
  return `=IF(${same}>1,${rank}&"-"&(${rank}+${same}-1),${rank})`;
}

/** Places for a list of totals, as «Итоги» shows them: 1, 2, "3-4", "3-4", 5, … */
function placeLabels(totals) {
  return totals.map((t) => {
    const above = totals.filter((x) => x > t).length;
    const same = totals.filter((x) => x === t).length;
    return same > 1 ? `${above + 1}-${above + same}` : above + 1;
  });
}

/** Reference standings from marks ({team_id: [value per question]}): round sums, total, place. */
function standings(roundSizes, teamIds, marks) {
  const rows = teamIds.map((id) => {
    const values = marks[id] || [];
    let q = 0;
    const rounds = roundSizes.map((size) => {
      let sum = 0;
      for (let k = 0; k < size; k++, q++) {
        if (values[q] === 1) {
          sum++;
        }
      }
      return sum;
    });
    return {team_id: id, rounds, total: rounds.reduce((a, b) => a + b, 0)};
  });
  const places = placeLabels(rows.map((r) => r.total));
  rows.forEach((r, i) => {
    r.place = places[i];
  });
  return rows;
}

/** «Итоги» order (user rule): Итого; on a tie the better last round, then the round before, …; then ID. */
function compareStandings(a, b) {
  if (a.total !== b.total) {
    return b.total - a.total;
  }
  for (let i = a.rounds.length - 1; i >= 0; i--) {
    if (a.rounds[i] !== b.rounds[i]) {
      return b.rounds[i] - a.rounds[i];
    }
  }
  return a.team_id < b.team_id ? -1 : a.team_id > b.team_id ? 1 : 0;
}

/** The same order as Range.sort() specs for «Итоги» (sheet columns, 1-based). */
function summarySortSpec(roundSizes) {
  const L = summaryLayout(roundSizes);
  const spec = [{column: L.totalCol, ascending: false}];
  for (let i = roundSizes.length - 1; i >= 0; i--) {
    spec.push({column: L.firstRound + i, ascending: false});
  }
  spec.push({column: 1, ascending: true});
  return spec;
}

/** Round tabs: by the round's «Сумма», equal sums in team ID order (the order of the cards). */
function roundSortSpec(lay) {
  return [
    {column: lay.sumCol, ascending: false},
    {column: 1, ascending: true},
  ];
}

/** Team IDs in the order a round tab should show them (roundSortSpec), from marks {id: [values]}. */
function roundOrder(roundSizes, round, ids, values) {
  const lay = roundLayout(roundSizes, round);
  const sum = (id) => {
    let s = 0;
    for (let k = 0; k < lay.size; k++) {
      if ((values[id] || [])[lay.first - 1 + k] === 1) {
        s++;
      }
    }
    return s;
  };
  return [...ids].sort((a, b) => sum(b) - sum(a) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Team IDs in the order «Итоги» should show them (summarySortSpec). */
function summaryOrder(roundSizes, ids, values) {
  return standings(roundSizes, ids, values)
    .sort(compareStandings)
    .map((r) => r.team_id);
}

/** Hidden Meta tab: team_id, a last-write time per question, then the last value the backend knows. */
function metaLayout(n) {
  const header = ['team_id'];
  for (let q = 1; q <= n; q++) {
    header.push(q);
  }
  for (let q = 1; q <= n; q++) {
    header.push(`v${q}`);
  }
  return {header, width: 1 + 2 * n, tsCol: (q) => 1 + q, knownCol: (q) => 1 + n + q};
}

/**
 * Jury edits: marks whose value on a round tab differs from the last value the backend knows.
 * Found by team ID and question, never by row, so rows may be re-sorted at any time.
 * `current` and `known` map "TEAM:Q" → value. Returns [{key, raw, status, value}]; status null = not a mark.
 */
function sheetEdits(current, known) {
  return Object.keys(current)
    .filter((key) => String(current[key]) !== String(key in known ? known[key] : ''))
    .map((key) => {
      const status = normalizeCellInput(current[key]);
      return {key, raw: current[key], status, value: status === null ? null : STATUS_VALUE[status]};
    });
}

/** Stats tab rows: one per question with how many teams took it. */
function statsRows(roundSizes) {
  const rows = [['Вопрос', 'Тур', 'Взяли', 'Доля']];
  for (let q = 1; q <= totalQuestions(roundSizes); q++) {
    const at = questionCell(roundSizes, q);
    const tab = `'${at.name}'`;
    const col = colLetter(at.col);
    const r = rows.length + 1;
    rows.push([q, at.round, `=COUNTIF(${tab}!${col}$2:${col},1)`, `=IFERROR(C${r}/COUNTA(${tab}!$A$2:$A),0)`]);
  }
  return rows;
}

/** "TEAM:Q" keys of every «?» mark, in a stable order: compare two of these to see if «Спорные» must change. */
function disputedKeys(values) {
  return Object.keys(values)
    .filter((key) => values[key] === '?')
    .sort();
}

/**
 * The «Спорные» tab (user request): every undecided «?» — round, question, team, photo of
 * the card when there is one — by question, then team ID; and how many there are overall,
 * per round and per team (teams with none left out, most first).
 * @param values {"TEAM:Q": mark}   @param names {team_id: name}   @param photos {"TEAM:Q": link or file name}
 * @returns {{list: any[][], summary: any[][]}}  list goes to A1 (4 columns), summary to F1 (2 columns)
 */
function disputedSheet(roundSizes, names, values, photos) {
  const items = disputedKeys(values)
    .map((key) => {
      const [teamId, q] = key.split(':');
      return {teamId, q: Number(q), round: questionCell(roundSizes, Number(q)).round, photo: (photos || {})[key] || ''};
    })
    .sort((a, b) => a.q - b.q || (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0));
  const name = (id) => names[id] || id;
  const list = [['Тур', 'Вопрос', 'Команда', 'Фото']].concat(
    items.map((it) => [it.round, it.q, name(it.teamId), it.photo]),
  );
  const perRound = roundSizes.map((_, i) => items.filter((it) => it.round === i + 1).length);
  const perTeam = {};
  items.forEach((it) => {
    perTeam[it.teamId] = (perTeam[it.teamId] || 0) + 1;
  });
  const teams = Object.keys(perTeam).sort((a, b) => perTeam[b] - perTeam[a] || (a < b ? -1 : a > b ? 1 : 0));
  const summary = [
    ['Всего «?»', items.length],
    ['', ''],
    ['Тур', '«?»'],
  ]
    .concat(perRound.map((n, i) => [`Тур ${i + 1}`, n]))
    .concat([
      ['', ''],
      ['Команда', '«?»'],
    ])
    .concat(teams.length ? teams.map((id) => [name(id), perTeam[id]]) : [['—', 0]]);
  return {list, summary};
}

/** Which teams need new rows on a tab and which names changed, given the IDs already there. */
function planTeamRows(existingRows, teams) {
  const byId = new Map(existingRows.map((r) => [r.team_id, r.name]));
  const append = teams.filter((t) => !byId.has(t.team_id));
  const rename = teams.filter((t) => byId.has(t.team_id) && byId.get(t.team_id) !== t.name);
  return {append, rename};
}

if (typeof module !== 'undefined') {
  module.exports = {
    STATUSES,
    STATUS_VALUE,
    FIRST_MARK_COL,
    RequestError,
    fail,
    tokensEqual,
    colLetter,
    totalQuestions,
    validateRequest,
    eventError,
    mergeCell,
    applyEvents,
    normalizeCellInput,
    roundSheetName,
    roundLayout,
    roundRow,
    questionCell,
    questionAt,
    summaryLayout,
    summaryRow,
    placeFormula,
    placeLabels,
    standings,
    compareStandings,
    summarySortSpec,
    roundSortSpec,
    roundOrder,
    summaryOrder,
    metaLayout,
    sheetEdits,
    statsRows,
    disputedKeys,
    disputedSheet,
    planTeamRows,
    validateReserve,
    reservePlaceholder,
    nameEdits,
  };
}
