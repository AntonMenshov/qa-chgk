// Marks as the phone shows them: the last server snapshot with the phone's own recent
// events on top. The merge rule is the backend's own (apps_script/logic.js, served as
// ../../shared/logic.js), checked against tests/vectors/merge_cases.json.

import {mergeCell, STATUS_VALUE} from '../../shared/logic.js';

export const STATUS_LABEL = {correct: 'верно', incorrect: 'неверно', disputed: 'спорно', received: 'получена'};
// No prototype: a cell holding the text "constructor" is no status either.
const VALUE_STATUS = Object.assign(
  Object.create(null),
  Object.fromEntries(
    Object.entries(STATUS_VALUE)
      .filter(([, value]) => value !== '')
      .map(([status, value]) => [value, status]),
  ),
);

/** Status name for a cell value (1 → "correct"), or null for an empty cell. */
export function statusOf(value) {
  return VALUE_STATUS[value] ?? null;
}

/** The card sheet's button that gives no verdict: a card already entered keeps its mark. */
export function noVerdictLabel(previous) {
  return previous ? `Отмена (останется: ${STATUS_LABEL[previous]})` : 'Решить позже (карточка получена)';
}

/**
 * {team_id: [value per question]} from a server snapshot plus local events (applied in
 * client_ts order). Snapshot cells count as older than any local event: events the
 * server already had are only passed in while the snapshot may not include them yet.
 */
export function overlay(snapshotMarks, events, totalQuestions) {
  const row = (values) => Array.from({length: totalQuestions}, (_, q) => ({value: values[q] ?? '', ts: -Infinity}));
  const cells = {};
  for (const [teamId, values] of Object.entries(snapshotMarks || {})) {
    cells[teamId] = row(values);
  }
  const sorted = [...events].sort((a, b) => a.client_ts - b.client_ts);
  for (const ev of sorted) {
    if (ev.question < 1 || ev.question > totalQuestions) {
      continue;
    }
    cells[ev.team_id] ??= row([]);
    const teamCells = cells[ev.team_id];
    teamCells[ev.question - 1] = mergeCell(teamCells[ev.question - 1], ev.status, ev.client_ts);
  }
  return Object.fromEntries(Object.entries(cells).map(([id, teamCells]) => [id, teamCells.map((c) => c.value)]));
}
