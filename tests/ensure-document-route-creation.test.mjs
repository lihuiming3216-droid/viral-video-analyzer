import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const routeSource = await readFile(
  new URL("../app/api/products/ensure-document/route.ts", import.meta.url),
  "utf8",
);

async function loadRouteModule() {
  const stubSource = `
    const hooks = () => globalThis.__ensureDocumentRouteTestHooks || {};
    export class NextRequest {}
    export const NextResponse = { json: (body, init = {}) => ({ body, status: init.status || 200 }) };
    export const createProduct = (...args) => hooks().createProduct(...args);
    export const getProductByPid = (...args) => hooks().getProductByPid?.(...args) ?? null;
    export const mergeVerifiedProductFacts = (...args) => hooks().mergeVerifiedProductFacts?.(...args) ?? null;
    export const updateProduct = (...args) => hooks().updateProduct?.(...args) ?? null;
    export const ensureProductDocument = (...args) => hooks().ensureProductDocument(...args);
    export const ensureFeishuConnection = (...args) => hooks().ensureFeishuConnection?.(...args) ?? null;
    export const getConnectedFeishuChannel = (...args) => hooks().getConnectedFeishuChannel?.(...args) ?? null;
    export const isExactTikTokProductSource = (...args) => hooks().isExactTikTokProductSource?.(...args) ?? true;
    export const parsePublicProductPage = (...args) => hooks().parsePublicProductPage(...args);
  `;
  const stubUrl = `data:text/javascript;base64,${Buffer.from(stubSource).toString("base64")}`;
  let compiled = ts.transpileModule(routeSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const specifier of [
    "next/server",
    "@/lib/database",
    "@/lib/feishu/document",
    "@/lib/feishu/runtime",
    "@/lib/product-parser",
  ]) compiled = compiled.replaceAll(JSON.stringify(specifier), JSON.stringify(stubUrl));
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  return import(moduleUrl);
}

const route = await loadRouteModule();
const pid = "1732364299482009895";
const productUrl = `https://shop.tiktok.com/us/pdp/anime-phone-case/${pid}`;

function request(overrides = {}) {
  return {
    json: async () => ({ name: "手机壳", pid, productUrl, ...overrides }),
  };
}

function product() {
  return {
    id: "product-1",
    name: "手机壳",
    pid,
    productUrl,
    sellingPoints: "",
    productParameters: "",
    usageMethod: "",
    targetAudience: "",
    usageScenes: "",
    coreFunctions: [],
    propImages: [],
    visualAnalyzedAt: null,
    verifiedPid: "",
    verifiedSourceUrl: "",
    evidenceVersion: "",
    factsVerifiedAt: "",
  };
}

test("ensure-document creates nothing when a new PID fails parsing", async () => {
  let createCalls = 0;
  let updateCalls = 0;
  let documentCalls = 0;
  globalThis.__ensureDocumentRouteTestHooks = {
    getProductByPid: () => null,
    createProduct: () => { createCalls += 1; return product(); },
    updateProduct: () => { updateCalls += 1; return null; },
    parsePublicProductPage: async () => { throw new Error("商品资料解析失败：AI 提取未得到足够的可验证资料（Qwen 请求超时）；官方商品页路径也没有足够的确定性白名单资料"); },
    ensureProductDocument: async () => { documentCalls += 1; },
  };

  const response = await route.POST(request());
  assert.equal(response.status, 500);
  assert.match(response.body.error, /Qwen 请求超时/);
  assert.equal(createCalls, 0);
  assert.equal(updateCalls, 0);
  assert.equal(documentCalls, 0);
});

test("explicit parseProduct:false keeps the manual creation path", async () => {
  let createCalls = 0;
  let parseCalls = 0;
  let documentCalls = 0;
  globalThis.__ensureDocumentRouteTestHooks = {
    getProductByPid: () => null,
    createProduct: () => { createCalls += 1; return product(); },
    parsePublicProductPage: async () => { parseCalls += 1; throw new Error("must not parse"); },
    getConnectedFeishuChannel: () => ({ rawClient: {} }),
    ensureProductDocument: async () => {
      documentCalls += 1;
      return { documentId: "document", documentUrl: "https://feishu.cn/docx/document" };
    },
  };

  const response = await route.POST(request({ parseProduct: false }));
  assert.equal(response.status, 200);
  assert.equal(createCalls, 1);
  assert.equal(parseCalls, 0);
  assert.equal(documentCalls, 1);
});

