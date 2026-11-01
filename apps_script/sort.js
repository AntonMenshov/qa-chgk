// Sorting «Итоги» and the round tabs: one Sheets API call, or the slow SpreadsheetApp way.

/**
 * Re-sort round tabs (by «Сумма») and «Итоги» (by Итого, then the last round, …), then
 * rewrite any per-row formula that the move left pointing at another row.
 */
function sortTabs_(ss, sizes, changedRounds, m, reg, formulaTypedOver = false) {
  // A formula typed over, known from the edit or from keys that disagree with the marks: every tab gets its formulas back.
  const repair = formulaTypedOver || (Boolean(m) && !m.sortKeysOk);
  const rounds = repair ? sizes.map((_, i) => i + 1) : changedRounds;
  // With the marks at hand (`m` from readMarks_), a tab already in the right order is left
  // alone: most batches don't change the order.
  const values = m ? marksByTeam_(m, m.teams) : {};
  const inOrder = (current, desired) => current.every((id, i) => id === desired[i]);
  // Each tab to sort, with (given `m`) the rows its teams are on now.
  const tabs = [];
  rounds.forEach((round) => {
    const lay = roundLayout(sizes, round);
    let rows = null;
    if (m) {
      const current = Object.keys(values)
        .filter((id) => m.where[`${id}:${lay.first}`])
        .sort((a, b) => m.where[`${a}:${lay.first}`].row - m.where[`${b}:${lay.first}`].row);
      if (!repair && inOrder(current, roundOrder(sizes, round, current, values))) {
        return;
      }
      rows = current.map((id) => m.where[`${id}:${lay.first}`].row);
    }
    tabs.push({
      name: lay.name,
      width: lay.width,
      spec: roundSortSpec(lay),
      firstFormulaCol: lay.sumCol,
      formulasFor: (row) => roundFormulas(lay, row),
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
    formulasFor: (row) => summaryFormulas(sizes, row),
    rows: null,
  };
  if (m) {
    const current = m.summaryRows.map((t) => t.team_id);
    if (repair || !inOrder(current, summaryOrder(sizes, current, values))) {
      tabs.push(Object.assign(summaryTab, {rows: m.summaryRows.map((t) => t.row)}));
    }
  } else {
    tabs.push(summaryTab);
  }
  if (!tabs.length) {
    return;
  }
  SpreadsheetApp.flush(); // queued writes use today's row numbers: they must land before rows move
  if (m && !repair && reg && sheetsApi_() && sortWithApi_(ss, reg, tabs)) {
    return;
  }
  // The slow way: per tab, read the formulas and fix the wrong ones, sort, fix them again.
  tabs.forEach((tab) => {
    const sheet = tabOf_(ss, tab.name);
    if (timed_('sort_formulas', () => refreshFormulas_(sheet, tab.firstFormulaCol, tab.formulasFor))) {
      SpreadsheetApp.flush(); // seen live (sortWithApi_): a sort before a new formula is calculated sees a blank key
    }
    timed_('sort_range', () => {
      // Down to the last team, not the last row: a note typed under the table stays there.
      const teams = teamRowsOf_(sheet);
      const last = teams.length ? teams[teams.length - 1].row : 1;
      if (last > 2) {
        sheet.getRange(2, 1, last - 1, tab.width).sort(tab.spec);
      }
    });
    timed_('sort_formulas', () => refreshFormulas_(sheet, tab.firstFormulaCol, tab.formulasFor));
  });
}

/**
 * Sort tabs in one Sheets API call. Per tab: sort the team rows, then rewrite the formula
 * columns (a moved formula may point at its old row); they depend only on the row number,
 * so they are not read. Not written before the sort: seen live, a formula written earlier
 * in the same call is not yet calculated when sortRange runs, so every key looks blank and
 * the rows end up in ID order; hence the caller's check that no formula needs repair. Needs the teams on
 * rows 2…n+1 with no gaps; otherwise, or when the call fails (quota; a cached tab ID that
 * no longer exists, then dropped), returns false and the caller sorts the slow way.
 */
function sortWithApi_(ss, reg, tabs) {
  // sortTabs_ lists each tab's rows top to bottom.
  if (!tabs.every((tab) => tab.rows.every((row, i) => row === i + 2))) {
    return false;
  }
  try {
    const ids = sheetIds_(
      ss,
      reg,
      tabs.map((tab) => tab.name),
    );
    const requests = [];
    // «Итоги» first: its keys read the round tabs' formulas, and a formula rewritten earlier in
    // this call isn't calculated yet (see above).
    const summaryFirst = tabs
      .filter((tab) => tab.name === TABS.summary)
      .concat(tabs.filter((tab) => tab.name !== TABS.summary));
    summaryFirst.forEach((tab) => {
      const n = tab.rows.length;
      if (!n) {
        return;
      }
      const sheetId = ids[tab.name];
      const formulas = {
        start: {sheetId, rowIndex: 1, columnIndex: tab.firstFormulaCol - 1},
        rows: Array.from({length: n}, (_, i) => ({
          values: tab.formulasFor(i + 2).map((f) => ({userEnteredValue: {formulaValue: f}})),
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

/**
 * Rewrite the formula cells from `firstCol` on every team row where they differ from `want(row)`, a run
 * of rows at once. Returns whether it wrote anything.
 */
function refreshFormulas_(sheet, firstCol, want) {
  const teams = teamRowsOf_(sheet);
  if (!teams.length) {
    return false;
  }
  const width = want(teams[0].row).length;
  const last = teams[teams.length - 1].row;
  const formulas = sheet.getRange(2, firstCol, last - 1, width).getFormulas();
  let run = [];
  let wrote = false;
  const writeRun = () => {
    if (run.length) {
      wrote = true;
      sheet.getRange(run[0], firstCol, run.length, width).setValues(run.map(want));
      run = [];
    }
  };
  teams.forEach((t) => {
    if (run.length && t.row !== run[run.length - 1] + 1) {
      writeRun();
    }
    const w = want(t.row);
    if (formulas[t.row - 2].some((f, i) => f !== w[i])) {
      run.push(t.row);
    } else {
      writeRun();
    }
  });
  writeRun();
  return wrote;
}
