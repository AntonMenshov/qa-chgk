// Scanner web app (web/s/lib): QR decoding, marks, the scanning session and the queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeCard, decodeSetup } from "../../web/s/lib/payload.js";
import { mergeCell, overlay, statusOf } from "../../web/s/lib/marks.js";
import { Session, WARN } from "../../web/s/lib/session.js";
import { Queue } from "../../web/s/lib/queue.js";
import { backend, BackendError } from "../../web/s/lib/api.js";

const vectors = (name) => JSON.parse(readFileSync(new URL(`../vectors/${name}`, import.meta.url), "utf8"));

// ---------- payload: shared vectors with chgk/ids.py ----------

for (const c of vectors("qr_payloads.json").cases) {
  test(`card payload ${c.valid ? "decodes" : "is refused"}: ${c.note || c.payload}`, () => {
    const card = decodeCard(c.payload);
    if (!c.valid) return assert.equal(card, null);
    assert.deepEqual(card, { tid: c.tid, teamId: c.team_id, question: c.question, spare: c.spare });
  });
}

for (const c of vectors("jury_links.json").cases) {
  test(`jury link ${c.valid ? "decodes" : "is refused"}: ${c.note || c.link}`, () => {
    const setup = decodeSetup(c.link);
    if (!c.valid) return assert.equal(setup, null);
    assert.deepEqual(setup, { tid: c.tid, juryToken: c.jury_token, backendUrl: c.backend_url });
  });
}

test("a card is not a jury link and a jury link is not a card", () => {
  assert.equal(decodeSetup("https://e.github.io/qa-chgk/s/#K7M2Q.A07.27"), null);
  assert.equal(decodeCard("https://e.github.io/qa-chgk/s/#setup=K7M2Q.abcDEF123_-ghiJKL456mno.AKfycbx_Example"), null);
});

// ---------- marks: the same merge rule as the backend ----------

for (const c of vectors("merge_cases.json").cases) {
  test(`merge (phone): ${c.note}`, () => assert.deepEqual(mergeCell(c.before, c.status, c.ts), c.after));
}

test("overlay: local events over the snapshot, in time order", () => {
  const marks = overlay({ A01: ["", 1, "?"], A02: ["", "", ""] }, [
    { team_id: "A01", question: 3, status: "correct", client_ts: 20 },
    { team_id: "A01", question: 3, status: "incorrect", client_ts: 10 }, // older: loses
    { team_id: "A02", question: 1, status: "received", client_ts: 5 },
    { team_id: "A01", question: 2, status: "received", client_ts: 30 }, // never undoes a judgement
    { team_id: "R1", question: 1, status: "correct", client_ts: 1 }, // a team not in the snapshot yet
    { team_id: "A02", question: 9, status: "correct", client_ts: 1 }, // out of range: ignored
  ], 3);
  assert.deepEqual(marks, { A01: ["", 1, 1], A02: ["R", "", ""], R1: [1, "", ""] });
  assert.deepEqual([statusOf(1), statusOf(0), statusOf("?"), statusOf("R"), statusOf("")], ["correct", "incorrect", "disputed", "received", null]);
});

// ---------- the scanning session ----------

const TID = "K7M2Q";
const URL_BASE = "https://e.github.io/qa-chgk/s/#";
const STATE = {
  tournament: { name: "Кубок", round_sizes: [3, 3] },
  teams: [
    { team_id: "645", name: "42", reserve: false },
    { team_id: "58746", name: "Фиаско", reserve: false },
    { team_id: "R1", name: "R1 · впишите название", reserve: true },
  ],
  marks: { 645: ["", "", "", "", "", ""], 58746: ["", "", "", "", "", ""], R1: ["", "", "", "", "", ""] },
};

function session(over = {}) {
  let t = 1000;
  let n = 0;
  return new Session({ tid: TID, state: structuredClone(STATE), juror: "Анна", device: "dev1",
    now: () => (t += 10), uuid: () => `id${++n}`, ...over });
}

