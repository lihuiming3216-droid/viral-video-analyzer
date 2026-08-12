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
    export const claimFeishuProductCardDocument = (...args) => hooks().claimFeishuProductCardDocument?.(...args) ?? true;
    export const clearProductDocumentLink = (...args) => hooks().clearProductDocumentLink?.(...args) ?? null;
    export const createProduct = (...args) => hooks().createProduct?.(...args) ?? null;
    export const createVideo = (...args) => hooks().createVideo?.(...args) ?? null;
    export const deleteFeishuAutomationJob = () => {};
    export const getFeishuAutomationJob = () => null;
    export const getFeishuAutomationJobs = () => [];
    export const listFeishuAutomationJobVideoIds = () => [];
    export const getFeishuProductCardMapping = (...args) => hooks().getFeishuProductCardMapping?.(...args) ?? null;
    export const getProduct = (...args) => hooks().getProduct?.(...args) ?? null;
    export const getProductByPid = (...args) => hooks().getProductByPid?.(...args) ?? null;
    export const getVideo = () => null;
    export const getVideoBySourceUrl = () => null;
    export const saveFeishuAutomationJob = () => {};
    export const updateProduct = (...args) => hooks().updateProduct?.(...args) ?? null;
    export const updateVideo = (...args) => hooks().updateVideo?.(...args) ?? null;
    export const upsertFeishuProductCardMapping = (...args) => hooks().upsertFeishuProductCardMapping?.(...args) ?? args[0];
    export const ensureFeishuConnection = async () => null;
    export const getConnectedFeishuChannel = () => null;
    export const ensureProductCardShell = (...args) => hooks().ensureProductCardShell?.(...args) ?? ({
      documentId: "document-shell",
      documentUrl: "https://feishu.cn/docx/document-shell",
      reused: false,
      permissionWarning: "",
      identityWarning: "",
    });
    export const syncProductCardManagedFields = (...args) => hooks().syncProductCardManagedFields?.(...args) ?? ({ scanned: 9, updated: 0 });
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

test("the product-card hyperlink field uses its link instead of display text", () => {
  const documentUrl = "https://tenant.feishu.cn/docx/existing-card-token";
  const resolved = automation.resolveAutomationFields({
    产品链接: { link: productUrl, text: "商品页" },
    产品名称: "手机壳",
    产品手卡: { text: "打开手卡", link: documentUrl },
  });
  assert.equal(resolved.productDocument, documentUrl);
});

test("a cached product refresh failure still returns and re-links its document", async () => {
  const product = cachedProduct({
    documentId: "existing-document",
    documentUrl: "https://feishu.cn/docx/existing-document",
  });
  const snapshot = structuredClone(product);
  const order = [];
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      documentId: "existing-document",
      documentUrl: product.documentUrl,
      productId: product.id,
      lastProductPid: pid,
      lastProductUrl: productUrl,
      lastProductName: product.name,
      managedProductPid: pid,
      managedProductPid: pid,
    }),
    getProductByPid: () => product,
    ensureProductCardShell: async (_client, input) => {
      order.push("shell");
      assert.equal(input.existingDocumentId, "existing-document");
      return { documentId: "existing-document", documentUrl: product.documentUrl, reused: true };
    },
    parsePublicProductPage: async () => {
      order.push("parse");
      throw new Error("商品页要求安全验证");
    },
  };

  const result = await automation.handleFeishuAutomation(automationInput());
  assert.deepEqual(order, ["shell", "parse"]);
  assert.equal(result.documentReady, true);
  assert.equal(result.documentUrl, product.documentUrl);
  assert.match(result.productCardStatus, /手卡已就绪，资料刷新失败.*安全验证/);
  assert.equal(result.patch.产品手卡, product.documentUrl);
  assert.deepEqual(product, snapshot, "a failed refresh must preserve the last verified product facts");
});

