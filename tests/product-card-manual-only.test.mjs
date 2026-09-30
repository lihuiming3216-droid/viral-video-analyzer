import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the Base product-card button uses the shared PID catalog, never product-page parsing", async () => {
  const source = await readFile(new URL("../lib/feishu/automation.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /parsePublicProductPage/);
  assert.match(source, /getProductCatalog\(effectivePid\)/);
  assert.match(source, /preserveExistingOnMissing: true/);
  assert.match(source, /ensureProductCardByPid\(input\.client/);
  assert.match(source, /fillEmptyOnly: true/);
  assert.match(source, /手卡空白基础资料已补录，已有内容保留/);
});

test("product-card identity accepts the Base PID without requiring a product URL", async () => {
  const source = await readFile(new URL("../lib/feishu/automation.ts", import.meta.url), "utf8");
  assert.match(source, /pid: suppliedPid/);
  assert.doesNotMatch(source, /extractProductIdFromUrl/);
  assert.doesNotMatch(source, /产品链接必须是 HTTPS TikTok/);
});
