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
    const rowBindings = new Map();
    const initializedDocuments = new Set();
    const seenVideos = new Map();
    let activeHooks;
    const resetState = () => {
      const current = hooks();
      if (activeHooks !== current) {
        rowBindings.clear();
        initializedDocuments.clear();
        seenVideos.clear();
        activeHooks = current;
      }
      return current;
    };
    const rememberVideo = (video, sourceUrl) => {
      if (!video?.id) return null;
      const prior = seenVideos.get(video.id) || {};
      const remembered = { ...prior, ...video };
      if (!remembered.sourceUrl && sourceUrl) remembered.sourceUrl = sourceUrl;
      seenVideos.set(remembered.id, remembered);
      return remembered;
    };
    export const createVideo = (...args) => rememberVideo(hooks().createVideo?.(...args), args[0]?.sourceUrl);
    export const deleteProductDocumentVideoRow = (documentId, linkBlockId) => {
      const current = resetState();
      if (current.deleteProductDocumentVideoRow) return current.deleteProductDocumentVideoRow(documentId, linkBlockId);
      rowBindings.delete(documentId + ":" + linkBlockId);
    };
    export const getProduct = (...args) => hooks().getProduct?.(...args) || null;
    export const getProductDocumentVideoRow = (documentId, linkBlockId) => { const current = resetState(); return current.getProductDocumentVideoRow?.(documentId, linkBlockId) || rowBindings.get(documentId + ":" + linkBlockId) || null; };
    export const getProductDocumentVideoRowByVideoId = (videoId) => { const current = resetState(); return current.getProductDocumentVideoRowByVideoId?.(videoId) || [...rowBindings.values()].find((row) => row.videoId === videoId) || null; };
    export const getVideo = (id, ...args) => { resetState(); return rememberVideo(hooks().getVideo?.(id, ...args) || seenVideos.get(id)); };
    export const getVideoBySourceUrl = (sourceUrl, ...args) => { resetState(); return rememberVideo(hooks().getVideoBySourceUrl?.(sourceUrl, ...args), sourceUrl); };
    export const isProductDocumentVideoRowsInitialized = (documentId) => { const current = resetState(); return current.isProductDocumentVideoRowsInitialized?.(documentId) ?? initializedDocuments.has(documentId); };
    export const listFeishuProductCardMappingsByProductId = (...args) => hooks().listFeishuProductCardMappingsByProductId?.(...args) || [];
    export const listProducts = (...args) => hooks().listProducts?.(...args) || [];
    export const markProductDocumentVideoRowsInitialized = (documentId) => { const current = resetState(); return current.markProductDocumentVideoRowsInitialized?.(documentId) ?? initializedDocuments.add(documentId); };
    export const saveProductDocumentVideoRow = (input) => {
      const current = resetState();
      if (current.saveProductDocumentVideoRow) return current.saveProductDocumentVideoRow(input);
      const row = { ...input };
      rowBindings.set(input.documentId + ":" + input.linkBlockId, row);
      return row;
    };
    export const updateVideo = (...args) => hooks().updateVideo?.(...args) || null;
    export const listFeishuDocumentBlocks = (...args) => hooks().listFeishuDocumentBlocks?.(...args) || [];
    export const updateFeishuTextBlock = (...args) => hooks().updateFeishuTextBlock?.(...args);
    export const ensureFeishuConnection = (...args) => hooks().ensureFeishuConnection?.(...args) || null;
    export const getConnectedFeishuChannel = (...args) => hooks().getConnectedFeishuChannel?.(...args) || null;
    export const conciseProductDocAnalysis = (...args) => hooks().conciseProductDocAnalysis?.(...args) || "自动视频分析";
    export const enqueueVideos = (...args) => hooks().enqueueVideos?.(...args);
    export const resolveMediaPath = (...args) => hooks().resolveMediaPath?.(...args) || args[0];
    export const ensureFeishuVideoPreview = (...args) => hooks().ensureFeishuVideoPreview?.(...args) || false;
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
  compiled = compiled.replaceAll('"@/lib/video-processing"', JSON.stringify(stubUrl));
  compiled = compiled.replaceAll('"@/lib/feishu/docx-file"', JSON.stringify(stubUrl));
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

