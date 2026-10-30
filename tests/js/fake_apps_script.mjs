// In-memory stand-ins for the Apps Script services Code.js uses, so the backend can be
// exercised in Node. They mimic the behaviour that matters: range bounds (1000 × 26 for
// a new sheet), getLastRow, values defaulting to "", getValues() returning computed
// formula results, and text that looks like a number turning into a number unless the
// cell is formatted as plain text ("@").
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { makeEvaluator } from "./sheet_formulas.mjs";

class FakeRange {
  constructor(sheet, row, col, rows, cols) {
    if (row < 1 || col < 1 || row + rows - 1 > sheet.maxRows || col + cols - 1 > sheet.maxCols) {
      throw new Error(`range out of bounds: ${sheet.name}!R${row}C${col} ${rows}x${cols} (max ${sheet.maxRows}x${sheet.maxCols})`);
    }
    Object.assign(this, { sheet, row, col, rows, cols });
  }
  getValues() {
    const value = makeEvaluator(this.sheet.ss);
    return Array.from({ length: this.rows }, (_, r) =>
      Array.from({ length: this.cols }, (_, c) => value(this.sheet, this.row + r, this.col + c)));
  }
  setValues(values) {
    if (values.length !== this.rows || values.some((r) => r.length !== this.cols)) throw new Error("setValues: wrong shape");
    values.forEach((r, i) => r.forEach((v, j) => this.sheet.write(this.row + i, this.col + j, v)));
    return this;
  }
  getValue() { return this.getValues()[0][0]; }
  getFormulas() {
    return Array.from({ length: this.rows }, (_, r) => Array.from({ length: this.cols }, (_, c) => {
      const v = this.sheet.get(this.row + r, this.col + c);
      return typeof v === "string" && v.startsWith("=") ? v : "";
    }));
  }
  setValue(v) { this.sheet.write(this.row, this.col, v); return this; }
  clearContent() { this.setValues(Array.from({ length: this.rows }, () => new Array(this.cols).fill(""))); return this; }
  setNote(n) { this.sheet.notes.set(`${this.row},${this.col}`, n); return this; }
  clearNote() { this.sheet.notes.delete(`${this.row},${this.col}`); return this; }
  getNumRows() { return this.rows; }
  getNumColumns() { return this.cols; }
  /**
   * Range.sort: rows ordered by computed values, blanks last. Raw cells and notes move
   * with their row, but formulas are NOT re-pointed at their new row (the worst case),
   * so the backend has to rewrite per-row formulas itself.
   */
  sort(specs) {
    const value = makeEvaluator(this.sheet.ss);
    const rows = [];
    for (let r = this.row; r < this.row + this.rows; r++) {
      const cells = [];
      const notes = [];
      for (let c = this.col; c < this.col + this.cols; c++) {
        cells.push(this.sheet.cells.get(`${r},${c}`));
        notes.push(this.sheet.notes.get(`${r},${c}`));
      }
      rows.push({ keys: specs.map((s) => value(this.sheet, r, s.column)), cells, notes });
    }
    rows.sort((a, b) => {
      for (let i = 0; i < specs.length; i++) {
        const x = a.keys[i];
        const y = b.keys[i];
        if (x === y) continue;
        if (x === "") return 1;
        if (y === "") return -1;
        const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        if (cmp !== 0) return specs[i].ascending === false ? -cmp : cmp;
      }
      return 0;
    });
    rows.forEach((row, i) => row.cells.forEach((v, j) => {
      const key = `${this.row + i},${this.col + j}`;
      if (v === undefined) this.sheet.cells.delete(key); else this.sheet.cells.set(key, v);
      if (row.notes[j] === undefined) this.sheet.notes.delete(key); else this.sheet.notes.set(key, row.notes[j]);
    }));
    this.sheet.sorts = (this.sheet.sorts || 0) + 1;
    return this;
  }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getSheet() { return this.sheet; }
  setFontWeight() { return this; }
  setNumberFormat(f) { this.each((r, c) => this.sheet.formats.set(`${r},${c}`, f)); return this; }
  setBackground(color) { this.each((r, c) => this.sheet.backgrounds.set(`${r},${c}`, color)); return this; }
  setHorizontalAlignment(a) { this.each((r, c) => this.sheet.align.set(`${r},${c}`, a)); return this; }
  setBorder(top, left, bottom, right, vertical, horizontal, color, style) {
    if (left) for (let r = this.row; r < this.row + this.rows; r++) this.sheet.leftBorders.set(`${r},${this.col}`, style);
    return this;
  }
  each(fn) { for (let r = this.row; r < this.row + this.rows; r++) for (let c = this.col; c < this.col + this.cols; c++) fn(r, c); }
}

