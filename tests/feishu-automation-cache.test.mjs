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
    export const mergeVerifiedProductFacts = (...args) => hooks().mergeVerifiedProductFacts?.(...args)
      ?? hooks().getProductByPid?.(args[1]?.pid)
      ?? null;
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
    export const syncProductCardManagedFields = (...args) => hooks().syncProductCardManagedFields?.(...args) ?? ({
      scanned: 9,
      updated: 0,
      missingLabels: [],
      duplicateLabels: [],
    });
    export const enqueueVideos = () => {};
    export const extractProductIdFromUrl = (url) => (String(url).match(/\\d{6,}/g) || []).sort((a, b) => b.length - a.length)[0] || "";
    export const hasUsableProductInfo = (...args) => hooks().hasUsableProductInfo?.(...args) ?? false;
    export const isExactTikTokProductSource = (sourceUrl, productId) => {
      try {
        const url = new URL(sourceUrl);
        const match = url.pathname.match(/\\/pdp\\/(?:[^/]+\\/)?(\\d{6,})\\/?$/);
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
  const productPid = overrides.pid ?? pid;
  const sourceUrl = overrides.productUrl ?? productUrl;
  return {
    id: "product-1",
    name: "手机壳",
    pid: productPid,
    productUrl: sourceUrl,
    documentId: null,
    documentUrl: null,
    sku: "CASE-OLD",
    visualAnalyzedAt: "2026-08-10T12:00:00.000Z",
    visualAnalysisStatus: "completed",
    visualEvidence: "Image text: Shockproof",
    coreFunctions: ["防震保护"],
    productParameters: "硅胶材质",
    usageMethod: "卡扣式安装",
    targetAudience: "手机用户",
    usageScenes: "日常使用",
    sourceTitle: "Verified phone case",
    sourceDescription: "",
    sourceImageUrls: [],
    verifiedPid: productPid,
    verifiedSourceUrl: sourceUrl,
    evidenceVersion: "test-evidence-v1",
    factsVerifiedAt: "2026-08-10T12:00:00.000Z",
    sellingPoints: "",
    propImages: [],
    ...overrides,
  };
}

function verifiedParse(overrides = {}) {
  const parsedPid = overrides.pid ?? pid;
  const sourceUrl = overrides.sourceUrl ?? productUrl;
  return {
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
    verification: {
      status: "complete",
      verifiedFactCount: 6,
      rejectedFactCount: 0,
      missingFields: [],
      verifiedFields: ["sku", "coreFunctions", "productParameters", "usageMethod", "audience", "scenes"],
      evidenceVersion: "test-evidence-v1",
      sourceUrl,
      pid: parsedPid,
    },
    ...overrides,
  };
}

function mergeVerifiedSnapshot(product, input) {
  const preserve = product.verifiedPid === input.pid && product.evidenceVersion === input.evidenceVersion;
  const value = (key, empty) => input[key] !== undefined ? input[key] : preserve ? product[key] : empty;
  return {
    ...product,
    sku: value("sku", ""),
    coreFunctions: value("coreFunctions", []),
    productParameters: value("productParameters", ""),
    usageMethod: value("usageMethod", ""),
    targetAudience: value("targetAudience", ""),
    usageScenes: value("usageScenes", ""),
    sourceTitle: value("sourceTitle", ""),
    sourceDescription: value("sourceDescription", ""),
    sourceImageUrls: value("sourceImageUrls", []),
    visualEvidence: value("visualEvidence", ""),
    visualAnalysisStatus: value("visualAnalysisStatus", ""),
    verifiedPid: input.pid,
    verifiedSourceUrl: input.sourceUrl,
    evidenceVersion: input.evidenceVersion,
    factsVerifiedAt: input.verifiedAt,
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

function completeManagedCurrentValues(documentPid, derivedValue = "历史可信资料") {
  return {
    商品名称: "历史产品",
    产品链接: documentPid ? `https://shop.tiktok.com/us/pdp/legacy/${documentPid}` : "",
    商品ID: documentPid,
    产品SKU: derivedValue,
    产品主要功能: derivedValue,
    产品参数: derivedValue,
    使用方法: derivedValue,
    适用人群: derivedValue,
    使用场景: derivedValue,
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

test("typed page and image failures publish the stable Base statuses", () => {
  for (const [code, expected] of [
    ["page_unavailable", "无法打开页面"],
    ["security_challenge", "无法打开页面"],
    ["all_product_images_unavailable", "无法获取图片信息"],
    ["page_incomplete", "商品信息获取不完整"],
    ["invalid_capture", "商品信息获取不完整"],
  ]) {
    const error = Object.assign(new Error("provider detail must not replace the stable status"), { code });
    assert.equal(automation.productCardFailureStatus({ error }), expected);
  }
  assert.match(
    automation.productCardFailureStatus({
      error: Object.assign(new Error("OpenAI 商品分析请求超时"), { code: "timeout" }),
      retainedVerifiedSnapshot: true,
    }),
    /^手卡已就绪，资料分析失败：OpenAI 商品分析请求超时；已保留/,
  );
});

test("typed capture failures keep the created card and reach the terminal Base status", async () => {
  for (const [index, code, expected] of [
    [1, "page_unavailable", "无法打开页面"],
    [2, "all_product_images_unavailable", "无法获取图片信息"],
    [3, "page_incomplete", "商品信息获取不完整"],
  ]) {
    const created = cachedProduct({
      id: `capture-failure-${index}`,
      documentId: `capture-doc-${index}`,
      documentUrl: `https://feishu.cn/docx/capture-doc-${index}`,
      sku: "", coreFunctions: [], productParameters: "", usageMethod: "", targetAudience: "", usageScenes: "",
      verifiedPid: "", verifiedSourceUrl: "", evidenceVersion: "", factsVerifiedAt: "",
    });
    globalThis.__feishuAutomationCacheTestHooks = {
      getProductByPid: () => null,
      ensureProductCardShell: async () => ({
        documentId: created.documentId,
        documentUrl: created.documentUrl,
        reused: false,
      }),
      syncProductCardManagedFields: async () => ({
        scanned: 9, updated: 0, missingLabels: [], duplicateLabels: [], currentValues: {},
      }),
      createProduct: () => created,
      parsePublicProductPage: async () => {
        throw Object.assign(new Error("provider diagnostics"), { code });
      },
    };
    const baseWrites = [];
    const result = await automation.handleFeishuAutomation({
      ...automationInput(),
      recordId: `capture-record-${index}`,
      client: { request: async ({ data }) => { baseWrites.push(data.fields); return { code: 0 }; } },
      writeBack: true,
    });
    assert.equal(result.productCardStatus, expected);
    assert.equal(result.patch.产品手卡, created.documentUrl);
    assert.equal(baseWrites.some((fields) => fields.手卡状态 === expected), true);
  }
});

test("a historical same-PID card without managed markers is never cleared before a failed refresh", async () => {
  const product = cachedProduct({
    documentId: "existing-document",
    documentUrl: "https://feishu.cn/docx/existing-document",
  });
  const snapshot = structuredClone(product);
  const syncCalls = [];
  const managedEvents = [];
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      documentId: "existing-document",
      documentUrl: product.documentUrl,
      productId: product.id,
      lastProductPid: "",
      lastProductUrl: "",
      lastProductName: "",
      managedProductPid: "",
    }),
    getProductByPid: () => product,
    ensureProductCardShell: async (_client, input) => {
      assert.equal(input.existingDocumentId, "existing-document");
      return { documentId: "existing-document", documentUrl: product.documentUrl, reused: true };
    },
    syncProductCardManagedFields: async (_client, input) => {
      syncCalls.push(input);
      managedEvents.push(input.preflightOnly ? "preflight" : input.mode === "identity" ? "identity" : "restore");
      return { scanned: 9, updated: 0, missingLabels: [], duplicateLabels: [] };
    },
    upsertFeishuProductCardMapping: (input) => {
      if (Object.hasOwn(input, "managedProductPid")) managedEvents.push(`managed-${input.managedProductPid || "empty"}`);
      return input;
    },
    parsePublicProductPage: async () => {
      managedEvents.push("parse");
      throw new Error("商品页要求安全验证");
    },
  };

  const result = await automation.handleFeishuAutomation(automationInput());
  assert.deepEqual(syncCalls.map((call) => call.preflightOnly ? "preflight" : call.mode),
    ["preflight", "identity", "verified-basic"]);
  assert.equal(syncCalls.some((call) => call.derivedOnly), false,
    "a missing historical marker is not evidence that the same-PID facts need a destructive pre-clear");
  const restored = syncCalls.at(-1);
  assert.equal(restored.clearDerived, true);
  assert.deepEqual(restored.coreFunctions, snapshot.coreFunctions);
  assert.equal(restored.productParameters, snapshot.productParameters,
    "the DB snapshot is idempotently restored before the provider request");
  assert.deepEqual(managedEvents, ["preflight", "identity", "restore", `managed-${pid}`, "parse"],
    "an unmarked historical card is bound only after its trusted snapshot was restored");
  assert.equal(result.documentReady, true);
  assert.equal(result.documentUrl, product.documentUrl);
  assert.match(result.productCardStatus, /手卡已就绪，资料刷新失败.*安全验证/);
  assert.equal(result.patch.产品手卡, product.documentUrl);
  assert.deepEqual(product, snapshot, "a failed refresh must preserve the last verified product facts");
});

test("a legacy mapped product PID isolates old derived facts before writing a new identity", async () => {
  const oldPid = pid;
  const nextPid = "1732364299482009999";
  const nextUrl = `https://shop.tiktok.com/us/pdp/next-product/${nextPid}?source=anchor`;
  const oldProduct = cachedProduct({
    id: "old-product",
    pid: oldPid,
    documentId: "existing-document",
    documentUrl: "https://feishu.cn/docx/existing-document",
  });
  const nextProduct = cachedProduct({
    id: "next-product", pid: nextPid, productUrl: nextUrl,
    documentId: "existing-document", documentUrl: "https://feishu.cn/docx/existing-document",
    sku: "", coreFunctions: [], productParameters: "", usageMethod: "", targetAudience: "", usageScenes: "",
    verifiedPid: "", verifiedSourceUrl: "", evidenceVersion: "", factsVerifiedAt: "",
  });
  const events = [];
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: oldProduct.id,
      documentId: "existing-document",
      documentUrl: "https://feishu.cn/docx/existing-document",
      lastProductPid: "",
      lastProductUrl: "",
      lastProductName: "",
      managedProductPid: "",
    }),
    getProduct: (id) => id === oldProduct.id ? oldProduct : null,
    getProductByPid: () => null,
    createProduct: () => nextProduct,
    ensureProductCardShell: async () => ({
      documentId: "existing-document", documentUrl: "https://feishu.cn/docx/existing-document", reused: true,
    }),
    syncProductCardManagedFields: async (_client, input) => {
      events.push(input.preflightOnly ? "preflight"
        : input.derivedOnly ? "preclear"
          : input.mode === "identity" ? `identity-${input.pid}` : "unexpected-restore");
      return { scanned: 9, updated: 6, missingLabels: [], duplicateLabels: [] };
    },
    upsertFeishuProductCardMapping: (input) => {
      if (Object.hasOwn(input, "managedProductPid")) events.push(`managed-${input.managedProductPid}`);
      return input;
    },
    parsePublicProductPage: async () => {
      events.push("parse");
      throw new Error("provider timeout");
    },
  };

  const result = await automation.handleFeishuAutomation(automationInput({ productUrl: nextUrl }));
  assert.deepEqual(events, ["preflight", "preclear", `managed-${nextPid}`, `identity-${nextPid}`, "parse"]);
  assert.equal(events.includes("unexpected-restore"), false,
    "facts certified for the mapped old PID must never be restored under the new identity");
  assert.match(result.productCardStatus, /资料刷新失败.*provider timeout/);
  assert.equal(result.pid, nextPid);
});

