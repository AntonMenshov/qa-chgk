// Scanner web app: screens, camera, setup from the jury link, background sending.
// The logic lives in lib/ (tested in Node); this file only wires it to the page.

import { decodeCard, decodeSetup } from "./lib/payload.js";
import { STATUS_LABEL } from "./lib/marks.js";
import { Session } from "./lib/session.js";
import { Queue } from "./lib/queue.js";
import { backend } from "./lib/api.js";
import { storage } from "./lib/storage.js";
import { Camera } from "./lib/camera.js";

const FLUSH_EVERY_MS = 1000;
const REFRESH_EVERY_MS = 20000;
const REFRESH_AFTER_SEND_MS = 1500;

const $ = (id) => document.getElementById(id);
const store = storage();
const K = {
  setup: "chgk.setup",
  device: "chgk.device",
  juror: "chgk.juror",
  state: (tid) => `chgk.state.${tid}`,
  current: (tid) => `chgk.current.${tid}`,
  queue: (tid) => `chgk.queue.${tid}`,
};

let setup = store.get(K.setup); // {tid, juryToken, backendUrl}
let call = null; // backend(...) for the current tournament
let session = null;
let queue = null;
let camera = null;
let openCardResult = null; // the card on screen, waiting for a verdict
let spareResult = null; // the spare card on screen, waiting for its question
let spareDigits = "";
let refreshTimer = null;
let setupCamera = null;

function deviceId() {
  let id = store.get(K.device);
  if (!id) {
    id = crypto.randomUUID();
    store.set(K.device, id);
  }
  return id;
}

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
}

function sheet(id) {
  for (const s of document.querySelectorAll(".sheet")) s.hidden = s.id !== id;
  if (camera) id ? camera.pause() : camera.resume();
}

// ---------- sound (iOS has no vibration for web pages) ----------

let audio = null;
function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch {
    audio = null;
  }
}
function beep(kind) {
  if (!audio) return;
  const tones = kind === "warn" ? [[440, 0], [440, 0.18]] : kind === "bad" ? [[220, 0], [220, 0.2], [220, 0.4]] : [[1046, 0]];
  for (const [freq, at] of tones) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(audio.destination);
    osc.start(audio.currentTime + at);
    osc.stop(audio.currentTime + at + 0.12);
  }
}

