import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const VECTORS_DIR = new URL("../vectors/", import.meta.url);

test("every shared vector file has a description and a cases array", () => {
  for (const name of readdirSync(VECTORS_DIR).filter((n) => n.endsWith(".json"))) {
    const data = JSON.parse(readFileSync(new URL(name, VECTORS_DIR), "utf8"));
    assert.equal(typeof data.description, "string", name);
    assert.ok(Array.isArray(data.cases), name);
  }
});