for (const scenario of [
  { name: "the same PID preserves derived facts", documentPid: pid, expectPreclear: false },
  { name: "a different PID clears derived facts", documentPid: "1732364299482009888", expectPreclear: true },
  { name: "an empty PID with derived facts clears unknown ownership", documentPid: "", expectPreclear: true },
]) {
  test(`a first-claimed supplied legacy document ${scenario.name}`, async () => {
    const legacyUrl = "https://feishu.cn/docx/supplied-legacy-document";
    let claimed = false;
    let mapping = null;
    const syncCalls = [];
    const managedUpdates = [];
    globalThis.__feishuAutomationCacheTestHooks = {
      getFeishuProductCardMapping: () => mapping,
      claimFeishuProductCardDocument: (key, document) => {
        claimed = true;
        mapping = {
          ...key,
          productId: null,
          documentId: document.documentId,
          documentUrl: document.documentUrl,
          lastProductPid: "",
          lastProductUrl: "",
          lastProductName: "",
          managedProductPid: "",
        };
        return true;
      },
      upsertFeishuProductCardMapping: (input) => {
        mapping = { ...(mapping || {}), ...input };
        if (Object.hasOwn(input, "managedProductPid")) managedUpdates.push(input.managedProductPid);
        return mapping;
      },
      ensureProductCardShell: async (_client, input) => {
        assert.equal(input.existingDocumentId, "supplied-legacy-document");
        return { documentId: "supplied-legacy-document", documentUrl: legacyUrl, reused: true };
      },
      syncProductCardManagedFields: async (_client, input) => {
        syncCalls.push(input);
        if (input.preflightOnly) {
          return {
            scanned: 9, updated: 0, missingLabels: [], duplicateLabels: [],
            currentValues: completeManagedCurrentValues(scenario.documentPid),
          };
        }
        return { scanned: 9, updated: input.derivedOnly ? 6 : 3, missingLabels: [], duplicateLabels: [] };
      },
      getProductByPid: () => null,
      createProduct: (input) => cachedProduct({
        id: "new-product", ...input,
        sku: "", coreFunctions: [], productParameters: "", usageMethod: "", targetAudience: "", usageScenes: "",
        verifiedPid: "", verifiedSourceUrl: "", evidenceVersion: "", factsVerifiedAt: "",
      }),
      parsePublicProductPage: async () => { throw new Error("provider timeout"); },
    };
    const input = automationInput();
    input.fields.产品手卡 = { text: "打开历史手卡", link: legacyUrl };

    const result = await automation.handleFeishuAutomation(input);
    assert.equal(claimed, true);
    const preclear = syncCalls.find((call) => call.derivedOnly && call.clearDerived);
    assert.equal(Boolean(preclear), scenario.expectPreclear);
    if (scenario.expectPreclear) assert.deepEqual(managedUpdates, [pid]);
    else assert.deepEqual(managedUpdates, [], "same-PID legacy facts remain unmarked until trusted DB restore or final sync");
    assert.match(result.productCardStatus, /资料刷新失败.*provider timeout/);
  });
}