test("a new PID creates the shell and minimal product before a parse failure", async () => {
  const calls = [];
  const created = cachedProduct({
    documentId: "document-shell",
    documentUrl: "https://feishu.cn/docx/document-shell",
    visualAnalyzedAt: null,
    coreFunctions: [],
  });
  globalThis.__feishuAutomationCacheTestHooks = {
    getProductByPid: () => null,
    ensureProductCardShell: async () => {
      calls.push("shell");
      return { documentId: "document-shell", documentUrl: created.documentUrl, reused: false };
    },
    syncProductCardManagedFields: async (_client, input) => {
      calls.push(input.clearDerived ? "clear" : "sync");
      return { scanned: 9, updated: 0 };
    },
    createProduct: () => { calls.push("create-product"); return created; },
    parsePublicProductPage: async () => {
      calls.push("parse");
      throw new Error("商品资料解析失败：Qwen 请求超时");
    },
  };

  const result = await automation.handleFeishuAutomation(automationInput());
  assert.deepEqual(calls, ["shell", "clear", "sync", "create-product", "parse"]);
  assert.match(result.productCardStatus, /手卡已就绪，资料刷新失败.*Qwen 请求超时/);
  assert.equal(result.patch.产品手卡, created.documentUrl);
});

test("an invalid or PID-less product link still creates a pending row card", async () => {
  let parseCalls = 0;
  let createCalls = 0;
  let shellInput;
  globalThis.__feishuAutomationCacheTestHooks = {
    getProductByPid: () => null,
    ensureProductCardShell: async (_client, input) => {
      shellInput = input;
      return { documentId: "pending-document", documentUrl: "https://feishu.cn/docx/pending-document", reused: false };
    },
    createProduct: () => { createCalls += 1; return null; },
    parsePublicProductPage: async () => { parseCalls += 1; },
  };
  const result = await automation.handleFeishuAutomation(automationInput({ productUrl: "https://www.tiktok.com/shop" }));
  assert.equal(shellInput.recordKey.recordId, "record-id");
  assert.equal(shellInput.pid, "");
  assert.equal(shellInput.productUrl, "https://www.tiktok.com/shop");
  assert.equal(parseCalls, 0);
  assert.equal(createCalls, 0);
  assert.match(result.productCardStatus, /手卡已就绪，资料刷新失败.*没有可识别的商品 PID/);
  assert.equal(result.patch.产品手卡, "https://feishu.cn/docx/pending-document");
  assert.equal("商品ID" in result.patch, false, "an unverified PID must never be written to Base");
});

test("a confirmed PID switch clears old managed facts before the new parse", async () => {
  const nextPid = "1732364299482009999";
  const nextUrl = `https://shop.tiktok.com/us/pdp/next-product/${nextPid}?source=anchor`;
  const syncCalls = [];
  const detachedProducts = [];
  const oldProduct = cachedProduct({
    id: "old-product",
    documentId: "existing-document",
    documentUrl: "https://feishu.cn/docx/existing-document",
  });
  const nextProduct = cachedProduct({
    id: "next-product",
    pid: nextPid,
    productUrl: nextUrl,
    documentId: "existing-document",
    documentUrl: "https://feishu.cn/docx/existing-document",
  });
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: oldProduct.id,
      documentId: "existing-document",
      documentUrl: "https://feishu.cn/docx/existing-document",
      lastProductPid: pid,
      lastProductUrl: productUrl,
      lastProductName: "手机壳",
      managedProductPid: pid,
    }),
    getProductByPid: () => null,
    getProduct: (id) => id === oldProduct.id ? oldProduct : null,
    clearProductDocumentLink: (id) => {
      detachedProducts.push(id);
      oldProduct.documentId = null;
      oldProduct.documentUrl = null;
      return oldProduct;
    },
    ensureProductCardShell: async () => ({
      documentId: "existing-document",
      documentUrl: "https://feishu.cn/docx/existing-document",
      reused: true,
    }),
    syncProductCardManagedFields: async (_client, input) => {
      syncCalls.push(input);
      return { scanned: 9, updated: 6 };
    },
    createProduct: () => nextProduct,
    parsePublicProductPage: async () => { throw new Error("商品页要求安全验证"); },
  };
  const result = await automation.handleFeishuAutomation(automationInput({ productUrl: nextUrl }));
  assert.equal(syncCalls[0].mode, "verified-basic");
  assert.equal(syncCalls[0].clearDerived, true);
  assert.equal(result.pid, nextPid);
  assert.deepEqual(detachedProducts, ["old-product"], "the repurposed row shell must be detached from the old PID");
  assert.equal(oldProduct.documentId, null);
  assert.match(result.productCardStatus, /资料刷新失败/);
});

