// Marks: reading them with Meta and the Log, jury edits, record_events, get_state, get_board.

/**
 * Every mark: "TEAM:Q" → {value, ts}, where it sits now, and the last value the backend
 * knows; all in one read. Rows are matched by team ID, so the tabs may have been re-sorted
 * in between. `with_.teams` adds the Teams tab (m.teamsTab), `with_.log` the Log (m.log:
 * scan IDs, photos, next free row). Writes go to `m.w`, sent by `m.w.flush()`.
 */
function readMarks_(ss, reg, with_) {
  const opts = with_ || {};
  const sizes = reg.round_sizes;
  const n = totalQuestions(sizes);
  const ml = metaLayout(n);
  const lays = sizes.map((_, i) => roundLayout(sizes, i + 1));
  const logFirst = LOG_HEADER.indexOf('scan_id') + 1;
  const logCols = LOG_HEADER.length - logFirst + 1;
  const sl = summaryLayout(sizes);
  // Up to and including the computed sort keys: Итого on «Итоги», «Сумма» on round tabs.
  const specs = [
    {name: TABS.summary, row: 2, col: 1, cols: sl.totalCol},
    {name: TABS.meta, row: 1, col: 1, cols: ml.width},
  ].concat(lays.map((lay) => ({name: lay.name, row: 2, col: 1, cols: lay.sumCol})));
  if (opts.teams) {
    specs.push({name: TABS.teams, row: 2, col: 1, cols: TEAMS_HEADER.length});
  }
  if (opts.log) {
    specs.push({name: TABS.log, row: 2, col: logFirst, cols: logCols});
  }
  const blocks = readBlocks_(ss, specs);
  const w = writer_(ss);

  // «Итоги» as it is now, row by row (sortTabs_ checks its order without reading it again).
  const summaryRows = [];
  blocks[0].forEach((r, j) => {
    const id = String(r[0]).trim();
    if (id) {
      summaryRows.push({team_id: id, row: j + 2});
    }
  });
  // ID order (the order of the cards), not the standings order of «Итоги».
  const teams = blocks[0]
    .map((r) => ({team_id: String(r[0]).trim(), name: String(r[1])}))
    .filter((t) => t.team_id !== '')
    .sort((a, b) => (a.team_id < b.team_id ? -1 : a.team_id > b.team_id ? 1 : 0));
  const cells = {};
  const where = {};
  // The sort keys as the Sheet computed them must agree with the marks read with them; a
  // formula overwritten by hand makes them disagree, and then sortTabs_ takes the slow way,
  // which repairs formulas before sorting (the one-call sort can't: see sortWithApi_).
  let sortKeysOk = true;
  const roundSums = {};
  lays.forEach((lay, i) => {
    blocks[2 + i].forEach((r, j) => {
      const id = String(r[0]).trim();
      if (!id) {
        return;
      }
      let took = 0;
      for (let k = 0; k < lay.size; k++) {
        const key = `${id}:${lay.first + k}`;
        cells[key] = {value: r[lay.firstCol - 1 + k], ts: 0};
        where[key] = {name: lay.name, row: j + 2, col: lay.firstCol + k, round: i + 1};
        took += cells[key].value === 1 ? 1 : 0;
      }
      (roundSums[id] = roundSums[id] || [])[i] = took;
      sortKeysOk = sortKeysOk && r[lay.sumCol - 1] === took;
    });
  });
  blocks[0].forEach((r) => {
    const id = String(r[0]).trim();
    if (id) {
      const sums = lays.map((_, i) => (roundSums[id] || [])[i] || 0);
      sums.forEach((sum, i) => {
        sortKeysOk = sortKeysOk && r[sl.firstRound - 1 + i] === sum;
      });
      sortKeysOk = sortKeysOk && r[sl.totalCol - 1] === sums.reduce((a, b) => a + b, 0);
    }
  });

  const metaBlock = blocks[1];
  const known = {};
  const rows = new Map();
  metaBlock.slice(1).forEach((r, j) => {
    const id = String(r[0]).trim();
    if (!id) {
      return;
    }
    rows.set(id, j + 2);
    for (let q = 1; q <= n; q++) {
      const key = `${id}:${q}`;
      if (!cells[key]) {
        continue;
      }
      cells[key].ts = Number(r[ml.tsCol(q) - 1]) || 0;
      known[key] = r[ml.knownCol(q) - 1];
    }
  });
  const meta = {ml, rows, next: Math.max(metaBlock.length, 1) + 1};

  const m = {sizes, n, teams, summaryRows, cells, where, known, meta, w, sortKeysOk};
  const extra = blocks.slice(2 + lays.length); // the optional blocks, in the order requested
  if (opts.teams) {
    m.teamsTab = teamsFromRows_(extra.shift());
  }
  if (opts.log) {
    const logRows = extra.shift();
    const at = (name) => LOG_HEADER.indexOf(name) + 1 - logFirst;
    const photos = {};
    logRows.forEach((r) => {
      const photo = String(r[at('photo')]).trim();
      if (photo) {
        photos[`${String(r[at('team_id')]).trim()}:${Number(r[at('question')])}`] = photo;
      }
    });
    m.log = {seen: new Set(logRows.map((r) => String(r[0]))), photos, next: logRows.length + 2};
  }
  return m;
}

