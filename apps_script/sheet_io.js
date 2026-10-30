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
          // e.g. a tab too small (the Log grows all game): the slow way grows it
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
  return Utilities.formatDate(new Date(ms), scriptTimeZone_(), 'yyyy-MM-dd HH:mm:ss');
}

let scriptTimeZone = null;

/** The script's time zone, looked up once per request (it showed in the timings). */
function scriptTimeZone_() {
  scriptTimeZone = scriptTimeZone || Session.getScriptTimeZone();
  return scriptTimeZone;
}