test("an invalid temporary link preserves the same row's verified derived facts", async () => {
  const syncCalls = [];
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: "old-product",
      documentId: "existing-document",
      documentUrl: "https://feishu.cn/docx/existing-document",
      lastProductPid: pid,
      lastProductUrl: productUrl,
      lastProductName: "手机壳",
      managedProductPid: pid,
    }),
    getProductByPid: () => null,
    ensureProductCardShell: async (_client, input) => {
      assert.equal(input.pid, pid);
      assert.equal(input.productUrl, productUrl);
      return { documentId: "existing-document", documentUrl: "https://feishu.cn/docx/existing-document", reused: true };
    },
    syncProductCardManagedFields: async (_client, input) => {
      syncCalls.push(input);
      return { scanned: 9, updated: 0, missingLabels: [] };
    },
    parsePublicProductPage: async () => { throw new Error("must not parse invalid link"); },
  };
  const result = await automation.handleFeishuAutomation(automationInput({ productUrl: "https://www.tiktok.com/shop" }));
  assert.equal(syncCalls.length, 1, "a bad input may refresh identity but must not erase derived facts");
  assert.equal(syncCalls[0].mode, "identity");
  assert.equal(syncCalls[0].clearDerived, undefined);
  assert.match(result.productCardStatus, /资料刷新失败.*没有可识别的商品 PID/);
});

test("an invalid link cannot mix a new name with the previous verified PID and URL", async () => {
  let identityInput;
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: "old-product", documentId: "existing-document",
      documentUrl: "https://feishu.cn/docx/existing-document",
      lastProductPid: pid, lastProductUrl: productUrl, lastProductName: "旧手机壳", managedProductPid: pid,
    }),
    getProductByPid: () => null,
    ensureProductCardShell: async (_client, input) => ({
      documentId: "existing-document", documentUrl: "https://feishu.cn/docx/existing-document", reused: true,
      deferIdentity: input.deferIdentity,
    }),
    syncProductCardManagedFields: async (_client, input) => {
      if (input.mode === "identity") identityInput = input;
      return { scanned: 9, updated: 0, missingLabels: [] };
    },
  };
  const result = await automation.handleFeishuAutomation(automationInput({
    productName: "新摄像头", productUrl: "https://www.tiktok.com/shop",
  }));
  assert.equal(identityInput.name, "旧手机壳");
  assert.equal(identityInput.pid, pid);
  assert.equal(identityInput.productUrl, productUrl);
  assert.match(result.productCardStatus, /资料刷新失败/);
});

test("a new valid PID without a name uses a neutral pending name, never the old product name", async () => {
  const nextPid = "1732364299482009999";
  const nextUrl = `https://shop.tiktok.com/us/pdp/new-camera/${nextPid}?source=anchor`;
  let identityInput;
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: "old-product", documentId: "existing-document",
      documentUrl: "https://feishu.cn/docx/existing-document",
      lastProductPid: pid, lastProductUrl: productUrl, lastProductName: "旧手机壳", managedProductPid: pid,
    }),
    getProductByPid: () => null,
    ensureProductCardShell: async () => ({
      documentId: "existing-document", documentUrl: "https://feishu.cn/docx/existing-document", reused: true,
    }),
    syncProductCardManagedFields: async (_client, input) => {
      if (input.mode === "identity") identityInput = input;
      return { scanned: 9, updated: 0, missingLabels: [] };
    },
  };
  const input = automationInput({ productUrl: nextUrl });
  input.fields.产品名称 = "";
  const result = await automation.handleFeishuAutomation(input);
  assert.equal(identityInput.name, "待补产品");
  assert.equal(identityInput.pid, nextPid);
  assert.equal(identityInput.productUrl, nextUrl);
  assert.match(result.productCardStatus, /资料刷新失败.*缺少产品名称/);
});

