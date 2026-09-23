import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const source = file => readFile(new URL(`../lib/products/${file}.ts`, import.meta.url), "utf8");
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('import "server-only";', "");
const typesUrl = dataUrl(compile(await source("catalog-types")));
const types = await import(typesUrl);
const fixturePid = "1732350695360139845";
const result = pid => ({ pid, fields: Object.fromEntries(Object.keys(types.catalogFields).map(key => [key, { text: key, basis: "direct", evidence: ["product-text"] }])), warnings: [], model: "test", createdAt: "t" });
const networkUrl = dataUrl("export const fetchWithProxy = (...args) => globalThis.__catalogFetch(...args);");
const settingsUrl = dataUrl('export const requireAiRuntime = async () => globalThis.__catalogRuntime || ({ provider: "openai", apiKey: "fixture", model: "fixture-model", baseUrl: "https://api.openai.com/v1", retries: 0 });');
const envSnapshots = new WeakMap();
function env(t, key, value) {
  if (!envSnapshots.has(t)) {
    const snapshot = new Map(); envSnapshots.set(t, snapshot);
    t.after(() => { for (const [name, old] of snapshot) { if (old === undefined) delete process.env[name]; else process.env[name] = old; } });
  }
  const snapshot = envSnapshots.get(t);
  if (!snapshot.has(key)) snapshot.set(key, process.env[key]);
  process.env[key] = value;
}

async function modules(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "catalog-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let code = compile(await source("catalog-source"))
    .replace('process.cwd()', JSON.stringify(directory))
    .replaceAll('"@/lib/products/catalog-types"', JSON.stringify(typesUrl))
    .replaceAll('"@/lib/network"', JSON.stringify(networkUrl));
  const sourceUrl = dataUrl(code);
  const file = await import(sourceUrl);
  code = compile(await source("catalog-analyzer"))
    .replaceAll('"@/lib/products/catalog-types"', JSON.stringify(typesUrl))
    .replaceAll('"@/lib/products/catalog-source"', JSON.stringify(sourceUrl))
    .replaceAll('"@/lib/ai/settings"', JSON.stringify(settingsUrl))
    .replaceAll('"@/lib/network"', JSON.stringify(networkUrl));
  globalThis.__catalogFetch = () => { throw Error("UNEXPECTED_NETWORK_ACCESS"); };
  t.after(() => { delete globalThis.__catalogFetch; delete globalThis.__catalogRuntime; });
  return { file, analyzer: await import(dataUrl(code)) };
}

test("PID identity is exact, textual and unambiguous; no URL/name guesses", () => {
  for (const pid of ["../123456", "123", "1e18", "123456?x", "１２３４５６"]) assert.throws(() => types.validatePid(pid));
  for (const items of [[], [{ product_id: 1732350695360139845 }], [{ product_id: fixturePid, id: "other" }], [{ product_id: fixturePid }, { product_id: fixturePid }]]) {
    assert.throws(() => types.exactProduct({ data: { items } }, fixturePid));
  }
  assert.equal(types.exactProduct({ data: { items: [{ product_id: fixturePid }] } }, fixturePid).product_id, fixturePid);
});

test("provider timeout retains a durable marker and never makes a second detail request", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "isolated-test-key");
  const { file } = await modules(t);
  let calls = 0;
  globalThis.__catalogFetch = async () => { calls++; throw Error("network secret https://private.invalid"); };
  await assert.rejects(file.fetchProductOnce(fixturePid));
  await assert.rejects(file.fetchProductOnce(fixturePid), /已请求过/);
  assert.equal(calls, 1);
  assert.doesNotMatch(types.catalogError(Error("secret https://private.invalid")), /secret|https/);
});

test("successful response is durable, exact-PID checked, and reused without credentials", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "isolated-test-key");
  const { file } = await modules(t);
  const raw = { data: { items: [{ product_id: fixturePid, product_name: "Travel dispenser" }] } };
  let calls = 0;
  globalThis.__catalogFetch = async (url, init) => {
    calls++;
    assert.equal(url, `https://openapi.gateway.chuhaijiang.com/open/v1/products/${fixturePid}?country=us&include=channel,core`);
    assert.equal(init.redirect, "error");
    return Response.json(raw);
  };
  await file.fetchProductOnce(fixturePid);
  env(t, "CHUHAIJIANG_API_KEY", "");
  assert.deepEqual(await file.fetchProductOnce(fixturePid), raw.data.items[0]);
  assert.equal(calls, 1);
});