test("scan: a numbered card is marked for the question in its QR code", () => {
  const s = session();
  const r = s.scan(`${URL_BASE}${TID}.645.2`);
  assert.equal(r.kind, "card");
  assert.deepEqual([r.team.name, r.question, r.spare, r.previous, r.warnings], ["42", 2, null, null, []]);
});

test("the current question follows the scans: a later card makes it current, an earlier one only warns", () => {
  const s = session();
  assert.equal(s.current, 1);
  s.scan(`${TID}.645.1`);
  assert.equal(s.current, 1);
  s.scan(`${TID}.645.4`);
  assert.equal(s.current, 4);
  const late = s.scan(`${TID}.58746.2`);
  assert.equal(s.current, 4); // an old card doesn't move it back
  assert.equal(late.question, 2); // and is still for question 2
  assert.deepEqual(late.warnings.map((w) => w.code), [WARN.EARLIER]);
  assert.match(late.warnings[0].text, /Карточка вопроса 2 \(идёт 4\) — отмечается для 2/);
});

test("◀ ▶ can still set the question by hand, within the tournament", () => {
  const s = session();
  assert.equal(s.setQuestion(5), 5);
  assert.equal(s.setQuestion(0), 1);
  assert.equal(s.setQuestion(99), 6);
});

test("a spare card asks for the question; the answer is then treated like a numbered card", () => {
  const s = session();
  s.scan(`${TID}.645.3`);
  const r = s.scan(`${TID}.58746.S2`);
  assert.deepEqual([r.kind, r.team.team_id, r.spare], ["spare", "58746", 2]);
  assert.equal(s.current, 3); // nothing recorded or moved before the juror answers
  const card = s.card("58746", 3, 2);
  assert.deepEqual([card.kind, card.question, card.spare, card.warnings], ["card", 3, 2, []]);
  const ev = s.record("58746", 3, 2, "received");
  assert.equal(ev.spare, 2);
  assert.equal(s.valueOf("58746", 3), "R");
});

test("cards of another tournament, unknown teams and other QR codes are refused", () => {
  const s = session();
  assert.deepEqual(s.scan(`${URL_BASE}PU4WR.645.2`), { kind: "foreign", tid: "PU4WR" }); // same team and question, old tournament
  assert.deepEqual(s.scan(`${TID}.Z99.2`), { kind: "unknown_team", teamId: "Z99" });
  assert.deepEqual(s.scan("https://example.com/menu"), { kind: "other" });
  const setup = s.scan(`${URL_BASE}setup=QHZJ8.abcDEF123_-ghiJKL456mno.AKfycbx_Example-Deployment_ID123`);
  assert.equal(setup.kind, "setup");
  assert.equal(setup.setup.tid, "QHZJ8");
  assert.equal(s.current, 1);
});

test("a card already judged warns; one only received does not", () => {
  const s = session();
  s.record("645", 1, null, "received");
  assert.deepEqual(s.scan(`${TID}.645.1`).warnings, []);
  s.record("645", 1, null, "correct");
  const again = s.scan(`${TID}.645.1`);
  assert.equal(again.previous, "correct");
  assert.deepEqual(again.warnings.map((w) => [w.code, w.text]), [[WARN.ALREADY, "Уже отмечено: верно"]]);
});

test("events carry everything the backend needs", () => {
  const s = session();
  const ev = s.record("645", 2, null, "correct");
  assert.deepEqual(Object.keys(ev).sort(), ["client_ts", "device", "juror", "question", "scan_id", "status", "team_id"]);
  assert.deepEqual([ev.juror, ev.device, ev.status, ev.question], ["Анна", "dev1", "correct", 2]);
});