test("a recovered replacement document is cleared even for the same PID", async () => {
  const syncCalls = [];
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: "product-1",
      documentId: "deleted-document",
      documentUrl: "https://feishu.cn/docx/deleted-document",
      lastProductPid: pid,
      lastProductUrl: productUrl,
      lastProductName: "手机壳",
      managedProductPid: pid,
    }),
    getProductByPid: () => cachedProduct({ id: "product-1" }),
    ensureProductCardShell: async () => ({
      documentId: "recovered-document",
      documentUrl: "https://feishu.cn/docx/recovered-document",
      reused: true,
    }),
    syncProductCardManagedFields: async (_client, input) => {
      syncCalls.push(input);
      return { scanned: 9, updated: 6, missingLabels: [] };
    },
    parsePublicProductPage: async () => { throw new Error("provider timeout"); },
  };
  const result = await automation.handleFeishuAutomation(automationInput());
  assert.equal(syncCalls.length, 2);
  assert.equal(syncCalls[0].clearDerived, true);
  assert.equal(syncCalls[0].derivedOnly, true);
  assert.equal(syncCalls[1].mode, "identity");
  assert.match(result.productCardStatus, /资料刷新失败/);
});

test("a PID switch clears derived facts before writing the new identity", async () => {
  const calls = [];
  const nextPid = "1732364299482009999";
  const nextUrl = `https://shop.tiktok.com/us/pdp/next-product/${nextPid}?source=anchor`;
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: "old-product", documentId: "existing-document",
      documentUrl: "https://feishu.cn/docx/existing-document",
      lastProductPid: pid, lastProductUrl: productUrl, lastProductName: "手机壳", managedProductPid: pid,
    }),
    getProductByPid: () => null,
    ensureProductCardShell: async (_client, input) => {
      assert.equal(input.deferIdentity, true);
      calls.push("shell-no-identity");
      return { documentId: "existing-document", documentUrl: "https://feishu.cn/docx/existing-document", reused: true };
    },
    syncProductCardManagedFields: async (_client, input) => {
      if (input.derivedOnly) {
        calls.push("clear-derived");
        throw new Error("clear failed midway");
      }
      calls.push(`identity-${input.pid || "empty"}`);
      return { scanned: 9, updated: 3, missingLabels: [] };
    },
    createProduct: () => { throw new Error("must not create after failed clear"); },
    parsePublicProductPage: async () => { throw new Error("must not parse after failed clear"); },
  };
  const result = await automation.handleFeishuAutomation(automationInput({ productUrl: nextUrl }));
  assert.deepEqual(calls, ["shell-no-identity", "clear-derived"]);
  assert.match(result.productCardStatus, /资料刷新失败.*clear failed midway/);
});

test("a successful click writes only verified managed fields and existing Base columns", async () => {
  const product = cachedProduct({
    documentId: "existing-document",
    documentUrl: "https://feishu.cn/docx/existing-document",
  });
  const parsed = {
    sku: "CASE-01",
    coreFunctions: ["防震保护"],
    productParameters: "材质：硅胶",
    usageMethod: "套入手机",
    audience: "手机用户",
    scenes: "日常使用",
    sellingPoints: "",
    sourceTitle: "Silicone Shockproof Phone Case",
    sourceDescription: "",
    sourceImageUrls: [],
    visualEvidence: "",
    visualAnalysisStatus: "unavailable",
  };
  const syncCalls = [];
  let updated;
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: product.id,
      documentId: product.documentId,
      documentUrl: product.documentUrl,
      lastProductPid: pid,
      lastProductUrl: productUrl,
      lastProductName: product.name,
      managedProductPid: pid,
    }),
    getProductByPid: () => product,
    ensureProductCardShell: async () => ({
      documentId: product.documentId,
      documentUrl: product.documentUrl,
      reused: true,
    }),
    parsePublicProductPage: async () => parsed,
    updateProduct: (_id, input) => { updated = input; return { ...product, ...input }; },
    syncProductCardManagedFields: async (_client, input) => {
      syncCalls.push(input);
      return { scanned: 9, updated: 6 };
    },
  };
  const result = await automation.handleFeishuAutomation(automationInput());
  assert.equal(result.productCardStatus, "已完成");
  assert.deepEqual(updated.coreFunctions, ["防震保护"]);
  assert.equal(syncCalls.length, 2);
  assert.equal(syncCalls[0].mode, "identity");
  assert.equal(syncCalls[1].mode, "verified-basic");
  assert.equal(syncCalls[1].clearDerived, true);
  assert.equal(syncCalls[1].productParameters, "材质：硅胶");
  assert.deepEqual(Object.keys(result.patch).sort(), ["产品手卡", "商品ID", "手卡状态"].sort());
  assert.equal(result.patch.产品链接, undefined, "the hyperlink input must never be echoed as plain text");
});