test("HTTP failure and mismatched PID are not billed again", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "isolated-test-key");
  const { file } = await modules(t);
  let calls = 0;
  globalThis.__catalogFetch = async () => { calls++; return Response.json({ data: { items: [{ product_id: "999999" }] } }); };
  await assert.rejects(file.fetchProductOnce(fixturePid), /PID/);
  await assert.rejects(file.fetchProductOnce(fixturePid), /PID/);
  globalThis.__catalogFetch = async () => { calls++; return new Response("no", { status: 429 }); };
  await assert.rejects(file.fetchProductOnce("123456"), /HTTP 429/);
  await assert.rejects(file.fetchProductOnce("123456"), /校验失败/);
  assert.equal(calls, 2);
});

test("main product images are read by bytes even with octet-stream MIME, then reused without SKU downloads", async t => {
  const { file } = await modules(t);
  const bytes = Buffer.from("RIFF1234WEBPpayload");
  const item = { product_name: "四合一分装瓶", product_specifications: [{ name: "Function", value: "Shampoo, Body Wash" }],
    product_images: [{ url: "https://oss-t.chuhaijiang.com/a?signature=secret" }],
    product_sku_props: [{ prop_name: "颜色", sale_prop_values: [{ prop_value: "白", image: { url: "https://oss-t.chuhaijiang.com/b?signature=secret" } }] }] };
  let calls = 0;
  globalThis.__catalogFetch = async () => { calls++; return new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }); };
  const evidence = await file.prepareCatalogEvidence(fixturePid, item);
  assert.equal(evidence.images.length, 1);
  assert.ok(evidence.warnings.some(warning => warning.includes("SKU图未送入模型")));
  assert.match(evidence.images[0].dataUrl, /^data:image\/webp;base64,/);
  assert.match(evidence.text, /Shampoo/);
  assert.doesNotMatch(evidence.text, /signature|https|secret/);
  await file.prepareCatalogEvidence(fixturePid, item);
  assert.equal(calls, 1);
});

test("Qwen receives at most eight main product images and no SKU images", async t => {
  const { file } = await modules(t);
  const url = index => `https://oss-t.chuhaijiang.com/${index}`;
  const item = {
    product_name: "Many-image product",
    product_images: Array.from({ length: 12 }, (_, index) => ({ url: url(`product-${index + 1}`) })),
    product_sku_props: [{ prop_name: "颜色", sale_prop_values: Array.from({ length: 12 }, (_, index) => ({
      prop_value: `SKU-${index + 1}`, image: { url: url(`sku-${index + 1}`) },
    })) }],
  };
  const requested = [];
  globalThis.__catalogFetch = async requestedUrl => {
    requested.push(requestedUrl);
    return new Response(Buffer.from("RIFF1234WEBPpayload"));
  };
  const evidence = await file.prepareCatalogEvidence(fixturePid, item);
  assert.equal(evidence.images.length, 8);
  assert.deepEqual(evidence.images.map(image => image.label), [
    "商品图1", "商品图2", "商品图3", "商品图4", "商品图5", "商品图6", "商品图7", "商品图8",
  ]);
  assert.equal(requested.length, 8);
  assert.ok(evidence.warnings.some(warning => warning.includes("共24张") && warning.includes("SKU图未送入模型")));
});

test("SKU-only products send no image to Qwen", async t => {
  const { file } = await modules(t);
  const productOnly = file.imageCandidates({
    product_images: Array.from({ length: 10 }, (_, index) => ({ url: `https://oss-t.chuhaijiang.com/${index}` })),
  });
  assert.deepEqual(file.selectCatalogImages(productOnly).map(candidate => candidate.label),
    Array.from({ length: 8 }, (_, index) => `商品图${index + 1}`));
  const skuOnly = file.imageCandidates({ product_sku_props: [{ sale_prop_values: Array.from({ length: 10 }, (_, index) => ({
    prop_value: `SKU-${index + 1}`, image: { url: `https://oss-t.chuhaijiang.com/${index}` },
  })) }] });
  assert.deepEqual(file.selectCatalogImages(skuOnly), []);
});