test("missing: teams without a card for the current question; an unused reserve team isn't counted", () => {
  const s = session();
  s.scan(`${TID}.645.1`);
  s.record("645", 1, null, "received");
  assert.deepEqual(s.missing().map((t) => t.team_id), ["58746"]);
  // R1 turns up and hands in a card: from now on it is counted.
  const r = s.scan(`${TID}.R1.2`);
  assert.deepEqual(r.warnings.map((w) => w.code), [WARN.RESERVE]);
  s.record("R1", 2, null, "received");
  assert.deepEqual(s.missing().map((t) => t.team_id), ["645", "58746"]);
  assert.deepEqual(s.missing(1).map((t) => t.team_id), ["58746", "R1"]);
});

test("pending and recently sent events stay on screen until a newer snapshot has them", () => {
  const s = session();
  const a = s.record("645", 1, null, "correct");
  const b = s.record("645", 2, null, "incorrect");
  s.acked([a.scan_id], 5000);
  // A snapshot fetched before the ack doesn't include `a` yet: keep showing it.
  s.setSnapshot(structuredClone(STATE), 4000);
  assert.deepEqual(s.marks["645"].slice(0, 2), [1, 0]);
  // A snapshot fetched after the ack includes it (here: the jury changed it to «?» in the Sheet since).
  const later = structuredClone(STATE);
  later.marks["645"][0] = "?";
  s.setSnapshot(later, 6000);
  assert.deepEqual(s.marks["645"].slice(0, 2), ["?", 0]); // b is still pending, so still shown
  s.rejected([b.scan_id]);
  assert.deepEqual(s.marks["645"].slice(0, 2), ["?", ""]);
});

test("resuming: the current question comes back, else the last question with any mark", () => {
  const state = structuredClone(STATE);
  state.marks["645"][4] = 1;
  assert.equal(session({ state }).current, 5);
  assert.equal(session({ state, current: 2 }).current, 2);
  assert.equal(session({ state, current: 99 }).current, 5);
});

// ---------- the queue ----------

function memoryStorage() {
  const data = new Map();
  return { get: (k) => (data.has(k) ? JSON.parse(data.get(k)) : null), set: (k, v) => data.set(k, JSON.stringify(v)), data };
}

const ev = (id) => ({ scan_id: id, team_id: "645", question: 1, status: "correct", client_ts: 1 });

test("queue: everything pending goes in one request; acked and refused events leave the queue", async () => {
  const storage = memoryStorage();
  const sent = [];
  const q = new Queue({ storage, key: "q", send: async (events) => {
    sent.push(events.map((e) => e.scan_id));
    return { results: events.map((e) => (e.scan_id === "b" ? { scan_id: "b", applied: false, error: "invalid question" }
      : { scan_id: e.scan_id, applied: true, duplicate: false })) };
  } });
  ["a", "b", "c"].forEach((id) => q.add(ev(id)));
  const res = await q.flush();
  assert.deepEqual(sent, [["a", "b", "c"]]);
  assert.deepEqual(res, { acked: ["a", "c"], rejected: ["b"] });
  assert.deepEqual(q.status, { pending: 0, rejected: 1, failing: false, lastError: null });
  assert.equal(q.rejected[0].error, "invalid question");
  assert.equal(await q.flush(), null); // nothing left to send
});

test("queue: survives a reload (saved after every change)", async () => {
  const storage = memoryStorage();
  const q = new Queue({ storage, key: "q", send: async () => { throw new Error("offline"); } });
  q.add(ev("a"));
  q.add(ev("b"));
  const again = new Queue({ storage, key: "q", send: async () => ({ results: [] }) });
  assert.deepEqual(again.pending.map((e) => e.scan_id), ["a", "b"]);
});