test("write-back publishes the card URL before starting the provider parse", async () => {
  const product = cachedProduct({ documentId: "document-shell", documentUrl: "https://feishu.cn/docx/document-shell" });
  const baseWrites = [];
  const client = {
    request: async (request) => {
      baseWrites.push(request.data.fields);
      return { code: 0 };
    },
  };
  globalThis.__feishuAutomationCacheTestHooks = {
    getProductByPid: () => product,
    ensureProductCardShell: async () => ({
      documentId: product.documentId,
      documentUrl: product.documentUrl,
      reused: true,
    }),
    parsePublicProductPage: async () => {
      assert.equal(baseWrites.length, 3, "document, PID and stage status must finish before parsing starts");
      assert.equal(baseWrites[0].产品手卡, product.documentUrl);
      assert.equal(baseWrites[2].手卡状态, "手卡已就绪，资料刷新中");
      throw new Error("商品页要求安全验证");
    },
  };
  const result = await automation.handleFeishuAutomation({ ...automationInput(), client, writeBack: true });
  assert.equal(baseWrites.length, 4);
  assert.match(baseWrites[3].手卡状态, /资料刷新失败/);
  assert.equal(result.writeBackError, "");
});

test("concurrent rows for one PID create only one internal product", async () => {
  let storedProduct = null;
  let createCalls = 0;
  const parsed = {
    sku: "CASE-01",
    coreFunctions: ["防震保护"],
    productParameters: "材质：硅胶",
    usageMethod: "套入手机",
    audience: "手机用户",
    scenes: "日常使用",
    sellingPoints: "",
    sourceTitle: "Silicone Shockproof Phone Case",
    sourceDescription: "",
    sourceImageUrls: [],
    visualEvidence: "",
    visualAnalysisStatus: "unavailable",
  };
  globalThis.__feishuAutomationCacheTestHooks = {
    getProductByPid: () => storedProduct,
    ensureProductCardShell: async (_client, input) => ({
      documentId: `doc-${input.recordKey.recordId}`,
      documentUrl: `https://feishu.cn/docx/doc-${input.recordKey.recordId}`,
      reused: false,
    }),
    createProduct: (input) => {
      createCalls += 1;
      storedProduct = cachedProduct({ id: "shared-product", ...input });
      return storedProduct;
    },
    updateProduct: (_id, input) => {
      storedProduct = { ...storedProduct, ...input };
      return storedProduct;
    },
    parsePublicProductPage: async () => parsed,
  };
  const [first, second] = await Promise.all([
    automation.handleFeishuAutomation({ ...automationInput(), recordId: "row-a" }),
    automation.handleFeishuAutomation({ ...automationInput(), recordId: "row-b" }),
  ]);
  assert.equal(createCalls, 1);
  assert.equal(first.productCardStatus, "已完成");
  assert.equal(second.productCardStatus, "已完成");
  assert.notEqual(first.documentUrl, second.documentUrl, "each Base row keeps its own stable hand-card mapping");
});

