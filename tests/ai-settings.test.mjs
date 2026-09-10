import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const url = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('import "server-only";', "");
const typesUrl = url(compile(await readFile(new URL("../lib/ai/types.ts", import.meta.url), "utf8")));
const { validateAiSettings, validateAiBaseUrl } = await import(typesUrl);
const fixture = (purpose = "product") => ({ purpose, provider: "qwen", model: purpose === "product" ? "qwen3.7-plus" : purpose === "video" ? "qwen3.5-omni-plus" : "qwen-plus", credentialSource: "shared", baseUrl: "", retries: purpose === "video" ? 1 : 0, videoAudioConfirmed: purpose === "video" });

async function load(t) {
  let stored;
  let outage = false;
  const legacy = { product_doc: "qwen3.5-omni-plus", translation: "qwen-plus" };
  const shared = { apiKey: "shared-fixture", baseUrl: "https://workspace.example/v1", model: "legacy-video-model", enabled: true };
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    execute: async (sql, params) => {
      if (outage) throw Error("database unavailable");
      if (sql.startsWith("SELECT")) return [stored ? [structuredClone(stored)] : []];
      if (sql.startsWith("INSERT")) { stored = { config_json: JSON.parse(params[1]), encrypted_api_key: params[2] }; return [{ affectedRows: 1 }]; }
      throw Error("Unexpected SQL");
    },
  };
  const hook = "aiSettings" + Math.random();
  globalThis[hook] = {
    getPool: async () => ({ execute: connection.execute, getConnection: async () => connection }),
    getProviderConfig: async () => shared,
    getQwenPurposeModel: async purpose => legacy[purpose],
    encryptSecret: text => "ENCRYPTED:" + text, decryptSecret: text => text?.replace(/^ENCRYPTED:/, "") || "",
  };
  t.after(() => { delete globalThis[hook]; });
  const stub = url(Object.keys(globalThis[hook]).map(name => `export const ${name} = (...args) => globalThis[${JSON.stringify(hook)}][${JSON.stringify(name)}](...args);`).join("\n"));
  const code = compile(await readFile(new URL("../lib/ai/settings.ts", import.meta.url), "utf8"))
    .replaceAll('"./types"', JSON.stringify(typesUrl)).replaceAll(/"@\/lib\/[^\"]+"/g, JSON.stringify(stub));
  return { api: await import(url(code)), shared, legacy, stored: () => stored, outage: () => { outage = true; } };
}

test("three purposes enforce retry limits and full-video audio capability without fallback", () => {
  for (const purpose of ["product", "video", "translation"]) assert.equal(validateAiSettings(fixture(purpose)).purpose, purpose);
  for (const retries of [-1, 2, NaN, "1"]) assert.throws(() => validateAiSettings({ ...fixture(), retries }));
  assert.throws(() => validateAiSettings({ ...fixture("video"), model: "qwen3.7-plus" }), /原音轨/);
  assert.throws(() => validateAiSettings({ ...fixture("video"), provider: "openai" }), /完整MP4/);
  assert.throws(() => validateAiSettings({ ...fixture("video"), videoAudioConfirmed: false }));
  assert.equal(validateAiSettings({ ...fixture("video"), model: "future-model" }).model, "future-model");
  assert.throws(() => validateAiSettings({ ...fixture(), provider: "compatible" }), /单独/);
});

test("API root validation rejects credentials, local addresses and completion paths", () => {
  for (const address of ["http://example.com/v1", "https://user:secret@example.com/v1", "https://localhost/v1", "https://127.0.0.1/v1", "https://2130706433/v1", "https://[::1]/v1", "https://host.local/v1", "https://example.com/v1?key=secret", "https://example.com/v1/chat/completions"]) assert.throws(() => validateAiBaseUrl(address));
  assert.equal(validateAiBaseUrl("https://example.com/v1/"), "https://example.com/v1");
});

test("default product is Qwen, video and translation preserve independent legacy selections", async t => {
  const f = await load(t);
  assert.equal((await f.api.requireAiRuntime("product")).model, "qwen3.7-plus");
  assert.equal((await f.api.requireAiRuntime("video")).model, "qwen3.5-omni-plus");
  assert.equal((await f.api.requireAiRuntime("translation")).model, "qwen-plus");
  f.legacy.product_doc = "qwen3.7-plus";
  await assert.rejects(f.api.requireAiRuntime("video"), /原音轨/);
});

test("explicit purpose settings win over a legacy environment override", async t => {
  const f = await load(t);
  const before = process.env.QWEN_VIDEO_MODEL;
  t.after(() => { if (before === undefined) delete process.env.QWEN_VIDEO_MODEL; else process.env.QWEN_VIDEO_MODEL = before; });
  process.env.QWEN_VIDEO_MODEL = "legacy-env-model";
  await f.api.saveAiSettings({ ...fixture("video"), model: "explicit-model" }, {});
  const runtime = await f.api.requireAiRuntime("video");
  assert.equal(runtime.model, "explicit-model");
  assert.equal(runtime.apiKey, "shared-fixture");
});

test("custom credentials are encrypted, masked, independent of disabled shared provider and retained on blank save", async t => {
  const f = await load(t);
  const config = { ...fixture(), credentialSource: "custom", baseUrl: "https://independent.example/v1" };
  await f.api.saveAiSettings(config, { apiKey: "private-fixture" });
  assert.equal(f.stored().encrypted_api_key, "ENCRYPTED:private-fixture");
  assert.doesNotMatch(JSON.stringify(await f.api.getAiSettings("product")), /private-fixture|ENCRYPTED/);
  f.shared.enabled = false;
  assert.equal((await f.api.requireAiRuntime("product")).apiKey, "private-fixture");
  await f.api.saveAiSettings({ ...config, model: "new-model" }, {});
  assert.equal((await f.api.requireAiRuntime("product")).apiKey, "private-fixture");
  await assert.rejects(f.api.saveAiSettings({ ...config, baseUrl: "https://different.example/v1" }, {}), /重新填写/);
  assert.equal((await f.api.requireAiRuntime("product")).baseUrl, config.baseUrl);
  await f.api.saveAiSettings(config, { clearKey: true });
  await assert.rejects(f.api.requireAiRuntime("product"), /独立密钥/);
});

test("database failure cannot silently choose a new model or credential source", async t => {
  const f = await load(t); f.outage();
  await assert.rejects(f.api.requireAiRuntime("product"), /database unavailable/);
});
