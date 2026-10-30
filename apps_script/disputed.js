// «Спорные»: every undecided «?» with its photo, and the counts.

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
