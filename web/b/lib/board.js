// What the projector board shows, without any DOM: standings after the rounds revealed so
// far, in the Sheet's order (Итого, then the last round, the one before, …, then team ID)
// with shared places as "2-3". The place labels and the order are the Sheet's own
// (apps_script/logic.js, served as ../../shared/logic.js).

import {compareStandings, placeLabels} from '../../shared/logic.js';

/** "+" taken, "−" not (a missing card counts as wrong), "?" not decided yet («?» or only received). */
export function cellMark(value) {
  if (value === 1) {
    return '+';
  }
  if (value === '?' || value === 'R') {
    return '?';
  }
  return '−';
}

/**
 * The board after `revealed` rounds.
 * @param {object} data      get_board reply: {tournament: {name, date, round_sizes}, teams, marks, view_url}
 * @param {number} revealed  rounds shown so far (0 = title screen)
 * @param {object} o
 * @param {number} o.gridMax  up to this many teams: the full grid of every round, else "compact"
 * @param {"grid"|"compact"|null} [o.view]  forced view (the G key), else by team count
 * @returns {{name, date, rounds, revealed, view, groups, rows, took, teams}}
 *   groups: the question columns shown, [{round, questions: [q, …]}]
 *   rows:   [{team_id, name, place, total, sums: [per revealed round], marks: {q: "+"|"−"|"?"}}]
 *   took:   {q: number of teams that took it}
 */
export function boardModel(data, revealed, {gridMax, view = null}) {
  const sizes = data.tournament.round_sizes;
  const shown = Math.min(Math.max(0, revealed), sizes.length);
  const firstOf = (round) => sizes.slice(0, round - 1).reduce((a, b) => a + b, 1);
  const questionsOf = (round) => Array.from({length: sizes[round - 1]}, (_, k) => firstOf(round) + k);
  const chosen = view || (data.teams.length <= gridMax ? 'grid' : 'compact');
  const groupRounds = shown === 0 ? [] : chosen === 'grid' ? Array.from({length: shown}, (_, i) => i + 1) : [shown];
  const groups = groupRounds.map((round) => ({round, questions: questionsOf(round)}));

  const rows = data.teams.map((team) => {
    const values = data.marks[team.team_id] || [];
    const sums = [];
    for (let r = 1; r <= shown; r++) {
      sums.push(questionsOf(r).filter((q) => values[q - 1] === 1).length);
    }
    const marks = {};
    for (const g of groups) {
      for (const q of g.questions) {
        marks[q] = cellMark(values[q - 1] ?? '');
      }
    }
    return {team_id: team.team_id, name: team.name, sums, total: sums.reduce((a, b) => a + b, 0), marks};
  });
  // compareStandings (the backend's tie-break rule) reads the round sums as `rounds`.
  rows.sort((a, b) => compareStandings({...a, rounds: a.sums}, {...b, rounds: b.sums}));
  const places = placeLabels(rows.map((r) => r.total));
  rows.forEach((r, i) => {
    r.place = places[i];
  });

  const took = {};
  for (const g of groups) {
    for (const q of g.questions) {
      took[q] = rows.filter((r) => r.marks[q] === '+').length;
    }
  }
  return {
    name: data.tournament.name,
    date: data.tournament.date,
    rounds: sizes.length,
    revealed: shown,
    view: chosen,
    groups,
    rows,
    took,
    teams: data.teams.length,
  };
}