test("untrusted image hosts never receive a request, and partial missing images do not block text", async t => {
  const { file } = await modules(t);
  for (const url of ["http://oss-t.chuhaijiang.com/a", "https://127.0.0.1/a", "https://user@oss-t.chuhaijiang.com/a", "https://oss-t.chuhaijiang.com.evil.test/a"]) {
    const evidence = await file.prepareCatalogEvidence(fixturePid, { product_name: "Bottle", product_images: [{ url }] });
    assert.equal(evidence.images.length, 0);
    assert.ok(evidence.warnings.some(w => w.includes("无法获取图片信息")));
    assert.match(evidence.text, /Bottle/);
  }
});

test("each field is independently grounded, inference is labelled, invalid claims do not erase valid ones", async t => {
  const { analyzer } = await modules(t);
  const input = { pid: fixturePid, text: "travel bottle", images: [], warnings: [] };
  const raw = result(fixturePid);
  raw.fields.audience.basis = "inference";
  raw.fields.usageMethod.evidence = ["made-up-image"];
  const out = analyzer.validateCatalogResult(raw, input, "test");
  assert.equal(out.fields.coreFunctions.basis, "direct");
  assert.match(out.fields.audience.text, /^推断：/);
  assert.equal(out.fields.usageMethod.text, "未找到");
  assert.throws(() => analyzer.validateCatalogResult(result("999999"), input, "test"), /PID/);
});

test("Qwen's single-product array and labelled references are normalized without weakening PID checks", async t => {
  const { analyzer } = await modules(t);
  const input = { pid: fixturePid, images: [{ id: "image-1" }], warnings: [] };
  const raw = result(fixturePid);
  raw.fields.coreFunctions.evidence = ["image-1: supplier caption", "product-sku: unknown"];
  const out = analyzer.validateCatalogResult([raw], input, "qwen3.7-plus");
  assert.equal(Object.values(out.fields).filter(f => f.basis !== "missing").length, 6);
  assert.deepEqual(out.fields.coreFunctions.evidence, ["image-1"]);
  assert.equal(out.fields.coreFunctions.text, raw.fields.coreFunctions.text);
  assert.ok(out.warnings.some(w => w.includes("未知来源")));
  for (const value of [[], [raw, raw], [[raw]], { ...raw, pid: Number(fixturePid) }, { ...raw, pid: "123456" }]) {
    assert.throws(() => analyzer.validateCatalogResult(value, input, "fixture"));
  }
  raw.fields.coreFunctions.evidence = ["image-99: nonexistent"];
  raw.fields.usageMethod.basis = "inference";
  const unsafe = analyzer.validateCatalogResult(raw, input, "fixture");
  assert.equal(unsafe.fields.coreFunctions.basis, "missing");
  assert.equal(unsafe.fields.usageMethod.basis, "missing");
});

test("Qwen product request uses selected endpoint/model, exact schema enum and all actual images", async t => {
  const { analyzer, file } = await modules(t);
  globalThis.__catalogRuntime = { provider: "qwen", apiKey: "fixture-qwen", model: "qwen3.7-plus", baseUrl: "https://qwen.example/v1", retries: 0 };
  const input = { pid: fixturePid, text: "supplier description", images: [{ id: "image-1", label: "SKU", dataUrl: "data:image/webp;base64,AAAA" }], warnings: [] };
  let calls = 0;
  globalThis.__catalogFetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://qwen.example/v1/chat/completions");
    assert.equal(init.headers.Authorization, "Bearer fixture-qwen");
    const request = JSON.parse(init.body);
    assert.equal(request.model, "qwen3.7-plus");
    assert.equal(request.enable_thinking, false);
    assert.equal(request.response_format.json_schema.strict, true);
    assert.deepEqual(request.response_format.json_schema.schema.properties.pid.enum, [fixturePid]);
    assert.deepEqual(request.response_format.json_schema.schema.properties.fields.properties.coreFunctions.properties.evidence.items.enum, ["product-text", "image-1"]);
    assert.equal(request.messages[1].content.find(c => c.type === "image_url").image_url.url, input.images[0].dataUrl);
    assert.match(request.messages[0].content, /整机、外壳、内部容器、配件或包装/);
    assert.match(request.messages[0].content, /对应字段正文紧邻/);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify([result(fixturePid)]) } }] });
  };
  assert.equal((await analyzer.analyzeCatalog(input)).model, "qwen3.7-plus");
  assert.ok(await file.readPrivateJson(path.join(file.catalogDirectory(fixturePid), "model-response-1.json")));
  await assert.rejects(analyzer.analyzeCatalog(input), /已提交过/);
  assert.equal(calls, 1);
});