test("queue: failures retry with growing pauses; success resets them", async () => {
  let t = 0;
  let online = false;
  const q = new Queue({ storage: memoryStorage(), key: "q", now: () => t,
    send: async (events) => {
      if (!online) throw new Error("нет связи");
      return { results: events.map((e) => ({ scan_id: e.scan_id, applied: true })) };
    } });
  q.add(ev("a"));
  assert.equal(await q.flush(), null);
  assert.deepEqual([q.status.failing, q.status.lastError, q.nextAttemptAt], [true, "нет связи", 2000]);
  t = 1000;
  assert.equal(q.due(), false); // waiting
  t = 2000;
  await q.flush();
  assert.equal(q.nextAttemptAt, 2000 + 4000);
  t = 6000;
  await q.flush();
  assert.equal(q.nextAttemptAt, 6000 + 8000);
  for (let i = 0; i < 5; i++) { t = q.nextAttemptAt; await q.flush(); }
  assert.equal(q.nextAttemptAt - t, 30000); // capped
  online = true;
  t = q.nextAttemptAt;
  assert.deepEqual(await q.flush(), { acked: ["a"], rejected: [] });
  assert.deepEqual(q.status, { pending: 0, rejected: 0, failing: false, lastError: null });
});

test("queue: events added while a request is in flight wait for the next one", async () => {
  let release;
  const q = new Queue({ storage: memoryStorage(), key: "q",
    send: (events) => new Promise((resolve) => { release = () => resolve({ results: events.map((e) => ({ scan_id: e.scan_id, applied: true })) }); }) });
  q.add(ev("a"));
  const flushing = q.flush();
  assert.equal(q.due(), false); // one request at a time
  q.add(ev("b"));
  release();
  assert.deepEqual(await flushing, { acked: ["a"], rejected: [] });
  assert.deepEqual(q.pending.map((e) => e.scan_id), ["b"]);
});

test("queue: an event without an answer stays pending; batches are capped", async () => {
  const sizes = [];
  const q = new Queue({ storage: memoryStorage(), key: "q", batchSize: 2,
    send: async (events) => { sizes.push(events.length); return { results: [{ scan_id: events[0].scan_id, applied: true }] }; } });
  ["a", "b", "c"].forEach((id) => q.add(ev(id)));
  await q.flush();
  assert.deepEqual(sizes, [2]);
  assert.deepEqual(q.pending.map((e) => e.scan_id), ["b", "c"]);
});

// ---------- api ----------

test("api: text/plain POST with the token; backend errors and network errors become BackendError", async () => {
  const calls = [];
  const ok = backend("https://script.google.com/macros/s/X/exec", "tok", async (url, init) => {
    calls.push({ url, init });
    return { status: 200, json: async () => ({ ok: true, teams: [] }) };
  });
  assert.deepEqual(await ok("get_state", { tid: TID }), { ok: true, teams: [] });
  assert.equal(calls[0].init.headers["Content-Type"], "text/plain;charset=utf-8");
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: "get_state", token: "tok", tid: TID });

  const refused = backend("u", "t", async () => ({ status: 200, json: async () => ({ ok: false, error: "forbidden: jury token required" }) }));
  await assert.rejects(refused("get_state"), (err) => err instanceof BackendError && /forbidden/.test(err.message));
  const html = backend("u", "t", async () => ({ status: 200, json: async () => { throw new SyntaxError("<html>"); } }));
  await assert.rejects(html("get_state"), /не JSON/);
  const offline = backend("u", "t", async () => { throw new TypeError("Load failed"); });
  await assert.rejects(offline("get_state"), /нет связи/);
});

// ---------- the phone's modules end to end against the fake Apps Script backend ----------

import { loadBackend } from "./fake_apps_script.mjs";