test("partial refresh renders the complete merged verified snapshot", async () => {
  const existing = {
    ...product(),
    coreFunctions: ["旧有可信功能"],
    productParameters: "分辨率：2.5K",
    verifiedPid: pid,
    verifiedSourceUrl: productUrl,
    evidenceVersion: "exact-pdp-atomic-v1",
    factsVerifiedAt: "2026-08-12T00:00:00.000Z",
  };
  const merged = {
    ...existing,
    usageMethod: "点击按钮启动",
    factsVerifiedAt: "2026-08-12T01:00:00.000Z",
  };
  let current = existing;
  let documentInput = null;
  globalThis.__ensureDocumentRouteTestHooks = {
    getProductByPid: () => current,
    updateProduct: () => current,
    parsePublicProductPage: async () => ({
      sku: "",
      coreFunctions: [],
      productParameters: "",
      usageMethod: "点击按钮启动",
      audience: "",
      scenes: "",
      sellingPoints: "",
      sourceTitle: "Exact product",
      sourceDescription: "",
      sourceImageUrls: [],
      visualEvidence: "",
      visualAnalysisStatus: "unavailable",
      verification: {
        status: "partial",
        verifiedFactCount: 1,
        rejectedFactCount: 0,
        verifiedFields: ["usageMethod"],
        missingFields: ["sku", "coreFunctions", "productParameters", "audience", "scenes"],
        sourceUrl: productUrl,
        evidenceVersion: "exact-pdp-atomic-v1",
      },
    }),
    mergeVerifiedProductFacts: () => {
      current = merged;
      return merged;
    },
    getConnectedFeishuChannel: () => ({ rawClient: {} }),
    ensureProductDocument: async (_client, _product, input) => {
      documentInput = input;
      return { documentId: "document", documentUrl: "https://feishu.cn/docx/document" };
    },
  };

  const response = await route.POST(request({ forceProductParse: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(documentInput.coreFunctions, ["旧有可信功能"]);
  assert.equal(documentInput.productParameters, "分辨率：2.5K");
  assert.equal(documentInput.usageMethod, "点击按钮启动");
});

test("labelled OpenAI inference is accepted without pretending it was directly verified", async () => {
  let current = product();
  let mergeInput = null;
  const inferred = {
    coreFunctions: ["辅助查看门外情况（AI推断）"],
    usageMethod: "安装后通过手机查看（AI推断）",
    audience: "需要查看访客的家庭用户（AI推断）",
    scenes: "住宅门口访客查看（AI推断）",
  };
  globalThis.__ensureDocumentRouteTestHooks = {
    getProductByPid: () => current,
    updateProduct: () => current,
    parsePublicProductPage: async () => ({
      sku: "", productParameters: "", sellingPoints: "", sourceTitle: "Exact product",
      sourceDescription: "", sourceImageUrls: [], visualEvidence: "", visualAnalysisStatus: "completed",
      ...inferred,
      verification: {
        status: "complete",
        verifiedFactCount: 0,
        acceptedFactCount: 4,
        inferredFactCount: 4,
        rejectedFactCount: 0,
        verifiedFields: [],
        acceptedFields: ["coreFunctions", "usageMethod", "audience", "scenes"],
        inferredFields: ["coreFunctions", "usageMethod", "audience", "scenes"],
        missingFields: [],
        sourceUrl: productUrl,
        evidenceVersion: "complete-pdp-openai-v1",
        factProvenance: {
          coreFunctions: [{ value: inferred.coreFunctions[0], basis: "ai_inference" }],
          usageMethod: [{ value: inferred.usageMethod, basis: "ai_inference" }],
          audience: [{ value: inferred.audience, basis: "ai_inference" }],
          scenes: [{ value: inferred.scenes, basis: "ai_inference" }],
        },
      },
    }),
    mergeVerifiedProductFacts: (_id, input) => {
      mergeInput = input;
      current = { ...current, ...inferred };
      return current;
    },
    getConnectedFeishuChannel: () => ({ rawClient: {} }),
    ensureProductDocument: async () => ({ documentId: "document", documentUrl: "https://feishu.cn/docx/document" }),
  };

  const response = await route.POST(request({ forceProductParse: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(mergeInput.coreFunctions, inferred.coreFunctions);
  assert.equal(mergeInput.usageMethod, inferred.usageMethod);
  assert.equal(mergeInput.factProvenance.coreFunctions[0].basis, "ai_inference");
});
