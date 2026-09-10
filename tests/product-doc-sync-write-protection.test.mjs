import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const syncSource = await readFile(
  new URL("../lib/feishu/product-doc-sync.ts", import.meta.url),
  "utf8",
);
const transcriptValidationSource = await readFile(new URL("../lib/transcript-validation.ts", import.meta.url), "utf8");
const transcriptValidationUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(transcriptValidationSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64")}`;
const { NO_PRODUCT_VOICEOVER_TRANSCRIPT } = await import(transcriptValidationUrl);

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
    export const getCachedDocumentRevision = async (...args) => hooks().getCachedDocumentRevision?.(...args) ?? null;
    export const setCachedDocumentRevision = async (...args) => hooks().setCachedDocumentRevision?.(...args);
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
    .replaceAll('"@/lib/transcript-validation"', JSON.stringify(transcriptValidationUrl))
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

async function withResultCellFixture(run, overrides = {}) {
  const link = "https://www.tiktok.com/@demo/video/123456789";
  const fixture = documentBlocks([{ link, status: "", analysis: "", translation: "" }]);
  const { blocks, rowTextIds: [ids] } = fixture;
  const video = {
    id: "whole-cell-video", productId: "p", sourceType: "tiktok", sourceUrl: link,
    analysisMode: "product_doc", status: "completed", attemptCount: 1,
    transcriptZh: "自动中文", originalPath: "fixture.mp4", ...overrides,
  };
  const writes = [], enqueued = [], updates = [], cached = [], reads = [];
  const state = { revision: 10, onPreview: () => {}, onWrite: () => {} };
  const client = { request: async ({ url, params }) => {
    if (!String(url).includes("/blocks/")) return { data: { document: { revision_id: state.revision } } };
    const id = decodeURIComponent(url.split("/").at(-1));
    reads.push({ id, revision: Number(params.document_revision_id) });
    return { data: { block: blocks.find(b => b.block_id === id) } };
  } };
  const append = (field, payload) => {
    const cell = blocks.find(b => b.block_id === `row-1-${field}`);
    const block = { block_id: `${cell.block_id}-extra-${cell.children.length}`, ...payload };
    cell.children.push(block.block_id);
    blocks.push(block);
    return block;
  };
  globalThis.__productDocSyncWriteProtectionHooks = {
    listFeishuDocumentBlocks: () => structuredClone(blocks),
    getVideoBySourceUrl: () => video,
    getVideo: () => video,
    ensureFeishuVideoPreview: async () => state.onPreview(),
    updateFeishuTextBlock: async (_c, _d, id, content, options) => {
      state.onWrite();
      assert.equal(options.documentRevisionId, state.revision, "never write at a stale revision");
      writes.push({ id, content });
      blocks.find(b => b.block_id === id).text = { elements: [{ text_run: { content } }] };
      state.revision += 1;
    },
    enqueueVideos: ids => enqueued.push(...ids),
    updateVideo: (_id, patch) => updates.push(patch),
    setCachedDocumentRevision: (...args) => cached.push(args),
  };
  const sync = () => syncModule.syncProductDocument(client, { id: "p", documentId: "whole-cell-doc" });
  try { await run({ blocks, ids, video, writes, enqueued, updates, cached, reads, state, append, sync }); }
  finally { delete globalThis.__productDocSyncWriteProtectionHooks; }
}

const manualParagraph = () => ({ block_type: 2, text: { elements: [{ text_run: { content: "人工第二段" } }] } });

for (const status of ["analyzing", "failed", "completed"]) {
  test(`handcard voiceover label: exact TokScript marker becomes no voiceover during ${status}`, async () => {
    await withResultCellFixture(async ({ ids, video, writes, enqueued, updates, sync }) => {
      const storedTranscript = video.transcriptZh;
      await sync();
      assert.deepEqual(writes.filter(w => w.id === ids.translation), [{ id: ids.translation, content: "无口播" }]);
      assert.equal(video.transcriptZh, storedTranscript, "display formatting must not change stored provider data");
      assert.equal(updates.some(p => "transcript_zh" in p || "transcript_original" in p), false);
      assert.deepEqual(enqueued, [], "formatting must not rerun analysis");
      if (status === "completed") assert.ok(writes.some(w => w.id === ids.analysis && w.content === "自动视频分析"));
    }, { status, transcriptZh: `  ${NO_PRODUCT_VOICEOVER_TRANSCRIPT}\n` });
  });
}

for (const timing of ["before scan", "during preview"]) {
  test(`handcard voiceover label: preserves existing text ${timing}`, async () => {
    await withResultCellFixture(async ({ ids, append, state, writes, sync }) => {
      const fill = () => { append("translation", manualParagraph()); state.revision += 1; };
      if (timing === "before scan") fill();
      else state.onPreview = fill;
      await sync();
      assert.equal(writes.some(w => w.id === ids.translation), false);
      assert.ok(writes.some(w => w.id === ids.analysis), "the independent empty analysis still fills");
    }, { transcriptZh: NO_PRODUCT_VOICEOVER_TRANSCRIPT });
  });
}

for (const transcriptZh of ["无口播", `这是口播中的原句：${NO_PRODUCT_VOICEOVER_TRANSCRIPT}，不是系统标记。`, ""]) {
  test(`handcard voiceover label: leaves other translation text unchanged ${JSON.stringify(transcriptZh)}`, async () => {
    await withResultCellFixture(async ({ ids, writes, sync }) => {
      await sync();
      assert.deepEqual(writes.filter(w => w.id === ids.translation), transcriptZh ? [{ id: ids.translation, content: transcriptZh }] : []);
    }, { transcriptZh });
  });
}

for (const status of ["completed", "analyzing", "failed", "stopped"]) {
  for (const timing of ["before scan", "during preview"]) {
    test(`whole-cell guard preserves later manual paragraphs: ${status}, ${timing}`, async () => {
      await withResultCellFixture(async ({ append, state, writes, enqueued, updates, sync }) => {
        const fill = () => {
          append("analysis", manualParagraph());
          append("translation", manualParagraph());
          state.revision += 1;
        };
        if (timing === "before scan") fill();
        else state.onPreview = fill;
        await sync();
        assert.deepEqual(writes, [], "any manual paragraph owns the entire result cell");
        assert.deepEqual(enqueued, [], "an empty first paragraph is not a cleared failure cell");
        assert.deepEqual(updates, [], "do not reset a delivered failure while manual text remains");
      }, { status, productDocFailureDelivered: true });
    });
  }
}

for (const [kind, content] of [
  ["heading", { heading1: { elements: [{ text_run: { content: "人工标题" } }] } }],
  ["styled text", { text: { elements: [{ text_run: { content: "人工加粗", text_element_style: { bold: true } } }] } }],
  ["mention", { text: { elements: [{ mention_user: { user_id: "isolated-user" } }] } }],
  ["nested paragraph", { children: ["nested-manual"], quote_container: {} }],
]) {
  test(`whole-cell guard protects ${kind} inserted after the scan`, async () => {
    await withResultCellFixture(async ({ blocks, append, state, writes, sync }) => {
      state.onPreview = () => {
        append("analysis", structuredClone(content));
        blocks.push({ block_id: "nested-manual", ...manualParagraph() });
        state.revision += 1;
      };
      await sync();
      assert.deepEqual(writes.map(w => w.content), ["自动中文"], "the independent empty translation still fills");
    });
  });
}

test("whole-cell guard checks every paragraph at the write revision and still fills truly empty cells", async () => {
  await withResultCellFixture(async ({ append, state, reads, writes, ids, sync }) => {
    const extra = append("analysis", { text: { elements: [{ text_run: { content: " \n　 " } }] } });
    state.onPreview = () => { state.revision = 20; };
    await sync();
    assert.deepEqual(writes, [{ id: ids.translation, content: "自动中文" }, { id: ids.analysis, content: "自动视频分析" }]);
    assert.ok(reads.some(r => r.id === "row-1-analysis" && r.revision === 21));
    assert.ok(reads.some(r => r.id === extra.block_id && r.revision === 21));
  });
});

test("whole-cell guard uses the current empty paragraph rather than a removed scan-time target", async () => {
  await withResultCellFixture(async ({ blocks, append, state, writes, sync }) => {
    let replacement;
    state.onPreview = () => {
      replacement = append("analysis", { text: { elements: [] } });
      blocks.find(b => b.block_id === "row-1-analysis").children = [replacement.block_id];
      state.revision += 1;
    };
    await sync();
    assert.equal(writes.at(-1).id, replacement.block_id);
  });
});

// A simulated rejection checks error handling, not a guarantee that Feishu
// actually rejects stale revisions. Live acceptance found that it may not.
for (const failure of ["missing paragraph", "cycle", "revision conflict"]) {
  const label = failure === "revision conflict" ? "simulated API revision rejection" : failure;
  test(`whole-cell guard fails closed on ${label}`, async () => {
    await withResultCellFixture(async ({ blocks, state, writes, cached, sync }) => {
      state.onPreview = () => {
        blocks.find(b => b.block_id === "row-1-translation").children.push(
          failure === "cycle" ? "row-1-translation" : failure === "missing paragraph" ? "missing-child" : "row-1-translation-text",
        );
        if (failure === "revision conflict") {
          blocks.find(b => b.block_id === "row-1-translation").children.pop();
          state.onWrite = () => { state.revision += 1; };
        }
      };
      await sync();
      assert.deepEqual(writes, []);
      assert.deepEqual(cached, [], "an incomplete read or rejected write must remain retryable");
    });
  });
}

for (const status of ["analyzing", "failed", "completed"]) {
  test(`direct ${status} delivery bypasses unchanged revisions and preserves manual cells`, async () => {
    const link = "https://www.tiktok.com/@demo/video/123456789";
    const { blocks, rowTextIds } = documentBlocks([
      { link: "", status: "", analysis: "", translation: "" },
      { link, status: "", analysis: "人工分析", translation: "" },
    ]);
    blocks.find(b => b.block_id === "header-1-text").text.elements[0].text_run.content = "视频文件";
    const video = {
      id: "partial-result", productId: "product", sourceType: "tiktok", sourceUrl: link,
      analysisMode: "product_doc", status, transcriptZh: "独立翻译", originalPath: "fake-original.mp4", attemptCount: 1,
    };
    const binding = { videoId: video.id, documentId: "partial-doc", linkBlockId: rowTextIds[1].link, sourceUrl: link };
    const writes = [], enqueued = [];
    let previews = 0, revisionReads = 0;
    const client = { request: async ({ url }) => {
      if (!String(url).includes("/blocks/")) {
        revisionReads += 1;
        return { data: { document: { revision_id: 20 } } };
      }
      return { data: { block: blocks.find(b => b.block_id === decodeURIComponent(url.split("/").at(-1))) } };
    } };
    globalThis.__productDocSyncWriteProtectionHooks = {
      getVideo: () => video,
      getProduct: () => ({ id: "product", documentId: "partial-doc" }),
      getProductDocumentVideoRow: () => binding,
      getCachedDocumentRevision: () => 20,
      getConnectedFeishuChannel: () => ({ rawClient: client }),
      listFeishuDocumentBlocks: () => blocks,
      updateFeishuTextBlock: async (_client, _doc, blockId, content) => writes.push({ blockId, content }),
      deleteProductDocumentVideoRow: () => { throw new Error("must not mutate another row"); },
      ensureFeishuVideoPreview: async () => { previews += 1; throw new Error("simulated upload failure"); },
      enqueueVideos: ids => enqueued.push(...ids),
    };
    try {
      await syncModule.syncVideoToProductDocument(video.id);
      assert.equal(previews, 1);
      assert.equal(revisionReads, 1, "only the final blank-cell guard reads a revision");
      assert.deepEqual(writes, [{ blockId: rowTextIds[1].translation, content: "独立翻译" }]);
      assert.deepEqual(enqueued, []);
    } finally { delete globalThis.__productDocSyncWriteProtectionHooks; }
  });
}

test("a late failed-task translation never requeues analysis after the user clears its failure", async () => {
  const link = "https://www.tiktok.com/@demo/video/123456789";
  const { blocks, rowTextIds } = documentBlocks([{ link, status: "", analysis: "", translation: "" }]);
  const video = { id: "late-failure", productId: "p", sourceUrl: link, sourceType: "tiktok",
    status: "failed", analysisMode: "product_doc", productDocFailureDelivered: true,
    transcriptZh: "迟到的翻译", attemptCount: 1 };
  const binding = { videoId: video.id, documentId: "doc-late", linkBlockId: rowTextIds[0].link, sourceUrl: link };
  const writes = [], enqueued = [];
  const client = { request: async ({ url }) => String(url).includes("/blocks/")
    ? { data: { block: blocks.find(b => b.block_id === decodeURIComponent(url.split("/").at(-1))) } }
    : { data: { document: { revision_id: 10 } } } };
  globalThis.__productDocSyncWriteProtectionHooks = {
    getVideo: () => video, getProduct: () => ({ id: "p", documentId: "doc-late" }),
    getProductDocumentVideoRow: () => binding, getConnectedFeishuChannel: () => ({ rawClient: client }),
    listFeishuDocumentBlocks: () => blocks,
    updateFeishuTextBlock: async (_c, _d, blockId, content) => writes.push({ blockId, content }),
    enqueueVideos: ids => enqueued.push(...ids),
  };
  try {
    await syncModule.syncVideoToProductDocument(video.id);
    assert.deepEqual(writes, [{ blockId: rowTextIds[0].translation, content: "迟到的翻译" }]);
    assert.deepEqual(enqueued, []);
  } finally { delete globalThis.__productDocSyncWriteProtectionHooks; }
});

test("a failed immediate delivery invalidates an unchanged document revision for polling recovery", async () => {
  let revision = 20;
  const video = { id: "event", productId: "p", status: "failed" };
  globalThis.__productDocSyncWriteProtectionHooks = {
    getVideo: () => video, getProduct: () => ({ id: "p", documentId: "doc-event" }),
    getConnectedFeishuChannel: () => ({ rawClient: {} }),
    isProductDocumentVideoRowsInitialized: () => true,
    setCachedDocumentRevision: (_doc, value) => { revision = value; },
    listFeishuDocumentBlocks: () => { throw new Error("temporary Feishu outage"); },
  };
  try {
    await assert.rejects(syncModule.syncVideoToProductDocument(video.id), /temporary Feishu outage/);
    assert.equal(revision, -1);
  } finally { delete globalThis.__productDocSyncWriteProtectionHooks; }
});

test("a failed row write is not marked as a successfully processed document revision", async () => {
  const link = "https://www.tiktok.com/@demo/video/123456789";
  const { blocks } = documentBlocks([{ link, status: "", analysis: "", translation: "" }]);
  const cached = [];
  const client = { request: async ({ url }) => String(url).includes("/blocks/")
    ? { data: { block: blocks.find(b => b.block_id === decodeURIComponent(url.split("/").at(-1))) } }
    : { data: { document: { revision_id: 20 } } } };
  globalThis.__productDocSyncWriteProtectionHooks = {
    getCachedDocumentRevision: () => 19,
    setCachedDocumentRevision: (...args) => cached.push(args),
    listFeishuDocumentBlocks: () => blocks,
    getVideoBySourceUrl: () => ({ id: "delivery-error", sourceUrl: link, status: "completed", transcriptZh: "译文" }),
    updateFeishuTextBlock: () => { throw new Error("temporary row write failure"); },
  };
  try {
    await syncModule.syncProductDocument(client, { id: "p", documentId: "doc-write-error" });
    assert.deepEqual(cached, []);
  } finally { delete globalThis.__productDocSyncWriteProtectionHooks; }
});

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
    .filter((block) => block.block_id)
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
      17,
      "one scan revision plus each writable cell's revision, link, cell and paragraph blocks",
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
    .filter((block) => block.block_id)
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
    assert.equal(await syncModule.syncVideoToProductDocument(video.id), true);
    assert.deepEqual(scans, documentIds, "the canonical document duplicated by its mapping is scanned once");
    assert.deepEqual(writes.filter((write) => write.documentId === documentIds[0]), [
      { documentId: documentIds[0], blockId: rowTextIds[0].status, content: "" },
      { documentId: documentIds[0], blockId: rowTextIds[0].translation, content: "直接写入的翻译" },
      { documentId: documentIds[0], blockId: rowTextIds[0].analysis, content: "直接写入的视频分析" },
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
    .filter((block) => block.block_id)
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
    .filter((block) => block.block_id)
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
      { blockId: rowTextIds[0].translation, content: "自动翻译", revision: 41 },
      { blockId: rowTextIds[0].analysis, content: "自动分析", revision: 42 },
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
  const latestText = new Map(blocks.map((block) => [block.block_id, block]));
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
  const latestText = new Map(blocks.map((block) => [block.block_id, block]));
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
  const latestText = new Map(blocks.map((block) => [block.block_id, block]));
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
  const latestText = new Map(blocks.map((block) => [block.block_id, block]));
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
  const latestText = new Map(blocks.map((block) => [block.block_id, structuredClone(block)]));
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
  const latestText = new Map(blocks.map((block) => [block.block_id, structuredClone(block)]));
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
  const latestText = new Map(blocks.map((block) => [block.block_id, structuredClone(block)]));
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
