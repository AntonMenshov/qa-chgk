// Evaluates the subset of Google Sheets formulas the backend writes (SUM, COUNTIF, COUNTA,
// RANK, INDEX, MATCH, IF, IFERROR, & and arithmetic, cross-tab and open-ended ranges), so
// tests check the numbers the jury will see, not only the formula text.

export class SheetError extends Error {}

const TOKEN = new RegExp(
  [
    String.raw`(?<num>\d+(?:\.\d+)?)`,
    String.raw`"(?<str>(?:[^"]|"")*)"`,
    // Optional 'Tab name'! or Tab!, then A1, $A$1, A:A, E$2:E, …
    String.raw`(?<ref>(?:'(?:[^']|'')+'!|[A-Za-z_][\w]*!)?\$?[A-Z]{1,3}\$?\d*(?::\$?[A-Z]{1,3}\$?\d*)?)(?![\w(])`,
    String.raw`(?<fn>[A-Z][A-Z0-9.]*)\(`,
    String.raw`(?<op><=|>=|<>|[-+*/&=<>(),])`,
    String.raw`(?<ws>\s+)`,
  ].join("|"),
  "y",
);

function tokenize(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`cannot parse formula at ${JSON.stringify(src.slice(TOKEN.lastIndex))}: ${src}`);
    const g = m.groups;
    if (g.ws) continue;
    if (g.num) out.push({ t: "num", v: Number(g.num) });
    else if (g.str !== undefined) out.push({ t: "str", v: g.str.replace(/""/g, '"') });
    else if (g.ref) out.push({ t: "ref", v: g.ref });
    else if (g.fn) out.push({ t: "fn", v: g.fn }, { t: "op", v: "(" });
    else out.push({ t: "op", v: g.op });
  }
  return out;
}

