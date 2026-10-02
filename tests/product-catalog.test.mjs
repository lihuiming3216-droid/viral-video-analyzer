import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
const tiktokProductUrl = dataUrl('export const tiktokProductUrlFromPid = pid => `https://www.tiktok.com/view/product/${pid}`;');
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

async function publicSource(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "public-product-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const code = compile(await source("tiktok-public-source"))
    .replace('process.cwd()', JSON.stringify(directory))
    .replaceAll('"@/lib/products/catalog-types"', JSON.stringify(typesUrl))
    .replaceAll('"@/lib/network"', JSON.stringify(networkUrl))
    .replaceAll('"@/lib/tiktok-product"', JSON.stringify(tiktokProductUrl));
  globalThis.__catalogFetch = () => { throw Error("UNEXPECTED_NETWORK_ACCESS"); };
  t.after(() => { delete globalThis.__catalogFetch; });
  return import(dataUrl(code));
}

function publicProductHtml(pid, options = {}) {
  const product = {
    product_id: pid,
    name: "Detail-image product",
    seller_id: "seller-1",
    images: [{ url_list: ["https://p16-oec-general-useast5.ttcdn-us.com/main.webp"] }],
    description: JSON.stringify([
      { text: "Use after washing." },
      { image: { url_list: ["https://p16-oec-general-useast5.ttcdn-us.com/detail-1.webp"] } },
      { image: { url_list: ["https://p16-oec-general-useast5.ttcdn-us.com/detail-2.webp"] } },
    ]),
    product_properties: [{ property_name: "Material", property_values: [{ property_value_name: "Silicone" }] }],
    skus: [{ sku_id: "sku-1", sku_name: "Blue", sku_image: { url_list: ["https://p16-oec-general-useast5.ttcdn-us.com/sku.webp"] } }],
    ...options,
  };
  return `<script id="__MODERN_ROUTER_DATA__" type="application/json">${JSON.stringify({ loaderData: { product_model: product, seller: { seller_id: "seller-1", shop_name: "Fixture Shop" } } })}</script>`;
}

test("public TikTok parser keeps main and SKU images as metadata but exposes only description detail images", async t => {
  const file = await publicSource(t);
  const product = file.parsePublicTikTokProductHtml(publicProductHtml(fixturePid), fixturePid);
  assert.equal(product.product_id, fixturePid);
  assert.equal(product.product_name, "Detail-image product");
  assert.equal(product.shop_name, "Fixture Shop");
  assert.deepEqual(product.product_images.map(image => image.url), ["https://p16-oec-general-useast5.ttcdn-us.com/main.webp"]);
  assert.deepEqual(product.product_detail_images.map(image => image.url), [
    "https://p16-oec-general-useast5.ttcdn-us.com/detail-1.webp",
    "https://p16-oec-general-useast5.ttcdn-us.com/detail-2.webp",
  ]);
  assert.doesNotMatch(JSON.stringify(product.product_detail_images), /main|sku/);
  assert.equal(product.product_skus[0].sku_name, "Blue");
});

