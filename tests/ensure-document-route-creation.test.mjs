import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/products/ensure-document/route.ts", import.meta.url),
  "utf8",
);

test("the legacy ensure-document endpoint cannot create or analyze product cards", () => {
  assert.match(route, /产品手卡只能通过飞书表格按钮生成或关联/);
  assert.match(route, /status: 410/);
  assert.doesNotMatch(route, /ensureProductDocument|parsePublicProductPage|createProduct/);
});