test("a fresh shell removes template examples before a parse failure", async () => {
  const calls = [];
  const created = cachedProduct({
    documentId: "document-shell",
    documentUrl: "https://feishu.cn/docx/document-shell",
    visualAnalyzedAt: null,
    sku: "",
    coreFunctions: [],
    productParameters: "",
    usageMethod: "",
    targetAudience: "",
    usageScenes: "",
    verifiedPid: "",
    verifiedSourceUrl: "",
    evidenceVersion: "",
    factsVerifiedAt: "",
  });
  globalThis.__feishuAutomationCacheTestHooks = {
    getProductByPid: () => null,
    ensureProductCardShell: async () => {
      calls.push("shell");
      return { documentId: "document-shell", documentUrl: created.documentUrl, reused: false };
    },
    syncProductCardManagedFields: async (_client, input) => {
      calls.push(input.preflightOnly ? "preflight" : input.clearDerived ? "clear" : input.mode);
      return { scanned: 9, updated: 0, missingLabels: [], duplicateLabels: [] };
    },
    createProduct: () => { calls.push("create-product"); return created; },
    parsePublicProductPage: async () => {
      calls.push("parse");
      throw new Error("商品资料解析失败：Qwen 请求超时");
    },
  };

  const result = await automation.handleFeishuAutomation(automationInput());
  assert.deepEqual(calls, ["shell", "preflight", "clear", "identity", "create-product", "parse"]);
  assert.equal(calls.includes("clear"), true,
    "a new template must not expose sample functions as if they belonged to the product");
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

test("a confirmed PID switch isolates old facts before identity and atomically replaces them after success", async () => {
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
    sku: "",
    coreFunctions: [],
    productParameters: "",
    usageMethod: "",
    targetAudience: "",
    usageScenes: "",
    verifiedPid: "",
    verifiedSourceUrl: "",
    evidenceVersion: "",
    factsVerifiedAt: "",
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
    updateProduct: (_id, input) => Object.assign(nextProduct, input),
    mergeVerifiedProductFacts: (_id, input) => Object.assign(nextProduct, mergeVerifiedSnapshot(nextProduct, input)),
    parsePublicProductPage: async () => verifiedParse({
      pid: nextPid,
      sourceUrl: nextUrl,
      verification: {
        status: "complete", verifiedFactCount: 6, rejectedFactCount: 0, missingFields: [],
        verifiedFields: ["sku", "coreFunctions", "productParameters", "usageMethod", "audience", "scenes"],
        evidenceVersion: "test-evidence-v1", sourceUrl: nextUrl,
      },
    }),
  };
  const result = await automation.handleFeishuAutomation(automationInput({ productUrl: nextUrl }));
  assert.equal(syncCalls[0].preflightOnly, true);
  const clear = syncCalls.find((call) => call.clearDerived && call.derivedOnly);
  const finalClear = syncCalls.find((call) => call.clearDerived && call.mode === "verified-basic" && !call.preflightOnly);
  assert.ok(clear, "a confirmed PID switch must clear the previous PID before writing the new identity");
  assert.ok(finalClear, "a confirmed PID switch must atomically replace old derived facts after verification");
  assert.equal(result.pid, nextPid);
  assert.deepEqual(detachedProducts, ["old-product"], "the repurposed row shell must be detached from the old PID");
  assert.equal(oldProduct.documentId, null);
  assert.equal(result.productCardStatus, "已完成");
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
      return { scanned: 9, updated: 0, missingLabels: [], duplicateLabels: [] };
    },
    parsePublicProductPage: async () => { throw new Error("must not parse invalid link"); },
  };
  const result = await automation.handleFeishuAutomation(automationInput({ productUrl: "https://www.tiktok.com/shop" }));
  assert.deepEqual(syncCalls.map((call) => call.preflightOnly ? "preflight" : call.mode), ["preflight", "identity"]);
  assert.equal(syncCalls.some((call) => call.clearDerived), false,
    "a bad input may refresh identity but must not erase derived facts");
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

test("a recovered shell clears then restores its trusted DB snapshot before a failed refresh", async () => {
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
      return { scanned: 9, updated: 6, missingLabels: [], duplicateLabels: [] };
    },
    parsePublicProductPage: async () => { throw new Error("provider timeout"); },
  };
  const result = await automation.handleFeishuAutomation(automationInput());
  assert.deepEqual(syncCalls.map((call) => call.preflightOnly
    ? "preflight"
    : call.derivedOnly ? "preclear" : call.mode === "identity" ? "identity" : "restore"),
  ["preflight", "preclear", "identity", "restore"]);
  const restored = syncCalls.at(-1);
  assert.equal(restored.clearDerived, true);
  assert.deepEqual(restored.coreFunctions, ["防震保护"]);
  assert.equal(restored.productParameters, "硅胶材质");
  assert.match(result.productCardStatus, /资料刷新失败.*已保留上次通过安全校验的资料/);
});

