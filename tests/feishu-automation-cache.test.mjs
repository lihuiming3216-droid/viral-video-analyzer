import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const automationSource = await readFile(new URL("../lib/feishu/automation.ts", import.meta.url), "utf8");

async function loadAutomationModule() {
  const stubSource = `
    const hooks = () => globalThis.__manualCardTestHooks || {};
    export const claimFeishuProductCardDocument = (...args) => hooks().claim?.(...args) ?? true;
    export const clearProductDocumentLink = (...args) => hooks().clear?.(...args) ?? null;
    export const createProduct = (...args) => hooks().createProduct?.(...args) ?? null;
    export const createVideo = () => null;
    export const deleteFeishuAutomationJob = () => {};
    export const getFeishuAutomationJobs = () => [];
    export const getFeishuProductCardMapping = (...args) => hooks().mapping?.(...args) ?? null;
    export const getProduct = (...args) => hooks().getProduct?.(...args) ?? null;
    export const getProductByPid = (...args) => hooks().getProductByPid?.(...args) ?? null;
    export const getVideo = () => null;
    export const getVideoBySourceUrl = () => null;
    export const listFeishuAutomationJobVideoIds = () => [];
    export const saveFeishuAutomationJob = () => {};
    export const updateProduct = (...args) => hooks().updateProduct?.(...args) ?? null;
    export const updateVideo = () => null;
    export const upsertFeishuProductCardMapping = (...args) => hooks().upsert?.(...args) ?? args[0];
    export const ensureFeishuConnection = async () => null;
    export const getConnectedFeishuChannel = () => null;
    export const ensureProductCardShell = (...args) => hooks().ensureShell(...args);
    export const renameProductCardDocument = (...args) => hooks().rename(...args);
    export const enqueueVideos = () => {};
    export const extractProductIdFromUrl = (url) => (String(url).match(/\\d{6,}/g) || []).sort((a, b) => b.length - a.length)[0] || "";
    export const conciseProductDocAnalysis = () => "";
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
    .replaceAll('"@/lib/product-doc-analysis"', JSON.stringify(stubUrl));
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const automation = await loadAutomationModule();
const pid = "1732364299482009895";

test("manual-only click copies and renames the template without requiring a product link", async () => {
  const renameCalls = [];
  const created = {
    id: "product-1", name: "血压仪大号", pid, productUrl: "",
    documentId: "manual-doc", documentUrl: "https://feishu.cn/docx/manual-doc",
  };
  globalThis.__manualCardTestHooks = {
    getProductByPid: () => null,
    createProduct: () => created,
    ensureShell: async () => ({
      documentId: created.documentId,
      documentUrl: created.documentUrl,
      reused: false,
      permissionWarning: "",
      ownershipWarning: "",
    }),
    rename: async (_client, documentId, name, productPid) => {
      renameCalls.push({ documentId, name, pid: productPid });
      return `${name}_${productPid}`;
    },
  };
  const result = await automation.handleFeishuAutomation({
    client: {}, appToken: "app", tableId: "table", recordId: "row",
    fields: { 产品名称: "血压仪大号", 商品ID: pid, 产品手卡: "" },
    writeBack: false,
  });
  assert.deepEqual(renameCalls, [{ documentId: "manual-doc", name: "血压仪大号", pid }]);
  assert.equal(result.productCardStatus, "手卡已就绪，请手动填写");
  assert.equal(result.productRefreshError, "");
  assert.equal(result.patch.产品手卡, created.documentUrl);
});

test("an existing row card remains row-specific and is renamed in place", async () => {
  const renameCalls = [];
  const documentUrl = "https://tenant.feishu.cn/docx/existing-card";
  const product = { id: "product-2", name: "旧名", pid, productUrl: "", documentId: null, documentUrl: null };
  globalThis.__manualCardTestHooks = {
    mapping: () => ({ documentId: "existing-card", documentUrl }),
    getProductByPid: () => product,
    updateProduct: (_id, updates) => Object.assign(product, updates),
    ensureShell: async (_client, input) => ({
      documentId: input.existingDocumentId,
      documentUrl: input.existingDocumentUrl,
      reused: true,
      permissionWarning: "",
      ownershipWarning: "",
    }),
    rename: async (_client, documentId, name, productPid) => renameCalls.push({ documentId, name, pid: productPid }),
  };
  const result = await automation.handleFeishuAutomation({
    client: {}, appToken: "app", tableId: "table", recordId: "existing-row",
    fields: { 产品名称: "新名称", 商品ID: pid, 产品手卡: { text: "打开", link: documentUrl } },
    writeBack: false,
  });
  assert.deepEqual(renameCalls, [{ documentId: "existing-card", name: "新名称", pid }]);
  assert.equal(result.documentUrl, documentUrl);
});
