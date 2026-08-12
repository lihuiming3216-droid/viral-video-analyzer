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
    const hooks = () => globalThis.__productCardDocumentTestHooks || {};
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
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const documentModule = await loadDocumentModule();

function textBlock(id, content, link = "") {
  return {
    block_id: id,
    text: {
      elements: [{
        text_run: {
          content,
          ...(link ? { text_element_style: { link: { url: link } } } : {}),
        },
      }],
    },
  };
}

test("identity and verified-basic modes only change exact single-line managed labels", () => {
  const identity = {
    mode: "identity",
    name: "室内摄像头",
    productUrl: "https://shop.tiktok.com/us/pdp/camera/1731678528327946361",
    pid: "1731678528327946361",
  };
  assert.equal(
    documentModule.syncProductCardManagedBlockText("商品名称：旧名称", identity),
    "商品名称：室内摄像头",
  );
  assert.equal(
    documentModule.syncProductCardManagedBlockText("📦 商品名称：旧名称", identity),
    "📦 商品名称：室内摄像头",
  );
  assert.equal(
    documentModule.syncProductCardManagedBlockText("商品名称：旧名称", {
      ...identity,
      name: "Camera / Baby: 2.5K",
    }),
    "商品名称：Camera / Baby: 2.5K",
    "document text must not use filename sanitization",
  );
  assert.equal(
    documentModule.syncProductCardManagedBlockText("商品名称：旧名称", {
      mode: "identity",
      name: "",
    }),
    "商品名称：",
    "an explicit empty field clears its managed value",
  );
  for (const untouched of [
    "人工说明：商品名称：不要改这里",
    "这里提到商品名称：不要改",
    "商品名称不是标签：不要改",
    "商品名称：第一行\n人工补充：必须保留",
    "\n商品名称：前导换行不得匹配",
    "产品SKU：MANUAL-SKU",
    "产品主要功能：人工功能",
    "产品卖点：人工卖点",
    "A. 人工功能 A",
    "道具列表：人工道具",
  ]) {
    assert.equal(documentModule.syncProductCardManagedBlockText(untouched, identity), untouched);
  }

  const verified = {
    ...identity,
    mode: "verified-basic",
    sku: "CAM-25K",
    coreFunctions: ["夜视", "双向语音"],
    productParameters: "分辨率：2.5K",
    usageMethod: "连接2.4GHz Wi-Fi",
    audience: "家庭用户",
    scenes: "室内",
    clearDerived: true,
  };
  const expectations = new Map([
    ["产品SKU：旧", "产品SKU：CAM-25K"],
    ["产品主要功能：旧", "产品主要功能：夜视；双向语音"],
    ["产品参数：旧", "产品参数：分辨率：2.5K"],
    ["使用方法：旧", "使用方法：连接2.4GHz Wi-Fi"],
    ["适用人群：旧", "适用人群：家庭用户"],
    ["使用场景：旧", "使用场景：室内"],
  ]);
  for (const [before, after] of expectations) {
    assert.equal(documentModule.syncProductCardManagedBlockText(before, verified), after);
  }
  for (const untouched of ["产品卖点：人工卖点", "A. 人工功能 A", "道具列表：人工道具"]) {
    assert.equal(documentModule.syncProductCardManagedBlockText(untouched, verified), untouched);
  }

  assert.equal(
    documentModule.syncProductCardManagedBlockText("使用方法：旧方法", {
      mode: "verified-basic",
      name: "摄像头",
    }),
    "使用方法：旧方法",
    "omitted derived fields are preserved by default",
  );
  assert.equal(
    documentModule.syncProductCardManagedBlockText("使用方法：旧方法", {
      mode: "verified-basic",
      name: "摄像头",
      clearDerived: true,
    }),
    "使用方法：",
    "clearDerived explicitly clears omitted derived fields",
  );
});

test("document block listing reads every page beyond the 500-block API limit", async () => {
  const requests = [];
  const firstPage = Array.from({ length: 500 }, (_, index) => textBlock(`first-${index}`, `普通内容 ${index}`));
  const secondPage = [textBlock("second-1", "商品名称：旧名称"), textBlock("second-2", "商品ID：旧PID")];
  const client = {
    request: async (request) => {
      requests.push(request);
      if (!request.params.page_token) {
        return { code: 0, data: { items: firstPage, has_more: true, page_token: "next-page" } };
      }
      assert.equal(request.params.page_token, "next-page");
      return { code: 0, data: { items: secondPage, has_more: false } };
    },
  };

  const blocks = await documentModule.listFeishuDocumentBlocks(client, "document-token");
  assert.equal(blocks.length, 502);
  assert.equal(blocks[500].block_id, "second-1");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.params.document_revision_id), ["-1", "-1"]);
  assert.deepEqual(requests.map((request) => request.params.page_size), ["500", "500"]);
});

