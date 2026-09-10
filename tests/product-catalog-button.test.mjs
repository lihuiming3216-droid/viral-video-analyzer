import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const url = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('import "server-only";', "");
const source = await readFile(new URL("../lib/feishu/automation.ts", import.meta.url), "utf8");
const typesUrl = url(compile(await readFile(new URL("../lib/products/catalog-types.ts", import.meta.url), "utf8")));
const types = await import(typesUrl);

async function fixture(t) {
  const key = `catalogButton${Math.random()}`;
  const pid = "1732350695360139845";
  const events = [];
  const catalog = { pid, fields: Object.fromEntries(Object.keys(types.catalogFields).map(key => [key, { text: key, basis: "direct", evidence: ["product-text"] }])), warnings: [] };
  const currentValues = { 商品名称: "旧名称", 产品链接: "", 商品ID: pid, ...Object.fromEntries(Object.values(types.catalogFields).map(label => [label, "人工原值"])) };
  const hooks = {
    getFeishuFieldMapping: async () => null,
    ensureProductCardByPid: async (_client, input) => { events.push(["shell", input]); return { documentId: "card", documentUrl: "https://feishu.cn/docx/card", reused: true }; },
    syncProductCardManagedFields: async (_client, input) => {
      events.push(["sync", input]);
      return { currentValues, duplicateLabels: [], missingLabels: [], skippedLabels: [] };
    },
    getProductCatalog: async value => { events.push(["catalog", value]); return catalog; },
    getProductByPid: async () => ({ id: "product", pid }),
    updateProduct: async () => ({ id: "product", pid }),
    upsertFeishuProductCardMapping: async () => {},
    createVideo: async () => { throw Error("UNEXPECTED_VIDEO_TASK"); },
  };
  globalThis[key] = hooks;
  t.after(() => { delete globalThis[key]; });
  let code = compile(source);
  for (const [, names, module] of [...code.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(@\/lib\/[^\"]+)"/g)]) {
    if (module === "@/lib/products/catalog-types") { code = code.replaceAll(JSON.stringify(module), JSON.stringify(typesUrl)); continue; }
    const stub = names.split(",").map(name => name.trim()).filter(Boolean).map(name => `export const ${name} = async (...a) => globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}]?.(...a);`).join("\n");
    code = code.replaceAll(JSON.stringify(module), JSON.stringify(url(stub)));
  }
  code = code.replaceAll('"@/lib/products/catalog"', JSON.stringify(url(`export const getProductCatalog = (...a) => globalThis[${JSON.stringify(key)}].getProductCatalog(...a);`)));
  const automation = await import(url(code));
  const client = { request: async request => { events.push(["write", request.data.fields]); return { code: 0 }; } };
  const input = { client, appToken: "app", tableId: "table", recordId: "row", fields: { 产品名称: "分装瓶", PID: pid }, writeBack: true };
  return { hooks, events, catalog, currentValues, input, run: () => automation.handleFeishuAutomation(input) };
}

test("PID and name alone deliver a reused card link before catalog processing and fill six fields", async t => {
  const f = await fixture(t);
  const out = await f.run();
  assert.equal(out.productRefreshError, "");
  assert.equal(out.productCardStatus, "手卡商品资料已整理");
  const linkIndex = f.events.findIndex(([kind, input]) => kind === "write" && input.产品手卡);
  const catalogIndex = f.events.findIndex(([kind]) => kind === "catalog");
  assert.ok(linkIndex >= 0 && linkIndex < catalogIndex);
  const derived = f.events.find(([kind, input]) => kind === "sync" && input.derivedOnly)[1];
  assert.equal(derived.preserveExistingOnMissing, true);
  assert.equal(derived.protectRevision, true);
  assert.deepEqual(derived.expectedValues, f.currentValues);
  for (const key of Object.keys(types.catalogFields)) assert.ok(derived[key]);
});

test("provider failure leaves the delivered card available and publishes a safe error", async t => {
  const f = await fixture(t);
  f.hooks.getProductCatalog = async () => { throw Error("private-token https://signed.invalid"); };
  const out = await f.run();
  assert.equal(out.documentReady, true);
  assert.match(out.productCardStatus, /未完成/);
  assert.doesNotMatch(out.productCardStatus, /private-token|signed.invalid/);
  assert.ok(f.events.some(([kind, input]) => kind === "write" && input.产品手卡));
  assert.equal(f.events.filter(([kind, input]) => kind === "sync" && input.derivedOnly).length, 0);
});

test("template identity mismatch prevents paid calls but not the card link", async t => {
  const f = await fixture(t);
  f.currentValues.商品ID = "9999999999999999999";
  const out = await f.run();
  assert.match(out.productRefreshError, /PID 不一致/);
  assert.equal(f.events.filter(([kind]) => kind === "catalog").length, 0);
});

test("one unavailable field is written as missing with preservation enabled; other fields still succeed", async t => {
  const f = await fixture(t);
  f.catalog.fields.usageMethod = { text: "未找到", basis: "missing", evidence: [] };
  const out = await f.run();
  const input = f.events.find(([kind, input]) => kind === "sync" && input.derivedOnly)[1];
  assert.equal(input.usageMethod, "未找到");
  assert.equal(input.preserveExistingOnMissing, true);
  assert.equal(input.audience, "audience");
  assert.match(out.productCardWarning, /使用方法/);
});

test("test-name creates a new shell but still uses only the PID for shared data", async t => {
  const f = await fixture(t);
  f.input.fields.产品名称 = "分装瓶测试";
  await f.run();
  assert.equal(f.events.find(([kind]) => kind === "shell")[1].forceNew, true);
  assert.equal(f.events.find(([kind]) => kind === "catalog")[1], f.input.fields.PID);
});

test("an unsafe numeric PID stops before creating a card or charging for a rounded product ID", async t => {
  const f = await fixture(t);
  f.input.fields.PID = Number(f.input.fields.PID);
  await assert.rejects(f.run(), /精度已丢失/);
  assert.equal(f.events.length, 0);
});

test("the live template may keep product name only in its title, without a false missing-field warning", async t => {
  const f = await fixture(t);
  const sync = f.hooks.syncProductCardManagedFields;
  f.hooks.syncProductCardManagedFields = async (client, input) => ({ ...await sync(client, input), missingLabels: input.preflightOnly ? ["商品名称"] : [] });
  const out = await f.run();
  assert.equal(out.productCardWarning, "");
  assert.equal(out.productRefreshError, "");
});
