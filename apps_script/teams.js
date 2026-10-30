// Teams: the Teams tab, rows on «Итоги» and the round tabs, reserve decks, names, formatting.

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

function setTeams_(ss, reg, teams) {
  formatSheets_(ss, reg.round_sizes); // safe to re-run
  writeTeams_(ss, teams);
  const counts = syncTeamRows_(ss, reg.round_sizes, teams);
  refreshDisputed_(ss, reg.round_sizes); // names may have changed
  return {ok: true, appended: counts.appended, renamed: counts.renamed};
}
