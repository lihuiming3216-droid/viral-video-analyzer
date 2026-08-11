import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const documentSource = await readFile(
  new URL("../lib/feishu/document.ts", import.meta.url),
  "utf8",
);

async function loadDocumentModule() {
  const stubSource = `
    const hooks = () => globalThis.__feishuDocumentTestHooks || {};
    export const getProduct = (...args) => hooks().getProduct?.(...args) ?? null;
    export const getVideo = (...args) => hooks().getVideo?.(...args) ?? null;
    export const updateProduct = (...args) => hooks().updateProduct?.(...args) ?? null;
    export const clearProductDocumentLink = (...args) => hooks().clearProductDocumentLink?.(...args) ?? null;
    export const formatTime = () => "";
    export const resolveMediaPath = (value) => value;
    export const getFeishuDocument = () => null;
    export const getFeishuFolder = () => null;
    export const getFeishuSettings = () => hooks().getFeishuSettings?.() ?? {};
    export const saveFeishuDocument = () => {};
    export const saveFeishuFolder = () => {};
    export const setFeishuRootFolder = () => {};
  `;
  const stubUrl = `data:text/javascript;base64,${Buffer.from(stubSource).toString("base64")}`;
  let compiled = ts.transpileModule(documentSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  compiled = compiled
    .replace('import "server-only";', "")
    .replaceAll('"@/lib/database"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/json-utils"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/video-processing"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/feishu/store"', JSON.stringify(stubUrl));
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  return import(moduleUrl);
}

const documentModule = await loadDocumentModule();
const targetOwnerOpenId = "ou_target_owner";

function validFolderMembers(ownerOpenId = targetOwnerOpenId) {
  return [
    { member_type: "openid", member_id: ownerOpenId, perm: "full_access", type: "user", name: "Owner" },
    { member_type: "openchat", member_id: "oc_management_group", perm: "full_access", type: "chat", name: "管理群" },
  ];
}

function sdkError(code, msg) {
  const error = new Error("Request failed");
  error.response = { data: { code, msg } };
  return error;
}

function migrationClient(firstOwnerLookup, members = validFolderMembers()) {
  let ownerReads = 0;
  let transfers = 0;
  return {
    client: {
      request: async () => ({
        code: 0,
        data: { token: "folder-token", name: "产品说明文档", ownUid: "unusable-folder-own-uid" },
      }),
      drive: {
        v1: {
          file: {
            list: async () => ({
              code: 0,
              data: { files: [{ token: "document-token", type: "docx" }], has_more: false },
            }),
          },
          meta: {
            batchQuery: async () => {
              ownerReads += 1;
              if (ownerReads === 1) {
                if (firstOwnerLookup instanceof Error) throw firstOwnerLookup;
                return firstOwnerLookup;
              }
              return {
                code: 0,
                data: { metas: [{ doc_token: "document-token", owner_id: targetOwnerOpenId }] },
              };
            },
          },
          permissionMember: {
            list: async () => ({ code: 0, data: { items: members } }),
            transferOwner: async () => {
              transfers += 1;
              return { code: 0 };
            },
          },
        },
      },
    },
    transferCount: () => transfers,
  };
}

function product(overrides = {}) {
  return {
    id: "product-1",
    name: "Stable Product",
    pid: "1732507663809155965",
    sku: "",
    documentId: null,
    documentUrl: null,
    productUrl: "https://www.tiktok.com/view/product/1732507663809155965",
    targetAudience: "",
    propImages: [],
    ...overrides,
  };
}

function ensureClient(options = {}) {
  const state = {
    file: options.file || null,
    owner: options.owner || "application-owner-open-id",
    copyCount: 0,
    transferCount: 0,
    loseFirstCopyResponse: options.loseFirstCopyResponse === true,
    deletedToken: options.deletedToken || "",
    copyDelayMs: options.copyDelayMs || 0,
  };
  const client = {
    request: async ({ url, data }) => {
      if (url.includes("/drive/explorer/v2/folder/")) {
        return { code: 0, data: { name: "产品说明文档", ownUid: "never-use-this-id" } };
      }
      if (url.includes("/copy")) {
        state.copyCount += 1;
        if (state.copyDelayMs) await new Promise((resolve) => setTimeout(resolve, state.copyDelayMs));
        state.file = {
          token: "created-document-token",
          name: data?.name || "Stable Product_1732507663809155965",
          type: "docx",
          url: "https://feishu.cn/docx/created-document-token",
        };
        if (state.loseFirstCopyResponse && state.copyCount === 1) {
          throw sdkError(5990001, "copy response lost");
        }
        return { code: 0, data: { file: state.file } };
      }
      if (url.includes("/docx/v1/documents/") && url.endsWith("/blocks")) {
        return { code: 0, data: { items: [] } };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    drive: {
      v2: { permissionPublic: { patch: async () => ({ code: 0 }) } },
      v1: {
        permissionMember: {
          list: async () => ({ code: 0, data: { items: validFolderMembers() } }),
          transferOwner: async () => {
            state.transferCount += 1;
            state.owner = targetOwnerOpenId;
            return { code: 0 };
          },
        },
        file: {
          list: async () => ({
            code: 0,
            data: { files: state.file ? [state.file] : [], has_more: false },
          }),
        },
        meta: {
          batchQuery: async ({ data }) => {
            const token = data.request_docs[0].doc_token;
            if (token === state.deletedToken) throw sdkError(1770002, "document deleted");
            return { code: 0, data: { metas: [{ doc_token: token, owner_id: state.owner }] } };
          },
        },
      },
    },
  };
  return { client, state };
}

test("product documents use the dedicated folder and explicit OpenID", async () => {
  const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  assert.match(documentSource, /FEISHU_PRODUCT_DOCUMENT_OWNER_OPEN_ID/);
  assert.match(documentSource, /ownerMemberType: "openid"/);
  assert.match(documentSource, /user_id_type: "open_id"/);
  assert.doesNotMatch(documentSource, /member_type:\s*"userid"|user_id_type:\s*"user_id"/);
  assert.doesNotMatch(documentSource, /isInvalidApplicationOwnerLookup|99992359/);
  assert.match(compose, /FEISHU_PRODUCT_DOCUMENT_OWNER_OPEN_ID: \$\{FEISHU_PRODUCT_DOCUMENT_OWNER_OPEN_ID:-\}/);
});

test("folder validation requires the owner and a management group at full_access", async () => {
  const harness = migrationClient({
    code: 0,
    data: { metas: [{ doc_token: "document-token", owner_id: "application-owner" }] },
  });
  const validated = await documentModule.validateProductDocumentFolder(
    harness.client,
    "folder-token",
    targetOwnerOpenId,
  );
  assert.equal(validated.ownerId, targetOwnerOpenId);
  assert.equal(validated.ownerMemberType, "openid");
  assert.equal(validated.folderMetaOwnerId, "unusable-folder-own-uid");

  const noGroup = migrationClient({ code: 0, data: { metas: [] } }, validFolderMembers().slice(0, 1));
  await assert.rejects(
    documentModule.validateProductDocumentFolder(noGroup.client, "folder-token", targetOwnerOpenId),
    /缺少可管理群协作者/,
  );

  const noOwner = migrationClient({ code: 0, data: { metas: [] } }, validFolderMembers("ou_someone_else"));
  await assert.rejects(
    documentModule.validateProductDocumentFolder(noOwner.client, "folder-token", targetOwnerOpenId),
    /不是该文件夹的直接可管理用户/,
  );

});

test("ownership transfer uses explicit OpenID and verifies the result", async () => {
  const harness = migrationClient({
    code: 0,
    data: { metas: [{ doc_token: "document-token", owner_id: "application-owner-open-id" }] },
  });
  const result = await documentModule.migrateProductDocument(harness.client, {
    documentToken: "document-token",
    folderToken: "folder-token",
    ownerOpenId: targetOwnerOpenId,
  });
  assert.equal(harness.transferCount(), 1);
  assert.equal(result.ownershipTransferred, true);
  assert.equal(result.ownerId, targetOwnerOpenId);
  assert.match(documentSource, /stay_put: true/);
  assert.match(documentSource, /remove_old_owner: false/);
  assert.match(documentSource, /old_owner_perm: "full_access"/);
});

test("a lost copy response is recovered by stable-title adoption", async () => {
  const { client, state } = ensureClient({ loseFirstCopyResponse: true });
  globalThis.__feishuDocumentTestHooks = {
    getFeishuSettings: () => ({ productFolderToken: "folder-token" }),
    updateProduct: () => null,
    clearProductDocumentLink: () => null,
  };
  const item = product();
  await assert.rejects(
    documentModule.ensureProductDocument(client, item, { ownerOpenId: targetOwnerOpenId }),
    /复制飞书产品文档模板失败|copy response lost/,
  );
  const recovered = await documentModule.ensureProductDocument(client, item, { ownerOpenId: targetOwnerOpenId });
  assert.equal(state.copyCount, 1);
  assert.equal(recovered.documentId, "created-document-token");
  assert.equal(recovered.reused, true);
});

test("long product names keep distinct PID suffixes and never adopt another PID's document", async () => {
  const longName = "相同超长商品名称前缀".repeat(20);
  const firstPid = "1732507663809155961";
  const secondPid = "1732507663809155962";
  const firstTitle = documentModule.productDocumentStableTitle(longName, firstPid);
  const secondTitle = documentModule.productDocumentStableTitle(longName, secondPid);

  assert.equal(firstTitle.length, 90);
  assert.equal(secondTitle.length, 90);
  assert.ok(firstTitle.endsWith(`_${firstPid}`));
  assert.ok(secondTitle.endsWith(`_${secondPid}`));
  assert.notEqual(firstTitle, secondTitle);
  assert.equal(firstTitle.slice(0, -(firstPid.length + 1)), secondTitle.slice(0, -(secondPid.length + 1)));

  const { client, state } = ensureClient({
    owner: targetOwnerOpenId,
    file: {
      token: "first-product-document-token",
      name: firstTitle,
      type: "docx",
      url: "https://feishu.cn/docx/first-product-document-token",
    },
  });
  globalThis.__feishuDocumentTestHooks = {
    getFeishuSettings: () => ({ productFolderToken: "folder-token" }),
    updateProduct: () => null,
    clearProductDocumentLink: () => null,
  };

  const result = await documentModule.ensureProductDocument(
    client,
    product({ id: "second-long-name-product", name: longName, pid: secondPid }),
    { ownerOpenId: targetOwnerOpenId },
  );
  assert.equal(state.copyCount, 1);
  assert.equal(result.reused, false);
  assert.equal(result.title, secondTitle);
});

test("a deleted DB-linked document is cleared and recreated in the same call", async () => {
  const item = product({
    documentId: "deleted-document-token",
    documentUrl: "https://feishu.cn/docx/deleted-document-token",
  });
  const { client, state } = ensureClient({ deletedToken: "deleted-document-token" });
  let clearCount = 0;
  globalThis.__feishuDocumentTestHooks = {
    getFeishuSettings: () => ({ productFolderToken: "folder-token" }),
    updateProduct: () => null,
    clearProductDocumentLink: () => {
      clearCount += 1;
      return { ...item, documentId: null, documentUrl: null };
    },
  };
  const recreated = await documentModule.ensureProductDocument(client, item, { ownerOpenId: targetOwnerOpenId });
  assert.equal(clearCount, 1);
  assert.equal(state.copyCount, 1);
  assert.equal(recreated.documentId, "created-document-token");
  assert.equal(recreated.reused, false);
});

test("same-product concurrent calls serialize and create only one copy", async () => {
  const { client, state } = ensureClient({ copyDelayMs: 20 });
  globalThis.__feishuDocumentTestHooks = {
    getFeishuSettings: () => ({ productFolderToken: "folder-token" }),
    updateProduct: () => null,
    clearProductDocumentLink: () => null,
  };
  const item = product({ id: "locked-product" });
  const results = await Promise.all([
    documentModule.ensureProductDocument(client, item, { ownerOpenId: targetOwnerOpenId }),
    documentModule.ensureProductDocument(client, item, { ownerOpenId: targetOwnerOpenId }),
  ]);
  assert.equal(state.copyCount, 1);
  assert.deepEqual(results.map((result) => result.reused), [false, true]);
});

test("only known deleted-document codes trigger recovery", () => {
  assert.match(documentSource, /\[1770002, 1770003, 1063005, 1061007\]/);
  assert.match(documentSource, /clearProductDocumentLink\(currentProduct\.id\)/);
  assert.match(documentSource, /findProductDocumentByTitle\(client, productFolderToken, stableTitle\)/);
  assert.match(documentSource, /productDocumentStableTitle\(currentProduct\.name, currentProduct\.pid\)/);
  assert.match(documentSource, /withProductDocumentLock\(product\.id/);
});

test("stale document links are cleared explicitly with SQL NULL", async () => {
  const database = await readFile(new URL("../lib/database.ts", import.meta.url), "utf8");
  assert.match(database, /export function clearProductDocumentLink\(id: string\)/);
  assert.match(database, /UPDATE products SET document_id=NULL, document_url=NULL/);
});
