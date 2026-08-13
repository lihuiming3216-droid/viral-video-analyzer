import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the Base product-card button no longer parses product links or rewrites template fields", async () => {
  const source = await readFile(new URL("../lib/feishu/automation.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /parsePublicProductPage/);
  assert.doesNotMatch(source, /syncProductCardManagedFields/);
  assert.match(source, /ensureProductCardByPid\(input\.client/);
  assert.match(source, /手卡已就绪，请手动填写/);
});

test("product-card identity accepts the Base PID without requiring a product URL", async () => {
  const source = await readFile(new URL("../lib/feishu/automation.ts", import.meta.url), "utf8");
  assert.match(source, /pid: suppliedPid/);
  assert.doesNotMatch(source, /extractProductIdFromUrl/);
  assert.doesNotMatch(source, /产品链接必须是 HTTPS TikTok/);
});
