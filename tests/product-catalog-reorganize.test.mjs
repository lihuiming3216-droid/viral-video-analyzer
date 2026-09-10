import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import ts from "typescript";

const pid = "1732350695360139845";
const url = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('import "server-only";', "");
const typesUrl = url(compile(await readFile(new URL("../lib/products/catalog-types.ts", import.meta.url), "utf8")));
const { catalogFields } = await import(typesUrl);
const result = model => ({ pid, model, createdAt: "t", warnings: [], fields: Object.fromEntries(Object.keys(catalogFields).map(key => [key, { text: "fixture", evidence: ["product-text"], basis: "direct" }])) });

async function load(t) {
  const state = { modelCalls: 0, rawPresent: true, failModel: false, failPublish: false, locked: false,
    catalog: { fetch_state: "ready", analysis_state: "ready", result_json: result("old") }, ledger: new Map(), files: new Map() };
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    execute: async (sql, args) => {
      if (sql.includes("GET_LOCK")) return [[{ acquired: state.locked ? 0 : 1 }]];
      if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }]];
      if (sql.startsWith("SELECT * FROM product_catalog_reorganizations")) return [[state.ledger.get(args[0])].filter(Boolean)];
      if (sql.startsWith("SELECT id FROM product_catalog_reorganizations")) return [[...state.ledger.values()].filter(r => r.pid === args[0] && r.state === "requested")];
      if (sql.startsWith("SELECT fetch_state")) return [[state.catalog]];
      if (sql.startsWith("INSERT INTO product_catalog_reorganizations")) { state.ledger.set(args[0], { id: args[0], pid: args[1], state: "requested" }); return [{ affectedRows: 1 }]; }
      if (sql.startsWith("UPDATE product_catalog_cache")) {
        if (state.failPublish) throw Error("database disconnected");
        state.catalog.result_json = JSON.parse(args[0]); return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("UPDATE product_catalog_reorganizations SET state='ready'")) { state.ledger.get(args[1]).state = "ready"; return [{ affectedRows: 1 }]; }
      if (sql.startsWith("UPDATE product_catalog_reorganizations SET state='failed'")) { state.ledger.get(args[2]).state = "failed"; return [{ affectedRows: 1 }]; }
      throw Error("Unexpected SQL: " + sql);
    },
  };
  const key = "catalogReorganize" + Math.random();
  globalThis[key] = {
    getPool: async () => ({ getConnection: async () => connection }),
    requireAiRuntime: async () => ({ model: "new", provider: "qwen", retries: 0 }),
    cachedProduct: async () => state.rawPresent ? { product_id: pid } : null,
    prepareCatalogEvidence: async (_pid, _item, options) => { assert.equal(options.cacheOnly, true); return { pid }; },
    analyzeCatalog: async (_input, _runtime, runId) => { state.modelCalls++; assert.ok(runId); if (state.failModel) throw Error("untrusted provider secret"); return result("new"); },
    catalogDirectory: () => "/private-fixture/" + pid,
    readPrivateJson: async file => state.files.get(file) || null,
    savePrivate: async (file, body) => state.files.set(file, JSON.parse(body)),
  };
  t.after(() => { delete globalThis[key]; });
  const stub = url(Object.keys(globalThis[key]).map(name => `export const ${name} = (...args) => globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}](...args);`).join("\n"));
  const code = compile(await readFile(new URL("../lib/products/catalog-reorganize.ts", import.meta.url), "utf8"))
    .replaceAll('"@/lib/products/catalog-types"', JSON.stringify(typesUrl)).replaceAll(/"@\/lib\/[^\"]+"/g, JSON.stringify(stub));
  return { state, api: await import(url(code)) };
}

test("repeated manual submissions with one id use cached source and organize only once", async t => {
  const f = await load(t); const id = randomUUID();
  await Promise.all(Array.from({ length: 10 }, () => f.api.reorganizeCatalogFromCache(pid, id)));
  assert.equal(f.state.modelCalls, 1);
  assert.equal(f.state.catalog.result_json.model, "new");
  assert.equal(f.state.ledger.get(id).state, "ready");
  assert.equal([...f.state.files.keys()].some(file => file === `/private-fixture/${pid}/organized.json`), false);
});

test("a failed manual model call preserves the old catalog and its id cannot be charged again", async t => {
  const f = await load(t); const id = randomUUID(); f.state.failModel = true;
  await assert.rejects(f.api.reorganizeCatalogFromCache(pid, id));
  assert.equal(f.state.catalog.result_json.model, "old");
  assert.equal(f.state.ledger.get(id).state, "failed");
  await assert.rejects(f.api.reorganizeCatalogFromCache(pid, id), /不会重复请求/);
  assert.equal(f.state.modelCalls, 1);
});

test("a durable result survives DB publication failure and replay publishes without another model request", async t => {
  const f = await load(t); const id = randomUUID(); f.state.failPublish = true;
  await assert.rejects(f.api.reorganizeCatalogFromCache(pid, id));
  assert.equal(f.state.catalog.result_json.model, "old");
  assert.equal(f.state.ledger.get(id).state, "requested");
  f.state.failPublish = false;
  await f.api.reorganizeCatalogFromCache(pid, id);
  assert.equal(f.state.catalog.result_json.model, "new");
  assert.equal(f.state.modelCalls, 1);
});

test("missing raw source, active original task and uncertain prior reorganization cannot trigger paid work", async t => {
  const f = await load(t);
  f.state.rawPresent = false;
  await assert.rejects(f.api.reorganizeCatalogFromCache(pid, randomUUID()), /不会调用出海匠/);
  f.state.rawPresent = true; f.state.catalog.analysis_state = "requested";
  await assert.rejects(f.api.reorganizeCatalogFromCache(pid, randomUUID()), /仍在进行/);
  f.state.catalog.analysis_state = "ready";
  const pending = randomUUID(); f.state.ledger.set(pending, { pid, id: pending, state: "requested" });
  await assert.rejects(f.api.reorganizeCatalogFromCache(pid, randomUUID()), /未确认完成/);
  assert.equal(f.state.modelCalls, 0);
});

test("cross-PID request ids and a cross-process lock reject before any model request", async t => {
  const f = await load(t); const id = randomUUID();
  f.state.ledger.set(id, { id, pid: "999999", state: "ready" });
  await assert.rejects(f.api.reorganizeCatalogFromCache(pid, id), /PID不一致/);
  f.state.locked = true;
  await assert.rejects(f.api.reorganizeCatalogFromCache(pid, randomUUID()), /已有重新整理任务/);
  assert.equal(f.state.modelCalls, 0);
});