test("public TikTok parser preserves plain and nested description text without treating image URLs as copy", async t => {
  const file = await publicSource(t);
  const descriptions = [
    "Standalone plain product copy",
    ["Plain product copy", "Second paragraph"],
    JSON.stringify(["JSON string item", { content: "Content field" }, { text_content: "Text content field" }]),
    { description: { textContent: "Nested description" }, image: { url_list: ["https://p16-oec-general-useast5.ttcdn-us.com/detail.webp"] } },
  ];
  for (const [index, description] of descriptions.entries()) {
    const product = file.parsePublicTikTokProductHtml(publicProductHtml(fixturePid, { description }), fixturePid);
    if (index === 0) assert.equal(product.product_description, "Standalone plain product copy");
    if (index === 1) assert.equal(product.product_description, "Plain product copy\nSecond paragraph");
    if (index === 2) assert.equal(product.product_description, "JSON string item\nContent field\nText content field");
    if (index === 3) {
      assert.equal(product.product_description, "Nested description");
      assert.deepEqual(product.product_detail_images.map(image => image.url), ["https://p16-oec-general-useast5.ttcdn-us.com/detail.webp"]);
      assert.doesNotMatch(product.product_description, /https?:\/\//);
    }
  }
});

test("public TikTok source verifies exact PID, caches one capture and never retries a recorded failure", async t => {
  const file = await publicSource(t);
  let calls = 0;
  globalThis.__catalogFetch = async () => {
    calls++;
    return new Response(publicProductHtml(fixturePid), { status: 200 });
  };
  assert.equal((await file.fetchPublicProductOnce(fixturePid)).product_id, fixturePid);
  assert.equal((await file.fetchPublicProductOnce(fixturePid)).product_id, fixturePid);
  assert.equal(calls, 1);

  const other = "1732350695360139846";
  globalThis.__catalogFetch = async () => { calls++; return new Response(publicProductHtml(fixturePid), { status: 200 }); };
  await assert.rejects(file.fetchPublicProductOnce(other), /PID/);
  await assert.rejects(file.fetchPublicProductOnce(other), /PID/);
  assert.equal(calls, 2);
});

function modernHtml(pid) {
  return `<script id="__MODERN_ROUTER_DATA__">${JSON.stringify({ loaderData: { page: {
    product: { product_model: { product_id: pid, seller_id: "seller-1" } },
    page_config: { components_map: { "3": { component_data: { product_info: {
      product_id: pid, seller_id: "seller-1", title: "OTG flash drive",
      images: [{ url_list: ["https://p16.ttcdn-us.com/main.webp"] }],
      desc_blocks: [
        { type: "text", text: "No additional app needed." },
        { type: "ul", content: ["Use File Management.", "Download cloud files first."] },
        { type: "image", image: { url_list: ["https://p16.ttcdn-us.com/detail.webp", "https://p19.ttcdn-us.com/detail.webp"] } },
      ],
      specifications: [{ name: "Material", value: "Metal" }],
      seller: { seller_id: "seller-1", name: "Exact shop" },
      skus: [{ sku_id: "sku-1", stock: 0, sku_sale_props: [{ prop_value: "128GB" }],
        price: { sale_price_decimal: "18.19", currency_name: "USD" } }],
    } } } } },
    recommendations: [{ product_id: "99999999", title: "Wrong product", desc_blocks: [] }],
  } } })}</script>`;
}

test("component product_info preserves description lists, detail-only images, SKU price and exact seller", async t => {
  const file = await publicSource(t);
  const product = file.parsePublicTikTokProductHtml(modernHtml(fixturePid), fixturePid);
  assert.equal(product.product_name, "OTG flash drive");
  assert.equal(product.product_description, "No additional app needed.\nUse File Management.\nDownload cloud files first.");
  assert.equal(product.shop_name, "Exact shop");
  assert.deepEqual(product.product_specifications, [{ name: "Material", value: "Metal" }]);
  assert.deepEqual(product.product_detail_images, [{ url: "https://p16.ttcdn-us.com/detail.webp" }]);
  assert.equal(product.product_skus[0].sku_name, "128GB");
  assert.equal(product.product_skus[0].available_quantity, 0);
  assert.equal(product.product_skus[0].price, "18.19");
  assert.equal(product.product_skus[0].currency, "USD");
  assert.throws(() => file.parsePublicTikTokProductHtml(modernHtml(fixturePid), "99999999"), /PID/);
  assert.throws(() => file.parsePublicTikTokProductHtml("<title>Security Check</title>", fixturePid), /安全验证/);
});

test("failed exact-PID saved pages recover with checksum and no repeated HTTP; corrupted pages stay blocked", async t => {
  const file = await publicSource(t);
  const dir = file.publicCatalogDirectory(fixturePid);
  await mkdir(dir, { recursive: true });
  const html = modernHtml(fixturePid);
  const receipt = JSON.stringify({ pid: fixturePid, source: "tiktok-public", state: "failed",
    responseSha256: createHash("sha256").update(html).digest("hex"), automaticRetries: 0 });
  await writeFile(path.join(dir, "response.html"), html);
  await writeFile(path.join(dir, "receipt.json"), receipt);
  await writeFile(path.join(dir, "request-started.json"), "{}");
  await file.recoverPublicProductFromSavedPage(fixturePid);
  assert.equal(await readFile(path.join(dir, "receipt.json"), "utf8"), receipt);
  assert.equal((await file.fetchPublicProductOnce(fixturePid)).product_name, "OTG flash drive");
  assert.equal((await file.cachedPublicProduct(fixturePid)).product_id, fixturePid);
  assert.equal(await readFile(path.join(dir, "receipt.before-reparse.json"), "utf8"), receipt);
  assert.equal(await readFile(path.join(dir, "request-started.json"), "utf8"), "{}");
  await writeFile(path.join(dir, "receipt.json"), receipt);
  await writeFile(path.join(dir, "response.html"), html + "tampered");
  await assert.rejects(file.fetchPublicProductOnce(fixturePid), /校验/);
  assert.equal(await readFile(path.join(dir, "receipt.json"), "utf8"), receipt);
});

test("explicit free-source recovery tries the direct PDP once, preserves old evidence and caches success", async t => {
  const file = await publicSource(t);
  const dir = file.publicCatalogDirectory(fixturePid);
  await mkdir(dir, { recursive: true });
  const html = "<title>Security Check</title>";
  const receipt = JSON.stringify({ pid: fixturePid, source: "tiktok-public", state: "failed", httpStatus: 200,
    errorMessage: "TikTok 返回安全验证页，未取得商品资料", requestedUrl: `https://www.tiktok.com/view/product/${fixturePid}`,
    fetchedAt: "2026-01-01T00:00:00Z", responseSha256: createHash("sha256").update(html).digest("hex") });
  await writeFile(path.join(dir, "response.html"), html);
  await writeFile(path.join(dir, "receipt.json"), receipt);
  await writeFile(path.join(dir, "request-started.json"), "original marker");
  let calls = 0;
  globalThis.__catalogFetch = async url => { calls++; assert.equal(url, `https://shop.tiktok.com/us/pdp/${fixturePid}?source=anchor`); return new Response(publicProductHtml(fixturePid)); };
  const options = { retryFailed: true };
  assert.equal((await file.fetchPublicProductOnce(fixturePid, options)).product_id, fixturePid);
  assert.equal((await file.fetchPublicProductOnce(fixturePid, options)).product_id, fixturePid);
  assert.equal(calls, 1);
  assert.equal(await readFile(path.join(dir, "request-started.json"), "utf8"), "original marker");
  const generation = createHash("sha256").update(receipt).digest("hex");
  assert.equal(await readFile(path.join(dir, "retries", generation, "previous-response.html"), "utf8"), html);
  assert.equal(await readFile(path.join(dir, "retries", generation, "previous-receipt.json"), "utf8"), receipt);
});

test("new free capture retries one blocked response but recent failures and wrong PID never loop", async t => {
  const file = await publicSource(t);
  let calls = 0;
  globalThis.__catalogFetch = async () => { calls++; return new Response("<title>Security Check</title>"); };
  await assert.rejects(file.fetchPublicProductOnce(fixturePid, { retryFailed: true }), /安全验证/);
  assert.equal(calls, 2);
  await assert.rejects(file.fetchPublicProductOnce(fixturePid, { retryFailed: true }), /一分钟/);
  assert.equal(calls, 2);
  const wrong = "1732350695360139846";
  globalThis.__catalogFetch = async () => { calls++; return new Response(publicProductHtml(fixturePid)); };
  await assert.rejects(file.fetchPublicProductOnce(wrong, { retryFailed: true }), /PID/);
  assert.equal(calls, 3);
});

test("cross-process free recovery is claimed once and a corrupt failure cannot request anything", async t => {
  const file = await publicSource(t);
  const dir = file.publicCatalogDirectory(fixturePid);
  await mkdir(dir, { recursive: true });
  const html = "<title>Security Check</title>";
  const receipt = JSON.stringify({pid:fixturePid,source:"tiktok-public",state:"failed",httpStatus:200,fetchedAt:"2026-01-01T00:00:00Z",
    errorMessage:"TikTok 返回安全验证页，未取得商品资料",responseSha256:createHash("sha256").update(html).digest("hex")});
  await writeFile(path.join(dir, "response.html"), html);
  await writeFile(path.join(dir, "receipt.json"), receipt);
  let calls = 0;
  globalThis.__catalogFetch = async () => { calls++; await new Promise(resolve=>setTimeout(resolve,30)); return new Response(publicProductHtml(fixturePid)); };
  const outcomes = await Promise.allSettled(Array.from({length:8},()=>file.fetchPublicProductOnce(fixturePid,{retryFailed:true})));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(calls,1);
  await writeFile(path.join(dir,"receipt.json"),receipt);
  await writeFile(path.join(dir,"response.html"),html+'tampered');
  await assert.rejects(file.fetchPublicProductOnce(fixturePid,{retryFailed:true}),/校验/);
  assert.equal(calls,1);
});

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

test("description detail images are read by bytes and reused without main or SKU downloads", async t => {
  const { file } = await modules(t);
  const bytes = Buffer.from("RIFF1234WEBPpayload");
  const item = { product_name: "四合一分装瓶", product_specifications: [{ name: "Function", value: "Shampoo, Body Wash" }],
    product_detail_images: [{ url: "https://oss-t.chuhaijiang.com/detail?signature=secret" }],
    product_images: [{ url: "https://oss-t.chuhaijiang.com/main?signature=secret" }],
    product_sku_props: [{ prop_name: "颜色", sale_prop_values: [{ prop_value: "白", image: { url: "https://oss-t.chuhaijiang.com/b?signature=secret" } }] }] };
  let calls = 0;
  globalThis.__catalogFetch = async () => { calls++; return new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }); };
  const evidence = await file.prepareCatalogEvidence(fixturePid, item);
  assert.equal(evidence.images.length, 1);
  assert.equal(evidence.images[0].label, "详情图1");
  assert.ok(evidence.warnings.some(warning => warning.includes("主商品图1张、SKU图1张未送入模型")));
  assert.match(evidence.images[0].dataUrl, /^data:image\/webp;base64,/);
  assert.match(evidence.text, /Shampoo/);
  assert.doesNotMatch(evidence.text, /signature|https|secret/);
  await file.prepareCatalogEvidence(fixturePid, item);
  assert.equal(calls, 1);
});

