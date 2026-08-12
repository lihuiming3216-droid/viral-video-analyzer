import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const syncSource = await readFile(
  new URL("../lib/feishu/product-doc-sync.ts", import.meta.url),
  "utf8",
);

async function loadSyncModule() {
  const stubSource = `
    const hooks = () => globalThis.__productDocSyncWriteProtectionHooks || {};
    export const createVideo = (...args) => hooks().createVideo?.(...args);
    export const getProduct = (...args) => hooks().getProduct?.(...args) || null;
    export const getVideo = (...args) => hooks().getVideo?.(...args) || null;
    export const getVideoBySourceUrl = (...args) => hooks().getVideoBySourceUrl?.(...args) || null;
    export const listFeishuProductCardMappingsByProductId = (...args) => hooks().listFeishuProductCardMappingsByProductId?.(...args) || [];
    export const listProducts = (...args) => hooks().listProducts?.(...args) || [];
    export const updateVideo = (...args) => hooks().updateVideo?.(...args) || null;
    export const listFeishuDocumentBlocks = (...args) => hooks().listFeishuDocumentBlocks?.(...args) || [];
    export const updateFeishuTextBlock = (...args) => hooks().updateFeishuTextBlock?.(...args);
    export const ensureFeishuConnection = (...args) => hooks().ensureFeishuConnection?.(...args) || null;
    export const getConnectedFeishuChannel = (...args) => hooks().getConnectedFeishuChannel?.(...args) || null;
    export const conciseProductDocAnalysis = (...args) => hooks().conciseProductDocAnalysis?.(...args) || "自动视频分析";
    export const enqueueVideos = (...args) => hooks().enqueueVideos?.(...args);
  `;
  const stubUrl = `data:text/javascript;base64,${Buffer.from(stubSource).toString("base64")}`;
  const testSource = syncSource.replace(
    "await new Promise((resolve) => setTimeout(resolve, 380));",
    "await Promise.resolve();",
  );
  assert.notEqual(testSource, syncSource, "the test must only remove Feishu write throttling, not sync behavior");
  let compiled = ts.transpileModule(testSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  compiled = compiled
    .replace('import "server-only";', "")
    .replaceAll('"@/lib/database"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/feishu/document"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/feishu/runtime"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/product-doc-analysis"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/queue"', JSON.stringify(stubUrl));
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

function documentBlocks(rows) {
  const blocks = [];
  const cells = [];
  const addCell = (id, content) => {
    const textId = `${id}-text`;
    cells.push(id);
    blocks.push({ block_id: id, children: [textId] });
    blocks.push({
      block_id: textId,
      text: { elements: [{ text_run: { content } }] },
    });
    return textId;
  };

  ["视频链接", "分析状态", "视频分析", "中文翻译"].forEach((content, index) => {
    addCell(`header-${index}`, content);
  });
  const rowTextIds = [];
  rows.forEach((row, index) => {
    const prefix = `row-${index + 1}`;
    rowTextIds.push({
      link: addCell(`${prefix}-link`, row.link),
      status: addCell(`${prefix}-status`, row.status),
      analysis: addCell(`${prefix}-analysis`, row.analysis),
      translation: addCell(`${prefix}-translation`, row.translation),
    });
  });
  blocks.unshift({
    block_id: "video-table",
    block_type: 31,
    table: { property: { column_size: 4 }, cells },
  });
  return { blocks, rowTextIds };
}

const syncModule = await loadSyncModule();

test("completed document sync fills only independently blank analysis and translation cells", async () => {
  const rows = [
    { analysis: "人工分析一", translation: "人工翻译一", transcript: "自动翻译一" },
    { analysis: "人工分析二", translation: "", transcript: "自动翻译二" },
    { analysis: "", translation: "人工翻译三", transcript: "自动翻译三" },
    { analysis: " \n\t ", translation: "　 ", transcript: "  自动翻译四  " },
    { analysis: "人工分析五", translation: "无口播", transcript: "自动翻译五" },
    { analysis: "人工分析六", translation: "   ", transcript: " \n " },
  ].map((row, index) => ({
    ...row,
    status: "AI分析",
    link: `https://www.tiktok.com/@demo/video/${7000000000000000001n + BigInt(index)}`,
    id: `video-${index + 1}`,
  }));
  const { blocks, rowTextIds } = documentBlocks(rows);
  const videos = new Map(rows.map((row) => [new URL(row.link).toString(), {
    id: row.id,
    status: "completed",
    transcriptZh: row.transcript,
    errorMessage: null,
  }]));
  const writes = [];
  let freshReadRequests = 0;
  const latestText = new Map(blocks
    .filter((block) => block.block_id && block.text)
    .map((block) => [block.block_id, block]));
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getConnectedFeishuChannel: () => ({ rawClient: {} }),
    getVideoBySourceUrl: (url) => videos.get(url),
    conciseProductDocAnalysis: (video) => `自动分析-${video.id}`,
    ensureFeishuConnection: () => ({ rawClient: {} }),
    updateFeishuTextBlock: async (_client, _documentId, blockId, content) => {
      writes.push({ blockId, content });
    },
  };

  const client = {
    request: async ({ url }) => {
      freshReadRequests += 1;
      if (!String(url).includes("/blocks/")) {
        return { data: { document: { revision_id: 10 } } };
      }
      const blockId = decodeURIComponent(String(url).split("/").at(-1));
      return { data: { block: latestText.get(blockId) } };
    },
  };

  try {
    const result = await syncModule.syncProductDocument(client, {
      id: "product-1",
      documentId: "document-1",
    });

    assert.deepEqual(result, { found: 6, queued: 0, completed: 6, failed: 0 });
    for (const ids of rowTextIds) {
      assert.deepEqual(
        writes.filter((write) => write.blockId === ids.status).map((write) => write.content),
        ["已完成"],
        "status remains system-managed even when the result columns already contain text",
      );
    }

    assert.equal(writes.some((write) => write.blockId === rowTextIds[0].analysis), false);
    assert.equal(writes.some((write) => write.blockId === rowTextIds[0].translation), false);
    assert.equal(
      freshReadRequests,
      8,
      "only the four blank writable cells make one revision GET and one block GET each",
    );

    assert.equal(writes.some((write) => write.blockId === rowTextIds[1].analysis), false);
    assert.deepEqual(
      writes.filter((write) => write.blockId === rowTextIds[1].translation).map((write) => write.content),
      ["自动翻译二"],
    );

    assert.deepEqual(
      writes.filter((write) => write.blockId === rowTextIds[2].analysis).map((write) => write.content),
      ["自动分析-video-3"],
    );
    assert.equal(writes.some((write) => write.blockId === rowTextIds[2].translation), false);

    assert.deepEqual(
      writes.filter((write) => write.blockId === rowTextIds[3].analysis).map((write) => write.content),
      ["自动分析-video-4"],
      "whitespace-only analysis is blank",
    );
    assert.deepEqual(
      writes.filter((write) => write.blockId === rowTextIds[3].translation).map((write) => write.content),
      ["自动翻译四"],
      "whitespace-only translation is blank and delivered text is trimmed",
    );

    assert.equal(
      writes.some((write) => write.blockId === rowTextIds[4].translation),
      false,
      "manual 无口播 is nonempty user content and must be preserved",
    );
    assert.equal(
      writes.some((write) => write.blockId === rowTextIds[5].translation),
      false,
      "an empty database translation leaves the blank document cell untouched",
    );
    assert.equal(writes.some((write) => write.content === "暂无中文翻译"), false);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("document sync worker waits twenty seconds before its first scan", () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalInterval = process.env.PRODUCT_DOC_SYNC_INTERVAL_MS;
  const timeouts = [];
  const intervals = [];
  let unrefCalls = 0;
  globalThis.setTimeout = (callback, delay) => {
    timeouts.push({ callback, delay });
    return { unref() { unrefCalls += 1; } };
  };
  globalThis.setInterval = (callback, delay) => {
    intervals.push({ callback, delay });
    return { unref() { unrefCalls += 1; } };
  };
  delete process.env.PRODUCT_DOC_SYNC_INTERVAL_MS;

  try {
    syncModule.startProductDocumentSyncWorker();
    assert.equal(timeouts.length, 0, "startup must not schedule an immediate document scan");
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].delay, 20_000);
    assert.equal(unrefCalls, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
    if (originalInterval === undefined) delete process.env.PRODUCT_DOC_SYNC_INTERVAL_MS;
    else process.env.PRODUCT_DOC_SYNC_INTERVAL_MS = originalInterval;
  }
});

test("a newly completed video is delivered to its exact document row immediately", async () => {
  const link = "https://www.tiktok.com/@demo/video/7999999999999999999";
  const video = {
    id: "video-direct",
    productId: "product-direct",
    status: "completed",
    transcriptZh: "直接写入的翻译",
    errorMessage: null,
  };
  const { blocks, rowTextIds } = documentBlocks([{
    link,
    status: "AI分析",
    analysis: "",
    translation: "",
  }]);
  const documentIds = ["document-row-a", "document-row-b"];
  const scans = [];
  const writes = [];
  const latestText = new Map(blocks
    .filter((block) => block.block_id && block.text)
    .map((block) => [block.block_id, block]));
  const client = {
    request: async ({ url }) => {
      if (!String(url).includes("/blocks/")) {
        return { data: { document: { revision_id: 20 } } };
      }
      const blockId = decodeURIComponent(String(url).split("/").at(-1));
      return { data: { block: latestText.get(blockId) } };
    },
  };
  globalThis.__productDocSyncWriteProtectionHooks = {
    getVideo: () => video,
    getProduct: () => ({
      id: "product-direct",
      documentId: documentIds[0],
      documentUrl: `https://feishu.cn/docx/${documentIds[0]}`,
    }),
    listFeishuProductCardMappingsByProductId: () => documentIds.map((documentId) => ({
      productId: "product-direct",
      documentId,
      documentUrl: `https://feishu.cn/docx/${documentId}`,
    })),
    getVideoBySourceUrl: () => video,
    getConnectedFeishuChannel: () => ({ rawClient: client }),
    listFeishuDocumentBlocks: (_client, documentId) => {
      scans.push(documentId);
      return blocks;
    },
    conciseProductDocAnalysis: () => "直接写入的视频分析",
    updateFeishuTextBlock: async (_client, documentId, blockId, content) => {
      writes.push({ documentId, blockId, content });
    },
  };

  try {
    assert.equal(await syncModule.syncCompletedVideoToProductDocument(video.id), true);
    assert.deepEqual(scans, documentIds, "the canonical document duplicated by its mapping is scanned once");
    for (const documentId of documentIds) {
      assert.deepEqual(writes.filter((write) => write.documentId === documentId), [
        { documentId, blockId: rowTextIds[0].status, content: "已完成" },
        { documentId, blockId: rowTextIds[0].analysis, content: "直接写入的视频分析" },
        { documentId, blockId: rowTextIds[0].translation, content: "直接写入的翻译" },
      ], `the completed video must be delivered to its exact row in ${documentId}`);
    }
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("periodic sync discovers a new link in the second row-mapped document without duplicate scans", async () => {
  const product = {
    id: "product-mapped",
    name: "多行同款产品",
    pid: "1731678528327946361",
    documentId: "document-row-a",
    documentUrl: "https://feishu.cn/docx/document-row-a",
    isSystem: false,
  };
  const newLink = "https://www.tiktok.com/@demo/video/7111111111111111111";
  const first = documentBlocks([]);
  const second = documentBlocks([{
    link: newLink,
    status: "待处理",
    analysis: "",
    translation: "",
  }]);
  const blocksByDocument = new Map([
    ["document-row-a", first.blocks],
    ["document-row-b", second.blocks],
  ]);
  const scans = [];
  const created = [];
  const enqueued = [];
  const writes = [];
  globalThis.__productDocSyncWriteProtectionHooks = {
    listProducts: () => [product],
    listFeishuProductCardMappingsByProductId: (productId) => {
      assert.equal(productId, product.id);
      return ["document-row-a", "document-row-b"].map((documentId) => ({
        productId,
        documentId,
        documentUrl: `https://feishu.cn/docx/${documentId}`,
      }));
    },
    getConnectedFeishuChannel: () => ({ rawClient: {} }),
    listFeishuDocumentBlocks: (_client, documentId) => {
      scans.push(documentId);
      return blocksByDocument.get(documentId) || [];
    },
    getVideoBySourceUrl: () => null,
    createVideo: (input) => {
      created.push(input);
      return { id: "video-from-second-document", status: "waiting" };
    },
    enqueueVideos: (ids) => enqueued.push(...ids),
    updateFeishuTextBlock: async (_client, documentId, blockId, content) => {
      writes.push({ documentId, blockId, content });
    },
  };

  try {
    assert.deepEqual(await syncModule.syncAllProductDocuments(), {
      documents: 2,
      found: 1,
      queued: 1,
      completed: 0,
      failed: 0,
    });
    assert.deepEqual(scans, ["document-row-a", "document-row-b"]);
    assert.deepEqual(created, [{
      productId: product.id,
      sourceType: "tiktok",
      sourceUrl: newLink,
      title: "文档样片 1",
      analysisMode: "product_doc",
    }]);
    assert.deepEqual(enqueued, ["video-from-second-document"]);
    assert.deepEqual(writes, [{
      documentId: "document-row-b",
      blockId: second.rowTextIds[0].status,
      content: "排队中",
    }]);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("a result cell filled after the table scan is re-read and never overwritten", async () => {
  const link = "https://www.tiktok.com/@demo/video/7666666666666666666";
  const video = {
    id: "video-race",
    status: "completed",
    transcriptZh: "自动翻译",
    errorMessage: null,
  };
  const { blocks, rowTextIds } = documentBlocks([{
    link,
    status: "AI分析",
    analysis: "",
    translation: "",
  }]);
  const latestText = new Map(blocks
    .filter((block) => block.block_id && block.text)
    .map((block) => [block.block_id, structuredClone(block)]));
  const writes = [];
  const client = {
    request: async ({ url }) => {
      if (!String(url).includes("/blocks/")) {
        return { data: { document: { revision_id: 30 } } };
      }
      const blockId = decodeURIComponent(String(url).split("/").at(-1));
      return { data: { block: latestText.get(blockId) } };
    },
  };
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getVideoBySourceUrl: () => video,
    conciseProductDocAnalysis: () => "自动分析",
    updateFeishuTextBlock: async (_client, _documentId, blockId, content) => {
      writes.push({ blockId, content });
      if (blockId === rowTextIds[0].status) {
        latestText.set(rowTextIds[0].analysis, {
          block_id: rowTextIds[0].analysis,
          text: { elements: [{ text_run: { content: "用户刚输入的分析" } }] },
        });
      }
    },
  };

  try {
    await syncModule.syncProductDocument(client, { id: "product-race", documentId: "document-race" });
    assert.equal(writes.some((write) => write.blockId === rowTextIds[0].analysis), false);
    assert.deepEqual(
      writes.filter((write) => write.blockId === rowTextIds[0].translation),
      [{ blockId: rowTextIds[0].translation, content: "自动翻译" }],
    );
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("automatic result writes carry the freshly read document revision", async () => {
  const link = "https://www.tiktok.com/@demo/video/7555555555555555555";
  const video = {
    id: "video-revision",
    status: "completed",
    transcriptZh: "自动翻译",
    errorMessage: null,
  };
  const { blocks, rowTextIds } = documentBlocks([{
    link,
    status: "已完成",
    analysis: "",
    translation: "",
  }]);
  const latestText = new Map(blocks
    .filter((block) => block.block_id && block.text)
    .map((block) => [block.block_id, block]));
  let revision = 40;
  const writes = [];
  const client = {
    request: async ({ url }) => {
      if (!String(url).includes("/blocks/")) {
        return { data: { document: { revision_id: revision } } };
      }
      const blockId = decodeURIComponent(String(url).split("/").at(-1));
      return { data: { block: latestText.get(blockId) } };
    },
  };
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getVideoBySourceUrl: () => video,
    conciseProductDocAnalysis: () => "自动分析",
    updateFeishuTextBlock: async (_client, _documentId, blockId, content, options) => {
      writes.push({ blockId, content, revision: options?.documentRevisionId });
      revision += 1;
    },
  };

  try {
    await syncModule.syncProductDocument(client, { id: "product-revision", documentId: "document-revision" });
    assert.deepEqual(writes, [
      { blockId: rowTextIds[0].analysis, content: "自动分析", revision: 40 },
      { blockId: rowTextIds[0].translation, content: "自动翻译", revision: 41 },
    ]);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("an explicit retry requeues a completed video without touching manual result cells", async () => {
  const link = "https://www.tiktok.com/@demo/video/7888888888888888888";
  const video = {
    id: "video-retry",
    status: "completed",
    transcriptZh: "旧自动翻译",
    errorMessage: null,
  };
  const { blocks, rowTextIds } = documentBlocks([{
    link,
    status: "重试",
    analysis: "人工修正分析",
    translation: "人工修正翻译",
  }]);
  const writes = [];
  const enqueued = [];
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getVideoBySourceUrl: () => video,
    updateVideo: () => video,
    enqueueVideos: (ids) => enqueued.push(...ids),
    updateFeishuTextBlock: async (_client, _documentId, blockId, content) => {
      writes.push({ blockId, content });
    },
  };

  try {
    const result = await syncModule.syncProductDocument({}, { id: "product-1", documentId: "document-1" });
    assert.deepEqual(result, { found: 1, queued: 1, completed: 0, failed: 0 });
    assert.deepEqual(enqueued, [video.id]);
    assert.deepEqual(writes, [{ blockId: rowTextIds[0].status, content: "排队中" }]);
    assert.equal(writes.some((write) => write.blockId === rowTextIds[0].analysis), false);
    assert.equal(writes.some((write) => write.blockId === rowTextIds[0].translation), false);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("document polling ignores non-HTTPS or credential-bearing TikTok links", async () => {
  const rows = [
    "http://www.tiktok.com/@demo/video/7444444444444444444",
    "https://user@www.tiktok.com/@demo/video/7333333333333333333",
    "https://www.tiktok.com:444/@demo/video/7222222222222222222",
  ].map((link) => ({ link, status: "待处理", analysis: "", translation: "" }));
  const { blocks } = documentBlocks(rows);
  let created = 0;
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    createVideo: () => { created += 1; },
  };

  try {
    assert.deepEqual(
      await syncModule.syncProductDocument({}, { id: "product-invalid-links", documentId: "document-invalid-links" }),
      { found: 0, queued: 0, completed: 0, failed: 0 },
    );
    assert.equal(created, 0);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});