test("a PID switch cannot report completion when its final atomic replacement fails", async () => {
  const calls = [];
  const nextPid = "1732364299482009999";
  const nextUrl = `https://shop.tiktok.com/us/pdp/next-product/${nextPid}?source=anchor`;
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: "old-product", documentId: "existing-document",
      documentUrl: "https://feishu.cn/docx/existing-document",
      lastProductPid: pid, lastProductUrl: productUrl, lastProductName: "手机壳", managedProductPid: pid,
    }),
    getProductByPid: () => cachedProduct({
      id: "next-product", pid: nextPid, productUrl: nextUrl,
      verifiedPid: "", verifiedSourceUrl: "", evidenceVersion: "", factsVerifiedAt: "",
      sku: "", coreFunctions: [], productParameters: "", usageMethod: "", targetAudience: "", usageScenes: "",
    }),
    ensureProductCardShell: async (_client, input) => {
      assert.equal(input.deferIdentity, true);
      calls.push("shell-no-identity");
      return { documentId: "existing-document", documentUrl: "https://feishu.cn/docx/existing-document", reused: true };
    },
    syncProductCardManagedFields: async (_client, input) => {
      if (input.preflightOnly) {
        calls.push("preflight");
        return { scanned: 9, updated: 0, missingLabels: [], duplicateLabels: [] };
      }
      if (input.derivedOnly && input.clearDerived) {
        calls.push("preclear");
        return { scanned: 9, updated: 6, missingLabels: [], duplicateLabels: [] };
      }
      if (input.mode === "verified-basic" && input.clearDerived) {
        calls.push("atomic-replace");
        throw new Error("atomic replace failed");
      }
      calls.push(input.mode === "identity" ? `identity-${input.pid || "empty"}` : "restore-snapshot");
      return { scanned: 9, updated: 3, missingLabels: [] };
    },
    updateProduct: (_id, input) => cachedProduct({ id: "next-product", pid: nextPid, productUrl: nextUrl, ...input }),
    mergeVerifiedProductFacts: (_id, input) => mergeVerifiedSnapshot(cachedProduct({
      id: "next-product", pid: nextPid, productUrl: nextUrl,
      verifiedPid: "", verifiedSourceUrl: "", evidenceVersion: "", factsVerifiedAt: "",
      sku: "", coreFunctions: [], productParameters: "", usageMethod: "", targetAudience: "", usageScenes: "",
    }), input),
    parsePublicProductPage: async () => verifiedParse({
      pid: nextPid,
      sourceUrl: nextUrl,
      verification: {
        status: "complete", verifiedFactCount: 6, rejectedFactCount: 0, missingFields: [],
        verifiedFields: ["sku", "coreFunctions", "productParameters", "usageMethod", "audience", "scenes"],
        evidenceVersion: "test-evidence-v1", sourceUrl: nextUrl,
      },
    }),
  };
  const result = await automation.handleFeishuAutomation(automationInput({ productUrl: nextUrl }));
  assert.deepEqual(calls, [
    "shell-no-identity", "preflight", "preclear", `identity-${nextPid}`, "atomic-replace",
  ]);
  assert.match(result.productCardStatus, /资料刷新失败.*atomic replace failed/);
});

test("a successful click writes only verified managed fields and existing Base columns", async () => {
  const product = cachedProduct({
    documentId: "existing-document",
    documentUrl: "https://feishu.cn/docx/existing-document",
  });
  const parsed = verifiedParse();
  const syncCalls = [];
  let identityUpdate;
  let verifiedMerge;
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
    updateProduct: (_id, input) => { identityUpdate = input; return Object.assign(product, input); },
    mergeVerifiedProductFacts: (_id, input) => {
      verifiedMerge = input;
      return Object.assign(product, mergeVerifiedSnapshot(product, input));
    },
    syncProductCardManagedFields: async (_client, input) => {
      syncCalls.push(input);
      return { scanned: 9, updated: 6, missingLabels: [], duplicateLabels: [] };
    },
  };
  const result = await automation.handleFeishuAutomation(automationInput());
  assert.equal(result.productCardStatus, "已完成");
  assert.deepEqual(identityUpdate, { productUrl, name: "手机壳", pid },
    "ordinary product update may only refresh identity, never certify parser facts");
  assert.deepEqual(verifiedMerge.coreFunctions, ["防震保护"]);
  assert.equal(verifiedMerge.productParameters, "硅胶材质；材质：硅胶");
  assert.deepEqual(syncCalls.map((call) => call.preflightOnly ? "preflight" : call.mode),
    ["preflight", "identity", "verified-basic", "verified-basic"]);
  assert.equal(syncCalls[2].productParameters, "硅胶材质", "the old DB snapshot is restored before parsing");
  assert.equal(syncCalls[2].clearDerived, true);
  assert.equal(syncCalls[3].productParameters, "硅胶材质；材质：硅胶");
  assert.equal(syncCalls[3].clearDerived, true);
  assert.deepEqual(Object.keys(result.patch).sort(), ["产品手卡", "商品ID", "手卡状态"].sort());
  assert.equal(result.patch.产品链接, undefined, "the hyperlink input must never be echoed as plain text");
});

