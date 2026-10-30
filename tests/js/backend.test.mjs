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
  assert.deepEqual(ss.getSheets().map((s) => s.getName()), ["Results", "Stats", "Teams", "Log", "Settings", "Meta"]);
  assert.equal(tab("Meta").hidden, true);
  assert.deepEqual(tab("Results").row(1, 11), ["ID", "Команда", 1, 2, 3, 4, 5, 6, "Тур 1", "Тур 2", "Итого"]);
  assert.deepEqual(tab("Results").row(3, 12), ["A02", "Фиаско", "", "", "", "", "", "", "=COUNTIF(C3:E3,1)",
    "=COUNTIF(F3:H3,1)", "=SUM(I3:J3)", "=RANK(K3,K$2:K)"]);
  assert.deepEqual(tab("Teams").row(3, 4), ["A02", "Фиаско", "Бостон", ""]);
  assert.equal(tab("Stats").getLastRow(), 7);
  assert.deepEqual(b.$.triggers, ["onSheetEdit"]);
  assert.equal(b.$.root.children[0].name, "ЧГК");

  const again = b.post({ action: "create_tournament", token: admin, tid: TID, name: "Кубок", date: "2026-11-15",
    round_sizes: [3, 3], jury_token: JURY, teams: TEAMS });
  assert.equal(again.existed, true);
  const clash = b.post({ action: "create_tournament", token: admin, tid: TID, name: "Кубок", date: "2026-11-15",
    round_sizes: [3, 3], jury_token: "another-token-000000", teams: TEAMS });
  assert.match(clash.error, /already exists/);
});

test("a wide tournament (8 × 15 questions) fits: sheets grow past 26 columns", () => {
  const { tab } = world({ roundSizes: new Array(8).fill(15) });
  assert.equal(tab("Results").get(1, 2 + 120 + 8 + 2), "Место");
  assert.ok(tab("Meta").getMaxColumns() >= 120);
});

test("record_events writes marks, timestamps and the log; duplicates and bad events are reported", () => {
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
  assert.equal(tab("Results").get(2, 4), 0); // A01 q2
  assert.equal(tab("Results").get(3, 8), "?"); // A02 q6
  assert.equal(tab("Meta").get(1, 2), now - 2000);
  assert.equal(tab("Log").getLastRow(), 4); // header + 3 valid events
  assert.deepEqual(tab("Log").row(2, 12).slice(2, 12), ["r1", "app", "Анна", "iphone", "A01", 2, "", "received", "R", true]);

  // Retried request: everything is a duplicate, nothing is logged twice.
  const retry = b.post({ action: "record_events", tid: TID, token: JURY, events: [ev({ scan_id: "j1", status: "incorrect", question: 2 })] });
  assert.equal(retry.results[0].duplicate, true);
  assert.equal(tab("Log").getLastRow(), 4);

  // Re-scanning a judged card does not undo the judgement.
  b.post({ action: "record_events", tid: TID, token: JURY, events: [ev({ status: "received", question: 2, client_ts: now })] });
  assert.equal(tab("Results").get(2, 4), 0);
});

test("record_events needs the jury (or admin) token", () => {
  const { b, admin } = world();
  assert.match(b.post({ action: "record_events", tid: TID, token: "nope", events: [ev()] }).error, /forbidden/);
  assert.equal(b.post({ action: "record_events", tid: TID, token: admin, events: [ev()] }).ok, true);
});

test("get_state returns teams and marks for the scanner", () => {
  const { b } = world();
  b.post({ action: "record_events", tid: TID, token: JURY, events: [ev({ question: 3 })] });
  const state = b.post({ action: "get_state", tid: TID, token: JURY });
  assert.deepEqual(state.tournament.round_sizes, [3, 3]);
  assert.deepEqual(state.teams.map((t) => t.team_id), ["A01", "A02"]);
  assert.deepEqual(state.marks.A01, ["", "", 1, "", "", ""]);
});

test("set_teams appends Results rows for new teams and renames changed ones", () => {
  const { b, admin, tab } = world();
  const res = b.post({ action: "set_teams", tid: TID, token: admin, teams: [
    { team_id: "A01", name: "42 (новое имя)" }, { team_id: "A02", name: "Фиаско" }, { team_id: "A03", name: "Совхоз Победа" },
  ] });
  assert.deepEqual([res.appended, res.renamed], [1, 1]);
  assert.equal(tab("Results").get(2, 2), "42 (новое имя)");
  assert.deepEqual(tab("Results").row(4, 2), ["A03", "Совхоз Победа"]);
  assert.equal(tab("Results").get(4, 11), "=SUM(I4:J4)");
  assert.deepEqual(b.post({ action: "get_teams", tid: TID, token: admin }).teams.map((t) => t.team_id), ["A01", "A02", "A03"]);
});

test("onSheetEdit: jury edits are normalised, time-stamped and logged; nonsense gets a note", () => {
  const { b, tab } = world();
  const results = tab("Results");
  results.set(2, 3, "+");
  b.onSheetEdit({ range: results.getRange(2, 3), user: { getEmail: () => "judge@gmail.com" } });
  assert.equal(results.get(2, 3), 1);
  assert.ok(tab("Meta").get(1, 1) > 0);
  assert.deepEqual(tab("Log").row(2, 11).slice(3, 11), ["sheet", "judge@gmail.com", "", "A01", 1, "", "correct", 1]);

  results.set(2, 4, "maybe");
  b.onSheetEdit({ range: results.getRange(2, 4) });
  assert.match(results.notes.get("2,4"), /Непонятное/);
  assert.equal(tab("Log").getLastRow(), 2);

  // Edits outside the marks block (names, totals) are ignored.
  b.onSheetEdit({ range: results.getRange(2, 2) });
  assert.equal(tab("Log").getLastRow(), 2);

  // A later app event older than the jury's edit does not overwrite it.
  b.post({ action: "record_events", tid: TID, token: JURY, events: [ev({ status: "incorrect", question: 1, client_ts: Date.now() - 3600000 })] });
  assert.equal(results.get(2, 3), 1);
});
