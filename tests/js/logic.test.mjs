import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const L = require("../../apps_script/logic.js");
const MERGE = JSON.parse(readFileSync(new URL("../vectors/merge_cases.json", import.meta.url), "utf8"));

const TEAMS = new Set(["A01", "A02"]);
const ROUNDS = [3, 3];
const NOW = 1_800_000_000_000;
const ev = (over = {}) => ({ scan_id: "s1", status: "correct", team_id: "A01", question: 2, client_ts: NOW - 1000, ...over });

for (const c of MERGE.cases) {
  test(`merge: ${c.note}`, () => {
    assert.deepEqual(L.mergeCell(c.before, c.status, c.ts), c.after);
  });
}

test("tokensEqual", () => {
  assert.equal(L.tokensEqual("abc", "abc"), true);
  assert.equal(L.tokensEqual("abc", "abd"), false);
  assert.equal(L.tokensEqual("abc", "abcd"), false);
  assert.equal(L.tokensEqual("", ""), false);
  assert.equal(L.tokensEqual(undefined, "abc"), false);
});

test("colLetter", () => {
  assert.deepEqual([1, 2, 26, 27, 52, 53, 702, 703].map(L.colLetter), ["A", "B", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
});

test("validateRequest accepts good requests", () => {
  assert.ok(L.validateRequest({ action: "ping" }));
  assert.ok(L.validateRequest({
    action: "create_tournament", tid: "K7M2Q", name: "Кубок", date: "2026-11-15", round_sizes: [12, 12, 15],
    jury_token: "x".repeat(24), teams: [{ team_id: "A01", name: "Синие зайцы" }],
  }));
  assert.ok(L.validateRequest({ action: "record_events", tid: "K7M2Q", events: [ev()] }));
});

const BAD = [
  [null, "JSON object"],
  [{ action: "nope", tid: "K7M2Q" }, "unknown action"],
  [{ action: "get_state", tid: "k7m2q" }, "invalid tid"],
  [{ action: "create_tournament", tid: "K7M2Q", name: "", date: "2026-11-15", round_sizes: [1], jury_token: "x".repeat(24) }, "name"],
  [{ action: "create_tournament", tid: "K7M2Q", name: "X", date: "15.11.2026", round_sizes: [1], jury_token: "x".repeat(24) }, "date"],
  [{ action: "create_tournament", tid: "K7M2Q", name: "X", date: "2026-11-15", round_sizes: [], jury_token: "x".repeat(24) }, "round_sizes"],
  [{ action: "create_tournament", tid: "K7M2Q", name: "X", date: "2026-11-15", round_sizes: [0], jury_token: "x".repeat(24) }, "questions"],
  [{ action: "create_tournament", tid: "K7M2Q", name: "X", date: "2026-11-15", round_sizes: [1], jury_token: "short" }, "jury_token"],
  [{ action: "set_teams", tid: "K7M2Q", teams: [{ team_id: "A01", name: "X" }, { team_id: "A01", name: "Y" }] }, "duplicate"],
  [{ action: "set_teams", tid: "K7M2Q", teams: [{ team_id: "a1", name: "X" }] }, "invalid team_id"],
  [{ action: "set_teams", tid: "K7M2Q", teams: [{ team_id: "A01", name: " " }] }, "no name"],
  [{ action: "record_events", tid: "K7M2Q", events: [] }, "non-empty"],
  [{ action: "record_events", tid: "K7M2Q", events: new Array(501).fill(ev()) }, "at most"],
];
for (const [body, message] of BAD) {
  test(`validateRequest rejects: ${message}`, () => {
    assert.throws(() => L.validateRequest(body), (err) => err instanceof L.RequestError && err.message.includes(message));
  });
}

test("eventError catches each bad field", () => {
  assert.equal(L.eventError(ev(), TEAMS, ROUNDS, NOW), null);
  assert.equal(L.eventError(ev({ spare: 2 }), TEAMS, ROUNDS, NOW), null);
  assert.match(L.eventError(ev({ scan_id: "" }), TEAMS, ROUNDS, NOW), /scan_id/);
  assert.match(L.eventError(ev({ status: "cleared" }), TEAMS, ROUNDS, NOW), /status/); // sheet-only
  assert.match(L.eventError(ev({ team_id: "B01" }), TEAMS, ROUNDS, NOW), /team/);
  assert.match(L.eventError(ev({ question: 7 }), TEAMS, ROUNDS, NOW), /question/);
  assert.match(L.eventError(ev({ question: 0 }), TEAMS, ROUNDS, NOW), /question/);
  assert.match(L.eventError(ev({ client_ts: NOW + 2 * 86400000 }), TEAMS, ROUNDS, NOW), /client_ts/);
  assert.match(L.eventError(ev({ spare: 0 }), TEAMS, ROUNDS, NOW), /spare/);
});

test("applyEvents: idempotent, order-independent for judgements, reports outcomes", () => {
  const cells = {};
  const seen = new Set();
  const out = L.applyEvents(cells, seen, [
    ev({ scan_id: "a", status: "received", client_ts: NOW - 300 }),
    ev({ scan_id: "b", status: "incorrect", client_ts: NOW - 200 }),
    ev({ scan_id: "b", status: "incorrect", client_ts: NOW - 200 }), // retried in the same batch
    ev({ scan_id: "c", status: "correct", client_ts: NOW - 250 }), // older than b: loses
    ev({ scan_id: "d", team_id: "ZZZ" }),
  ], TEAMS, ROUNDS, NOW);
  assert.deepEqual(out.map((o) => [o.scan_id, o.applied, o.duplicate, Boolean(o.error)]), [
    ["a", true, false, false], ["b", true, false, false], ["b", false, true, false],
    ["c", false, false, false], ["d", false, false, true],
  ]);
  assert.deepEqual(cells["A01:2"], { value: 0, ts: NOW - 200 });
  // A later request retrying "b" is a duplicate too.
  assert.equal(L.applyEvents(cells, seen, [ev({ scan_id: "b" })], TEAMS, ROUNDS, NOW)[0].duplicate, true);
});

test("normalizeCellInput", () => {
  const cases = { "1": "correct", "+": "correct", " Да ": "correct", "0": "incorrect", "-": "incorrect", "−": "incorrect",
    "?": "disputed", "R": "received", "р": "received", "": "cleared", "2": null, "maybe": null };
  for (const [raw, status] of Object.entries(cases)) assert.equal(L.normalizeCellInput(raw), status, raw);
  assert.equal(L.normalizeCellInput(1), "correct");
  assert.equal(L.normalizeCellInput(null), "cleared");
});

test("roundLayout and roundRow", () => {
  const lay = L.roundLayout([12, 12, 15], 3);
  assert.deepEqual([lay.name, lay.first, lay.size, lay.firstCol, lay.sumCol], ["Тур 3", 25, 15, 3, 18]);
  assert.deepEqual(lay.header.slice(0, 3), ["ID", "Команда", 25]);
  assert.deepEqual(lay.header.slice(-2), [39, "Сумма"]);
  assert.equal(lay.header.length, lay.width);
  const row = L.roundRow(L.roundLayout([2, 3], 2), { team_id: "A01", name: "Синие зайцы" }, 4);
  assert.deepEqual(row, ["A01", "Синие зайцы", "", "", "", "=COUNTIF(C4:E4,1)"]);
});

test("questionCell and questionAt agree for every question", () => {
  const sizes = [12, 12, 15];
  for (let q = 1; q <= 39; q++) {
    const at = L.questionCell(sizes, q);
    assert.equal(L.questionAt(sizes, at.name, 7, at.col), q);
  }
  assert.deepEqual(L.questionCell(sizes, 13), { round: 2, name: "Тур 2", col: 3 });
  assert.equal(L.questionCell(sizes, 40), null);
  assert.equal(L.questionAt(sizes, "Тур 1", 1, 3), null); // header
  assert.equal(L.questionAt(sizes, "Тур 1", 2, 2), null); // name
  assert.equal(L.questionAt(sizes, "Тур 1", 2, 15), null); // Сумма
  assert.equal(L.questionAt(sizes, "Тур 4", 2, 3), null);
  assert.equal(L.questionAt(sizes, "Итоги", 2, 3), null);
});

test("summaryLayout and summaryRow", () => {
  const lay = L.summaryLayout([2, 3]);
  assert.deepEqual(lay.header, ["ID", "Команда", "Тур 1", "Тур 2", "Итого", "Место"]);
  assert.deepEqual(L.summaryRow([2, 3], { team_id: "A01", name: "X" }, 4), ["A01", "X",
    "=IFERROR(INDEX('Тур 1'!$E:$E,MATCH($A4,'Тур 1'!$A:$A,0)),0)",
    "=IFERROR(INDEX('Тур 2'!$F:$F,MATCH($A4,'Тур 2'!$A:$A,0)),0)", "=SUM(C4:D4)", "=RANK(E4,E$2:E)"]);
});

test("statsRows", () => {
  const rows = L.statsRows([2, 1]);
  assert.deepEqual(rows[0], ["Вопрос", "Тур", "Взяли", "Доля"]);
  assert.deepEqual(rows[1], [1, 1, "=COUNTIF('Тур 1'!C$2:C,1)", "=IFERROR(C2/COUNTA('Тур 1'!$A$2:$A),0)"]);
  assert.deepEqual(rows[3], [3, 2, "=COUNTIF('Тур 2'!C$2:C,1)", "=IFERROR(C4/COUNTA('Тур 2'!$A$2:$A),0)"]);
});

test("planTeamRows", () => {
  const plan = L.planTeamRows(
    [{ team_id: "A01", name: "Старое" }, { team_id: "A02", name: "Same" }],
    [{ team_id: "A01", name: "Новое" }, { team_id: "A02", name: "Same" }, { team_id: "A03", name: "New" }],
  );
  assert.deepEqual(plan.append.map((t) => t.team_id), ["A03"]);
  assert.deepEqual(plan.rename.map((t) => t.team_id), ["A01"]);
});
