// What the projector board shows, without any DOM: standings after the rounds revealed so
// far, in the Sheet's order (Итого, then the last round, the one before, …, then team ID)
// with shared places as "2-3". The place labels and the order are the Sheet's own
// (apps_script/logic.js, served as ../../shared/logic.js).

import {compareStandings, NOT_A_MARK, STATUS_VALUE, standings} from '../../shared/logic.js';

/** "+" taken, "×" wrong, "•" no card yet (counts as not taken), "?" not decided yet («?», only received, or unreadable). */
export function cellMark(value) {
  if (value === STATUS_VALUE.correct) {
    return '+';
  }
  if (value === STATUS_VALUE.disputed || value === STATUS_VALUE.received || value === NOT_A_MARK) {
    return '?';
  }
  return value === STATUS_VALUE.incorrect ? '×' : '•';
}

/** The view shown: the one forced with the G key, else by team count. */
export function chosenView(data, gridMax, view) {
  return view || (data.teams.length <= gridMax ? 'grid' : 'compact');
}

/**
 * The board after `revealed` rounds.
 * @param {any} data      get_board reply: {tournament: {name, date, round_sizes}, teams, marks, view_url}
 * @param {number} revealed  rounds shown so far (0 = title screen)
 * @param {object} o
 * @param {number} o.gridMax  up to this many teams: the full grid of every round, else "compact"
 * @param {"grid"|"compact"|null} [o.view]  forced view (the G key), else by team count
 * @returns {{name, date, rounds, revealed, view, groups, rows, took}}
 *   groups: the question columns shown, [{round, questions: [q, …]}]
 *   rows:   [{team_id, name, place, total, rounds: [per revealed round], marks: {q: "+"|"×"|"•"|"?"}}]
 *   took:   {q: number of teams that took it}
 */
export function boardModel(data, revealed, {gridMax, view = null}) {
  const sizes = data.tournament.round_sizes;
  const shown = Math.min(Math.max(0, revealed), sizes.length);
  let next = 1;
  const allQuestions = sizes.map((size) => Array.from({length: size}, () => next++));
  const chosen = chosenView(data, gridMax, view);
  const groupRounds = shown === 0 ? [] : chosen === 'grid' ? Array.from({length: shown}, (_, i) => i + 1) : [shown];
  const groups = groupRounds.map((round) => ({round, questions: allQuestions[round - 1]}));

  // The same sums and places as the Sheet, over the revealed rounds only.
  const revealedSizes = sizes.slice(0, shown);
  const totals = standings(
    revealedSizes,
    data.teams.map((team) => team.team_id),
    data.marks,
  );
  const rows = data.teams.map((team, i) => {
    const values = data.marks[team.team_id] || [];
    const marks = {};
    for (const g of groups) {
      for (const q of g.questions) {
        marks[q] = cellMark(values[q - 1]);
      }
    }
    const {rounds, total, place} = totals[i];
    return {team_id: team.team_id, name: team.name, rounds, total, place, marks};
  });
  rows.sort(compareStandings); // the backend's tie-break rule

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
  };
}