/** Meta row of a team; a team without one gets the next free row (written with the rest). */
function metaRowOf_(m, teamId) {
  if (!m.meta.rows.has(teamId)) {
    const row = m.meta.next++;
    m.w.set(TABS.meta, row, 1, [[teamId].concat(new Array(m.meta.ml.width - 1).fill(''))]);
    m.meta.rows.set(teamId, row);
  }
  return m.meta.rows.get(teamId);
}

/** Store a mark's value and time: on its round tab (if `toTab`) and in Meta. */
function writeMark_(m, key, cell, toTab) {
  const at = m.where[key];
  if (toTab) {
    m.w.set(at.name, at.row, at.col, [[cell.value]]);
  }
  const [teamId, q] = key.split(':');
  const row = metaRowOf_(m, teamId);
  m.w.set(TABS.meta, row, m.meta.ml.tsCol(Number(q)), [[cell.ts]]);
  m.w.set(TABS.meta, row, m.meta.ml.knownCol(Number(q)), [[cell.value]]);
  m.known[key] = cell.value;
}

/** Queue Log rows after the last one; their scan IDs and photos count from now on. */
function appendLog_(m, rows) {
  if (!rows.length) {
    return;
  }
  m.w.set(TABS.log, m.log.next, 1, rows);
  const col = (name) => LOG_HEADER.indexOf(name);
  rows.forEach((r) => {
    m.log.seen.add(String(r[col('scan_id')]));
    if (r[col('photo')]) {
      m.log.photos[`${r[col('team_id')]}:${r[col('question')]}`] = r[col('photo')];
    }
  });
  m.log.next += rows.length;
}

/**
 * Pick up jury edits on the round tabs (see sheetEdits): normalise them («+» → 1),
 * time-stamp and log them. Returns the rounds that changed. Needs `m` read with the Log.
 */
function applySheetEdits_(ss, m, user) {
  const current = {};
  Object.keys(m.cells).forEach((key) => {
    current[key] = m.cells[key].value;
  });
  const now = Date.now();
  const rows = [];
  const rounds = new Set();
  sheetEdits(current, m.known).forEach((edit) => {
    const at = m.where[edit.key];
    // Notes are not values: these go through SpreadsheetApp (jury edits are rare).
    const range = ss.getSheetByName(at.name).getRange(at.row, at.col);
    if (edit.status === null) {
      timed_('notes', () => range.setNote('Непонятное значение: используйте 1, 0, ? или R'));
      return;
    }
    timed_('notes', () => range.clearNote());
    m.cells[edit.key] = {value: edit.value, ts: now};
    writeMark_(m, edit.key, m.cells[edit.key], edit.raw !== edit.value);
    rounds.add(at.round);
    const [teamId, q] = edit.key.split(':');
    rows.push([
      logTime_(now),
      logTime_(now),
      `sheet-${now}-${edit.key}`,
      'sheet',
      user,
      '',
      teamId,
      Number(q),
      '',
      edit.status,
      edit.value,
      true,
      '',
    ]);
  });
  appendLog_(m, rows);
  return rounds;
}