test("failed product parsing preserves raw output before validation and never auto-recalls", async t => {
  const { analyzer, file } = await modules(t);
  globalThis.__catalogRuntime = { provider: "qwen", apiKey: "fixture", model: "configured-model", baseUrl: "https://qwen.example/v1", retries: 0 };
  let calls = 0;
  globalThis.__catalogFetch = async () => { calls++; return Response.json({ choices: [{ finish_reason: "stop", message: { content: "not JSON" } }] }); };
  const input = { pid: fixturePid, text: "", images: [], warnings: [] };
  await assert.rejects(analyzer.analyzeCatalog(input), /正文不是合法JSON/);
  assert.ok(await file.readPrivateJson(path.join(file.catalogDirectory(fixturePid), "model-response-1.json")));
  await assert.rejects(analyzer.analyzeCatalog(input), /已提交过/);
  assert.equal(calls, 1);
});

test("configured product retry stays on the same provider and stops after two HTTP failures", async t => {
  const { analyzer } = await modules(t);
  globalThis.__catalogRuntime = { provider: "qwen", apiKey: "fixture", model: "configured-model", baseUrl: "https://qwen.example/v1", retries: 1 };
  let calls = 0;
  globalThis.__catalogFetch = async url => { assert.equal(url, "https://qwen.example/v1/chat/completions"); calls++; return new Response("secret provider error", { status: 503 }); };
  await assert.rejects(analyzer.analyzeCatalog({ pid: fixturePid, text: "", images: [], warnings: [] }), error => {
    assert.match(error.message, /已请求2次/); assert.doesNotMatch(error.message, /secret/); return true;
  });
  assert.equal(calls, 2);
});

test("manual evidence preparation never downloads absent images or changes the original manifest", async t => {
  const { file } = await modules(t);
  const directory = file.catalogDirectory(fixturePid);
  await file.savePrivate(path.join(directory, "image-manifest.json"), JSON.stringify([{ label: "kept", failed: true }]));
  const before = await readFile(path.join(directory, "image-manifest.json"), "utf8");
  const evidence = await file.prepareCatalogEvidence(fixturePid, { product_name: "Bottle", product_images: [{ url: "https://oss-t.chuhaijiang.com/not-cached" }] }, { cacheOnly: true });
  assert.equal(evidence.images.length, 0);
  assert.match(evidence.text, /Bottle/);
  assert.equal(await readFile(path.join(directory, "image-manifest.json"), "utf8"), before);
});

test("OpenAI gets actual image bytes plus supplier text, strict structured output, and no automatic retry", async t => {
  env(t, "OPENAI_API_KEY", "isolated-test-key");
  const { analyzer } = await modules(t);
  let calls = 0;
  globalThis.__catalogFetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/responses");
    const payload = JSON.parse(init.body);
    assert.equal(payload.store, false);
    assert.equal(payload.text.format.strict, true);
    assert.equal(payload.input[0].content.filter(c => c.type === "input_image").length, 2);
    assert.equal(payload.input[0].content.filter(c => c.type === "input_image")[0].image_url, "data:image/webp;base64,AAAA");
    return Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(result(fixturePid)) }] }] });
  };
  const input = { pid: fixturePid, text: "Shampoo", images: [1, 2].map(i => ({ id: `image-${i}`, label: "SKU", dataUrl: "data:image/webp;base64,AAAA" })), warnings: [] };
  const out = await analyzer.analyzeCatalog(input);
  assert.equal(out.pid, fixturePid);
  await assert.rejects(analyzer.analyzeCatalog(input), /已提交过/);
  assert.equal(calls, 1);
});