test("a later click restores a DB merge that succeeded before the prior document sync failed", async () => {
  const product = cachedProduct({
    documentId: "existing-document",
    documentUrl: "https://feishu.cn/docx/existing-document",
    productParameters: "材质：旧硅胶",
  });
  const events = [];
  let click = 1;
  let failFirstFinalSync = true;
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: product.id, documentId: product.documentId, documentUrl: product.documentUrl,
      lastProductPid: pid, lastProductUrl: productUrl, lastProductName: product.name, managedProductPid: pid,
    }),
    getProductByPid: () => product,
    ensureProductCardShell: async () => ({
      documentId: product.documentId, documentUrl: product.documentUrl, reused: true,
    }),
    updateProduct: (_id, input) => Object.assign(product, input),
    mergeVerifiedProductFacts: (_id, input) => Object.assign(product, mergeVerifiedSnapshot(product, input)),
    syncProductCardManagedFields: async (_client, input) => {
      const phase = input.preflightOnly ? "preflight"
        : input.mode === "identity" ? "identity"
          : input.productParameters?.includes("材质：TPU") ? "new-snapshot" : "old-snapshot";
      events.push({ click, phase, clearDerived: input.clearDerived, productParameters: input.productParameters });
      if (click === 1 && phase === "new-snapshot" && failFirstFinalSync) {
        failFirstFinalSync = false;
        throw new Error("document sync unavailable");
      }
      return { scanned: 9, updated: 6, missingLabels: [], duplicateLabels: [] };
    },
    parsePublicProductPage: async () => {
      events.push({ click, phase: "parse" });
      if (click === 2) throw new Error("provider timeout on retry");
      return verifiedParse({
        productParameters: "材质：TPU",
        verification: {
          status: "partial", verifiedFactCount: 1, rejectedFactCount: 0,
          missingFields: ["sku", "coreFunctions", "usageMethod", "audience", "scenes"],
          verifiedFields: ["productParameters"], evidenceVersion: "test-evidence-v1", sourceUrl: productUrl,
        },
      });
    },
  };

  const first = await automation.handleFeishuAutomation(automationInput());
  assert.match(first.productCardStatus, /资料刷新失败.*document sync unavailable/);
  assert.equal(product.productParameters, "材质：TPU",
    "the verified DB merge remains durable even when its Feishu patch fails");

  click = 2;
  const second = await automation.handleFeishuAutomation(automationInput());
  const retryEvents = events.filter((event) => event.click === 2);
  assert.deepEqual(retryEvents.map((event) => event.phase), ["preflight", "identity", "new-snapshot", "parse"]);
  assert.equal(retryEvents[2].clearDerived, true);
  assert.equal(retryEvents[2].productParameters, "材质：TPU",
    "the next click repairs the document from DB before attempting the provider again");
  assert.match(second.productCardStatus, /资料刷新失败.*provider timeout on retry.*已保留上次通过安全校验的资料/);
  assert.equal(product.productParameters, "材质：TPU");
});

test("a partial same-version parse writes only nonempty verified fields and retains other trusted facts", async () => {
  const product = cachedProduct({
    documentId: "existing-document",
    documentUrl: "https://feishu.cn/docx/existing-document",
    productParameters: "材质：旧硅胶；尺寸：6.1 英寸",
    usageMethod: "卡扣式安装",
    targetAudience: "手机用户",
    usageScenes: "通勤",
  });
  const parsed = verifiedParse({
    sku: "",
    coreFunctions: [],
    productParameters: "材质：新硅胶",
    usageMethod: "",
    audience: "",
    scenes: "",
    sourceTitle: "",
    verification: {
      status: "partial",
      verifiedFactCount: 1,
      rejectedFactCount: 2,
      missingFields: ["usageMethod", "audience", "scenes"],
      verifiedFields: ["productParameters"],
      evidenceVersion: "test-evidence-v1",
      sourceUrl: productUrl,
    },
  });
  const syncCalls = [];
  let mergeInput;
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: product.id, documentId: product.documentId, documentUrl: product.documentUrl,
      lastProductPid: pid, lastProductUrl: productUrl, lastProductName: product.name, managedProductPid: pid,
    }),
    getProductByPid: () => product,
    ensureProductCardShell: async () => ({
      documentId: product.documentId, documentUrl: product.documentUrl, reused: true,
    }),
    parsePublicProductPage: async () => parsed,
    updateProduct: (_id, input) => Object.assign(product, input),
    mergeVerifiedProductFacts: (_id, input) => {
      mergeInput = input;
      return Object.assign(product, mergeVerifiedSnapshot(product, input));
    },
    syncProductCardManagedFields: async (_client, input) => {
      syncCalls.push(input);
      return { scanned: 9, updated: 1, missingLabels: [], duplicateLabels: [] };
    },
  };

  const result = await automation.handleFeishuAutomation(automationInput());
  assert.match(result.productCardStatus, /^部分完成：已写入 1 条可信资料/);
  assert.equal(mergeInput.productParameters, "尺寸：6.1 英寸；材质：新硅胶");
  assert.equal(mergeInput.usageMethod, "卡扣式安装");
  assert.equal(mergeInput.targetAudience, "手机用户");
  assert.equal(mergeInput.usageScenes, "通勤");
  assert.equal(product.usageMethod, "卡扣式安装");
  assert.equal(product.targetAudience, "手机用户");
  assert.equal(product.usageScenes, "通勤");
  const finalSync = syncCalls.at(-1);
  assert.equal(finalSync.productParameters, "尺寸：6.1 英寸；材质：新硅胶");
  assert.equal(finalSync.usageMethod, "卡扣式安装");
  assert.equal(finalSync.audience, "手机用户");
  assert.equal(finalSync.scenes, "通勤");
  assert.deepEqual(finalSync.coreFunctions, ["防震保护"]);
  assert.equal(finalSync.clearDerived, true,
    "the DB-returned complete trusted snapshot replaces the managed derived area atomically");
});