test("writes to the same Feishu document are serialized", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) await firstGate;
      active -= 1;
      return [];
    },
  };
  const product = { id: "serial-product", documentId: "serial-document" };
  const first = syncModule.syncProductDocument({}, product);
  while (calls < 1) await new Promise((resolve) => setTimeout(resolve, 1));
  const second = syncModule.syncProductDocument({}, product);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1, "the second write waits for the first document operation");
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});

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
        [""],
        "legacy status text is cleared so the cell contains only the video",
      );
    }

    assert.equal(writes.some((write) => write.blockId === rowTextIds[0].analysis), false);
    assert.equal(writes.some((write) => write.blockId === rowTextIds[0].translation), false);
    assert.equal(
      freshReadRequests,
      12,
      "each of the four writable cells reads one revision plus its link and result blocks",
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

test("document sync sends a downloaded TokScript MP4 to the status cell preview helper", async () => {
  const link = "https://www.tiktok.com/@demo/video/7888888888888888888";
  const { blocks } = documentBlocks([{ link, status: "AI分析", analysis: "", translation: "" }]);
  const video = {
    id: "video-attachment-12345678",
    status: "failed",
    sourceType: "tiktok",
    originalPath: "media/video-attachment/original.mp4",
    remoteVideoUrl: "https://cdn.example/original.mp4",
    errorMessage: "分析失败",
  };
  const previews = [];
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getVideoBySourceUrl: () => video,
    resolveMediaPath: (value) => `/resolved/${value}`,
    ensureFeishuVideoPreview: async (input) => previews.push(input),
    updateFeishuTextBlock: async () => undefined,
  };
  try {
    const client = {};
    await syncModule.syncProductDocument(client, { id: "product-attachment", documentId: "document-attachment" });
    assert.equal(previews.length, 1);
    const [{ client: previewClient, blocks: previewBlocks, validateBinding, ...previewInput }] = previews;
    assert.equal(previewClient, client);
    assert.equal(previewBlocks, blocks);
    assert.equal(typeof validateBinding, "function");
    assert.deepEqual(previewInput, {
      documentId: "document-attachment",
      parentBlockId: "row-1-status",
      absolutePath: "/resolved/media/video-attachment/original.mp4",
      fileName: "TokScript视频-video-at.mp4",
    });
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

test("a newly completed video is delivered to only its bound document row", async () => {
  const link = "https://www.tiktok.com/@demo/video/7999999999999999999";
  const video = {
    id: "video-direct",
    productId: "product-direct",
    sourceType: "tiktok",
    sourceUrl: new URL(link).toString(),
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
    assert.deepEqual(writes.filter((write) => write.documentId === documentIds[0]), [
      { documentId: documentIds[0], blockId: rowTextIds[0].status, content: "" },
      { documentId: documentIds[0], blockId: rowTextIds[0].analysis, content: "直接写入的视频分析" },
      { documentId: documentIds[0], blockId: rowTextIds[0].translation, content: "直接写入的翻译" },
    ]);
    assert.deepEqual(writes.filter((write) => write.documentId === documentIds[1]), [], "one task is bound to one document row");
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
      return { id: "video-from-second-document", status: "queued" };
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
      content: "",
    }], "legacy state text is cleared; no new queue state is displayed");
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
        latestText.set(rowTextIds[0].analysis, {
          block_id: rowTextIds[0].analysis,
          text: { elements: [{ text_run: { content: "用户刚输入的分析" } }] },
        });
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
      { blockId: rowTextIds[0].status, content: "", revision: undefined },
      { blockId: rowTextIds[0].analysis, content: "自动分析", revision: 41 },
      { blockId: rowTextIds[0].translation, content: "自动翻译", revision: 42 },
    ]);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("the video cell no longer acts as a textual retry control", async () => {
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
    assert.deepEqual(result, { found: 1, queued: 0, completed: 1, failed: 0 });
    assert.deepEqual(enqueued, []);
    assert.deepEqual(writes, [{ blockId: rowTextIds[0].status, content: "" }]);
    assert.equal(writes.some((write) => write.blockId === rowTextIds[0].analysis), false);
    assert.equal(writes.some((write) => write.blockId === rowTextIds[0].translation), false);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("a malformed earlier row cannot block later new links", async () => {
  const badLink = "https://www.tiktok.com/@demo/video/7000000000000000101";
  const newLink = "https://www.tiktok.com/@demo/video/7000000000000000102";
  const { blocks, rowTextIds } = documentBlocks([
    { link: badLink, status: "", analysis: "", translation: "" },
    { link: newLink, status: "", analysis: "", translation: "" },
  ]);
  const statusCell = blocks.find((block) => block.block_id === "row-1-status");
  statusCell.children = ["row-1-video-view"];
  blocks.push({ block_id: "row-1-video-view", block_type: 33, children: ["row-1-video-file"] });
  blocks.push({ block_id: "row-1-video-file", block_type: 23, file: { name: "existing.mp4" } });
  const created = [];
  const enqueued = [];
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getVideoBySourceUrl: (url) => {
      if (url === new URL(badLink).toString()) throw new Error("坏行测试");
      return null;
    },
    createVideo: (input) => {
      created.push(input);
      return { id: "later-video", status: "queued" };
    },
    enqueueVideos: (ids) => enqueued.push(...ids),
  };
  try {
    const result = await syncModule.syncProductDocument({}, { id: "product-rows", documentId: "document-rows" });
    assert.deepEqual(result, { found: 1, queued: 1, completed: 0, failed: 0 });
    assert.equal(created[0].sourceUrl, new URL(newLink).toString());
    assert.deepEqual(enqueued, ["later-video"]);
    assert.equal(rowTextIds[0].status.endsWith("-text"), true);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("duplicate document links create independent tasks for each row", async () => {
  const link = "https://www.tiktok.com/t/ZP8Duplicate/";
  const { blocks } = documentBlocks([
    { link, status: "", analysis: "", translation: "" },
    { link, status: "", analysis: "", translation: "" },
  ]);
  let stored = null;
  let creates = 0;
  const enqueued = [];
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getVideoBySourceUrl: () => stored,
    createVideo: () => {
      creates += 1;
      stored = { id: `row-video-${creates}`, status: "queued" };
      return stored;
    },
    enqueueVideos: (ids) => enqueued.push(...ids),
  };
  try {
    assert.deepEqual(
      await syncModule.syncProductDocument({}, { id: "product-duplicate", documentId: "document-duplicate" }),
      { found: 2, queued: 2, completed: 0, failed: 0 },
    );
    assert.equal(creates, 2);
    assert.deepEqual(enqueued, ["row-video-1", "row-video-2"]);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("failed product-document analysis is reported without automatically requeueing the task", async () => {
  const link = "https://www.tiktok.com/@demo/video/7000000000000000201";
  const { blocks, rowTextIds } = documentBlocks([{ link, status: "旧状态", analysis: "", translation: "" }]);
  const video = {
    id: "retry-video",
    status: "failed",
    analysisMode: "product_doc",
    productDocRetryCount: 1,
    productDocFailureDelivered: false,
    errorMessage: "临时失败",
    transcriptZh: "这是 TokScript 原口播的中文翻译。",
  };
  const latestText = new Map(blocks.filter((block) => block.text).map((block) => [block.block_id, block]));
  const client = {
    request: async ({ url }) => {
      if (!String(url).includes("/blocks/")) return { data: { document: { revision_id: 49 } } };
      const blockId = decodeURIComponent(String(url).split("/").at(-1));
      return { data: { block: latestText.get(blockId) } };
    },
  };
  const updates = [];
  const enqueued = [];
  const writes = [];
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getVideoBySourceUrl: () => video,
    updateVideo: (_id, values) => updates.push(values),
    enqueueVideos: (ids) => enqueued.push(...ids),
    updateFeishuTextBlock: async (_client, _documentId, blockId, content) => writes.push({ blockId, content }),
  };
  try {
    assert.deepEqual(
      await syncModule.syncProductDocument(client, { id: "product-retry", documentId: "document-retry" }),
      { found: 1, queued: 0, completed: 0, failed: 1 },
    );
    assert.deepEqual(updates, [{ product_doc_failure_delivered: 1 }]);
    assert.deepEqual(enqueued, []);
    assert.deepEqual(writes, [
      { blockId: rowTextIds[0].status, content: "" },
      { blockId: rowTextIds[0].translation, content: "这是 TokScript 原口播的中文翻译。" },
      { blockId: rowTextIds[0].analysis, content: "失败：临时失败" },
    ]);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("a stopped document task stays stopped and is shown without automatic requeue", async () => {
  const link = "https://www.tiktok.com/@demo/video/7000000000000000250";
  const { blocks, rowTextIds } = documentBlocks([{ link, status: "", analysis: "", translation: "" }]);
  const video = {
    id: "stopped-video",
    productId: "product-stopped",
    sourceType: "tiktok",
    sourceUrl: new URL(link).toString(),
    status: "stopped",
    analysisMode: "product_doc",
    errorMessage: "用户停止",
  };
  const latestText = new Map(blocks.filter((block) => block.text).map((block) => [block.block_id, block]));
  const writes = [];
  const enqueued = [];
  const client = {
    request: async ({ url }) => {
      if (!String(url).includes("/blocks/")) return { data: { document: { revision_id: 77 } } };
      const blockId = decodeURIComponent(String(url).split("/").at(-1));
      return { data: { block: latestText.get(blockId) } };
    },
  };
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getVideo: () => video,
    getVideoBySourceUrl: () => video,
    enqueueVideos: (ids) => enqueued.push(...ids),
    updateFeishuTextBlock: async (_client, _documentId, blockId, content) => writes.push({ blockId, content }),
  };
  try {
    assert.deepEqual(
      await syncModule.syncProductDocument(client, { id: video.productId, documentId: "document-stopped" }),
      { found: 1, queued: 0, completed: 0, failed: 1 },
    );
    assert.deepEqual(enqueued, []);
    assert.deepEqual(writes, [{ blockId: rowTextIds[0].analysis, content: "已停止，请重新粘贴视频链接" }]);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("clearing a persistently delivered terminal error requests a fresh analysis after restart", async () => {
  const link = "https://www.tiktok.com/@demo/video/7000000000000000202";
  const { blocks } = documentBlocks([{ link, status: "", analysis: "", translation: "" }]);
  const video = {
    id: "terminal-video",
    status: "failed",
    analysisMode: "product_doc",
    productDocRetryCount: 2,
    productDocFailureDelivered: true,
    errorMessage: "最终失败",
  };
  const latestText = new Map(blocks.filter((block) => block.text).map((block) => [block.block_id, block]));
  const client = {
    request: async ({ url }) => {
      if (!String(url).includes("/blocks/")) return { data: { document: { revision_id: 50 } } };
      const blockId = decodeURIComponent(String(url).split("/").at(-1));
      return { data: { block: latestText.get(blockId) } };
    },
  };
  const updates = [];
  const enqueued = [];
  const writes = [];
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getVideoBySourceUrl: () => video,
    updateVideo: (_id, values) => updates.push(values),
    enqueueVideos: (ids) => enqueued.push(...ids),
    updateFeishuTextBlock: async (_client, _documentId, blockId, content) => writes.push({ blockId, content }),
  };
  try {
    assert.deepEqual(
      await syncModule.syncProductDocument(client, { id: "product-terminal", documentId: "document-terminal" }),
      { found: 1, queued: 1, completed: 0, failed: 0 },
    );
    assert.deepEqual(updates, [{ product_doc_failure_delivered: 0, error_message: null }]);
    assert.deepEqual(enqueued, [video.id]);
    assert.deepEqual(writes, []);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("an observed failure cell restores the durable manual-retry marker", async () => {
  const link = "https://www.tiktok.com/@demo/video/7000000000000000203";
  const { blocks } = documentBlocks([{ link, status: "", analysis: "失败：此前已写入", translation: "" }]);
  const video = {
    id: "observed-terminal-video",
    status: "failed",
    analysisMode: "product_doc",
    productDocFailureDelivered: false,
    errorMessage: "此前已写入",
  };
  const latestText = new Map(blocks.filter((block) => block.text).map((block) => [block.block_id, block]));
  const client = {
    request: async ({ url }) => {
      if (!String(url).includes("/blocks/")) return { data: { document: { revision_id: 51 } } };
      const blockId = decodeURIComponent(String(url).split("/").at(-1));
      return { data: { block: latestText.get(blockId) } };
    },
  };
  const updates = [];
  const enqueued = [];
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getVideoBySourceUrl: () => video,
    updateVideo: (_id, values) => updates.push(values),
    enqueueVideos: (ids) => enqueued.push(...ids),
  };
  try {
    assert.deepEqual(
      await syncModule.syncProductDocument(client, { id: "product-observed", documentId: "document-observed" }),
      { found: 1, queued: 0, completed: 0, failed: 1 },
    );
    assert.deepEqual(updates, [{ product_doc_failure_delivered: 1 }]);
    assert.deepEqual(enqueued, []);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("a manual analysis entered during preview upload prevents a stale retry", async () => {
  const link = "https://www.tiktok.com/@demo/video/7000000000000000204";
  const { blocks, rowTextIds } = documentBlocks([{ link, status: "", analysis: "", translation: "" }]);
  const video = {
    id: "preview-edit-video",
    productId: "product-preview-edit",
    sourceType: "tiktok",
    sourceUrl: link,
    originalPath: "preview-edit-video/original.mp4",
    status: "failed",
    analysisMode: "product_doc",
    productDocFailureDelivered: true,
    attemptCount: 1,
    errorMessage: "此前失败",
  };
  const latestText = new Map(blocks.filter((block) => block.text).map((block) => [block.block_id, structuredClone(block)]));
  const client = {
    request: async ({ url }) => {
      if (!String(url).includes("/blocks/")) return { data: { document: { revision_id: 61 } } };
      const blockId = decodeURIComponent(String(url).split("/").at(-1));
      return { data: { block: latestText.get(blockId) } };
    },
  };
  const updates = [];
  const enqueued = [];
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getVideoBySourceUrl: () => video,
    getVideo: () => video,
    updateVideo: (_id, values) => updates.push(values),
    enqueueVideos: (ids) => enqueued.push(...ids),
    ensureFeishuVideoPreview: async () => {
      latestText.get(rowTextIds[0].analysis).text.elements[0].text_run.content = "用户刚填写的分析";
      return true;
    },
  };
  try {
    assert.deepEqual(
      await syncModule.syncProductDocument(client, { id: video.productId, documentId: "document-preview-edit" }),
      { found: 1, queued: 0, completed: 0, failed: 1 },
    );
    assert.deepEqual(updates, []);
    assert.deepEqual(enqueued, []);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("a task completed during preview upload cannot be requeued from a stale failed snapshot", async () => {
  const link = "https://www.tiktok.com/@demo/video/7000000000000000205";
  const { blocks } = documentBlocks([{ link, status: "", analysis: "人工分析", translation: "人工翻译" }]);
  const failed = {
    id: "preview-complete-video",
    productId: "product-preview-complete",
    sourceType: "tiktok",
    sourceUrl: link,
    originalPath: "preview-complete-video/original.mp4",
    status: "failed",
    analysisMode: "product_doc",
    productDocFailureDelivered: true,
    attemptCount: 1,
    errorMessage: "此前失败",
  };
  let current = failed;
  const enqueued = [];
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getVideoBySourceUrl: () => current,
    getVideo: () => current,
    enqueueVideos: (ids) => enqueued.push(...ids),
    ensureFeishuVideoPreview: async () => {
      current = {
        ...failed,
        status: "completed",
        analysis: { summary: "完成结果" },
        transcriptZh: "完成翻译",
      };
      return true;
    },
  };
  try {
    assert.deepEqual(
      await syncModule.syncProductDocument({}, { id: failed.productId, documentId: "document-preview-complete" }),
      { found: 1, queued: 0, completed: 1, failed: 0 },
    );
    assert.deepEqual(enqueued, []);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("changing link A to B during preview prevents A's preview and completed result from binding", async () => {
  const linkA = "https://www.tiktok.com/@demo/video/7000000000000000206";
  const linkB = "https://www.tiktok.com/@demo/video/7000000000000000207";
  const { blocks, rowTextIds } = documentBlocks([{ link: linkA, status: "", analysis: "", translation: "" }]);
  const video = {
    id: "preview-link-change-completed",
    productId: "product-link-change-completed",
    sourceType: "tiktok",
    sourceUrl: new URL(linkA).toString(),
    originalPath: "preview-link-change-completed/original.mp4",
    status: "completed",
    analysisMode: "product_doc",
    productDocFailureDelivered: false,
    attemptCount: 1,
    analysis: { summary: "A的分析" },
    transcriptZh: "A的翻译",
  };
  const latestText = new Map(blocks.filter((block) => block.text).map((block) => [block.block_id, structuredClone(block)]));
  const client = {
    request: async ({ url }) => {
      if (!String(url).includes("/blocks/")) return { data: { document: { revision_id: 71 } } };
      const blockId = decodeURIComponent(String(url).split("/").at(-1));
      return { data: { block: latestText.get(blockId) } };
    },
  };
  const writes = [];
  const bindingChecks = [];
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getVideoBySourceUrl: () => video,
    getVideo: () => video,
    conciseProductDocAnalysis: () => "A的自动分析",
    updateFeishuTextBlock: async (_client, _documentId, blockId, content) => writes.push({ blockId, content }),
    ensureFeishuVideoPreview: async (input) => {
      bindingChecks.push(await input.validateBinding());
      latestText.get(rowTextIds[0].link).text.elements[0].text_run.content = linkB;
      bindingChecks.push(await input.validateBinding());
      return false;
    },
  };
  try {
    assert.deepEqual(
      await syncModule.syncProductDocument(client, { id: video.productId, documentId: "document-link-change-completed" }),
      { found: 1, queued: 0, completed: 1, failed: 0 },
    );
    assert.deepEqual(bindingChecks.map((item) => item.valid), [true, false]);
    assert.deepEqual(writes, []);
  } finally {
    delete globalThis.__productDocSyncWriteProtectionHooks;
  }
});

test("changing link A to B during preview prevents A's cleared failure from requeueing", async () => {
  const linkA = "https://www.tiktok.com/@demo/video/7000000000000000208";
  const linkB = "https://www.tiktok.com/@demo/video/7000000000000000209";
  const { blocks, rowTextIds } = documentBlocks([{ link: linkA, status: "", analysis: "", translation: "" }]);
  const video = {
    id: "preview-link-change-failed",
    productId: "product-link-change-failed",
    sourceType: "tiktok",
    sourceUrl: new URL(linkA).toString(),
    originalPath: "preview-link-change-failed/original.mp4",
    status: "failed",
    analysisMode: "product_doc",
    productDocFailureDelivered: true,
    attemptCount: 2,
    errorMessage: "A此前失败",
  };
  const latestText = new Map(blocks.filter((block) => block.text).map((block) => [block.block_id, structuredClone(block)]));
  const client = {
    request: async ({ url }) => {
      if (!String(url).includes("/blocks/")) return { data: { document: { revision_id: 72 } } };
      const blockId = decodeURIComponent(String(url).split("/").at(-1));
      return { data: { block: latestText.get(blockId) } };
    },
  };
  const updates = [];
  const enqueued = [];
  const bindingChecks = [];
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => blocks,
    getVideoBySourceUrl: () => video,
    getVideo: () => video,
    updateVideo: (_id, values) => updates.push(values),
    enqueueVideos: (ids) => enqueued.push(...ids),
    ensureFeishuVideoPreview: async (input) => {
      bindingChecks.push(await input.validateBinding());
      latestText.get(rowTextIds[0].link).text.elements[0].text_run.content = linkB;
      bindingChecks.push(await input.validateBinding());
      return false;
    },
  };
  try {
    assert.deepEqual(
      await syncModule.syncProductDocument(client, { id: video.productId, documentId: "document-link-change-failed" }),
      { found: 1, queued: 0, completed: 0, failed: 1 },
    );
    assert.deepEqual(bindingChecks.map((item) => item.valid), [true, false]);
    assert.deepEqual(updates, []);
    assert.deepEqual(enqueued, []);
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