async function service(t, initial = null) {
  const key = `catalogState${Math.random()}`;
  let row = initial;
  let paid = 0, ai = 0;
  const disk = new Map();
  const hooks = {
    readCatalog: async () => row && structuredClone(row),
    claimCatalog: async pid => { if (row) return false; row = { pid, fetch_state: "requested", analysis_state: "waiting" }; return true; },
    claimCatalogCreditRetry: async (_pid, updatedAt) => {
      if (row.fetch_state !== "failed" || row.analysis_state !== "waiting" || row.result_json || row.updated_at !== updatedAt) return false;
      row.fetch_state = "requested"; return true;
    },
    markCatalogFetched: async () => { row.fetch_state = "ready"; },
    claimCatalogAnalysis: async () => { if (row.analysis_state !== "waiting") return false; row.analysis_state = "requested"; return true; },
    finishCatalogAnalysis: async (_pid, value) => { row.analysis_state = "ready"; row.result_json = value; },
    failCatalog: async (_pid, stage, error) => { row[`${stage}_state`] = "failed"; row.error_message = error; },
    cachedProduct: async () => disk.get("raw") || null,
    readCreditRejection: async () => null,
    archiveCreditRejection: async () => { throw Error("UNEXPECTED_RETRY"); },
    fetchProductOnce: async pid => { paid++; const item = { product_id: pid, product_name: "Supplier bottle" }; disk.set("raw", item); return item; },
    prepareCatalogEvidence: async pid => ({ pid }),
    analyzeCatalog: async input => { ai++; return result(input.pid); },
    catalogDirectory: pid => `/isolated/${pid}`,
    readPrivateJson: async file => disk.get(file) || null,
    savePrivate: async (file, text) => { disk.set(file, JSON.parse(text)); },
  };
  globalThis[key] = hooks;
  t.after(() => { delete globalThis[key]; });
  const stub = dataUrl(Object.keys(hooks).map(name => `export const ${name} = (...a) => globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}](...a);`).join("\n"));
  const code = compile(await source("catalog"))
    .replaceAll('"@/lib/ai/settings"', JSON.stringify(settingsUrl))
    .replaceAll('"@/lib/products/catalog-types"', JSON.stringify(typesUrl))
    .replace(/"@\/lib\/products\/catalog-(?:store|source|analyzer)"/g, JSON.stringify(stub));
  const load = suffix => import(dataUrl(`${code}\n// ${suffix}`));
  return { api: await load("first"), restart: () => load("restart"), hooks, disk, counts: () => ({ paid, ai }), row: () => row };
}

test("twenty simultaneous clicks plus restart organize exactly once and reuse globally by PID", async t => {
  env(t, "OPENAI_API_KEY", "test"); env(t, "CHUHAIJIANG_API_KEY", "test");
  const f = await service(t);
  const out = await Promise.all(Array.from({ length: 20 }, () => f.api.getProductCatalog(fixturePid)));
  assert.equal(out.length, 20);
  await (await f.restart()).getProductCatalog(fixturePid);
  assert.deepEqual(f.counts(), { paid: 1, ai: 1 });
});

test("PID-only name retrieval charges once, skips AI, and shares the source with later catalog analysis", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "test");
  const f = await service(t);
  assert.equal(await f.api.getProductNameByPid(fixturePid), "Supplier bottle");
  assert.deepEqual(f.counts(), { paid: 1, ai: 0 });
  assert.equal(f.row().fetch_state, "ready");
  assert.equal(f.row().analysis_state, "waiting");
  await f.api.getProductCatalog(fixturePid);
  const restarted = await f.restart();
  assert.equal(await restarted.getProductNameByPid(fixturePid), "Supplier bottle");
  await restarted.getProductCatalog(fixturePid);
  assert.deepEqual(f.counts(), { paid: 1, ai: 1 });
});