test("accepted OpenAI inference writes all four managed fields without inflating direct verification", async () => {
  const product = cachedProduct({
    documentId: "existing-document", documentUrl: "https://feishu.cn/docx/existing-document",
    coreFunctions: [], usageMethod: "", targetAudience: "", usageScenes: "",
  });
  const parsed = verifiedParse({
    sku: "", productParameters: "", coreFunctions: ["夜视（AI推断）"],
    usageMethod: "安装后通过手机查看（AI推断）",
    audience: "需要远程查看的家庭用户（AI推断）",
    scenes: "住宅门口（AI推断）",
    verification: {
      status: "complete", verifiedFactCount: 0, rejectedFactCount: 0,
      verifiedFields: [], missingFields: [], evidenceVersion: "complete-pdp-openai-v1", sourceUrl: productUrl,
      acceptedFactCount: 4, acceptedFields: ["coreFunctions", "usageMethod", "audience", "scenes"],
      inferredFactCount: 4, inferredFields: ["coreFunctions", "usageMethod", "audience", "scenes"],
      factProvenance: {
        coreFunctions: [{ value: "夜视（AI推断）", basis: "ai_inference" }],
        usageMethod: [{ value: "安装后通过手机查看（AI推断）", basis: "ai_inference" }],
        audience: [{ value: "需要远程查看的家庭用户（AI推断）", basis: "ai_inference" }],
        scenes: [{ value: "住宅门口（AI推断）", basis: "ai_inference" }],
      },
    },
  });
  let mergeInput;
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({ productId: product.id, documentId: product.documentId, documentUrl: product.documentUrl }),
    getProductByPid: () => product,
    ensureProductCardShell: async () => ({ documentId: product.documentId, documentUrl: product.documentUrl, reused: true }),
    parsePublicProductPage: async () => parsed,
    updateProduct: (_id, input) => Object.assign(product, input),
    mergeVerifiedProductFacts: (_id, input) => {
      mergeInput = input;
      return Object.assign(product, mergeVerifiedSnapshot(product, input));
    },
    syncProductCardManagedFields: async () => ({ scanned: 9, updated: 4, missingLabels: [], duplicateLabels: [] }),
  };

  const result = await automation.handleFeishuAutomation(automationInput());
  assert.equal(result.productCardStatus, "已完成");
  assert.deepEqual(mergeInput.coreFunctions, ["夜视（AI推断）"]);
  assert.equal(mergeInput.usageMethod, "安装后通过手机查看（AI推断）");
  assert.equal(mergeInput.targetAudience, "需要远程查看的家庭用户（AI推断）");
  assert.equal(mergeInput.usageScenes, "住宅门口（AI推断）");
  assert.deepEqual(mergeInput.factProvenance.usageMethod, [
    { value: "安装后通过手机查看（AI推断）", basis: "ai_inference" },
  ]);
});

test("a parse with zero verified facts cannot merge, patch derived fields, or report completion", async () => {
  const product = cachedProduct({
    documentId: "existing-document",
    documentUrl: "https://feishu.cn/docx/existing-document",
  });
  const snapshot = structuredClone(product);
  const syncCalls = [];
  let mergeCalls = 0;
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: product.id, documentId: product.documentId, documentUrl: product.documentUrl,
      lastProductPid: pid, lastProductUrl: productUrl, lastProductName: product.name, managedProductPid: pid,
    }),
    getProductByPid: () => product,
    ensureProductCardShell: async () => ({
      documentId: product.documentId, documentUrl: product.documentUrl, reused: true,
    }),
    parsePublicProductPage: async () => verifiedParse({
      sku: "", coreFunctions: [], productParameters: "", usageMethod: "", audience: "", scenes: "",
      sourceTitle: "", sourceDescription: "", sourceImageUrls: [], visualEvidence: "",
      verification: {
        status: "partial", verifiedFactCount: 0, rejectedFactCount: 4,
        missingFields: ["sku", "coreFunctions", "productParameters", "usageMethod", "audience", "scenes"],
        verifiedFields: [], evidenceVersion: "test-evidence-v1", sourceUrl: productUrl,
      },
    }),
    updateProduct: (_id, input) => Object.assign(product, input),
    mergeVerifiedProductFacts: () => { mergeCalls += 1; return product; },
    syncProductCardManagedFields: async (_client, input) => {
      syncCalls.push(input);
      return { scanned: 9, updated: 0, missingLabels: [], duplicateLabels: [] };
    },
  };

  const result = await automation.handleFeishuAutomation(automationInput());
  assert.equal(mergeCalls, 0);
  const derivedSyncs = syncCalls.filter((call) => call.mode === "verified-basic" && !call.preflightOnly);
  assert.equal(derivedSyncs.length, 1, "only the pre-parse DB snapshot restore is allowed");
  assert.equal(derivedSyncs[0].clearDerived, true);
  assert.deepEqual(derivedSyncs[0].coreFunctions, snapshot.coreFunctions);
  assert.equal(derivedSyncs[0].productParameters, snapshot.productParameters);
  assert.notEqual(result.productCardStatus, "已完成");
  assert.match(result.productCardStatus, /没有取得任何逐条可验证的商品事实/);
  assert.deepEqual(product.coreFunctions, snapshot.coreFunctions);
  assert.equal(product.productParameters, snapshot.productParameters);
});