test("Qwen receives at most eight description detail images and no main or SKU images", async t => {
  const { file } = await modules(t);
  const url = index => `https://oss-t.chuhaijiang.com/${index}`;
  const item = {
    product_name: "Many-image product",
    product_detail_images: Array.from({ length: 12 }, (_, index) => ({ url: url(`detail-${index + 1}`) })),
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
    "详情图1", "详情图2", "详情图3", "详情图4", "详情图5", "详情图6", "详情图7", "详情图8",
  ]);
  assert.equal(requested.length, 8);
  assert.ok(evidence.warnings.some(warning => warning.includes("详情图共12张") && warning.includes("前8张")));
  assert.ok(evidence.warnings.some(warning => warning.includes("主商品图12张、SKU图12张未送入模型")));
});

test("products without description detail images send no main or SKU image to Qwen", async t => {
  const { file } = await modules(t);
  const candidates = file.imageCandidates({
    product_images: Array.from({ length: 10 }, (_, index) => ({ url: `https://oss-t.chuhaijiang.com/main-${index}` })),
    product_sku_props: [{ sale_prop_values: Array.from({ length: 10 }, (_, index) => ({
      prop_value: `SKU-${index + 1}`, image: { url: `https://oss-t.chuhaijiang.com/${index}` },
    })) }],
  });
  assert.deepEqual(file.selectCatalogImages(candidates), []);
});

