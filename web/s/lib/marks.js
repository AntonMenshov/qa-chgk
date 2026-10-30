// Marks as the phone shows them: the last server snapshot with the phone's own recent
// events on top. The merge rule is the backend's own (apps_script/logic.js, served as
// ../../shared/logic.js), checked against tests/vectors/merge_cases.json.

import {mergeCell} from '../../shared/logic.js';

export const STATUS_LABEL = {correct: 'верно', incorrect: 'неверно', disputed: 'спорно', received: 'получена'};
const VALUE_STATUS = {R: 'received', 1: 'correct', 0: 'incorrect', '?': 'disputed'};

/** Status name for a cell value (1 → "correct"), or null for an empty cell. */
export function statusOf(value) {
  return value === '' || value == null ? null : (VALUE_STATUS[value] ?? null);
}

/**
 * {team_id: [value per question]} from a server snapshot plus local events (applied in
 * client_ts order). Snapshot cells count as older than any local event: events the
 * server already had are only passed in while the snapshot may not include them yet.
 */
export function overlay(snapshotMarks, events, totalQuestions) {
  const cells = {};
  for (const [teamId, values] of Object.entries(snapshotMarks || {})) {
    cells[teamId] = Array.from({length: totalQuestions}, (_, q) => ({value: values[q] ?? '', ts: -Infinity}));
  }
  const sorted = [...events].sort((a, b) => a.client_ts - b.client_ts);
  for (const ev of sorted) {
    if (ev.question < 1 || ev.question > totalQuestions) {
      continue;
    }
    cells[ev.team_id] ??= Array.from({length: totalQuestions}, () => ({value: '', ts: -Infinity}));
    const row = cells[ev.team_id];
    row[ev.question - 1] = mergeCell(row[ev.question - 1], ev.status, ev.client_ts);
  }
  return Object.fromEntries(Object.entries(cells).map(([id, row]) => [id, row.map((c) => c.value)]));
}