test("concurrent name-only and full catalog lookups share one fetch in either order", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "test");
  for (const nameFirst of [true, false]) {
    const f = await service(t);
    const tasks = Array.from({ length: 20 }, (_, i) => (i % 2 === 0) === nameFirst
      ? f.api.getProductNameByPid(fixturePid) : f.api.getProductCatalog(fixturePid));
    await Promise.all(tasks);
    assert.deepEqual(f.counts(), { paid: 1, ai: 1 });
  }
});

test("verified cached names need no API credentials and do not depend on AI success", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "");
  const f = await service(t, { pid: fixturePid, fetch_state: "ready", analysis_state: "failed", error_message: "AI unavailable" });
  for (const item of [
    { product_name: "  原始商品名\n 商品型号  ", product_title: "备用名称" },
    { product_name: " ", product_title: " 原始商品名 商品型号 " },
    { product_name: { title: "不接受对象" }, product_title: "原始商品名 商品型号" },
  ]) {
    f.disk.set("raw", { product_id: fixturePid, ...item });
    assert.equal(await f.api.getProductNameByPid(fixturePid), "原始商品名 商品型号");
  }
  assert.deepEqual(f.counts(), { paid: 0, ai: 0 });
  assert.equal(f.row().analysis_state, "failed");
});

test("missing provider titles are not guessed or refetched, including after restart", async t => {
  const f = await service(t);
  f.disk.set("raw", { product_id: fixturePid, product_name: " ", product_title: 123, name: "Unverified", related: { product_name: "Another product" } });
  await assert.rejects(f.api.getProductNameByPid(fixturePid), /补填产品名称/);
  await assert.rejects((await f.restart()).getProductNameByPid(fixturePid), /补填产品名称/);
  assert.deepEqual(f.counts(), { paid: 0, ai: 0 });
});

test("name lookup does not repeat a persisted or uncertain source request", async t => {
  for (const state of ["requested", "ready", "failed"]) {
    const f = await service(t, { pid: fixturePid, fetch_state: state, analysis_state: "waiting", error_message: "此前取数失败" });
    await assert.rejects(f.api.getProductNameByPid(fixturePid));
    await assert.rejects((await f.restart()).getProductNameByPid(fixturePid));
    assert.deepEqual(f.counts(), { paid: 0, ai: 0 });
  }
});

test("missing credentials or invalid PID cannot consume the source claim", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "");
  const f = await service(t);
  assert.throws(() => f.api.getProductNameByPid("../../invalid"), /PID/);
  await assert.rejects(f.api.getProductNameByPid(fixturePid), /未配置/);
  assert.equal(f.row(), null);
  assert.deepEqual(f.counts(), { paid: 0, ai: 0 });
});

test("source failure during name lookup remains failed and cannot charge again", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "test");
  const f = await service(t);
  let calls = 0;
  f.hooks.fetchProductOnce = async () => { calls++; throw Error("private provider error"); };
  await assert.rejects(f.api.getProductNameByPid(fixturePid));
  assert.equal(f.row().fetch_state, "failed");
  assert.doesNotMatch(f.row().error_message, /private provider/);
  await assert.rejects((await f.restart()).getProductNameByPid(fixturePid));
  assert.equal(calls, 1);
});

test("another process winning the DB claim blocks a second name fetch", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "test");
  const f = await service(t);
  f.hooks.claimCatalog = async () => false;
  await assert.rejects(f.api.getProductNameByPid(fixturePid), /取数已开始/);
  assert.deepEqual(f.counts(), { paid: 0, ai: 0 });
});

test("corrupted raw cache never falls back to a new paid name request", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "test");
  const f = await service(t);
  f.hooks.cachedProduct = async () => { throw new types.CatalogError("商品缓存校验失败"); };
  await assert.rejects(f.api.getProductNameByPid(fixturePid), /校验失败/);
  assert.deepEqual(f.counts(), { paid: 0, ai: 0 });
});