test("a new evidence version does not promote omitted facts from the previous validator", async () => {
  const product = cachedProduct({
    documentId: "existing-document",
    documentUrl: "https://feishu.cn/docx/existing-document",
    evidenceVersion: "test-evidence-v1",
    coreFunctions: ["旧功能"],
    productParameters: "旧参数",
    usageMethod: "旧方法",
  });
  let mergeInput;
  let finalSync;
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: product.id, documentId: product.documentId, documentUrl: product.documentUrl,
      lastProductPid: pid, lastProductUrl: productUrl, lastProductName: product.name, managedProductPid: pid,
    }),
    getProductByPid: () => product,
    ensureProductCardShell: async () => ({
      documentId: product.documentId, documentUrl: product.documentUrl, reused: true,
    }),
    parsePublicProductPage: async () => verifiedParse({
      sku: "", coreFunctions: [], productParameters: "", usageMethod: "喷涂使用", audience: "", scenes: "",
      sourceTitle: "",
      verification: {
        status: "partial", verifiedFactCount: 1, rejectedFactCount: 0,
        missingFields: ["coreFunctions", "productParameters", "audience", "scenes"],
        verifiedFields: ["usageMethod"], evidenceVersion: "test-evidence-v2", sourceUrl: productUrl,
      },
    }),
    updateProduct: (_id, input) => Object.assign(product, input),
    mergeVerifiedProductFacts: (_id, input) => {
      mergeInput = input;
      return Object.assign(product, mergeVerifiedSnapshot(product, input));
    },
    syncProductCardManagedFields: async (_client, input) => {
      if (input.mode === "verified-basic" && !input.preflightOnly) finalSync = input;
      return { scanned: 9, updated: 1, missingLabels: [], duplicateLabels: [] };
    },
  };

  const result = await automation.handleFeishuAutomation(automationInput());
  assert.match(result.productCardStatus, /^部分完成/);
  assert.equal(mergeInput.usageMethod, "喷涂使用");
  assert.equal(mergeInput.coreFunctions, undefined);
  assert.equal(mergeInput.productParameters, undefined);
  assert.deepEqual(product.coreFunctions, []);
  assert.equal(product.productParameters, "");
  assert.equal(product.usageMethod, "喷涂使用");
  assert.equal(finalSync.usageMethod, "喷涂使用");
  assert.deepEqual(finalSync.coreFunctions, []);
  assert.equal(finalSync.productParameters, "");
  assert.equal(finalSync.audience, "");
  assert.equal(finalSync.scenes, "");
  assert.equal(finalSync.clearDerived, true);
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

test("concurrent partial clicks on one Base row serialize merge and final document sync", async () => {
  let storedProduct = cachedProduct({
    id: "serialized-product",
    documentId: "serialized-document",
    documentUrl: "https://feishu.cn/docx/serialized-document",
    sku: "",
    coreFunctions: [],
    productParameters: "可信初始参数",
    usageMethod: "",
    targetAudience: "",
    usageScenes: "",
  });
  let documentFacts = null;
  const synchronizedCoreSnapshots = [];
  let parseStarts = 0;
  let releaseFirstParse;
  let reportFirstParseStarted;
  const firstParseGate = new Promise((resolve) => { releaseFirstParse = resolve; });
  const firstParseStarted = new Promise((resolve) => { reportFirstParseStarted = resolve; });
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: storedProduct.id,
      documentId: storedProduct.documentId,
      documentUrl: storedProduct.documentUrl,
      lastProductPid: pid,
      lastProductUrl: productUrl,
      lastProductName: storedProduct.name,
      managedProductPid: pid,
    }),
    getProductByPid: () => structuredClone(storedProduct),
    ensureProductCardShell: async () => ({
      documentId: storedProduct.documentId,
      documentUrl: storedProduct.documentUrl,
      reused: true,
    }),
    updateProduct: (_id, input) => {
      storedProduct = { ...storedProduct, ...input };
      return structuredClone(storedProduct);
    },
    mergeVerifiedProductFacts: (_id, input) => {
      storedProduct = mergeVerifiedSnapshot(storedProduct, input);
      return structuredClone(storedProduct);
    },
    syncProductCardManagedFields: async (_client, input) => {
      if (input.mode === "verified-basic" && !input.preflightOnly && !input.derivedOnly) {
        synchronizedCoreSnapshots.push([...(input.coreFunctions || [])]);
        documentFacts = {
          sku: input.sku || "",
          coreFunctions: [...(input.coreFunctions || [])],
          productParameters: input.productParameters || "",
          usageMethod: input.usageMethod || "",
          targetAudience: input.audience || "",
          usageScenes: input.scenes || "",
        };
      }
      return { scanned: 9, updated: 6, missingLabels: [], duplicateLabels: [] };
    },
    parsePublicProductPage: async () => {
      parseStarts += 1;
      const current = parseStarts;
      if (current === 1) {
        reportFirstParseStarted();
        await firstParseGate;
      }
      const fact = current === 1 ? "功能A" : "功能B";
      return verifiedParse({
        sku: "",
        coreFunctions: [fact],
        productParameters: "",
        usageMethod: "",
        audience: "",
        scenes: "",
        sourceTitle: "",
        verification: {
          status: "partial", verifiedFactCount: 1, rejectedFactCount: 0,
          missingFields: ["sku", "productParameters", "usageMethod", "audience", "scenes"],
          verifiedFields: ["coreFunctions"], evidenceVersion: "test-evidence-v1", sourceUrl: productUrl,
        },
      });
    },
  };

  const rowInput = { ...automationInput(), recordId: "record-concurrent-partial" };
  const first = automation.handleFeishuAutomation(rowInput);
  await firstParseStarted;
  const second = automation.handleFeishuAutomation(rowInput);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(parseStarts, 1,
    "the second click must not read or parse while the first row transaction is still open");
  releaseFirstParse();
  const results = await Promise.all([first, second]);

  assert.deepEqual(results.map((result) => result.productCardStatus.startsWith("部分完成")), [true, true]);
  assert.deepEqual(storedProduct.coreFunctions, ["功能A", "功能B"]);
  assert.deepEqual(synchronizedCoreSnapshots, [[], ["功能A"], ["功能A"], ["功能A", "功能B"]],
    "click two must restore A before parsing B, then publish the complete A+B snapshot");
  assert.deepEqual(documentFacts, {
    sku: storedProduct.sku,
    coreFunctions: storedProduct.coreFunctions,
    productParameters: storedProduct.productParameters,
    usageMethod: storedProduct.usageMethod,
    targetAudience: storedProduct.targetAudience,
    usageScenes: storedProduct.usageScenes,
  }, "the final document snapshot must exactly match the final atomic DB snapshot");
});

