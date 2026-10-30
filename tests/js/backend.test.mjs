import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackend } from "./fake_apps_script.mjs";

const TID = "K7M2Q";
const JURY = "jury-token-0123456789";
const TEAMS = [{ team_id: "A01", name: "42" }, { team_id: "A02", name: "Фиаско", city: "Бостон" }];

function world({ roundSizes = [3, 3], teams = TEAMS } = {}) {
  const b = loadBackend();
  b.setup();
  const admin = b.$.props.get("ADMIN_TOKEN");
  const created = b.post({
    action: "create_tournament", token: admin, tid: TID, name: "Кубок", date: "2026-11-15",
    round_sizes: roundSizes, jury_token: JURY, teams,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const ss = b.$.spreadsheets.get(created.spreadsheet_id);
  return { b, admin, ss, tab: (name) => ss.getSheetByName(name) };
}

let seq = 0;
const ev = (over = {}) => ({ scan_id: `s${++seq}`, status: "correct", team_id: "A01", question: 1, client_ts: Date.now() - 60000, ...over });

test("setup creates an admin token once and prints the CLI command", () => {
  const b = loadBackend();
  b.setup();
  const token = b.$.props.get("ADMIN_TOKEN");
  b.setup();
  assert.equal(b.$.props.get("ADMIN_TOKEN"), token);
  assert.ok(token.length >= 32);
  assert.match(b.logged[0].join(" "), /chgk backend add/);
});

test("setup asks for every permission; ping reports a missing one", () => {
  const b = loadBackend({ allScopes: false });
  b.setup();
  assert.deepEqual(b.$.scopeRequests, ["FULL"]);
  const admin = b.$.props.get("ADMIN_TOKEN");
  assert.equal(b.post({ action: "ping", token: admin }).authorized, false);
  const ok = loadBackend();
  ok.setup();
  assert.equal(ok.post({ action: "ping", token: ok.$.props.get("ADMIN_TOKEN") }).authorized, true);
});

test("setup never prints the owner-only /dev URL", () => {
  const b = loadBackend({ serviceUrl: "https://script.google.com/macros/s/AKfycbDEV/dev" });
  b.setup();
  const printed = b.logged[0].join(" ");
  assert.doesNotMatch(printed, /\/dev/);
  assert.match(printed, /<Web app URL ending in \/exec>/);
});

test("doGet is a health check; bad JSON and bad tokens are refused", () => {
  const b = loadBackend();
  b.setup();
  assert.equal(JSON.parse(b.doGet().text).service, "chgk");
  assert.match(b.doPost({ postData: { contents: "{oops" } }).json().error, /not JSON/);
  assert.match(b.post({ action: "ping", token: "wrong" }).error, /forbidden/);
  assert.equal(b.post({ action: "ping", token: b.$.props.get("ADMIN_TOKEN") }).account, "me@gmail.com");
  assert.match(b.post({ action: "get_state", tid: TID, token: JURY }).error, /unknown tournament/);
});

test("create_tournament builds every tab and is idempotent for the same jury token", () => {
  const { b, admin, ss, tab } = world();
  assert.deepEqual(ss.getSheets().map((s) => s.getName()),
    ["Итоги", "Тур 1", "Тур 2", "Stats", "Teams", "Log", "Settings", "Meta"]);
  assert.equal(tab("Meta").hidden, true);
  assert.deepEqual(tab("Итоги").row(1, 6), ["ID", "Команда", "Тур 1", "Тур 2", "Итого", "Место"]);
  assert.deepEqual(tab("Итоги").row(3, 6), ["A02", "Фиаско",
    "=IFERROR(INDEX('Тур 1'!$F:$F,MATCH($A3,'Тур 1'!$A:$A,0)),0)",
    "=IFERROR(INDEX('Тур 2'!$F:$F,MATCH($A3,'Тур 2'!$A:$A,0)),0)", "=SUM(C3:D3)", "=RANK(E3,E$2:E)"]);
  // Round tabs keep the continuous question numbers.
  assert.deepEqual(tab("Тур 1").row(1, 6), ["ID", "Команда", 1, 2, 3, "Сумма"]);
  assert.deepEqual(tab("Тур 2").row(1, 6), ["ID", "Команда", 4, 5, 6, "Сумма"]);
  assert.deepEqual(tab("Тур 2").row(3, 6), ["A02", "Фиаско", "", "", "", "=COUNTIF(C3:E3,1)"]);
  assert.deepEqual(tab("Meta").row(1, 7), ["team_id", 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(tab("Meta").row(3, 1), ["A02"]);
  assert.deepEqual(tab("Teams").row(3, 4), ["A02", "Фиаско", "Бостон", ""]);
  assert.equal(tab("Stats").getLastRow(), 7);
  assert.deepEqual(tab("Stats").row(5, 3), [4, 2, "=COUNTIF('Тур 2'!C$2:C,1)"]);
  assert.deepEqual(b.$.triggers, ["onSheetEdit"]);
  assert.equal(b.$.root.children[0].name, "ЧГК");

  const again = b.post({ action: "create_tournament", token: admin, tid: TID, name: "Кубок", date: "2026-11-15",
    round_sizes: [3, 3], jury_token: JURY, teams: TEAMS });
  assert.equal(again.existed, true);
  const clash = b.post({ action: "create_tournament", token: admin, tid: TID, name: "Кубок", date: "2026-11-15",
    round_sizes: [3, 3], jury_token: "another-token-000000", teams: TEAMS });
  assert.match(clash.error, /already exists/);
});

test("round tabs: narrow centred question columns, a tint per round, a thick line before the sum", () => {
  const { tab } = world({ roundSizes: [3, 3, 2] });
  const r1 = tab("Тур 1"); // C-E questions, F Сумма
  assert.deepEqual([3, 4, 5].map((c) => r1.widths.get(c)), [28, 28, 28]);
  assert.ok(r1.widths.get(2) > 100);
  assert.equal(r1.align.get("5,4"), "center");
  assert.equal(r1.leftBorders.get("500,6"), "SOLID_MEDIUM");
  assert.equal(r1.leftBorders.get("2,4"), undefined);
  const tints = ["Тур 1", "Тур 2", "Тур 3"].map((n) => tab(n).tabColor);
  assert.equal(tints[0], tints[2]);
  assert.notEqual(tints[0], tints[1]);
  assert.equal(r1.backgrounds.get("1,3"), tints[0]);
  // «Итоги»: each round's column has that round's colour; a line before Итого (F).
  const sum = tab("Итоги");
  assert.deepEqual([3, 4, 5].map((c) => sum.backgrounds.get(`1,${c}`)), tints);
  assert.equal(sum.leftBorders.get("10,6"), "SOLID_MEDIUM");
});

test("set_teams re-applies the formatting", () => {
  const { b, admin, tab } = world();
  tab("Тур 1").widths.clear();
  b.post({ action: "set_teams", tid: TID, token: admin, teams: TEAMS });
  assert.equal(tab("Тур 1").widths.get(3), 28);
});

test("a wide tournament (8 × 15 questions) fits: Meta grows past 26 columns", () => {
  const { tab } = world({ roundSizes: new Array(8).fill(15) });
  assert.equal(tab("Итоги").get(1, 2 + 8 + 2), "Место");
  assert.equal(tab("Тур 8").get(1, 3), 106);
  assert.ok(tab("Meta").getMaxColumns() >= 121);
});

test("record_events writes marks to the round tabs, timestamps and the log; duplicates and bad events are reported", () => {
  const { b, tab } = world();
  const now = Date.now();
  const res = b.post({ action: "record_events", tid: TID, token: JURY, events: [
    ev({ scan_id: "r1", status: "received", question: 2, client_ts: now - 3000, juror: "Анна", device: "iphone" }),
    ev({ scan_id: "j1", status: "incorrect", question: 2, client_ts: now - 2000 }),
    ev({ scan_id: "j2", status: "disputed", team_id: "A02", question: 6, client_ts: now - 2000, spare: 1 }),
    ev({ scan_id: "bad", team_id: "Z99" }),
  ] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results.map((r) => [r.scan_id, r.applied, Boolean(r.error)]),
    [["r1", true, false], ["j1", true, false], ["j2", true, false], ["bad", false, true]]);
  assert.equal(tab("Тур 1").get(2, 4), 0); // A01 q2
  assert.equal(tab("Тур 2").get(3, 5), "?"); // A02 q6
  assert.equal(tab("Meta").get(2, 1 + 2), now - 2000); // A01 q2
  assert.equal(tab("Meta").get(3, 1 + 6), now - 2000); // A02 q6
  assert.equal(tab("Log").getLastRow(), 4); // header + 3 valid events
  assert.deepEqual(tab("Log").row(2, 12).slice(2, 12), ["r1", "app", "Анна", "iphone", "A01", 2, "", "received", "R", true]);

  // Retried request: everything is a duplicate, nothing is logged twice.
  const retry = b.post({ action: "record_events", tid: TID, token: JURY, events: [ev({ scan_id: "j1", status: "incorrect", question: 2 })] });
  assert.equal(retry.results[0].duplicate, true);
  assert.equal(tab("Log").getLastRow(), 4);

  // Re-scanning a judged card does not undo the judgement.
  b.post({ action: "record_events", tid: TID, token: JURY, events: [ev({ status: "received", question: 2, client_ts: now })] });
  assert.equal(tab("Тур 1").get(2, 4), 0);
});

test("rows are found by team ID: sorting a round tab doesn't misplace marks", () => {
  const { b, tab } = world();
  const r2 = tab("Тур 2");
  // The jury sorts «Тур 2» so that A02 comes first.
  const [row2, row3] = [r2.row(2, 6), r2.row(3, 6)];
  row3.forEach((v, c) => r2.set(2, c + 1, v));
  row2.forEach((v, c) => r2.set(3, c + 1, v));
  b.post({ action: "record_events", tid: TID, token: JURY, events: [ev({ team_id: "A02", question: 4 })] });
  assert.deepEqual(r2.row(2, 3), ["A02", "Фиаско", 1]);
  assert.equal(r2.get(3, 3), "");
  assert.deepEqual(b.post({ action: "get_state", tid: TID, token: JURY }).marks.A02, ["", "", "", 1, "", ""]);
});

test("a Sheet with the old single Results tab gets a clear error", () => {
  const { b, ss } = world();
  ss.getSheetByName("Итоги").setName("Results");
  assert.match(b.post({ action: "get_state", tid: TID, token: JURY }).error, /older layout/);
});

test("record_events needs the jury (or admin) token", () => {
  const { b, admin } = world();
  assert.match(b.post({ action: "record_events", tid: TID, token: "nope", events: [ev()] }).error, /forbidden/);
  assert.equal(b.post({ action: "record_events", tid: TID, token: admin, events: [ev()] }).ok, true);
});

test("get_state returns teams and marks for the scanner", () => {
  const { b } = world();
  b.post({ action: "record_events", tid: TID, token: JURY, events: [ev({ question: 3 }), ev({ team_id: "A02", question: 5 })] });
  const state = b.post({ action: "get_state", tid: TID, token: JURY });
  assert.deepEqual(state.tournament.round_sizes, [3, 3]);
  assert.deepEqual(state.teams.map((t) => t.team_id), ["A01", "A02"]);
  assert.deepEqual(state.marks.A01, ["", "", 1, "", "", ""]);
  assert.deepEqual(state.marks.A02, ["", "", "", "", 1, ""]);
});

test("set_teams adds rows on every tab for new teams and renames changed ones", () => {
  const { b, admin, tab } = world();
  const res = b.post({ action: "set_teams", tid: TID, token: admin, teams: [
    { team_id: "A01", name: "42 (новое имя)" }, { team_id: "A02", name: "Фиаско" }, { team_id: "A03", name: "Совхоз Победа" },
  ] });
  assert.deepEqual([res.appended, res.renamed], [1, 1]);
  for (const name of ["Итоги", "Тур 1", "Тур 2"]) {
    assert.equal(tab(name).get(2, 2), "42 (новое имя)", name);
    assert.deepEqual(tab(name).row(4, 2), ["A03", "Совхоз Победа"], name);
  }
  assert.equal(tab("Итоги").get(4, 5), "=SUM(C4:D4)");
  assert.equal(tab("Тур 2").get(4, 6), "=COUNTIF(C4:E4,1)");
  assert.equal(tab("Meta").get(4, 1), "A03");
  assert.deepEqual(b.post({ action: "get_teams", tid: TID, token: admin }).teams.map((t) => t.team_id), ["A01", "A02", "A03"]);
  // Marks for the new team work straight away.
  assert.equal(b.post({ action: "record_events", tid: TID, token: JURY, events: [ev({ team_id: "A03", question: 6 })] })
    .results[0].applied, true);
  assert.equal(tab("Тур 2").get(4, 5), 1);
});

test("onSheetEdit: jury edits on a round tab are normalised, time-stamped and logged; nonsense gets a note", () => {
  const { b, tab } = world();
  const r2 = tab("Тур 2");
  r2.set(3, 4, "+"); // A02, question 5
  b.onSheetEdit({ range: r2.getRange(3, 4), user: { getEmail: () => "judge@gmail.com" } });
  assert.equal(r2.get(3, 4), 1);
  assert.ok(tab("Meta").get(3, 1 + 5) > 0);
  assert.deepEqual(tab("Log").row(2, 11).slice(3, 11), ["sheet", "judge@gmail.com", "", "A02", 5, "", "correct", 1]);

  r2.set(2, 3, "maybe");
  b.onSheetEdit({ range: r2.getRange(2, 3) });
  assert.match(r2.notes.get("2,3"), /Непонятное/);
  assert.equal(tab("Log").getLastRow(), 2);

  // Names, sums, headers and other tabs are ignored.
  b.onSheetEdit({ range: r2.getRange(2, 2) });
  b.onSheetEdit({ range: r2.getRange(2, 6) });
  b.onSheetEdit({ range: r2.getRange(1, 3) });
  b.onSheetEdit({ range: tab("Итоги").getRange(2, 3) });
  assert.equal(tab("Log").getLastRow(), 2);

  // A later app event older than the jury's edit does not overwrite it.
  b.post({ action: "record_events", tid: TID, token: JURY, events: [ev({ team_id: "A02", status: "incorrect", question: 5, client_ts: Date.now() - 3600000 })] });
  assert.equal(r2.get(3, 4), 1);
});