test("name and catalog share the real checksummed disk response and durable request marker", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "isolated-test-key");
  const { file } = await modules(t);
  const f = await service(t);
  for (const name of ["cachedProduct", "fetchProductOnce", "catalogDirectory", "readPrivateJson", "savePrivate"])
    f.hooks[name] = file[name];
  let requests = 0;
  globalThis.__catalogFetch = async () => {
    requests++;
    return Response.json({ data: { items: [{ product_id: fixturePid, product_name: "Real cached title" }] } });
  };
  assert.equal(await f.api.getProductNameByPid(fixturePid), "Real cached title");
  assert.ok(await file.readPrivateJson(path.join(file.catalogDirectory(fixturePid), "request-started.json")));
  await f.api.getProductCatalog(fixturePid);
  env(t, "CHUHAIJIANG_API_KEY", "");
  assert.equal(await (await f.restart()).getProductNameByPid(fixturePid), "Real cached title");
  assert.equal(requests, 1);
  assert.equal(f.counts().ai, 1);
});

test("failed or uncertain persisted requests never retry after restart", async t => {
  const f = await service(t, { pid: fixturePid, fetch_state: "requested", analysis_state: "waiting" });
  await assert.rejects(f.api.getProductCatalog(fixturePid), /取数已开始/);
  await assert.rejects((await f.restart()).getProductCatalog(fixturePid));
  assert.deepEqual(f.counts(), { paid: 0, ai: 0 });
});

test("a persisted insufficient-credit rejection retries on the next click, preserves evidence, and then reuses paid data", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "isolated-test-key");
  for (const nameOnly of [false, true]) {
    const { file } = await modules(t);
    const f = await service(t);
    for (const name of ["cachedProduct", "fetchProductOnce", "catalogDirectory", "readPrivateJson", "savePrivate", "readCreditRejection", "archiveCreditRejection"])
      f.hooks[name] = file[name];
    let calls = 0;
    globalThis.__catalogFetch = async () => {
      calls++;
      if (calls === 1) return Response.json({ code: nameOnly ? "INSUFFICIENT_BALANCE" : "INSUFFICIENT_CREDITS", message: "private provider details" }, { status: 402 });
      return Response.json({ data: { items: [{ product_id: fixturePid, product_name: "Recovered product" }] } });
    };
    const invoke = api => nameOnly ? api.getProductNameByPid(fixturePid) : api.getProductCatalog(fixturePid);
    await assert.rejects(invoke(f.api), /余额不足.*充值后/);
    assert.equal(calls, 1);
    assert.equal(f.row().fetch_state, "failed");
    assert.doesNotMatch(f.row().error_message, /private/);
    const restarted = await f.restart();
    await Promise.all(Array.from({ length: 20 }, () => invoke(restarted)));
    await restarted.getProductCatalog(fixturePid);
    assert.equal(calls, 2);
    assert.equal(f.counts().ai, 1);
    const { readdir } = await import("node:fs/promises");
    const archive = path.join(path.dirname(file.catalogDirectory(fixturePid)), "credit-rejections");
    const attempts = await readdir(archive);
    assert.equal(attempts.length, 1);
    const receipt = await file.readPrivateJson(path.join(archive, attempts[0], "receipt.json"));
    assert.equal(receipt.httpStatus, 402);
    assert.ok(await file.readPrivateJson(path.join(archive, attempts[0], "request-started.json")));
  }
});

test("credit recovery rejects unrelated 402 errors, corrupt evidence and attempts with AI results", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "isolated-test-key");
  const { file } = await modules(t);
  let calls = 0;
  globalThis.__catalogFetch = async () => { calls++; return Response.json({ code: "OTHER_BILLING_ERROR" }, { status: 402 }); };
  await assert.rejects(file.fetchProductOnce(fixturePid), /HTTP 402/);
  assert.equal(await file.readCreditRejection(fixturePid), null);
  globalThis.__catalogFetch = async () => { calls++; return Response.json({ code: "INSUFFICIENT_CREDITS" }, { status: 402 }); };
  const pid = "123456";
  await assert.rejects(file.fetchProductOnce(pid), /余额不足/);
  const proof = await file.readCreditRejection(pid);
  assert.ok(proof);
  await file.savePrivate(path.join(file.catalogDirectory(pid), "response.json"), '{"code":"CHANGED"}');
  assert.equal(await file.readCreditRejection(pid), null);
  await assert.rejects(file.archiveCreditRejection(pid, proof), /记录已变化/);
  const other = "123457";
  await assert.rejects(file.fetchProductOnce(other), /余额不足/);
  await file.savePrivate(path.join(file.catalogDirectory(other), "analysis-started.json"), '{}');
  assert.equal(await file.readCreditRejection(other), null);
  assert.equal(calls, 3);
});