function readState_(ss, reg) {
  const m = readMarks_(ss, reg, {teams: true});
  const reserve = m.teamsTab.filter((t) => t.reserve);
  const reserveIds = new Set(reserve.map((t) => t.team_id));
  const present = new Set(m.teams.map((t) => t.team_id));
  // Phones need reserve IDs too, to accept those cards before their first scan.
  const teams = m.teams
    .map((t) => ({team_id: t.team_id, name: t.name, reserve: reserveIds.has(t.team_id)}))
    .concat(
      reserve
        .filter((t) => !present.has(t.team_id))
        .map((t) => ({team_id: t.team_id, name: t.name || reservePlaceholder(t.team_id), reserve: true})),
    );
  const marks = {};
  teams.forEach((t) => {
    marks[t.team_id] = Array.from({length: m.n}, (_, k) => {
      const cell = m.cells[`${t.team_id}:${k + 1}`];
      return cell ? cell.value : '';
    });
  });
  return {
    ok: true,
    tournament: {name: reg.name, date: reg.date, round_sizes: reg.round_sizes},
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
    marks[t.team_id] = Array.from({length: m.n}, (_, k) => {
      const cell = m.cells[`${t.team_id}:${k + 1}`];
      return cell ? cell.value : '';
    });
  });
  return {
    ok: true,
    tournament: {name: reg.name, date: reg.date, round_sizes: reg.round_sizes},
    teams: m.teams,
    marks,
    // The view-only table, for its QR code on the board (the same link as on the jury sheet).
    view_url: `https://docs.google.com/spreadsheets/d/${reg.spreadsheet_id}/htmlview`,
  };
}

/** «Итоги» and «Статистика» as Google computed them, to check the formulas live (tests). */
function readResults_(ss, reg) {
  const sizes = reg.round_sizes;
  const summary = summaryOf_(ss);
  const sl = summaryLayout(sizes);
  const last = summary.getLastRow();
  const standings =
    last < 2
      ? []
      : summary
          .getRange(2, 1, last - 1, sl.width)
          .getValues()
          .filter((r) => String(r[0]).trim() !== '')
          .map((r) => ({
            team_id: String(r[0]).trim(),
            name: String(r[1]),
            rounds: r.slice(sl.firstRound - 1, sl.totalCol - 1),
            total: r[sl.totalCol - 1],
            place: r[sl.placeCol - 1],
          }));
  const n = totalQuestions(sizes);
  const stats = ss
    .getSheetByName(TABS.stats)
    .getRange(2, 1, n, 4)
    .getValues()
    .map((r) => ({question: r[0], round: r[1], took: r[2], share: r[3]}));
  return {ok: true, standings, stats};
}

function recordEvents_(ss, reg, req) {
  let m = readMarks_(ss, reg, {teams: true, log: true});
  // A reserve team's first valid scan puts it on the tabs (rare: then read again).
  const reserveIds = new Set(m.teamsTab.filter((t) => t.reserve).map((t) => t.team_id));
  const nowMs = Date.now();
  const activate = req.events
    .filter(
      (ev) =>
        ev &&
        reserveIds.has(ev.team_id) &&
        !m.where[`${ev.team_id}:1`] &&
        !eventError(ev, new Set([ev.team_id]), reg.round_sizes, nowMs),
    )
    .map((ev) => ev.team_id);
  if (activate.length) {
    timed_('reserve', () => {
      activateReserve_(ss, reg.round_sizes, activate);
      SpreadsheetApp.flush();
    });
    m = readMarks_(ss, reg, {teams: true, log: true});
  }
  const disputedBefore = disputedBefore_(m);
  // Jury edits first, so they get their time before app marks are compared with them.
  const rounds = applySheetEdits_(ss, m, '');
  const cells = m.cells;
  const before = Object.assign({}, cells);
  // Teams with rows on the round tabs can be marked. Unused reserve teams count as known,
  // so their invalid events report the real problem (their valid ones activated them above).
  const teamIds = new Set(
    m.teams
      .map((t) => t.team_id)
      .filter((id) => m.where[`${id}:1`])
      .concat([...reserveIds]),
  );

  const outcomes = applyEvents(cells, m.log.seen, req.events, teamIds, reg.round_sizes, Date.now());

  // Write only the cells that changed, so a juror editing the sheet at the same moment is not overwritten.
  Object.keys(cells).forEach((key) => {
    if (cells[key] === before[key]) {
      return;
    }
    writeMark_(m, key, cells[key], true);
    rounds.add(m.where[key].round);
  });

  const now = logTime_(Date.now());
  const logRows = [];
  req.events.forEach((ev, k) => {
    const o = outcomes[k];
    if (o.error || o.duplicate) {
      return;
    }
    logRows.push([
      now,
      logTime_(ev.client_ts),
      ev.scan_id,
      'app',
      ev.juror || '',
      ev.device || '',
      ev.team_id,
      ev.question,
      ev.spare || '',
      ev.status,
      STATUS_VALUE[ev.status],
      o.applied,
      '', // photo: card photos come through upload_photo
    ]);
  });
  appendLog_(m, logRows);
  updateDisputed_(m, disputedBefore);
  m.w.flush(); // before sorting: the rows above are where the read found them
  if (rounds.size) {
    sortTabs_(ss, reg.round_sizes, [...rounds], m, reg);
  }
  return {ok: true, results: outcomes};
}
