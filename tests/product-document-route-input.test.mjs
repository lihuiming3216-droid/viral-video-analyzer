import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("product document route only forwards public business fields", async () => {
  const route = await readFile(new URL("app/api/products/[id]/document/route.ts", root), "utf8");
  const documentInput = route.match(/const documentInput = \{([\s\S]*?)\n\s*\};/);

  assert.ok(documentInput, "route should construct an explicit document input object");
  const allowedFields = [
    "templateToken",
    "coreFunctions",
    "productParameters",
    "usageMethod",
    "audience",
    "scenes",
    "sellingPoints",
    "propImages",
  ];
  const forwardedFields = [...documentInput[1].matchAll(/^\s+([A-Za-z]\w*):/gm)]
    .map((match) => match[1]);
  assert.deepEqual(forwardedFields, allowedFields);

  assert.doesNotMatch(documentInput[1], /\bownerOpenId\s*:/);
  assert.doesNotMatch(documentInput[1], /\bmigrateExisting\s*:/);
  assert.doesNotMatch(documentInput[1], /\.\.\./, "the whitelist must not spread untrusted request data");
  assert.doesNotMatch(route, /ensureProductDocument\(channel\.rawClient,\s*target,\s*body\)/);
  assert.match(route, /ensureProductDocument\(channel\.rawClient,\s*target,\s*documentInput\)/);
});