test("untrusted image hosts never receive a request, and partial missing images do not block text", async t => {
  const { file } = await modules(t);
  for (const url of ["http://oss-t.chuhaijiang.com/a", "https://127.0.0.1/a", "https://user@oss-t.chuhaijiang.com/a", "https://oss-t.chuhaijiang.com.evil.test/a"]) {
    const evidence = await file.prepareCatalogEvidence(fixturePid, { product_name: "Bottle", product_detail_images: [{ url }] });
    assert.equal(evidence.images.length, 0);
    assert.ok(evidence.warnings.some(w => w.includes("无法获取图片信息")));
    assert.match(evidence.text, /Bottle/);
  }
});

test("large SKU inventories keep every named variant without transport IDs overwhelming model text", async t => {
  const { file } = await modules(t);
  const product_skus = Array.from({ length: 282 }, (_, index) => ({
    sku_id: "1".repeat(80) + index, sale_prop_value_ids: "2".repeat(80), status: 1, stock: 2000,
    price: { real_price: 9.58 },
    sku_sale_props: [{ prop_id: "3".repeat(80), prop_name: "Color", prop_value: `Black-${index}`, prop_value_id: "4".repeat(80) },
      { prop_id: "5".repeat(80), prop_name: "Model", prop_value: `Phone-${index}`, prop_value_id: "6".repeat(80) }],
  }));
  const description = "Ordinary description must survive unchanged.\nNo additional app required.";
  const evidence = await file.prepareCatalogEvidence(fixturePid, { product_name: "Phone case", product_description: description, product_skus }, { cacheOnly: true });
  const text = JSON.parse(evidence.text);
  assert.equal(text.product_description, description);
  assert.equal(text.product_skus.length, 282);
  assert.equal(text.product_skus[281].sku_sale_props[1].prop_value, "Phone-281");
  assert.deepEqual(text.product_skus[0].price, { real_price: 9.58 });
  assert.equal(text.product_skus[0].sku_id, undefined);
  assert.equal(text.product_skus[0].sku_sale_props[0].prop_value_id, undefined);
  assert.equal(product_skus[0].sku_id, "1".repeat(80) + "0");
});

