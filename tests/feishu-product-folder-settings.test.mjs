import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("saving a product folder preserves the separate report root folder", async () => {
  const [schema, store] = await Promise.all([
    readFile(new URL("lib/db/schema.sql", root), "utf8"),
    readFile(new URL("lib/feishu/store.ts", root), "utf8"),
  ]);

  assert.match(schema, /product_folder_token VARCHAR\(191\) NOT NULL DEFAULT ''/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS feishu_settings/);
  assert.match(store, /const previousRoot = text\(current\.root_folder_token\)/);
  assert.match(store, /const nextRoot = input\.rootFolderToken\?\.trim\(\) \?\? previousRoot/);
  assert.match(store, /const nextProductFolder = input\.productFolderToken\?\.trim\(\) \?\? text\(current\.product_folder_token\)/);
  assert.match(store, /root_folder_token=\?, root_folder_url=\?,[\s\S]*?product_folder_token=\?, product_folder_url=\?/);
  assert.match(store, /if \(previousRoot !== nextRoot && options\.clearReportFolderCache !== false\) await clearFeishuFolderCache\(\)/);
});

