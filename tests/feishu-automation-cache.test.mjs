import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const automationSource = await readFile(
  new URL("../lib/feishu/automation.ts", import.meta.url),
  "utf8",
);

async function loadAutomationModule() {
  const stubSource = `
    const hooks = () => globalThis.__feishuAutomationCacheTestHooks || {};
    export const createProduct = (...args) => hooks().createProduct?.(...args) ?? null;
    export const createVideo = (...args) => hooks().createVideo?.(...args) ?? null;
    export const deleteFeishuAutomationJob = () => {};
    export const getFeishuAutomationJob = () => null;
    export const getProduct = (...args) => hooks().getProduct?.(...args) ?? null;
    export const getProductByPid = (...args) => hooks().getProductByPid?.(...args) ?? null;
    export const getVideo = () => null;
    export const getVideoBySourceUrl = () => null;
    export const saveFeishuAutomationJob = () => {};
    export const updateProduct = (...args) => hooks().updateProduct?.(...args) ?? null;
    export const updateVideo = (...args) => hooks().updateVideo?.(...args) ?? null;
    export const ensureFeishuConnection = async () => null;
    export const getConnectedFeishuChannel = () => null;
    export const ensureProductDocument = (...args) => hooks().ensureProductDocument(...args);
    export const enqueueVideos = () => {};
    export const extractProductIdFromUrl = (url) => (String(url).match(/\\d{6,}/g) || []).sort((a, b) => b.length - a.length)[0] || "";
    export const hasUsableProductInfo = (...args) => hooks().hasUsableProductInfo?.(...args) ?? false;
    export const isExactTikTokProductSource = (sourceUrl, productId) => {
      try {
        const url = new URL(sourceUrl);
        const match = url.pathname.match(/\\/pdp\\/[^/]+\\/(\\d{6,})\\/?$/);
        if (url.protocol !== "https:" || url.hostname !== "shop.tiktok.com" || match?.[1] !== productId) return false;
        return ["pid", "product_id", "productId", "item_id", "itemId"]
          .every((key) => url.searchParams.getAll(key).every((value) => value === productId));
      } catch { return false; }
    };
    export const parsePublicProductPage = (...args) => hooks().parsePublicProductPage(...args);
    export const conciseProductDocAnalysis = () => "";
    export const isTikTokUrl = (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && (url.hostname === "tiktok.com" || url.hostname.endsWith(".tiktok.com"));
      } catch { return false; }
    };
  `;
  const stubUrl = `data:text/javascript;base64,${Buffer.from(stubSource).toString("base64")}`;
  let compiled = ts.transpileModule(automationSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  compiled = compiled
    .replace('import "server-only";', "")
    .replaceAll('"@/lib/database"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/feishu/runtime"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/feishu/document"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/queue"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/product-parser"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/product-doc-analysis"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/tiktok-product"', JSON.stringify(stubUrl));
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  return import(moduleUrl);
}

const automation = await loadAutomationModule();
const pid = "1732364299482009895";
const productUrl = `https://shop.tiktok.com/us/pdp/anime-phone-case/${pid}?source=anchor`;

function cachedProduct(overrides = {}) {
  return {
    id: "product-1",
    name: "手机壳",
    pid,
    productUrl,
    documentId: null,
    documentUrl: null,
    visualAnalyzedAt: "2026-08-10T12:00:00.000Z",
    visualAnalysisStatus: "completed",
    visualEvidence: "Image text: Shockproof",
    coreFunctions: ["防震保护"],
    productParameters: "硅胶材质",
    usageMethod: "卡扣式安装",
    targetAudience: "手机用户",
    usageScenes: "日常使用",
    sellingPoints: "",
    propImages: [],
    ...overrides,
  };
}

function automationInput(overrides = {}) {
  const inputUrl = overrides.productUrl || productUrl;
  return {
    client: {},
    appToken: "app-token",
    tableId: "table-id",
    recordId: "record-id",
    fields: {
      产品链接: { link: inputUrl, text: "产品链接" },
      产品名称: overrides.productName || "手机壳",
      产品手卡: "",
    },
    writeBack: false,
  };
}

test("verified cached evidence without a document still fails closed", async () => {
  const product = cachedProduct();
  const snapshot = structuredClone(product);
  let documentCalls = 0;
  globalThis.__feishuAutomationCacheTestHooks = {
    getProductByPid: () => product,
    hasUsableProductInfo: () => true,
    parsePublicProductPage: async () => { throw new Error("商品页要求安全验证"); },
    ensureProductDocument: async () => { documentCalls += 1; },
  };

  await assert.rejects(automation.handleFeishuAutomation(automationInput()), /商品页要求安全验证/);
  assert.equal(documentCalls, 0);
  assert.deepEqual(product, snapshot, "a failed refresh must leave cached evidence unchanged");
});

test("an empty cache still fails closed when the public page cannot be verified", async () => {
  const product = cachedProduct({ visualAnalyzedAt: null, visualAnalysisStatus: "unavailable", visualEvidence: "", coreFunctions: [] });
  let documentCalls = 0;
  globalThis.__feishuAutomationCacheTestHooks = {
    getProductByPid: () => product,
    hasUsableProductInfo: () => false,
    parsePublicProductPage: async () => { throw new Error("商品页要求安全验证"); },
    ensureProductDocument: async () => { documentCalls += 1; },
  };

  await assert.rejects(
    automation.handleFeishuAutomation(automationInput()),
    /商品页要求安全验证/,
  );
  assert.equal(documentCalls, 0);
});

test("an existing document is not re-linked when product refresh fails", async () => {
  const product = cachedProduct({
    documentId: "existing-document",
    documentUrl: "https://feishu.cn/docx/existing-document",
  });
  let documentCalls = 0;
  globalThis.__feishuAutomationCacheTestHooks = {
    getProductByPid: () => product,
    hasUsableProductInfo: () => true,
    parsePublicProductPage: async () => { throw new Error("商品资料解析失败：HTTP 404"); },
    ensureProductDocument: async () => { documentCalls += 1; },
  };
  await assert.rejects(
    automation.handleFeishuAutomation(automationInput()),
    /商品资料解析失败：HTTP 404/,
  );
  assert.equal(documentCalls, 0);
});

test("a changed product URL failure cannot mutate or re-link the cached product", async () => {
  const product = cachedProduct({
    documentId: "existing-document",
    documentUrl: "https://feishu.cn/docx/existing-document",
  });
  const changedUrl = `https://shop.tiktok.com/us/pdp/changed-anime-phone-case/${pid}?source=anchor`;
  let documentCalls = 0;
  let updateCalls = 0;
  globalThis.__feishuAutomationCacheTestHooks = {
    getProductByPid: () => product,
    updateProduct: () => { updateCalls += 1; return product; },
    hasUsableProductInfo: () => true,
    parsePublicProductPage: async () => { throw new Error("商品页要求安全验证"); },
    ensureProductDocument: async () => { documentCalls += 1; },
  };
  await assert.rejects(
    automation.handleFeishuAutomation(automationInput({ productUrl: changedUrl })),
    /商品页要求安全验证/,
  );
  assert.equal(documentCalls, 0);
  assert.equal(updateCalls, 0);
  assert.equal(product.productUrl, productUrl);
});

test("a new PID parse failure creates no product or document", async () => {
  let createCalls = 0;
  let updateCalls = 0;
  let documentCalls = 0;
  globalThis.__feishuAutomationCacheTestHooks = {
    getProductByPid: () => null,
    createProduct: () => { createCalls += 1; return cachedProduct(); },
    updateProduct: () => { updateCalls += 1; return null; },
    hasUsableProductInfo: () => false,
    parsePublicProductPage: async () => { throw new Error("商品资料解析失败：AI 提取未得到足够的可验证资料（Qwen 请求超时）；官方商品页路径也没有足够的确定性白名单资料"); },
    ensureProductDocument: async () => { documentCalls += 1; },
  };
  await assert.rejects(
    automation.handleFeishuAutomation(automationInput()),
    /Qwen 请求超时/,
  );
  assert.equal(createCalls, 0);
  assert.equal(updateCalls, 0);
  assert.equal(documentCalls, 0);
});