test("sequential rows for one PID also keep distinct row hand-cards", async () => {
  let storedProduct = null;
  const shellInputs = [];
  const parsed = {
    sku: "CASE-01",
    coreFunctions: ["防震保护"],
    productParameters: "材质：硅胶",
    usageMethod: "套入手机",
    audience: "手机用户",
    scenes: "日常使用",
    sourceTitle: "Silicone Shockproof Phone Case",
    sourceDescription: "",
    sourceImageUrls: [],
    visualEvidence: "",
    visualAnalysisStatus: "unavailable",
  };
  globalThis.__feishuAutomationCacheTestHooks = {
    getProductByPid: () => storedProduct,
    ensureProductCardShell: async (_client, input) => {
      shellInputs.push(input);
      return {
        documentId: `doc-${input.recordKey.recordId}`,
        documentUrl: `https://feishu.cn/docx/doc-${input.recordKey.recordId}`,
        reused: false,
      };
    },
    createProduct: (input) => {
      storedProduct = cachedProduct({ id: "shared-product", ...input });
      return storedProduct;
    },
    updateProduct: (_id, input) => {
      storedProduct = { ...storedProduct, ...input };
      return storedProduct;
    },
    parsePublicProductPage: async () => parsed,
  };
  const first = await automation.handleFeishuAutomation({ ...automationInput(), recordId: "row-a" });
  const second = await automation.handleFeishuAutomation({ ...automationInput(), recordId: "row-b" });
  assert.notEqual(first.documentUrl, second.documentUrl);
  assert.equal(shellInputs[1].existingDocumentId, null, "a product-level canonical doc must not leak into another row");
  assert.equal(shellInputs[1].existingDocumentUrl, null);
});

test("two unmapped rows cannot mutate the same supplied legacy hand-card", async () => {
  const legacyUrl = "https://feishu.cn/docx/legacy-shared";
  const mappings = new Map();
  const occupiedDocuments = new Map();
  let storedProduct = null;
  const shellInputs = [];
  const keyOf = ({ appToken, tableId, recordId }) => `${appToken}:${tableId}:${recordId}`;
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: (key) => mappings.get(keyOf(key)) || null,
    claimFeishuProductCardDocument: (key, document) => {
      const rowKey = keyOf(key);
      const owner = occupiedDocuments.get(document.documentId);
      if (owner && owner !== rowKey) return false;
      occupiedDocuments.set(document.documentId, rowKey);
      mappings.set(rowKey, { ...(mappings.get(rowKey) || {}), ...key, ...document });
      return true;
    },
    upsertFeishuProductCardMapping: (input) => {
      const rowKey = keyOf(input);
      mappings.set(rowKey, { ...(mappings.get(rowKey) || {}), ...input });
      return mappings.get(rowKey);
    },
    getProductByPid: () => storedProduct,
    ensureProductCardShell: async (_client, input) => {
      shellInputs.push(input);
      const documentId = input.existingDocumentId || `doc-${input.recordKey.recordId}`;
      return {
        documentId,
        documentUrl: input.existingDocumentUrl || `https://feishu.cn/docx/${documentId}`,
        reused: Boolean(input.existingDocumentId),
      };
    },
    createProduct: (input) => {
      storedProduct = cachedProduct({ id: "shared-product", ...input });
      return storedProduct;
    },
    parsePublicProductPage: async () => { throw new Error("provider timeout"); },
  };
  const legacyFields = {
    产品链接: { link: productUrl, text: "商品页" },
    产品名称: "手机壳",
    产品手卡: { text: "打开手卡", link: legacyUrl },
  };
  const first = await automation.handleFeishuAutomation({
    ...automationInput(), recordId: "row-a", fields: legacyFields,
  });
  const second = await automation.handleFeishuAutomation({
    ...automationInput(), recordId: "row-b", fields: legacyFields,
  });
  assert.equal(first.documentUrl, legacyUrl);
  assert.equal(second.documentUrl, "https://feishu.cn/docx/doc-row-b");
  assert.equal(shellInputs[0].existingDocumentId, "legacy-shared");
  assert.equal(shellInputs[1].existingDocumentId, null, "claim conflict must be decided before shell mutation");
});

