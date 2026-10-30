// The jury's scanning session, without any DOM or network: which question is current,
// what a scanned code means, the warnings to show, the teams still missing a card, and
// the events to record. app.js wires it to the camera, the screen and the queue.

import {decodeCard, decodeSetup} from './payload.js';
import {overlay, statusOf, STATUS_LABEL} from './marks.js';

export const WARN = {EARLIER: 'earlier', ALREADY: 'already', RESERVE: 'reserve'};

export class Session {
  /**
   * @param {object} o
   * @param {string} o.tid       this tournament's ID (cards of other tournaments are refused)
   * @param {object} o.state     get_state reply: {tournament: {name, round_sizes}, teams, marks}
   * @param {number} [o.current] current question to resume from (else derived from the marks)
   * @param {string} [o.juror]   juror name stored on every event
   * @param {string} [o.device]  device ID stored on every event
   * @param {() => number} [o.now]
   * @param {() => string} [o.uuid]
   */
  constructor({tid, state, current = null, juror = '', device = '', now = Date.now, uuid = () => crypto.randomUUID()}) {
    Object.assign(this, {tid, juror, device, now, uuid});
    this.local = []; // {event, pending, ackedAt}
    this.setSnapshot(state, -Infinity);
    this.current = current && current >= 1 && current <= this.total ? current : this.lastMarkedQuestion() || 1;
  }

  // ---- data from the server ----

  /** A get_state reply whose request started at `startedAt` (events acked before that are in it). */
  setSnapshot(state, startedAt) {
    this.name = state.tournament.name;
    this.roundSizes = state.tournament.round_sizes;
    this.total = this.roundSizes.reduce((a, b) => a + b, 0);
    this.teams = state.teams;
    this.byId = new Map(state.teams.map((t) => [t.team_id, t]));
    this.snapshot = state.marks || {};
    this.local = this.local.filter((l) => l.pending || l.ackedAt >= startedAt);
  }

  /** Marks as the jury should see them: {team_id: [value per question]}. */
  get marks() {
    return overlay(
      this.snapshot,
      this.local.map((l) => l.event),
      this.total,
    );
  }

  valueOf(teamId, question) {
    return (this.marks[teamId] || [])[question - 1] ?? '';
  }

  lastMarkedQuestion() {
    let last = 0;
    for (const values of Object.values(this.marks)) {
      values.forEach((v, i) => {
        if (v !== '' && i + 1 > last) {
          last = i + 1;
        }
      });
    }
    return last;
  }

  roundOf(question) {
    let first = 1;
    for (let r = 0; r < this.roundSizes.length; r++) {
      if (question < first + this.roundSizes[r]) {
        return r + 1;
      }
      first += this.roundSizes[r];
    }
    return null;
  }

  // ---- the current question ----

  /** ◀ ▶ by hand; the scans move it too (see card()). */
  setQuestion(question) {
    this.current = Math.min(Math.max(1, question), this.total);
    return this.current;
  }

  // ---- scanning ----

  /**
   * What a scanned code means:
   *   {kind: "setup", setup}           a jury link (switch tournament / re-setup)
   *   {kind: "other"}                  not a ЧГК code
   *   {kind: "foreign", tid}           a card of another tournament: not recorded
   *   {kind: "unknown_team", teamId}   not in this tournament's team list
   *   {kind: "spare", team, spare}     ask the juror which question, then call card()
   *   {kind: "card", ...}              see card()
   */
  scan(text) {
    const setup = decodeSetup(text);
    if (setup) {
      return {kind: 'setup', setup};
    }
    const c = decodeCard(text);
    if (!c) {
      return {kind: 'other'};
    }
    if (c.tid !== this.tid) {
      return {kind: 'foreign', tid: c.tid};
    }
    const team = this.byId.get(c.teamId);
    if (!team) {
      return {kind: 'unknown_team', teamId: c.teamId};
    }
    if (c.spare !== null) {
      return {kind: 'spare', team, spare: c.spare};
    }
    return this.card(team.team_id, c.question, null);
  }

  /**
   * A card for `question` (from its QR code, or the juror's answer for a spare card).
   * A later question becomes the current one. Returns {kind: "card", team, question,
   * spare, previous, warnings} where previous is the status already recorded, if any.
   */
  card(teamId, question, spare) {
    const team = this.byId.get(teamId);
    const before = this.current;
    if (question > this.current) {
      this.current = question;
    }
    const previous = statusOf(this.valueOf(teamId, question));
    const warnings = [];
    if (question < before) {
      warnings.push({
        code: WARN.EARLIER,
        text: `Карточка вопроса ${question} (идёт ${before}) — отмечается для ${question}`,
      });
    }
    if (previous && previous !== 'received') {
      warnings.push({code: WARN.ALREADY, text: `Уже отмечено: ${STATUS_LABEL[previous]}`});
    }
    if (team.reserve && !this.isPlaying(team)) {
      warnings.push({
        code: WARN.RESERVE,
        text: `Запасной комплект ${team.team_id}: впишите название команды в таблицу`,
      });
    }
    return {kind: 'card', team, question, spare, previous, warnings};
  }

  // ---- events ----

  /** Create an event, show it at once (it is pending until the queue says it was sent). */
  record(teamId, question, spare, status) {
    const event = {
      scan_id: this.uuid(),
      team_id: teamId,
      question,
      status,
      client_ts: this.now(),
      juror: this.juror,
      device: this.device,
    };
    if (spare !== null && spare !== undefined) {
      event.spare = spare;
    }
    this.local.push({event, pending: true, ackedAt: null});
    return event;
  }

  /** Events from the queue (e.g. after a reload) that the server has not confirmed yet. */
  restorePending(events) {
    const known = new Set(this.local.map((l) => l.event.scan_id));
    for (const event of events) {
      if (!known.has(event.scan_id)) {
        this.local.push({event, pending: true, ackedAt: null});
      }
    }
  }

  /** The server took these events (applied or duplicate). */
  acked(scanIds, at = this.now()) {
    const ids = new Set(scanIds);
    for (const l of this.local) {
      if (ids.has(l.event.scan_id)) {
        Object.assign(l, {pending: false, ackedAt: at});
      }
    }
  }

  /** The server refused these events: they no longer count on screen. */
  rejected(scanIds) {
    const ids = new Set(scanIds);
    this.local = this.local.filter((l) => !ids.has(l.event.scan_id));
  }

  // ---- teams still to hand in a card ----

  /** A reserve team is playing once it has any mark; registered teams always are. */
  isPlaying(team) {
    if (!team.reserve) {
      return true;
    }
    return (this.marks[team.team_id] || []).some((v) => v !== '');
  }

  /** Teams with no card yet for the current question (or `question`). */
  missing(question = this.current) {
    return this.teams.filter((t) => this.isPlaying(t) && this.valueOf(t.team_id, question) === '');
  }
}
