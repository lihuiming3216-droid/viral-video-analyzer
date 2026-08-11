import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("product folder settings parse a complete Feishu folder URL and reject unrelated URLs", async () => {
  const route = await readFile(new URL("app/api/feishu/settings/route.ts", root), "utf8");
  const source = route.match(/function parseFeishuFolderInput\(value: unknown\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, "folder parser is present");
  const executable = source.replace("(value: unknown)", "(value)");
  const parse = Function(`${executable}; return parseFeishuFolderInput;`)();

  assert.deepEqual(
    parse("https://m6ksa3h3up.feishu.cn/drive/folder/BLIffC5ZIlWqqHdl0kVceBdunzb?from=copy"),
    {
      token: "BLIffC5ZIlWqqHdl0kVceBdunzb",
      url: "https://m6ksa3h3up.feishu.cn/drive/folder/BLIffC5ZIlWqqHdl0kVceBdunzb",
    },
  );
  assert.deepEqual(parse("BLIffC5ZIlWqqHdl0kVceBdunzb"), {
    token: "BLIffC5ZIlWqqHdl0kVceBdunzb",
    url: "",
  });
  assert.equal(parse("https://example.com/drive/folder/not-feishu"), null);
  assert.equal(parse("https://m6ksa3h3up.feishu.cn/wiki/not-a-folder"), null);
});

test("saving a product folder preserves the separate report root folder", async () => {
  const [database, store] = await Promise.all([
    readFile(new URL("lib/database.ts", root), "utf8"),
    readFile(new URL("lib/feishu/store.ts", root), "utf8"),
  ]);

  assert.match(database, /product_folder_token TEXT NOT NULL DEFAULT ''/);
  assert.match(database, /ALTER TABLE feishu_settings ADD COLUMN/);
  assert.match(store, /const previousRoot = text\(current\.root_folder_token\)/);
  assert.match(store, /const nextRoot = input\.rootFolderToken\?\.trim\(\) \?\? previousRoot/);
  assert.match(store, /const nextProductFolder = input\.productFolderToken\?\.trim\(\) \?\? text\(current\.product_folder_token\)/);
  assert.match(store, /root_folder_token=\?, root_folder_url=\?,[\s\S]*?product_folder_token=\?, product_folder_url=\?/);
  assert.match(store, /if \(previousRoot !== nextRoot && options\.clearReportFolderCache !== false\) clearFeishuFolderCache\(\)/);
});

test("saving an enabled product folder validates app access after reconnecting", async () => {
  const route = await readFile(new URL("app/api/feishu/settings/route.ts", root), "utf8");
  assert.match(route, /await restartFeishuConnection\(\)/);
  assert.match(route, /getConnectedFeishuChannel\(\)/);
  assert.match(route, /validateProductDocumentFolder\(channel\.rawClient, settings\.productFolderToken\)/);
  assert.match(route, /文件夹未共享给包含机器人的群，或机器人权限不足/);
});

test("a rejected product folder is rolled back and cannot remain in saved settings", async () => {
  const [route, store] = await Promise.all([
    readFile(new URL("app/api/feishu/settings/route.ts", root), "utf8"),
    readFile(new URL("lib/feishu/store.ts", root), "utf8"),
  ]);

  assert.match(route, /const previous = getRawFeishuSettings\(\)/);
  assert.match(route, /saveFeishuSettings\([\s\S]*?\{ clearReportFolderCache: false \}\)/);
  assert.match(route, /catch \(error\) \{[\s\S]*?await restorePreviousSettings\(previous\)/);
  assert.match(route, /productFolderToken: rawText\(previous, "product_folder_token"\)/);
  assert.match(route, /encryptedAppSecret: previous\.encrypted_app_secret/);
  assert.match(route, /if \(restored\.enabled\) await restartFeishuConnection\(\)/);
  assert.match(store, /options\.clearReportFolderCache !== false/);
  assert.match(route, /clearFeishuFolderCache\(\)/);
});