test("missing managed template labels cannot be reported as completed", async () => {
  const product = cachedProduct({ documentId: "document-shell", documentUrl: "https://feishu.cn/docx/document-shell" });
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: product.id,
      documentId: product.documentId,
      documentUrl: product.documentUrl,
      lastProductPid: pid,
      lastProductUrl: productUrl,
      lastProductName: product.name,
      managedProductPid: pid,
    }),
    getProductByPid: () => product,
    ensureProductCardShell: async () => ({
      documentId: product.documentId, documentUrl: product.documentUrl, reused: true,
    }),
    parsePublicProductPage: async () => ({
      sku: "CASE-01", coreFunctions: ["防震保护"], productParameters: "材质：硅胶",
      usageMethod: "套入手机", audience: "手机用户", scenes: "日常使用",
      sourceTitle: "Silicone Case", sourceDescription: "", sourceImageUrls: [],
      visualEvidence: "", visualAnalysisStatus: "unavailable",
    }),
    updateProduct: (_id, input) => ({ ...product, ...input }),
    syncProductCardManagedFields: async () => ({
      scanned: 8, updated: 0, matchedLabels: [], missingLabels: ["产品参数"],
    }),
  };
  const result = await automation.handleFeishuAutomation(automationInput());
  assert.notEqual(result.productCardStatus, "已完成");
  assert.match(result.productCardStatus, /资料刷新失败.*模板缺少基础字段.*产品参数/);
  assert.equal(result.documentUrl, product.documentUrl);
});

test("a failed Base card-link write cannot publish a completed status", async () => {
  const product = cachedProduct({ documentId: "document-shell", documentUrl: "https://feishu.cn/docx/document-shell" });
  const writtenStatuses = [];
  const client = {
    request: async ({ data }) => {
      if (Object.hasOwn(data.fields, "产品手卡")) return { code: 1250001, msg: "temporary card-link failure" };
      if (Object.hasOwn(data.fields, "手卡状态")) writtenStatuses.push(data.fields.手卡状态);
      return { code: 0 };
    },
  };
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: product.id, documentId: product.documentId, documentUrl: product.documentUrl,
      lastProductPid: pid, lastProductUrl: productUrl, lastProductName: product.name, managedProductPid: pid,
    }),
    getProductByPid: () => product,
    ensureProductCardShell: async () => ({ documentId: product.documentId, documentUrl: product.documentUrl, reused: true }),
    parsePublicProductPage: async () => ({
      sku: "CASE-01", coreFunctions: ["防震保护"], productParameters: "材质：硅胶",
      usageMethod: "套入手机", audience: "手机用户", scenes: "日常使用",
      sourceTitle: "Silicone Case", sourceDescription: "", sourceImageUrls: [],
      visualEvidence: "", visualAnalysisStatus: "unavailable",
    }),
    updateProduct: (_id, input) => ({ ...product, ...input }),
  };
  const result = await automation.handleFeishuAutomation({ ...automationInput(), client, writeBack: true });
  assert.match(result.productCardStatus, /手卡已创建，但表格手卡链接回写待重试/);
  assert.doesNotMatch(writtenStatuses.join("\n"), /^已完成$/m);
  assert.match(result.writeBackError, /产品手卡.*temporary card-link failure/);
});

test("a Base write failure cannot erase the created document or leak provider secrets", async () => {
  const product = cachedProduct({ documentId: "document-shell", documentUrl: "https://feishu.cn/docx/document-shell" });
  let writeAttempts = 0;
  const client = {
    request: async () => {
      writeAttempts += 1;
      return { code: 1250001, msg: "temporary Base failure" };
    },
  };
  globalThis.__feishuAutomationCacheTestHooks = {
    getProductByPid: () => product,
    ensureProductCardShell: async () => ({
      documentId: product.documentId,
      documentUrl: product.documentUrl,
      reused: true,
    }),
    parsePublicProductPage: async () => {
      throw new Error("Authorization: Bearer TEST_SECRET_TOKEN");
    },
  };
  const result = await automation.handleFeishuAutomation({ ...automationInput(), client, writeBack: true });
  assert.equal(result.documentReady, true);
  assert.equal(result.documentUrl, product.documentUrl);
  assert.ok(writeAttempts >= 2, "the final status write should retry a failed stage-one write");
  assert.match(result.writeBackError, /temporary Base failure/);
  assert.doesNotMatch(result.productCardStatus, /Bearer|TEST_SECRET_TOKEN|Authorization/i);
});