test("verified-basic preflight validates all nine unique labels and never patches", async () => {
  const patches = [];
  const completeTemplate = [
    textBlock("name", "商品名称：旧名称"),
    textBlock("url", "产品链接：https://old.invalid", "https://old.invalid"),
    textBlock("pid", "商品ID：旧PID"),
    textBlock("sku", "产品SKU：旧SKU"),
    textBlock("functions", "产品主要功能：旧功能"),
    textBlock("parameters", "产品参数：旧参数"),
    textBlock("method", "使用方法：旧方法"),
    textBlock("audience", "适用人群：旧人群"),
    textBlock("scenes", "使用场景：旧场景"),
  ];
  let blocks = completeTemplate;
  const client = {
    request: async () => ({ code: 0, data: { items: blocks } }),
    docx: { v1: { documentBlock: { patch: async (request) => {
      patches.push(request);
      return { code: 0 };
    } } } },
  };

  const valid = await documentModule.syncProductCardManagedFields(client, {
    documentId: "complete-template",
    mode: "verified-basic",
    preflightOnly: true,
  });
  assert.equal(valid.updated, 0);
  assert.equal(valid.matchedLabels.length, 9);
  assert.deepEqual(valid.missingLabels, []);
  assert.deepEqual(valid.duplicateLabels, []);
  assert.deepEqual(valid.currentValues, {
    商品名称: "旧名称",
    产品链接: "https://old.invalid",
    商品ID: "旧PID",
    产品SKU: "旧SKU",
    产品主要功能: "旧功能",
    产品参数: "旧参数",
    使用方法: "旧方法",
    适用人群: "旧人群",
    使用场景: "旧场景",
  });
  assert.equal(patches.length, 0);

  blocks = [
    ...completeTemplate.filter((block) => block.block_id !== "scenes"),
    textBlock("name-duplicate", "🎈 商品名称：另一个名称"),
  ];
  const invalid = await documentModule.syncProductCardManagedFields(client, {
    documentId: "invalid-template",
    mode: "verified-basic",
    preflightOnly: true,
  });
  assert.equal(invalid.updated, 0);
  assert.deepEqual(invalid.missingLabels, ["使用场景"]);
  assert.deepEqual(invalid.duplicateLabels, ["商品名称"]);
  assert.equal(Object.hasOwn(invalid.currentValues, "商品名称"), false,
    "an ambiguous duplicate value must not be exposed as document identity evidence");
  assert.equal(patches.length, 0, "preflight must report every structural problem without patching");
});

test("the managed-field API patches only the selected exact blocks and preserves link identity", async () => {
  const oldUrl = "https://shop.tiktok.com/us/pdp/old/111111";
  const nextUrl = "https://shop.tiktok.com/us/pdp/camera/1731678528327946361";
  const blocks = [
    textBlock("name", "商品名称：旧名称"),
    textBlock("url", `🔗 产品链接：${oldUrl}`, oldUrl),
    textBlock("pid", "商品ID：111111"),
    textBlock("sku", "产品SKU：旧SKU"),
    textBlock("functions", "产品主要功能：旧功能"),
    textBlock("parameters", "产品参数：旧参数"),
    textBlock("method", "使用方法：旧方法"),
    textBlock("audience", "适用人群：旧人群"),
    textBlock("scenes", "使用场景：旧场景"),
    textBlock("selling", "产品卖点：人工卖点"),
    textBlock("ranked", "A. 人工功能 A"),
    textBlock("manual", "人工说明：产品参数：不得修改"),
    textBlock("multi", "商品名称：第一行\n人工段落：不得修改"),
  ];
  const patches = [];
  const client = {
    request: async () => ({ code: 0, data: { items: blocks } }),
    docx: {
      v1: {
        documentBlock: {
          patch: async (request) => {
            patches.push(request);
            return { code: 0 };
          },
        },
      },
    },
  };

  const identityResult = await documentModule.syncProductCardManagedFields(client, {
    documentId: "document-token",
    mode: "identity",
    name: "室内摄像头",
    productUrl: nextUrl,
    pid: "1731678528327946361",
  });
  assert.equal(identityResult.updated, 3);
  assert.deepEqual(identityResult.missingLabels, []);
  assert.deepEqual(identityResult.matchedLabels.sort(), ["产品链接", "商品ID", "商品名称"].sort());
  assert.deepEqual(patches.map((patch) => patch.path.block_id).sort(), ["name", "pid", "url"]);
  const linkElements = patches.find((patch) => patch.path.block_id === "url")
    .data.update_text_elements.elements;
  assert.equal(linkElements.find((element) => element.text_run.text_element_style?.link)?.text_run.content, nextUrl);
  assert.equal(linkElements.find((element) => element.text_run.text_element_style?.link)
    ?.text_run.text_element_style.link.url, nextUrl);

  patches.length = 0;
  const verifiedResult = await documentModule.syncProductCardManagedFields(client, {
    documentId: "document-token",
    mode: "verified-basic",
    sku: "CAM-25K",
    coreFunctions: ["夜视", "双向语音"],
    productParameters: "分辨率：2.5K",
    usageMethod: "连接2.4GHz Wi-Fi",
    audience: "家庭用户",
    scenes: "室内",
    clearDerived: true,
  });
  assert.equal(verifiedResult.updated, 6);
  assert.deepEqual(verifiedResult.missingLabels, []);
  assert.deepEqual(
    patches.map((patch) => patch.path.block_id).sort(),
    ["audience", "functions", "method", "parameters", "scenes", "sku"],
  );
  assert.ok(patches.every((patch) => !["selling", "ranked", "manual", "multi"].includes(patch.path.block_id)));
});