function colNumber(letters) {
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

/** "'Тур 1'!$F:$F" → {sheet, r1, c1, r2, c2}; open ends run to the sheet's last row. */
function parseRef(text, here, ss) {
  let sheet = here;
  let body = text;
  const bang = text.lastIndexOf("!");
  if (bang >= 0) {
    const name = text.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'");
    sheet = ss.getSheetByName(name);
    if (!sheet) throw new SheetError(`#REF! no sheet ${name}`);
    body = text.slice(bang + 1);
  }
  const [a, b = a] = body.replace(/\$/g, "").split(":");
  const pa = /^([A-Z]+)(\d*)$/.exec(a);
  const pb = /^([A-Z]+)(\d*)$/.exec(b);
  const last = Math.max(sheet.getLastRow(), 1);
  return {
    sheet,
    r1: pa[2] ? Number(pa[2]) : 1,
    c1: colNumber(pa[1]),
    r2: pb[2] ? Number(pb[2]) : last,
    c2: colNumber(pb[1]),
  };
}

export function makeEvaluator(ss) {
  const memo = new Map();
  const active = new Set();

  function cellValue(sheet, r, c) {
    const raw = sheet.get(r, c);
    if (typeof raw !== "string" || !raw.startsWith("=")) return raw;
    const key = `${sheet.name}!${r},${c}`;
    if (memo.has(key)) return memo.get(key);
    if (active.has(key)) throw new Error(`circular reference at ${key}`);
    active.add(key);
    let value;
    try {
      value = evalFormula(raw.slice(1), sheet);
    } catch (err) {
      if (!(err instanceof SheetError)) throw err;
      value = err;
    } finally {
      active.delete(key);
    }
    memo.set(key, value);
    return value;
  }

  function cells(range) {
    const out = [];
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c <= range.c2; c++) out.push(cellValue(range.sheet, r, c));
    }
    return out;
  }

  const scalar = (v) => {
    if (v && v.range) {
      if (v.range.r1 !== v.range.r2 || v.range.c1 !== v.range.c2) throw new SheetError("#VALUE! range used as a value");
      return scalar(cellValue(v.range.sheet, v.range.r1, v.range.c1));
    }
    if (v instanceof SheetError) throw v;
    return v;
  };
  const num = (v) => {
    v = scalar(v);
    if (v === "" || v === false) return 0;
    if (v === true) return 1;
    if (typeof v === "number") return v;
    const n = Number(v);
    if (Number.isNaN(n)) throw new SheetError(`#VALUE! ${JSON.stringify(v)} is not a number`);
    return n;
  };
  const text = (v) => {
    v = scalar(v);
    return v === true ? "TRUE" : v === false ? "FALSE" : String(v);
  };
  const same = (a, b) =>
    typeof a === "number" || typeof b === "number" ? a === b : String(a).toLowerCase() === String(b).toLowerCase();

  const FUNCTIONS = {
    SUM: (...args) => args.reduce((s, a) => s + (a.range ? cells(a.range).filter((v) => typeof v === "number")
      .reduce((x, y) => x + y, 0) : num(a)), 0),
    COUNTA: (a) => cells(a.range).filter((v) => v !== "").length,
    COUNTIF: (a, crit) => {
      const c = scalar(crit);
      if (typeof c === "string" && /^[<>=]/.test(c)) throw new Error(`COUNTIF operator criteria not supported: ${c}`);
      return cells(a.range).filter((v) => v !== "" && !(v instanceof SheetError) && same(v, c)).length;
    },
    RANK: (value, a, ascending) => {
      const v = num(value);
      const nums = cells(a.range).filter((x) => typeof x === "number");
      if (!nums.includes(v)) throw new SheetError("#N/A value not in range");
      const up = ascending !== undefined && num(ascending) !== 0;
      return 1 + nums.filter((x) => (up ? x < v : x > v)).length;
    },
    INDEX: (a, row) => {
      const r = num(row);
      if (a.range.c1 !== a.range.c2) throw new Error("INDEX over several columns not supported");
      if (r < 1 || a.range.r1 + r - 1 > a.range.r2) throw new SheetError("#REF! INDEX out of range");
      return cellValue(a.range.sheet, a.range.r1 + r - 1, a.range.c1);
    },
    MATCH: (value, a, type) => {
      if (num(type) !== 0) throw new Error("only exact MATCH is supported");
      const v = scalar(value);
      const i = cells(a.range).findIndex((x) => x !== "" && same(x, v));
      if (i < 0) throw new SheetError("#N/A no match");
      return i + 1;
    },
  };

  function evalFormula(src, here) {
    const toks = tokenize(src);
    let i = 0;
    const peek = () => toks[i];
    const take = (v) => {
      const t = toks[i++];
      if (v !== undefined && (!t || t.v !== v)) throw new Error(`expected ${v} in ${src}`);
      return t;
    };

    // Lazy AST so IF/IFERROR evaluate only the branch they need.
    function primary() {
      const t = take();
      if (t.t === "num" || t.t === "str") return () => t.v;
      if (t.t === "ref") { const range = parseRef(t.v, here, ss); return () => ({ range }); }
      if (t.v === "-") { const e = primary(); return () => -num(e()); }
      if (t.v === "(") { const e = comparison(); take(")"); return e; }
      if (t.t === "fn") {
        take("(");
        const args = [];
        if (peek().v !== ")") {
          do { args.push(comparison()); } while (peek().v === "," && take(","));
        }
        take(")");
        if (t.v === "IF") return () => (scalar(args[0]()) ? args[1]() : args[2] ? args[2]() : false);
        if (t.v === "IFERROR") {
          return () => {
            try { return scalar(args[0]()); } catch (err) { if (err instanceof SheetError) return args[1](); throw err; }
          };
        }
        const fn = FUNCTIONS[t.v];
        if (!fn) throw new Error(`function ${t.v} not supported`);
        return () => fn(...args.map((a) => a()));
      }
      throw new Error(`unexpected ${t.v} in ${src}`);
    }
    function binary(next, ops, apply) {
      return () => {
        let left = next();
        while (peek() && ops.includes(peek().v)) {
          const op = take().v;
          const right = next();
          const l = left;
          left = () => apply(op, l(), right());
        }
        return left;
      };
    }
    const term = binary(primary, ["*", "/"], (op, a, b) => {
      if (op === "/" && num(b) === 0) throw new SheetError("#DIV/0!");
      return op === "*" ? num(a) * num(b) : num(a) / num(b);
    });
    const additive = binary(term, ["+", "-"], (op, a, b) => (op === "+" ? num(a) + num(b) : num(a) - num(b)));
    const concat = binary(additive, ["&"], (_, a, b) => text(a) + text(b));
    const comparison = binary(concat, ["=", "<>", "<", ">", "<=", ">="], (op, a, b) => {
      const x = scalar(a);
      const y = scalar(b);
      return { "=": same(x, y), "<>": !same(x, y), "<": x < y, ">": x > y, "<=": x <= y, ">=": x >= y }[op];
    });

    const expr = comparison();
    if (i !== toks.length) throw new Error(`trailing tokens in ${src}`);
    return scalar(expr());
  }

  /** The computed value of a cell, as getValues() returns it in Google Sheets. */
  return (sheet, r, c) => {
    const v = cellValue(sheet, r, c);
    return v instanceof SheetError ? `#ERROR: ${v.message}` : v;
  };
}