test("phone flow against the backend: scan, judge, send, refresh; reserve team; old card; foreign card", async () => {
  const b = loadBackend();
  b.setup();
  const admin = b.$.props.get("ADMIN_TOKEN");
  const JURY = "jury-token-0123456789";
  const created = b.post({ action: "create_tournament", token: admin, tid: TID, name: "Кубок", date: "2026-11-15",
    round_sizes: [3, 3], jury_token: JURY, teams: [{ team_id: "645", name: "42" }, { team_id: "58746", name: "Фиаско" }],
    reserve: ["R1"] });
  assert.equal(created.ok, true);
  // fetch → doPost, as Google would.
  const fakeFetch = async (url, init) => {
    const out = b.doPost({ postData: { contents: init.body } });
    return { status: 200, json: async () => JSON.parse(out.text) };
  };
  const call = backend("https://script.google.com/macros/s/X/exec", JURY, fakeFetch);
  const storage = memoryStorage();
  const s = new Session({ tid: TID, state: await call("get_state", { tid: TID }), device: "dev1" });
  const q = new Queue({ storage, key: `queue.${TID}`, send: (events) => call("record_events", { tid: TID, events }) });
  const judge = (text, verdict, answer) => {
    let r = s.scan(text);
    if (r.kind === "spare") r = s.card(r.team.team_id, answer, r.spare);
    assert.equal(r.kind, "card");
    q.add(s.record(r.team.team_id, r.question, r.spare, "received"));
    q.add(s.record(r.team.team_id, r.question, r.spare, verdict));
    return r;
  };
  const sync = async () => {
    const res = await q.flush();
    if (res) { s.acked(res.acked); s.rejected(res.rejected); }
    const started = Date.now();
    s.setSnapshot(await call("get_state", { tid: TID }), started);
  };

  judge(`${URL_BASE}${TID}.645.1`, "correct");
  judge(`${URL_BASE}${TID}.58746.1`, "incorrect");
  judge(`${URL_BASE}${TID}.R1.1`, "correct"); // reserve deck R1 turns up
  judge(`${URL_BASE}${TID}.645.S1`, "disputed", 2); // a spare card for question 2
  const late = judge(`${URL_BASE}${TID}.58746.1`, "correct"); // the jury changes its mind
  assert.deepEqual(late.warnings.map((w) => w.code), [WARN.EARLIER, WARN.ALREADY]); // question 2 is current by now
  assert.equal(s.scan(`${URL_BASE}PU4WR.645.1`).kind, "foreign");
  assert.equal(q.status.pending, 10);

  await sync();
  assert.deepEqual(q.status, { pending: 0, rejected: 0, failing: false, lastError: null });
  assert.deepEqual(s.marks["645"].slice(0, 2), [1, "?"]);
  assert.deepEqual(s.marks["58746"][0], 1);
  assert.deepEqual(s.marks.R1[0], 1);
  assert.deepEqual(s.teams.map((t) => t.team_id), ["58746", "645", "R1"]);
  assert.deepEqual(s.missing(2).map((t) => t.team_id), ["58746", "R1"]);

  // The Sheet agrees.
  const results = await call("get_results", { tid: TID });
  assert.deepEqual(results.standings.map((r) => [r.team_id, r.total, r.place]), [["58746", 1, "1-3"], ["645", 1, "1-3"], ["R1", 1, "1-3"]]);
  // Nothing was sent twice: a retry of the same events is all duplicates.
  const log = b.$.spreadsheets.get(created.spreadsheet_id).getSheetByName("Log");
  assert.equal(log.getLastRow() - 1, 10);
});

// ---------- camera: when a code in view is reported ----------

import { Camera } from "../../web/s/lib/camera.js";

test("camera: a card is reported once while in view; again after it was away; the next card at once", () => {
  globalThis.document ??= { createElement: () => ({ getContext: () => ({}) }) };
  const reported = [];
  const cam = new Camera({}, (text) => reported.push(text));
  cam.seen("A", 0);
  cam.seen("A", 100);
  cam.seen("A", 200); // still lying there
  assert.deepEqual(reported, ["A"]);
  cam.pause(); // the juror is judging A, A stays in view
  cam.seen("A", 1000);
  cam.seen("B", 1100); // the next card is already held up: not while paused
  cam.seen("A", 2500);
  cam.resume();
  cam.seen("A", 2600); // A never left: not again
  assert.deepEqual(reported, ["A"]);
  cam.seen("B", 2700); // B at once
  assert.deepEqual(reported, ["A", "B"]);
  cam.seen("A", 2800); // back to A: a different card than the last one, so reported
  cam.seen("A", 5000); // gone from 2800 to 5000 (no frames): reported again
  assert.deepEqual(reported, ["A", "B", "A", "A"]);
});