test("identifier-only SKU relationships stay intact and real oversized descriptions are not silently truncated", async t => {
  const { file } = await modules(t);
  const product_skus = [{ sku_id: "sku-1", sale_prop_value_ids: "prop-1", stock: 2 }];
  const evidence = await file.prepareCatalogEvidence(fixturePid, { product_name: "Bottle", product_skus }, { cacheOnly: true });
  assert.deepEqual(JSON.parse(evidence.text).product_skus, product_skus);
  await assert.rejects(file.prepareCatalogEvidence(fixturePid, { product_name: "Bottle", product_description: "a".repeat(100_001) }, { cacheOnly: true }), /文字资料过长/);
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
  assert.equal(unsafe.fields.usageMethod.basis, "inference");
  assert.match(unsafe.fields.usageMethod.text, /^推断：/);
});

test("routine usage inference is labelled but unknown images, invented numbers and risky steps stay missing", async t => {
  const { analyzer } = await modules(t);
  const input = { pid: fixturePid, text: "Storage basket", images: [], warnings: [] };
  const raw = result(fixturePid);
  raw.fields.usageMethod = { text: "将物品放入收纳篮，摆放于平稳表面。", basis: "inference", evidence: ["product-text"] };
  assert.equal(analyzer.validateCatalogResult(raw, input, "fixture").fields.usageMethod.text, "推断：将物品放入收纳篮，摆放于平稳表面。");
  for (const text of ["使用5V电源充电3小时", "接通市电后拆机维修", "服用两片", "将工具伸入耳道", "点燃蜡烛", "放入洗衣机清洗"]) {
    raw.fields.usageMethod.text = text;
    assert.equal(analyzer.validateCatalogResult(raw, input, "fixture").fields.usageMethod.basis, "missing");
  }
  raw.fields.usageMethod.text = "放入收纳物品。";
  raw.fields.usageMethod.evidence.push("image-9");
  assert.equal(analyzer.validateCatalogResult(raw, input, "fixture").fields.usageMethod.basis, "missing");
  raw.fields.productParameters = { text: "大容量", basis: "inference", evidence: ["product-text"] };
  assert.equal(analyzer.validateCatalogResult(raw, input, "fixture").fields.productParameters.basis, "missing");
});

test("seller compliance claims are attributed even when model text omitted the attribution", async t => {
  const { analyzer } = await modules(t);
  const raw = result(fixturePid);
  raw.fields.productParameters.text = "材质：硅胶；加州65号提案合规，不含致癌物。";
  raw.fields.coreFunctions.text = "防漏收纳。";
  const verified = analyzer.validateCatalogResult(raw, {pid:fixturePid,text:"seller specifications",images:[],warnings:[]}, "fixture");
  assert.match(verified.fields.productParameters.text, /^卖家宣称：/);
  assert.match(verified.fields.coreFunctions.text, /^卖家宣称：/);
});