test("losing a concurrent credit retry claim cannot archive evidence or call the provider", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "test");
  const f = await service(t, { pid: fixturePid, fetch_state: "failed", analysis_state: "waiting", updated_at: "old", error_message: "HTTP 402" });
  f.hooks.readCreditRejection = async () => "verified-proof";
  f.hooks.claimCatalogCreditRetry = async () => false;
  await assert.rejects(f.api.getProductNameByPid(fixturePid), /已开始重试/);
  await assert.rejects(f.api.getProductCatalog(fixturePid), /已开始重试/);
  assert.deepEqual(f.counts(), { paid: 0, ai: 0 });
});

test("an empty balance never creates a retry loop and a later uncertain retry stays blocked", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "test");
  const { file } = await modules(t);
  const f = await service(t);
  for (const name of ["cachedProduct", "fetchProductOnce", "catalogDirectory", "readPrivateJson", "savePrivate", "readCreditRejection", "archiveCreditRejection"])
    f.hooks[name] = file[name];
  let calls = 0;
  globalThis.__catalogFetch = async () => { calls++; return Response.json({ code: "INSUFFICIENT_CREDITS" }, { status: 402 }); };
  await assert.rejects(f.api.getProductCatalog(fixturePid), /余额不足/);
  assert.equal(calls, 1);
  await assert.rejects(f.api.getProductCatalog(fixturePid), /余额不足/);
  assert.equal(calls, 2);
  globalThis.__catalogFetch = async () => { calls++; throw Error("uncertain timeout"); };
  await assert.rejects(f.api.getProductCatalog(fixturePid));
  await assert.rejects((await f.restart()).getProductCatalog(fixturePid));
  assert.equal(calls, 3);
  assert.equal(f.counts().ai, 0);
});

test("provider and AI failures stop independently without repeated paid calls", async t => {
  env(t, "OPENAI_API_KEY", "test"); env(t, "CHUHAIJIANG_API_KEY", "test");
  const f = await service(t);
  let attempts = 0;
  f.hooks.analyzeCatalog = async () => { attempts++; throw Error("provider-secret"); };
  await assert.rejects(f.api.getProductCatalog(fixturePid));
  await assert.rejects((await f.restart()).getProductCatalog(fixturePid), /已保留缓存/);
  assert.equal(attempts, 1);
  assert.equal(f.counts().paid, 1);
  assert.equal(f.row().analysis_state, "failed");
  assert.ok(f.disk.get("raw"));
});

test("a previously paid trial imports raw data and an organized result without either API", async t => {
  env(t, "OPENAI_API_KEY", "test");
  const f = await service(t);
  f.disk.set("raw", { product_id: fixturePid });
  f.disk.set(`/isolated/${fixturePid}/organized.json`, result(fixturePid));
  await f.api.getProductCatalog(fixturePid);
  assert.deepEqual(f.counts(), { paid: 0, ai: 0 });
});

test("a DB failure after durable organization recovers without analyzing again", async t => {
  env(t, "OPENAI_API_KEY", "test"); env(t, "CHUHAIJIANG_API_KEY", "test");
  const f = await service(t);
  const finish = f.hooks.finishCatalogAnalysis;
  f.hooks.finishCatalogAnalysis = async () => { throw Error("DB offline"); };
  await assert.rejects(f.api.getProductCatalog(fixturePid));
  assert.equal(f.row().analysis_state, "requested");
  f.hooks.finishCatalogAnalysis = finish;
  await (await f.restart()).getProductCatalog(fixturePid);
  assert.deepEqual(f.counts(), { paid: 1, ai: 1 });
});