let toastTimer = null;
function toast(text, bad = false) {
  const el = $("toast");
  el.textContent = text;
  el.classList.toggle("bad", bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---------- setup: from the jury link (#setup=…) or by scanning its QR here ----------

function adoptSetup(s) {
  const changing = setup && setup.tid !== s.tid;
  if (changing && queue && queue.status.pending > 0) {
    if (!confirm(`На телефоне есть неотправленные отметки турнира ${setup.tid} (${queue.status.pending}). ` +
      `Они сохранятся и отправятся, когда вы вернётесь к нему. Переключиться на турнир ${s.tid}?`)) return false;
  }
  setup = s;
  store.set(K.setup, s);
  return true;
}

function startSetupScreen(message = "") {
  show("setup");
  $("setup-msg").textContent = message;
  const video = $("setup-video");
  const cam = setupCamera = new Camera(video, (text) => {
    const s = decodeSetup(text);
    if (!s) {
      $("setup-msg").textContent = decodeCard(text)
        ? "Это карточка команды. Нужен QR «Доступ жюри» с листа жюри."
        : "Это не QR-код доступа жюри.";
      return;
    }
    cam.stop();
    adoptSetup(s);
    startTournament();
  });
  $("setup-start").onclick = async () => {
    unlockAudio();
    try {
      await cam.start();
      $("setup-start").hidden = true;
    } catch (err) {
      $("setup-msg").textContent = `Камера недоступна: ${err.message}. Разрешите доступ к камере в настройках Safari.`;
    }
  };
}

// ---------- loading the tournament ----------

async function startTournament(cardText = null) {
  show("loading");
  $("loading-title").textContent = "Загрузка турнира…";
  $("loading-msg").textContent = "";
  $("loading-retry").hidden = true;
  $("loading-reset").hidden = true;
  call = backend(setup.backendUrl, setup.juryToken);
  const tid = setup.tid;
  let state = null;
  const started = Date.now();
  try {
    state = await call("get_state", { tid });
    store.set(K.state(tid), state);
  } catch (err) {
    state = store.get(K.state(tid)); // offline: last known data
    if (!state) {
      $("loading-title").textContent = "Не удалось загрузить турнир";
      $("loading-msg").textContent = err.message;
      $("loading-retry").hidden = false;
      $("loading-reset").hidden = false;
      $("loading-retry").onclick = () => startTournament(cardText);
      return;
    }
    toast("Нет связи: показаны последние сохранённые данные", true);
  }
  queue = new Queue({ storage: store, key: K.queue(tid), send: (events) => call("record_events", { tid, events }) });
  session = new Session({ tid, state, current: store.get(K.current(tid)), juror: store.get(K.juror) || "", device: deviceId() });
  session.restorePending(queue.pending);
  session.snapshotAt = started;
  show("main");
  render();
  camera ??= new Camera($("video"), handleCode);
  $("start").hidden = false;
  if (cardText) handleCode(cardText); // opened from the iPhone Camera with a card URL
}

// ---------- scanning ----------

function handleCode(text) {
  if (!session || openCardResult || spareResult) return;
  const r = session.scan(text);
  switch (r.kind) {
    case "setup":
      if (r.setup.tid === setup.tid) return toast("Это QR доступа жюри: телефон уже настроен на этот турнир");
      if (adoptSetup(r.setup)) startTournament();
      return;
    case "other":
      beep("bad");
      return toast("Это не карточка ЧГК", true);
    case "foreign":
      beep("bad");
      return toast(`Карточка другого турнира (${r.tid}) — не засчитана`, true);
    case "unknown_team":
      beep("bad");
      toast(`Команда ${r.teamId} не найдена — обновляю список команд…`, true);
      refresh();
      return;
    case "spare":
      return openSpare(r);
    case "card":
      return openCard(r);
  }
}

function openCard(r) {
  openCardResult = r;
  queue.add(session.record(r.team.team_id, r.question, r.spare, "received"));
  store.set(K.current(setup.tid), session.current);
  const round = session.roundOf(r.question);
  $("c-team").textContent = r.team.name;
  $("c-meta").textContent = `Вопрос ${r.question} · тур ${round}` + (r.spare ? ` · запасная карточка` : "") +
    ` · ID ${r.team.team_id}`;
  const warn = $("c-warn");
  warn.replaceChildren(...r.warnings.map((w) => Object.assign(document.createElement("li"), { textContent: w.text })));
  $("card").classList.toggle("warn", r.warnings.length > 0);
  beep(r.warnings.length ? "warn" : "ok");
  sheet("card");
  render();
}

function verdict(status) {
  const r = openCardResult;
  if (!r) return;
  if (status) queue.add(session.record(r.team.team_id, r.question, r.spare, status));
  openCardResult = null;
  sheet(null);
  render();
  flushSoon();
}

function openSpare(r) {
  spareResult = r;
  spareDigits = "";
  $("sp-team").textContent = r.team.name;
  $("sp-current").textContent = `Вопрос ${session.current} — текущий`;
  $("sp-display").textContent = "";
  beep("warn");
  sheet("spare");
}

function answerSpare(question) {
  const r = spareResult;
  if (!(question >= 1 && question <= session.total)) {
    $("sp-display").textContent = `1–${session.total}?`;
    spareDigits = "";
    return;
  }
  spareResult = null;
  openCard(session.card(r.team.team_id, question, r.spare));
}

// ---------- sending and refreshing ----------

async function flush() {
  if (!queue || !queue.due()) return;
  const res = await queue.flush();
  if (res) {
    session.acked(res.acked);
    session.rejected(res.rejected);
    if (res.rejected.length) toast(`Отклонено сервером: ${res.rejected.length}. Нажмите на статус отправки.`, true);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, REFRESH_AFTER_SEND_MS);
  }
  render();
}

function flushSoon() {
  setTimeout(flush, 50);
}

async function refresh() {
  if (!call || !session) return;
  const started = Date.now();
  try {
    const state = await call("get_state", { tid: setup.tid });
    store.set(K.state(setup.tid), state);
    session.setSnapshot(state, started);
    render();
  } catch {
    // offline: keep showing what we have; the sync pill says so
  }
}

// ---------- rendering ----------

function render() {
  if (!session) return;
  $("t-name").textContent = session.name;
  $("q-num").textContent = session.current;
  $("q-round").textContent = `тур ${session.roundOf(session.current)}`;
  const missing = session.missing();
  const m = $("missing-open");
  m.textContent = missing.length ? `Нет карточек: ${missing.length} ›` : "Все карточки этого вопроса получены";
  m.classList.toggle("none", missing.length === 0);
  const st = queue.status;
  const pill = $("sync");
  pill.className = "pill " + (st.failing || st.rejected ? "error" : st.pending ? "pending" : "ok");
  pill.textContent = st.rejected ? `⚠ отклонено: ${st.rejected}`
    : st.failing ? `⚠ нет связи · ${st.pending}`
      : st.pending ? `⏳ ${st.pending}` : "✓ отправлено";
}

function renderMissing() {
  const list = session.missing();
  $("m-title").textContent = `Вопрос ${session.current}: нет карточек — ${list.length}`;
  $("m-list").replaceChildren(...list.map((t) => {
    const li = document.createElement("li");
    li.textContent = t.name;
    li.append(Object.assign(document.createElement("small"), { textContent: `ID ${t.team_id}` }));
    return li;
  }));
}

function renderSync() {
  const st = queue.status;
  $("s-summary").textContent = st.pending ? `Ждут отправки: ${st.pending}.` : "Все отметки отправлены.";
  $("s-error").textContent = st.lastError ? `Последняя ошибка: ${st.lastError}. Повтор — автоматически.` : "";
  $("s-rejected").replaceChildren(...queue.rejected.map(({ event, error }) => {
    const li = document.createElement("li");
    const team = session.byId.get(event.team_id);
    li.textContent = `${team ? team.name : event.team_id} · вопрос ${event.question} · ${STATUS_LABEL[event.status] || event.status}`;
    li.append(Object.assign(document.createElement("small"), { textContent: `Отклонено: ${error}` }));
    return li;
  }));
  $("s-clear").hidden = queue.rejected.length === 0;
}

// ---------- wiring ----------

function wire() {
  $("start").onclick = async () => {
    unlockAudio();
    try {
      await camera.start();
      $("start").hidden = true;
    } catch (err) {
      toast(`Камера недоступна: ${err.message}`, true);
    }
  };
  $("q-prev").onclick = () => { session.setQuestion(session.current - 1); store.set(K.current(setup.tid), session.current); render(); };
  $("q-next").onclick = () => { session.setQuestion(session.current + 1); store.set(K.current(setup.tid), session.current); render(); };
  $("v-correct").onclick = () => verdict("correct");
  $("v-incorrect").onclick = () => verdict("incorrect");
  $("v-disputed").onclick = () => verdict("disputed");
  $("v-later").onclick = () => verdict(null);
  $("sp-current").onclick = () => answerSpare(session.current);
  $("sp-cancel").onclick = () => { spareResult = null; sheet(null); };
  for (const b of document.querySelectorAll(".keypad button")) {
    b.onclick = () => {
      const k = b.dataset.k;
      if (k === "ok") return answerSpare(Number(spareDigits));
      spareDigits = k === "back" ? spareDigits.slice(0, -1) : (spareDigits + k).replace(/^0+/, "").slice(0, 3);
      $("sp-display").textContent = spareDigits;
    };
  }
  $("missing-open").onclick = () => { renderMissing(); sheet("missing"); };
  $("m-close").onclick = () => sheet(null);
  $("sync").onclick = () => { renderSync(); sheet("syncinfo"); };
  $("s-now").onclick = async () => { queue.nextAttemptAt = 0; await flush(); renderSync(); };
  $("s-clear").onclick = () => { queue.clearRejected(); renderSync(); render(); };
  $("s-close").onclick = () => sheet(null);
  $("settings-open").onclick = () => {
    $("juror").value = store.get(K.juror) || "";
    $("about").textContent = `Турнир ${setup.tid} · ${session.name}. Сервер: ${setup.backendUrl.replace(/^https:\/\//, "").slice(0, 48)}…`;
    sheet("settings");
  };
  $("juror").onchange = () => { store.set(K.juror, $("juror").value.trim()); session.juror = $("juror").value.trim(); };
  $("refresh").onclick = async () => { await refresh(); toast("Данные обновлены"); };
  $("settings-close").onclick = () => sheet(null);
  $("forget").onclick = () => {
    const pending = queue.status.pending;
    if (!confirm(pending ? `Есть неотправленные отметки: ${pending}. Они останутся на телефоне. Отключить турнир?` : "Отключить этот турнир на телефоне?")) return;
    store.remove(K.setup);
    location.replace(location.pathname);
  };
  $("loading-reset").onclick = () => { store.remove(K.setup); location.replace(location.pathname); };
  setInterval(flush, FLUSH_EVERY_MS);
  setInterval(refresh, REFRESH_EVERY_MS);
  addEventListener("online", () => { if (queue) { queue.nextAttemptAt = 0; flush(); } });
}

/** A jury link (#setup=…) or a card (opened from the iPhone Camera) in the address. */
function readHash() {
  const hash = location.hash;
  if (hash) history.replaceState(null, "", location.pathname + location.search); // the token must not stay in the address bar
  return { setup: decodeSetup(hash), card: decodeCard(hash) ? hash : null };
}

function boot() {
  wire();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  // Safari may reuse the open tab for a link to this page: only the #… part changes.
  addEventListener("hashchange", () => {
    const next = readHash();
    if (next.setup) {
      if (session && next.setup.tid === setup.tid && next.setup.juryToken === setup.juryToken) return;
      if (adoptSetup(next.setup)) {
        if (setupCamera) setupCamera.stop();
        startTournament();
      }
    } else if (next.card && session) {
      handleCode(next.card);
    }
  });
  const from = readHash();
  if (from.setup) adoptSetup(from.setup);
  if (!setup) return startSetupScreen(from.card ? "Сначала настройте телефон: отсканируйте QR «Доступ жюри»." : "");
  startTournament(from.card);
}

boot();