function shellClient() {
  const state = {
    file: null,
    owner: "application-owner",
    copyCount: 0,
  };
  const client = {
    request: async ({ url, data }) => {
      if (url.includes("/drive/explorer/v2/folder/")) {
        return { code: 0, data: { name: "产品说明文档", ownUid: "unused" } };
      }
      if (url.includes("/copy")) {
        state.copyCount += 1;
        state.file = {
          token: "stable-shell-document",
          name: data.name,
          type: "docx",
          url: "https://tenant.feishu.cn/docx/stable-shell-document",
        };
        return { code: 0, data: { file: state.file } };
      }
      if (url.includes("/docx/v1/documents/") && url.endsWith("/blocks")) {
        return { code: 0, data: { items: [
          textBlock("name", "商品名称："),
          textBlock("url", "产品链接："),
          textBlock("pid", "商品ID："),
          textBlock("sku", "产品SKU："),
          textBlock("functions", "产品主要功能："),
          textBlock("parameters", "产品参数："),
          textBlock("method", "使用方法："),
          textBlock("audience", "适用人群："),
          textBlock("scenes", "使用场景："),
        ] } };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    docx: {
      v1: { documentBlock: { patch: async () => ({ code: 0 }) } },
    },
    drive: {
      v2: { permissionPublic: { patch: async () => ({ code: 0 }) } },
      v1: {
        permissionMember: {
          list: async () => ({
            code: 0,
            data: { items: [
              { member_type: "openid", member_id: "ou_owner", perm: "full_access", type: "user" },
              { member_type: "openchat", member_id: "oc_managers", perm: "full_access", type: "chat" },
            ] },
          }),
          transferOwner: async () => {
            state.owner = "ou_owner";
            return { code: 0 };
          },
        },
        file: {
          list: async () => ({ code: 0, data: { files: state.file ? [state.file] : [], has_more: false } }),
        },
        meta: {
          batchQuery: async ({ data }) => ({
            code: 0,
            data: { metas: [{ doc_token: data.request_docs[0].doc_token, owner_id: state.owner }] },
          }),
        },
      },
    },
  };
  return { client, state };
}

test("a stable Base record creates and reuses a shell without a PID or valid product URL", async () => {
  globalThis.__productCardDocumentTestHooks = {
    getFeishuSettings: () => ({ productFolderToken: "folder-token" }),
  };
  const { client, state } = shellClient();
  const recordKey = {
    appToken: "base-app-token",
    tableId: "table-id",
    recordId: "record-id",
  };
  const created = await documentModule.ensureProductCardShell(client, {
    recordKey,
    name: "",
    productUrl: "not-a-valid-url",
    pid: "",
    ownerOpenId: "ou_owner",
  });
  assert.equal(created.reused, false);
  assert.equal(created.documentId, "stable-shell-document");
  assert.equal(created.identityWarning, "");
  assert.match(created.title, /^待补产品_手卡_[a-f0-9]{24}$/);
  assert.doesNotMatch(created.title, /base-app-token|table-id|record-id/);
  assert.equal(state.copyCount, 1);

  const reused = await documentModule.ensureProductCardShell(client, {
    recordKey,
    name: "后来补充的名称",
    ownerOpenId: "ou_owner",
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.documentId, created.documentId);
  assert.equal(state.copyCount, 1, "the stable suffix must adopt the first shell instead of copying again");

  const byUrl = await documentModule.ensureProductCardShell(client, {
    existingDocumentUrl: created.documentUrl,
    name: "",
    ownerOpenId: "ou_owner",
  });
  assert.equal(byUrl.reused, true);
  assert.equal(byUrl.documentId, created.documentId);
  assert.equal(state.copyCount, 1);

  await assert.rejects(
    documentModule.ensureProductCardShell(client, { name: "没有稳定键" }),
    /需要记录稳定键或已有文档/,
  );
});

test("an owner repair failure cannot hide an already-created shell", async () => {
  globalThis.__productCardDocumentTestHooks = {
    getFeishuSettings: () => ({ productFolderToken: "folder-token" }),
  };
  const { client, state } = shellClient();
  client.drive.v1.permissionMember.list = async () => {
    throw new Error("temporary owner lookup failure");
  };
  const result = await documentModule.ensureProductCardShell(client, {
    recordKey: { appToken: "app", tableId: "table", recordId: "owner-failure-row" },
    name: "摄像头",
    ownerOpenId: "ou_owner",
  });
  assert.equal(state.copyCount, 1);
  assert.equal(result.documentId, "stable-shell-document");
  assert.match(result.ownershipWarning, /读取产品文档文件夹协作者失败/);
  assert.equal(result.migration.ownershipTransferred, false);
});

test("a transient metadata failure cannot hide an already-known shell URL", async () => {
  globalThis.__productCardDocumentTestHooks = {
    getFeishuSettings: () => ({ productFolderToken: "folder-token" }),
  };
  const { client, state } = shellClient();
  client.drive.v1.meta.batchQuery = async () => {
    throw new Error("temporary Drive metadata outage");
  };
  const result = await documentModule.ensureProductCardShell(client, {
    existingDocumentUrl: "https://tenant.feishu.cn/docx/existing-shell-token",
    name: "摄像头",
    ownerOpenId: "ou_owner",
  });
  assert.equal(state.copyCount, 0);
  assert.equal(result.reused, true);
  assert.equal(result.documentId, "existing-shell-token");
  assert.equal(result.documentUrl, "https://tenant.feishu.cn/docx/existing-shell-token");
  assert.match(result.ownershipWarning, /temporary Drive metadata outage/);
});

test("a non-template document reports every missing managed label", async () => {
  const client = {
    request: async () => ({ code: 0, data: { items: [textBlock("manual", "员工手写内容，不是模板字段")] } }),
    docx: { v1: { documentBlock: { patch: async () => ({ code: 0 }) } } },
  };
  const result = await documentModule.syncProductCardManagedFields(client, {
    documentId: "non-template-document",
    mode: "verified-basic",
    name: "摄像头",
    productUrl: "https://shop.tiktok.com/us/pdp/camera/1731678528327946361",
    pid: "1731678528327946361",
    sku: "",
    coreFunctions: [],
    productParameters: "",
    usageMethod: "",
    audience: "",
    scenes: "",
    clearDerived: true,
  });
  assert.equal(result.updated, 0);
  assert.deepEqual(result.matchedLabels, []);
  assert.deepEqual(result.missingLabels.sort(), [
    "商品名称", "产品链接", "商品ID", "产品SKU", "产品主要功能",
    "产品参数", "使用方法", "适用人群", "使用场景",
  ].sort());
});

test("a partially missing template performs zero patches", async () => {
  const patches = [];
  const client = {
    request: async () => ({ code: 0, data: { items: [textBlock("name", "商品名称：旧名称")] } }),
    docx: { v1: { documentBlock: { patch: async (request) => {
      patches.push(request);
      return { code: 0 };
    } } } },
  };
  const result = await documentModule.syncProductCardManagedFields(client, {
    documentId: "partially-missing-template",
    mode: "identity",
    name: "新名称",
    pid: "1731678528327946361",
  });
  assert.equal(result.updated, 0);
  assert.deepEqual(result.matchedLabels, ["商品名称"]);
  assert.deepEqual(result.missingLabels, ["商品ID"]);
  assert.deepEqual(result.duplicateLabels, []);
  assert.equal(patches.length, 0, "a valid earlier block must not be patched before preflight finishes");
});

test("a duplicate expected label performs zero patches and raises a safe template error", async () => {
  const patches = [];
  const client = {
    request: async () => ({ code: 0, data: { items: [
      textBlock("name-a", "商品名称：旧名称 A"),
      textBlock("name-b", "🎈商品名称：旧名称 B"),
    ] } }),
    docx: { v1: { documentBlock: { patch: async (request) => {
      patches.push(request);
      return { code: 0 };
    } } } },
  };
  await assert.rejects(
    documentModule.syncProductCardManagedFields(client, {
      documentId: "duplicate-template",
      mode: "identity",
      name: "新名称",
    }),
    /产品手卡模板基础字段重复：商品名称/,
  );
  assert.equal(patches.length, 0);
});

test("identical values are no-ops while omitted fields preserve and explicit empty clears", async () => {
  const url = "https://shop.tiktok.com/us/pdp/camera/1731678528327946361";
  const identityBlocks = [
    textBlock("name", "商品名称：摄像头"),
    textBlock("url", `产品链接：${url}`, url),
    textBlock("pid", "商品ID：1731678528327946361"),
  ];
  const patches = [];
  let blocks = identityBlocks;
  const client = {
    request: async () => ({ code: 0, data: { items: blocks } }),
    docx: { v1: { documentBlock: { patch: async (request) => {
      patches.push(request);
      return { code: 0 };
    } } } },
  };

  const unchanged = await documentModule.syncProductCardManagedFields(client, {
    documentId: "same-values",
    mode: "identity",
    name: "摄像头",
    productUrl: url,
    pid: "1731678528327946361",
  });
  assert.equal(unchanged.updated, 0);
  assert.equal(patches.length, 0);

  blocks = [
    textBlock("method", "使用方法：旧方法"),
    textBlock("audience", "适用人群：人工保留"),
  ];
  const cleared = await documentModule.syncProductCardManagedFields(client, {
    documentId: "partial-clear",
    mode: "verified-basic",
    usageMethod: "",
  });
  assert.equal(cleared.updated, 1);
  assert.deepEqual(cleared.matchedLabels, ["使用方法"]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].path.block_id, "method");
  assert.equal(
    patches[0].data.update_text_elements.elements.map((element) => element.text_run.content).join(""),
    "使用方法：",
  );

  patches.length = 0;
  const omitted = await documentModule.syncProductCardManagedFields(client, {
    documentId: "partial-preserve",
    mode: "verified-basic",
  });
  assert.equal(omitted.updated, 0);
  assert.deepEqual(omitted.matchedLabels, []);
  assert.deepEqual(omitted.missingLabels, []);
  assert.equal(patches.length, 0, "omitting every managed field must preserve the document exactly");
});

test("verified sync writes identity before derived fields in a rearranged template", async () => {
  const patchOrder = [];
  const blocks = [
    textBlock("functions", "产品主要功能：旧功能"),
    textBlock("pid", "商品ID：旧PID"),
    textBlock("name", "商品名称：旧名称"),
    textBlock("url", "产品链接：https://old.invalid", "https://old.invalid"),
    textBlock("sku", "产品SKU：旧SKU"),
    textBlock("parameters", "产品参数：旧参数"),
    textBlock("method", "使用方法：旧方法"),
    textBlock("audience", "适用人群：旧人群"),
    textBlock("scenes", "使用场景：旧场景"),
  ];
  const client = {
    request: async () => ({ code: 0, data: { items: blocks } }),
    docx: { v1: { documentBlock: { patch: async ({ path }) => {
      patchOrder.push(path.block_id);
      return { code: 0 };
    } } } },
  };
  const result = await documentModule.syncProductCardManagedFields(client, {
    documentId: "rearranged-document",
    mode: "verified-basic",
    name: "新名称",
    productUrl: "https://shop.tiktok.com/us/pdp/new/1731678528327946361",
    pid: "1731678528327946361",
    sku: "NEW-SKU",
    coreFunctions: ["夜视"],
    productParameters: "分辨率：2.5K",
    usageMethod: "连接 Wi-Fi",
    audience: "家庭用户",
    scenes: "室内",
    clearDerived: true,
  });
  assert.deepEqual(result.missingLabels, []);
  assert.deepEqual(patchOrder.slice(0, 3).sort(), ["name", "pid", "url"].sort());
  assert.ok(patchOrder.indexOf("functions") > 2, "derived facts must not be patched before identity");
});