test("concurrent partial clicks from different rows merge against the latest same-PID snapshot", async () => {
  let storedProduct = cachedProduct({
    id: "cross-row-product",
    documentId: "doc-row-a",
    documentUrl: "https://feishu.cn/docx/doc-row-a",
    sku: "", coreFunctions: [], productParameters: "", usageMethod: "", targetAudience: "", usageScenes: "",
  });
  const finalDocumentSnapshots = new Map();
  const parseStarted = new Map();
  for (const row of ["row-a", "row-b"]) {
    let release;
    let report;
    const gate = new Promise((resolve) => { release = resolve; });
    parseStarted.set(row, { promise: new Promise((resolve) => { report = resolve; }), gate, release, report });
  }
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: ({ recordId }) => ({
      productId: storedProduct.id,
      documentId: `doc-${recordId}`,
      documentUrl: `https://feishu.cn/docx/doc-${recordId}`,
      lastProductPid: pid, lastProductUrl: productUrl, lastProductName: storedProduct.name, managedProductPid: pid,
    }),
    getProductByPid: () => structuredClone(storedProduct),
    ensureProductCardShell: async (_client, input) => ({
      documentId: `doc-${input.recordKey.recordId}`,
      documentUrl: `https://feishu.cn/docx/doc-${input.recordKey.recordId}`,
      reused: true,
    }),
    updateProduct: (_id, input) => {
      storedProduct = { ...storedProduct, ...input };
      return structuredClone(storedProduct);
    },
    mergeVerifiedProductFacts: (_id, input) => {
      storedProduct = mergeVerifiedSnapshot(storedProduct, input);
      return structuredClone(storedProduct);
    },
    syncProductCardManagedFields: async (_client, input) => {
      if (input.mode === "verified-basic" && !input.preflightOnly && input.clearDerived) {
        finalDocumentSnapshots.set(input.documentId, [...(input.coreFunctions || [])]);
      }
      return { scanned: 9, updated: 6, missingLabels: [], duplicateLabels: [] };
    },
    parsePublicProductPage: async (_url, options) => {
      const row = options.productName === "产品A" ? "row-a" : "row-b";
      parseStarted.get(row).report();
      await parseStarted.get(row).gate;
      const fact = row === "row-a" ? "功能A" : "功能B";
      return verifiedParse({
        coreFunctions: [fact], sku: "", productParameters: "", usageMethod: "", audience: "", scenes: "",
        sourceTitle: "",
        verification: {
          status: "partial", verifiedFactCount: 1, rejectedFactCount: 0,
          missingFields: ["sku", "productParameters", "usageMethod", "audience", "scenes"],
          verifiedFields: ["coreFunctions"], evidenceVersion: "test-evidence-v1", sourceUrl: productUrl,
        },
      });
    },
  };

  const rowA = automation.handleFeishuAutomation({
    ...automationInput({ productName: "产品A" }), recordId: "row-a",
  });
  const rowB = automation.handleFeishuAutomation({
    ...automationInput({ productName: "产品B" }), recordId: "row-b",
  });
  await Promise.all([parseStarted.get("row-a").promise, parseStarted.get("row-b").promise]);
  parseStarted.get("row-a").release();
  await new Promise((resolve) => setImmediate(resolve));
  parseStarted.get("row-b").release();
  const results = await Promise.all([rowA, rowB]);

  assert.deepEqual(results.map((result) => result.productCardStatus.startsWith("部分完成")), [true, true]);
  assert.deepEqual(storedProduct.coreFunctions, ["功能A", "功能B"],
    "the second row must re-read the A snapshot while holding the shared product lock");
  assert.deepEqual(finalDocumentSnapshots.get("doc-row-b"), ["功能A", "功能B"]);
});

test("concurrent rows for one PID create only one internal product", async () => {
  let storedProduct = null;
  let createCalls = 0;
  const parsed = verifiedParse();
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
  const syncCalls = [];
  let parseCalls = 0;
  let mergeCalls = 0;
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
    parsePublicProductPage: async () => { parseCalls += 1; return ({
      sku: "CASE-01", coreFunctions: ["防震保护"], productParameters: "材质：硅胶",
      usageMethod: "套入手机", audience: "手机用户", scenes: "日常使用",
      sourceTitle: "Silicone Case", sourceDescription: "", sourceImageUrls: [],
      visualEvidence: "", visualAnalysisStatus: "unavailable",
    }); },
    updateProduct: (_id, input) => ({ ...product, ...input }),
    mergeVerifiedProductFacts: () => { mergeCalls += 1; return product; },
    syncProductCardManagedFields: async (_client, input) => {
      syncCalls.push(input);
      return { scanned: 8, updated: 0, matchedLabels: [], missingLabels: ["产品参数"], duplicateLabels: [] };
    },
  };
  const result = await automation.handleFeishuAutomation(automationInput());
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].preflightOnly, true);
  assert.equal(parseCalls, 0);
  assert.equal(mergeCalls, 0);
  assert.notEqual(result.productCardStatus, "已完成");
  assert.match(result.productCardStatus, /资料刷新失败.*模板缺少基础字段.*产品参数/);
  assert.equal(result.documentUrl, product.documentUrl);
});

test("duplicate managed template labels abort preflight with zero document patches", async () => {
  const product = cachedProduct({ documentId: "document-shell", documentUrl: "https://feishu.cn/docx/document-shell" });
  const syncCalls = [];
  let parseCalls = 0;
  globalThis.__feishuAutomationCacheTestHooks = {
    getFeishuProductCardMapping: () => ({
      productId: product.id, documentId: product.documentId, documentUrl: product.documentUrl,
      lastProductPid: pid, lastProductUrl: productUrl, lastProductName: product.name, managedProductPid: pid,
    }),
    getProductByPid: () => product,
    ensureProductCardShell: async () => ({
      documentId: product.documentId, documentUrl: product.documentUrl, reused: true,
    }),
    parsePublicProductPage: async () => { parseCalls += 1; return verifiedParse(); },
    syncProductCardManagedFields: async (_client, input) => {
      syncCalls.push(input);
      return { scanned: 10, updated: 0, missingLabels: [], duplicateLabels: ["产品参数"] };
    },
  };

  const result = await automation.handleFeishuAutomation(automationInput());
  assert.equal(syncCalls.length, 1, "preflight must be the only document operation");
  assert.equal(syncCalls[0].preflightOnly, true);
  assert.equal(parseCalls, 0);
  assert.match(result.productCardStatus, /资料刷新失败.*重复基础字段.*产品参数/);
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
