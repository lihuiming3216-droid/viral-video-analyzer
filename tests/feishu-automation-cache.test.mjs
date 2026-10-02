import assert from "node:assert/strict";
import test from "node:test";
import { loadAutomationFixture } from "./helpers/automation-fixture.mjs";
const catalogFields = { sku: "产品SKU", coreFunctions: "产品主要功能", productParameters: "产品参数", usageMethod: "使用方法", audience: "适用人群", scenes: "使用场景" };
const hooks = new Proxy({}, { get: (_target, name) => {
    const h = globalThis.__manualCardTestHooks || {};
    if (name === "getFeishuFieldMapping")
      return () => null;
    if (name === "getFeishuProductCardMapping")
      return h.mapping || (() => null);
    if (name === "upsertFeishuProductCardMapping")
      return h.upsert || (() => { });
    if (name === "ensureProductCardByPid")
      return h.ensureByPid;
    if (name === "syncProductCardManagedFields")
      return h.sync || (() => ({ currentValues: { 商品ID: "1732364299482009895" }, duplicateLabels: [], missingLabels: [], skippedLabels: [] }));
    if (name === "getProductCatalog")
      return () => ({ fields: Object.fromEntries(Object.keys(catalogFields).map(k => [k, { text: k, basis: "direct" }])), warnings: [] });
    if (name === "getProductMetadataByPid")
      return () => null;
    if (name === "getProduct")
      return h.getProduct || (() => null);
    return h[name];
  } });
const automation = await loadAutomationFixture({ after: callback => test.after(callback) }, hooks);
const pid = "1732364299482009895";
test("legacy button payload hydrates only current-row product-card fields", () => {
  const hydrated = automation.hydrateAutomationProductFields({ 产品名称: "血压仪大号" }, {
    产品名称: "血压仪大号",
    PID: pid,
    产品手卡: { text: "打开", link: "https://tenant.feishu.cn/docx/manual-doc" },
    样片链接: "https://www.tiktok.com/t/should-not-enter-video-branch/",
    视频分析: "人工内容",
  });
  assert.equal(automation.resolveAutomationFields(hydrated).pid, pid);
  assert.equal(automation.resolveAutomationFields(hydrated).productDocument, "https://tenant.feishu.cn/docx/manual-doc");
  assert.equal("样片链接" in hydrated, false);
  assert.equal("视频分析" in hydrated, false);
});
test("PID click copies the template and fills empty basic facts without requiring a product link", async () => {
  const ensureCalls = [];
  const currentValues = {商品ID:pid};
  const created = {
    id: "product-1", name: "血压仪大号", pid, productUrl: "",
    documentId: "manual-doc", documentUrl: "https://feishu.cn/docx/manual-doc",
  };
  globalThis.__manualCardTestHooks = {
    getProductByPid: () => null,
    createProduct: () => created,
    sync: (_client,input) => {
      if (!input.preflightOnly && input.mode === "verified-basic") {
        Object.assign(currentValues,{产品SKU:input.sku,产品主要功能:input.coreFunctions?.join("；"),产品参数:input.productParameters,
          使用方法:input.usageMethod,适用人群:input.audience,使用场景:input.scenes});
      }
      return {currentValues:{...currentValues},duplicateLabels:[],missingLabels:[],skippedLabels:[]};
    },
    ensureByPid: async (_client, input) => {
      ensureCalls.push(input);
      return {
        documentId: created.documentId,
        documentUrl: created.documentUrl,
        reused: false,
        permissionWarning: "",
        ownershipWarning: "",
      };
    },
  };
  const result = await automation.handleFeishuAutomation({
    client: {}, appToken: "app", tableId: "table", recordId: "row",
    fields: { 产品名称: "血压仪大号", 商品ID: pid, 产品手卡: "" },
    writeBack: false,
  });
  assert.equal(ensureCalls.length, 1);
  assert.equal(ensureCalls[0].name, "血压仪大号");
  assert.equal(ensureCalls[0].pid, pid);
  assert.equal(result.productCardStatus, "手卡空白基础资料已补录，已有内容保留");
  assert.equal(result.productRefreshError, "");
  assert.equal(result.patch.产品手卡, created.documentUrl);
});
test("same PID on another row reuses the PID document instead of the row mapping", async () => {
  const ensureCalls = [];
  const documentUrl = "https://tenant.feishu.cn/docx/existing-card";
  const product = { id: "product-2", name: "旧名", pid, productUrl: "", documentId: null, documentUrl: null };
  globalThis.__manualCardTestHooks = {
    getProductByPid: () => product,
    updateProduct: (_id, updates) => Object.assign(product, updates),
    ensureByPid: async (_client, input) => {
      ensureCalls.push(input);
      return {
        documentId: "existing-card",
        documentUrl,
        reused: true,
        permissionWarning: "",
        ownershipWarning: "",
      };
    },
  };
  const result = await automation.handleFeishuAutomation({
    client: {}, appToken: "app", tableId: "table", recordId: "existing-row",
    fields: { 产品名称: "新名称", 商品ID: pid, 产品手卡: { text: "打开", link: documentUrl } },
    writeBack: false,
  });
  assert.equal(ensureCalls.length, 1);
  assert.equal(ensureCalls[0].name, "新名称");
  assert.equal(ensureCalls[0].pid, pid);
  assert.equal(result.documentUrl, documentUrl);
  assert.equal(product.documentId, "existing-card");
});
