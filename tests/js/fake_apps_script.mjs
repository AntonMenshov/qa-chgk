// In-memory stand-ins for the Apps Script services Code.js uses, so the backend can be
// exercised in Node. They mimic the behaviour that matters: range bounds (1000 × 26 for
// a new sheet), getLastRow, values defaulting to "".
import { readFileSync } from "node:fs";
import vm from "node:vm";

class FakeRange {
  constructor(sheet, row, col, rows, cols) {
    if (row < 1 || col < 1 || row + rows - 1 > sheet.maxRows || col + cols - 1 > sheet.maxCols) {
      throw new Error(`range out of bounds: ${sheet.name}!R${row}C${col} ${rows}x${cols} (max ${sheet.maxRows}x${sheet.maxCols})`);
    }
    Object.assign(this, { sheet, row, col, rows, cols });
  }
  getValues() {
    return Array.from({ length: this.rows }, (_, r) =>
      Array.from({ length: this.cols }, (_, c) => this.sheet.get(this.row + r, this.col + c)));
  }
  setValues(values) {
    if (values.length !== this.rows || values.some((r) => r.length !== this.cols)) throw new Error("setValues: wrong shape");
    values.forEach((r, i) => r.forEach((v, j) => this.sheet.set(this.row + i, this.col + j, v)));
    return this;
  }
  getValue() { return this.sheet.get(this.row, this.col); }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
  clearContent() { this.setValues(Array.from({ length: this.rows }, () => new Array(this.cols).fill(""))); return this; }
  setNote(n) { this.sheet.notes.set(`${this.row},${this.col}`, n); return this; }
  clearNote() { this.sheet.notes.delete(`${this.row},${this.col}`); return this; }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getSheet() { return this.sheet; }
  setFontWeight() { return this; }
  setNumberFormat() { return this; }
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
      widths: new Map(), backgrounds: new Map(), align: new Map(), leftBorders: new Map() });
  }
  get(r, c) { return this.cells.has(`${r},${c}`) ? this.cells.get(`${r},${c}`) : ""; }
  set(r, c, v) { if (v === "" || v == null) this.cells.delete(`${r},${c}`); else this.cells.set(`${r},${c}`, v); }
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
  setFrozenRows() {}
  setFrozenColumns() {}
  hideSheet() { this.hidden = true; return this; }
  setConditionalFormatRules(rules) { this.rules = rules; }
  /** Row values as a plain array, for assertions. */
  row(r, width) { return Array.from({ length: width }, (_, c) => this.get(r, c + 1)); }
}

class FakeSpreadsheet {
  constructor(id, name) { Object.assign(this, { id, name, sheets: [] }); this.sheets.push(new FakeSheet(this, "Sheet1")); }
  getId() { return this.id; }
  getSheets() { return this.sheets; }
  insertSheet(name) { const s = new FakeSheet(this, name); this.sheets.push(s); return s; }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  setActiveSheet() {}
}

class FakeFolder {
  constructor(name) { Object.assign(this, { name, children: [], id: `folder-${name}` }); }
  getId() { return this.id; }
  createFolder(name) { const f = new FakeFolder(name); this.children.push(f); return f; }
  getFoldersByName(name) {
    const found = this.children.filter((f) => f.name === name);
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
    DriveApp: { getRootFolder: () => root, getFileById: () => ({ moveTo() {} }) },
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
  ctx.$ = { props, spreadsheets, root, triggers, scopeRequests: [] };
  ctx.post = (body) => ctx.doPost({ postData: { contents: JSON.stringify(body) } }).json();
  return ctx;
}