test("unsafe inferred care does not erase an independent ordinary use sentence", async t => {
  const { analyzer } = await modules(t);
  const raw = result(fixturePid);
  raw.fields.usageMethod = {text:"通过拉链开合主仓存取物品。冷水机洗。",basis:"inference",evidence:["product-text"]};
  const input = {pid:fixturePid,text:"backpack",images:[],warnings:[]};
  const verified = analyzer.validateCatalogResult(raw,input,"fixture");
  assert.equal(verified.fields.usageMethod.text,"推断：通过拉链开合主仓存取物品");
  assert.equal(verified.fields.usageMethod.basis,"inference");
  assert.ok(verified.warnings.some(w=>w.includes("特殊操作步骤未采用")));
  raw.fields.usageMethod = {text:"插头接入电源插座。",basis:"inference",evidence:["product-text"]};
  assert.equal(analyzer.validateCatalogResult(raw,input,"fixture").fields.usageMethod.basis,"missing");
  raw.fields.usageMethod = {text:"通过拉链开合主仓存取物品。冷水机洗。",basis:"inference",evidence:["image-9"]};
  assert.equal(analyzer.validateCatalogResult(raw,input,"fixture").fields.usageMethod.basis,"missing");
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
    assert.match(request.messages[0].content, /视觉证据只包含商品描述区域的详情图，最多8张/);
    assert.match(request.messages[0].content, /主商品图和SKU图没有提供给你/);
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

async function service(t, initial = null, fallback = "true") {
  env(t, "CHUHAIJIANG_FALLBACK_ENABLED", fallback);
  const key = `catalogState${Math.random()}`;
  let row = initial;
  let metadata = null;
  let paid = 0, ai = 0;
  const disk = new Map();
  const hooks = {
    readCatalog: async () => row && structuredClone(row),
    claimCatalog: async pid => { if (row) return false; row = { pid, fetch_state: "requested", analysis_state: "waiting" }; return true; },
    claimCatalogCreditRetry: async (_pid, updatedAt) => {
      if (row.fetch_state !== "failed" || row.analysis_state !== "waiting" || row.result_json || row.updated_at !== updatedAt) return false;
      row.fetch_state = "requested"; return true;
    },
    claimCatalogPublicRecovery: async (_pid, updatedAt) => {
      if (row.fetch_state !== "failed" || row.analysis_state !== "waiting" || row.result_json || row.updated_at !== updatedAt) return false;
      row.fetch_state = "requested"; return true;
    },
    markCatalogFetched: async () => { row.fetch_state = "ready"; },
    claimCatalogAnalysis: async () => { if (row.analysis_state !== "waiting") return false; row.analysis_state = "requested"; return true; },
    finishCatalogAnalysis: async (_pid, value) => { row.analysis_state = "ready"; row.result_json = value; },
    failCatalog: async (_pid, stage, error) => { row[`${stage}_state`] = "failed"; row.error_message = error; },
    readCatalogMetadata: async () => metadata,
    saveCatalogMetadata: async value => { metadata = structuredClone(value); },
    catalogSourceMetadata: (pid, item) => ({
      pid, source: item._catalog_source === "tiktok-public" ? "tiktok-public" : "chuhaijiang",
      title: String(item.product_name || item.product_title || ""), shopName: String(item.shop_name || ""),
      description: String(item.product_description || ""), mainImageUrls: [],
      sourceUrl: `https://www.tiktok.com/view/product/${pid}`, updatedAt: "t",
    }),
    cachedProduct: async () => disk.get("raw") || null,
    readCreditRejection: async () => null,
    archiveCreditRejection: async () => { throw Error("UNEXPECTED_RETRY"); },
    cachedPublicProduct: async () => disk.get("public-raw") || null,
    fetchPublicProductOnce: async () => { throw new types.CatalogError("public unavailable"); },
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
    .replace(/"@\/lib\/products\/(?:catalog-(?:store|source|analyzer)|tiktok-public-source)"/g, JSON.stringify(stub));
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

test("corrupt completed-cache JSON and a serialized null cannot escape as success or trigger paid work", async t => {
  for (const result_json of ["not JSON", "null"]) {
    const f = await service(t,{pid:fixturePid,fetch_state:"ready",analysis_state:"ready",result_json});
    await assert.rejects(f.api.getProductCatalog(fixturePid), /缓存.*(?:无效|为空)/);
    await assert.rejects((await f.restart()).getProductCatalog(fixturePid), /缓存.*(?:无效|为空)/);
    assert.deepEqual(f.counts(),{paid:0,ai:0});
  }
});

test("legacy main/SKU references cannot fill new blanks; text facts survive without mutating the cached row or paid calls", async t => {
  const cached=result(fixturePid);
  cached.fields.productParameters.evidence=["product-text","image-1"];
  cached.fields.scenes.evidence=["image-9"];
  const original=structuredClone(cached);
  const f=await service(t,{pid:fixturePid,fetch_state:"ready",analysis_state:"ready",result_json:cached});
  f.disk.set("raw",{product_id:fixturePid});
  let checks=0;
  f.hooks.prepareCatalogEvidence=async(_pid,_item,options)=>{
    assert.equal(options.cacheOnly,true);checks++;
    return {pid:fixturePid,images:[]};
  };
  const out=await f.api.getProductCatalog(fixturePid);
  assert.equal(out.fields.productParameters.basis,"missing");
  assert.equal(out.fields.scenes.basis,"missing");
  assert.deepEqual(out.fields.sku,original.fields.sku);
  assert.deepEqual(f.row().result_json,original);
  assert.deepEqual(f.counts(),{paid:0,ai:0});
  assert.equal(checks,1);
  assert.equal(types.restrictCachedCatalogEvidence(cached,[{id:"image-1",label:"详情图1"}]).fields.productParameters.basis,"direct");
  assert.equal(types.restrictCachedCatalogEvidence(cached,[{id:"image-1",label:"商品图1"}]).fields.productParameters.basis,"missing");
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

test("public TikTok source needs no ChuhaiJiang credential and invalid PID cannot consume a claim", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "");
  const f = await service(t);
  assert.throws(() => f.api.getProductNameByPid("../../invalid"), /PID/);
  f.hooks.fetchPublicProductOnce = async pid => {
    const item = { product_id: pid, product_name: "Public product", _catalog_source: "tiktok-public" };
    f.disk.set("public-raw", item);
    return item;
  };
  assert.equal(await f.api.getProductNameByPid(fixturePid), "Public product");
  assert.equal(f.row().fetch_state, "ready");
  assert.deepEqual(f.counts(), { paid: 0, ai: 0 });
});

test("disabled ChuhaiJiang fallback never calls the paid provider even when a key is configured", async t => {
  env(t, "CHUHAIJIANG_API_KEY", "configured-but-must-not-be-used");
  const f = await service(t, null, "false");
  await assert.rejects(f.api.getProductCatalog(fixturePid), /付费备选当前已停用/);
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

test("both disk-import and interrupted-DB recovery reject old main/SKU image facts without new calls", async t => {
  for (const state of [null, "requested"]) {
    const f=await service(t,state ? {pid:fixturePid,fetch_state:"ready",analysis_state:state} : null);
    f.disk.set("raw",{product_id:fixturePid});
    const saved=result(fixturePid);
    saved.fields.productParameters.evidence=["image-1"];
    f.disk.set(`/isolated/${fixturePid}/organized.json`,saved);
    f.hooks.prepareCatalogEvidence=async(_pid,_item,options)=>{
      assert.equal(options.cacheOnly,true);
      return {pid:fixturePid,images:[{id:"image-1",label:"商品图1"}]};
    };
    const out=await f.api.getProductCatalog(fixturePid);
    assert.equal(out.fields.productParameters.basis,"missing");
    assert.equal(out.fields.sku.basis,"direct");
    assert.equal(f.disk.get(`/isolated/${fixturePid}/organized.json`).fields.productParameters.basis,"direct");
    assert.deepEqual(f.counts(),{paid:0,ai:0});
    const restarted=await f.restart();
    assert.equal((await restarted.getProductCatalog(fixturePid)).fields.productParameters.basis,"missing");
  }
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
