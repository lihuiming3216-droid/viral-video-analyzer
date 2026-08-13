import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the per-product document endpoint cannot bypass the Feishu button", async () => {
  const route = await readFile(
    new URL("../app/api/products/[id]/document/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /产品手卡只能通过飞书表格按钮生成或关联/);
  assert.match(route, /status: 410/);
  assert.doesNotMatch(route, /ensureProductDocument|templateToken|ownerOpenId/);
});
