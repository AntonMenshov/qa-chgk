// The Sheet's onEdit trigger: jury edits of marks and names.

/**
 * Installable onEdit trigger. Marks on a round tab: found by comparing every mark with the
 * last known value (not by e.range, whose row may hold another team by now if the tab was
 * re-sorted), then the tabs are re-sorted. Names in column B of «Итоги», a round tab or
 * Teams: copied to every tab by team ID.
 */
function onSheetEdit(e) {
  const sheet = e.range.getSheet();
  const name = sheet.getName();
  const isRound = /^Тур \d+$/.test(name);
  if (!isRound && name !== TABS.summary && name !== TABS.teams) {
    return;
  }
  // The header row only.
  if (e.range.getRow() + e.range.getNumRows() - 1 < 2) {
    return;
  }
  const ss = sheet.getParent();
  const settings = ss.getSheetByName(TABS.settings).getRange(1, 1, SETTINGS_ROWS, 2).getValues();
  const sizes = JSON.parse(settings.find((r) => r[0] === 'round_sizes')[1]);
  const tid = String((settings.find((r) => r[0] === 'tid') || [])[1] || '');
  // Columns never move, so the columns still tell what was touched.
  const first = e.range.getColumn();
  const last = first + e.range.getNumColumns() - 1;
  const touchesNames = first <= 2 && last >= 2;
  const columns = Array.from({length: last - first + 1}, (_, i) => first + i);
  const touchesMarks = isRound && columns.some((c) => questionAt(sizes, name, 2, c) !== null);
  // A computed cell typed over («Сумма», «Итого», …): the same pass below finds and repairs it.
  const touchesFormulas = name !== TABS.teams && last > 2 && !touchesMarks;
  if (!touchesNames && !touchesMarks && !touchesFormulas) {
    return;
  }
  const user = e.user && e.user.getEmail ? e.user.getEmail() : '';

  withLock_(() => {
    let current = null;
    try {
      current = registry_(PropertiesService.getScriptProperties(), tid);
    } catch {
      // a Sheet the backend doesn't know (copied?): sort the slow way, nothing to publish to
    }
    if (touchesNames) {
      propagateNames_(ss, sizes, name);
      refreshDisputed_(ss, sizes);
    }
    if (touchesMarks || touchesFormulas) {
      SpreadsheetApp.flush(); // names written just above must be in the batched read
      const m = readMarks_(ss, {round_sizes: sizes}, {log: true});
      const disputedBefore = disputedBefore_(m);
      const rounds = applySheetEdits_(ss, m, user);
      updateDisputed_(m, disputedBefore);
      m.w.flush();
      if (rounds.size || !m.sortKeysOk) {
        sortTabs_(ss, sizes, [...rounds], m, current);
      }
    }
    // Not published here: a column of hand edits would publish once per cell, with phones waiting on the lock.
    if (current) {
      markUnpublished_(PropertiesService.getScriptProperties(), current);
    }
  });
}