export class FakeSheet {
  constructor(ss, name) {
    Object.assign(this, { ss, name, cells: new Map(), notes: new Map(), maxRows: 1000, maxCols: 26, hidden: false,
      widths: new Map(), backgrounds: new Map(), align: new Map(), leftBorders: new Map(), formats: new Map() });
  }
  get(r, c) { return this.cells.has(`${r},${c}`) ? this.cells.get(`${r},${c}`) : ""; }
  set(r, c, v) { if (v === "" || v == null) this.cells.delete(`${r},${c}`); else this.cells.set(`${r},${c}`, v); }
  /** A write through the Apps Script API: like Sheets, "42" becomes 42 unless the cell is plain text. */
  write(r, c, v) {
    const plain = this.formats.get(`${r},${c}`) === "@";
    this.set(r, c, !plain && typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v);
  }
  /** Computed value of a cell (formulas evaluated), as the jury sees it. */
  value(r, c) { return makeEvaluator(this.ss)(this, r, c); }
  getRange(row, col, rows = 1, cols = 1) { return new FakeRange(this, row, col, rows, cols); }
  getLastRow() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(",")[0])); return m; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(_, n) { this.maxRows += n; }
  insertColumnsAfter(_, n) { this.maxCols += n; }
  setName(n) { this.name = n; return this; }
  getName() { return this.name; }
  getParent() { return this.ss; }
  setColumnWidth(col, w) { this.widths.set(col, w); }
  setColumnWidths(col, n, w) {
    if (col + n - 1 > this.maxCols) throw new Error("setColumnWidths out of bounds");
    for (let i = 0; i < n; i++) this.widths.set(col + i, w);
  }
  setTabColor(c) { this.tabColor = c; return this; }
  setFrozenRows() {}
  setFrozenColumns() {}
  hideSheet() { this.hidden = true; return this; }
  isSheetHidden() { return Boolean(this.hidden); }
  setConditionalFormatRules(rules) { this.rules = rules; }
  /** The row of a team (column A = its ID): rows move when the backend sorts a tab. */
  rowOf(teamId) {
    for (let r = 2; r <= this.getLastRow(); r++) if (this.get(r, 1) === teamId) return r;
    throw new Error(`${teamId} not on ${this.name}`);
  }
  /** Team IDs from row 2 down, i.e. the order the jury sees. */
  ids() { return Array.from({ length: Math.max(this.getLastRow() - 1, 0) }, (_, i) => this.get(i + 2, 1)).filter(Boolean); }
  /** Row values as a plain array, for assertions. */
  row(r, width) { return Array.from({ length: width }, (_, c) => this.get(r, c + 1)); }
}

class FakeSpreadsheet {
  constructor(id, name) { Object.assign(this, { id, name, sheets: [] }); this.sheets.push(new FakeSheet(this, "Sheet1")); }
  getId() { return this.id; }
  getSheets() { return this.sheets; }
  insertSheet(name, index = this.sheets.length) {
    if (this.getSheetByName(name)) throw new Error(`sheet ${name} exists`);
    const s = new FakeSheet(this, name);
    this.sheets.splice(index, 0, s);
    return s;
  }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  setActiveSheet() {}
}

class FakeFolder {
  constructor(name) { Object.assign(this, { name, children: [], id: `folder-${name}`, trashed: false }); }
  isTrashed() { return this.trashed; }
  getId() { return this.id; }
  createFolder(name) { const f = new FakeFolder(name); this.children.push(f); return f; }
  getFoldersByName(name) {
    const found = this.children.filter((f) => f.name === name); // like Drive: trashed ones too
    return { hasNext: () => found.length > 0, next: () => found.shift() };
  }
}

function chain() {
  // Any method returns the same object; build()/create() end the chain.
  const proxy = new Proxy({}, { get: (_, prop) => (prop === "build" || prop === "create" ? () => ({}) : () => proxy) });
  return proxy;
}

/** A fresh Apps Script world with Code.js and logic.js loaded; returns the vm context. */
export function loadBackend({ account = "me@gmail.com", serviceUrl = "https://script.google.com/macros/s/AKfycbFAKE00000/exec",
  allScopes = true } = {}) {
  const props = new Map();
  const spreadsheets = new Map();
  const root = new FakeFolder("root");
  const triggers = [];
  const sharing = new Map(); // spreadsheet id → "ACCESS:PERMISSION"
  const ctx = {
    console,
    JSON, Date, Math, Number, String, Object, Array, Set, Map, Error,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, String(v)),
      }),
    },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: (text) => ({ setMimeType: () => ({ text, json: () => JSON.parse(text) }) }),
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => account }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: {
      create(name) { const ss = new FakeSpreadsheet(`ss${spreadsheets.size + 1}`, name); spreadsheets.set(ss.id, ss); return ss; },
      openById(id) { return spreadsheets.get(id); },
      newConditionalFormatRule: chain,
      BorderStyle: { SOLID_MEDIUM: "SOLID_MEDIUM" },
    },
    DriveApp: {
      getRootFolder: () => root,
      getFileById: (id) => ({ moveTo() {}, setSharing(access, permission) { sharing.set(id, `${access}:${permission}`); } }),
      Access: { ANYONE_WITH_LINK: "ANYONE_WITH_LINK" },
      Permission: { VIEW: "VIEW" },
    },
    ScriptApp: {
      newTrigger: (fn) => { triggers.push(fn); return chain(); },
      getService: () => ({ getUrl: () => serviceUrl }),
      AuthMode: { FULL: "FULL" },
      AuthorizationStatus: { REQUIRED: "REQUIRED", NOT_REQUIRED: "NOT_REQUIRED" },
      getAuthorizationInfo: () => ({ getAuthorizationStatus: () => (allScopes ? "NOT_REQUIRED" : "REQUIRED") }),
      requireAllScopes: (mode) => { ctx.$.scopeRequests.push(mode); },
    },
    Utilities: { getUuid: () => "0123456789abcdef0123456789abcdef" },
    Logger: { log: (...args) => ctx.logged.push(args) },
    logged: [],
  };
  vm.createContext(ctx);
  const dir = new URL("../../apps_script/", import.meta.url);
  const source = readFileSync(new URL("logic.js", dir), "utf8") + "\n" + readFileSync(new URL("Code.js", dir), "utf8");
  vm.runInContext(source, ctx, { filename: "apps_script bundle" });
  ctx.$ = { props, spreadsheets, root, triggers, sharing, scopeRequests: [] };
  ctx.post = (body) => ctx.doPost({ postData: { contents: JSON.stringify(body) } }).json();
  return ctx;
}
