import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const databaseSource = await readFile(
  new URL("../lib/database.ts", import.meta.url),
  "utf8",
);
const automationSource = await readFile(
  new URL("../lib/feishu/automation.ts", import.meta.url),
  "utf8",
);
const instrumentationSource = await readFile(
  new URL("../instrumentation.ts", import.meta.url),
  "utf8",
);

async function loadDatabaseModule(dataRoot) {
  let compiled = ts.transpileModule(databaseSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  compiled = compiled
    .replace('import "server-only";', "")
    .replace(
      'const dataRoot = path.join(process.cwd(), ".data");',
      `const dataRoot = ${JSON.stringify(dataRoot)};`,
    );
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

async function loadAutomationModule() {
  const stubSource = `
    const hooks = () => globalThis.__feishuVideoDeliveryTestHooks || {};
    export const claimFeishuProductCardDocument = () => true;
    export const clearProductDocumentLink = () => false;
    export const createProduct = () => null;
    export const createVideo = () => null;
    export const deleteFeishuAutomationJob = (...args) => hooks().deleteFeishuAutomationJob?.(...args);
    export const getFeishuAutomationJobs = (...args) => hooks().getFeishuAutomationJobs?.(...args) || [];
    export const listFeishuAutomationJobVideoIds = (...args) => hooks().listFeishuAutomationJobVideoIds?.(...args) || [];
    export const getFeishuProductCardMapping = (...args) => hooks().getFeishuProductCardMapping?.(...args) || null;
    export const getProduct = (...args) => hooks().getProduct?.(...args) || null;
    export const getProductByPid = () => null;
    export const getVideo = (...args) => hooks().getVideo?.(...args) || null;
    export const getVideoBySourceUrl = () => null;
    export const saveFeishuAutomationJob = () => undefined;
    export const updateProduct = () => null;
    export const updateVideo = () => null;
    export const upsertFeishuProductCardMapping = () => null;
    export const ensureFeishuConnection = (...args) => hooks().ensureFeishuConnection?.(...args) || null;
    export const getConnectedFeishuChannel = (...args) => hooks().getConnectedFeishuChannel?.(...args) || null;
    export const ensureProductCardShell = () => null;
    export const syncProductCardManagedFields = () => null;
    export const enqueueVideos = () => undefined;
    export const extractProductIdFromUrl = () => "";
    export const isExactTikTokProductSource = () => false;
    export const parsePublicProductPage = () => null;
    export const conciseProductDocAnalysis = (...args) => hooks().conciseProductDocAnalysis?.(...args) || "分析摘要";
    export const isTikTokUrl = () => false;
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
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

test("legacy video jobs migrate to per-Base-row deliveries without overwriting", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "viral-video-deliveries-"));
  const dataRoot = path.join(temporaryRoot, ".data");
  await mkdir(dataRoot, { recursive: true });
  delete globalThis.__viralDb;
  const database = await loadDatabaseModule(dataRoot);
  try {
    const product = database.createProduct({ name: "迁移测试产品" });
    const video = database.createVideo({
      productId: product.id,
      sourceType: "tiktok",
      sourceUrl: "https://www.tiktok.com/@creator/video/7000000000000000001",
    });
    const db = database.getDb();
    db.exec(`
      DROP TABLE feishu_automation_jobs;
      CREATE TABLE feishu_automation_jobs (
        video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
        app_token TEXT NOT NULL,
        table_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        field_map_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO feishu_automation_jobs(
      video_id, app_token, table_id, record_id, field_map_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(video.id, "app-a", "table-a", "record-a", '{"status":"旧状态"}', "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
    db.close();
    delete globalThis.__viralDb;

    const migrated = database.getFeishuAutomationJobs(video.id);
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].recordId, "record-a");
    assert.equal(migrated[0].fieldMap.status, "旧状态");

    database.saveFeishuAutomationJob({
      videoId: video.id,
      appToken: "app-b",
      tableId: "table-b",
      recordId: "record-b",
      fieldMap: { status: "B状态" },
    });
    database.saveFeishuAutomationJob({
      videoId: video.id,
      appToken: "app-a",
      tableId: "table-a",
      recordId: "record-a",
      fieldMap: { status: "A新状态", webhookSecret: "must-not-persist" },
    });
    const jobs = database.getFeishuAutomationJobs(video.id);
    assert.equal(jobs.length, 2, "the same video must retain both Base-row deliveries");
    assert.deepEqual(database.listFeishuAutomationJobVideoIds(), [video.id], "pending video IDs must be distinct");
    assert.equal(jobs.find((job) => job.recordId === "record-a").fieldMap.status, "A新状态");
    assert.equal(jobs.find((job) => job.recordId === "record-a").createdAt, "2026-08-01T00:00:00.000Z");
    assert.doesNotMatch(JSON.stringify(jobs), /must-not-persist|webhookSecret/);

    const primaryKey = database.getDb().prepare("PRAGMA table_info(feishu_automation_jobs)").all()
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => String(column.name));
    assert.deepEqual(primaryKey, ["video_id", "app_token", "table_id", "record_id"]);

    database.deleteFeishuAutomationJob(jobs.find((job) => job.recordId === "record-a"));
    const remaining = database.getFeishuAutomationJobs(video.id);
    assert.deepEqual(remaining.map((job) => job.recordId), ["record-b"], "one success must only delete its own delivery");
    assert.deepEqual(database.listFeishuAutomationJobVideoIds(), [video.id], "one remaining row keeps the video pending");
    database.deleteFeishuAutomationJob(remaining[0]);
    assert.deepEqual(database.listFeishuAutomationJobVideoIds(), []);
  } finally {
    try { database.getDb().close(); } catch { /* already closed */ }
    delete globalThis.__viralDb;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

const automation = await loadAutomationModule();

function delivery(recordId) {
  return {
    videoId: "video-1",
    appToken: "app-token",
    tableId: "table-id",
    recordId,
    fieldMap: {},
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

test("completion retries each Base delivery and deletes successful rows independently", async () => {
  const pending = new Map([["record-a", delivery("record-a")], ["record-b", delivery("record-b")]]);
  const attempts = new Map();
  const writes = [];
  globalThis.__feishuVideoDeliveryTestHooks = {
    getFeishuAutomationJobs: () => [...pending.values()],
    getVideo: () => ({
      id: "video-1", productId: "product-1", status: "completed", transcriptZh: "中文翻译", errorMessage: null,
    }),
    getProduct: () => ({ id: "product-1", documentUrl: "https://feishu.cn/docx/product-document" }),
    getFeishuProductCardMapping: ({ recordId }) => ({
      documentUrl: `https://feishu.cn/docx/${recordId}`,
    }),
    getConnectedFeishuChannel: () => ({
      rawClient: {
        request: async ({ url, data }) => {
          const recordId = url.includes("record-a") ? "record-a" : "record-b";
          const count = (attempts.get(recordId) || 0) + 1;
          attempts.set(recordId, count);
          writes.push({ recordId, fields: data.fields });
          if (recordId === "record-a" && count < 3) throw new Error("temporary network failure");
          return { code: 0 };
        },
      },
    }),
    deleteFeishuAutomationJob: (job) => pending.delete(job.recordId),
  };

  const completed = await automation.completeFeishuAutomation("video-1");
  assert.equal(completed, true);
  assert.equal(attempts.get("record-a"), 3);
  assert.equal(attempts.get("record-b"), 1);
  assert.equal(pending.size, 0);
  assert.equal(
    writes.find((write) => write.recordId === "record-a").fields.产品手卡,
    "https://feishu.cn/docx/record-a",
  );
  assert.equal(
    writes.find((write) => write.recordId === "record-b").fields.产品手卡,
    "https://feishu.cn/docx/record-b",
  );
});

test("the worker redelivers an exhausted terminal job on its later startup pass", async () => {
  const pending = new Map([["record-a", delivery("record-a")], ["record-b", delivery("record-b")]]);
  let allowRecordA = false;
  let releaseWorkerWrite;
  let reportWorkerWriteStarted;
  const workerWriteGate = new Promise((resolve) => { releaseWorkerWrite = resolve; });
  const workerWriteStarted = new Promise((resolve) => { reportWorkerWriteStarted = resolve; });
  const attempts = new Map();
  globalThis.__feishuVideoDeliveryTestHooks = {
    getFeishuAutomationJobs: () => [...pending.values()],
    listFeishuAutomationJobVideoIds: () => pending.size ? ["video-1"] : [],
    getVideo: () => ({ id: "video-1", productId: "product-1", status: "completed", transcriptZh: "", errorMessage: null }),
    getProduct: () => ({ id: "product-1", documentUrl: null }),
    getFeishuProductCardMapping: () => null,
    getConnectedFeishuChannel: () => ({
      rawClient: {
        request: async ({ url }) => {
          const recordId = url.includes("record-a") ? "record-a" : "record-b";
          attempts.set(recordId, (attempts.get(recordId) || 0) + 1);
          if (recordId === "record-a" && !allowRecordA) throw new Error("temporary write failure");
          if (recordId === "record-a") {
            reportWorkerWriteStarted();
            await workerWriteGate;
          }
          return { code: 0 };
        },
      },
    }),
    deleteFeishuAutomationJob: (job) => pending.delete(job.recordId),
  };

  assert.equal(await automation.completeFeishuAutomation("video-1"), false);
  assert.deepEqual([...pending.keys()], ["record-a"]);
  assert.equal(attempts.get("record-a"), 3, "a failing delivery must have a bounded attempt count");
  assert.equal(attempts.get("record-b"), 1, "later deliveries must still run after an earlier failure");

  allowRecordA = true;
  const originalSetTimeout = globalThis.setTimeout;
  const originalSetInterval = globalThis.setInterval;
  const scheduledTimeouts = [];
  const scheduledIntervals = [];
  let unrefCalls = 0;
  globalThis.setTimeout = (callback, delay) => {
    scheduledTimeouts.push({ callback, delay });
    return { unref: () => { unrefCalls += 1; } };
  };
  globalThis.setInterval = (callback, delay) => {
    scheduledIntervals.push({ callback, delay });
    return { unref: () => { unrefCalls += 1; } };
  };
  try {
    automation.startFeishuAutomationDeliveryWorker();
    automation.startFeishuAutomationDeliveryWorker();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
  }
  assert.equal(scheduledTimeouts.length, 1, "worker startup must be a process-wide singleton");
  assert.equal(scheduledTimeouts[0].delay, 2_500);
  assert.equal(scheduledIntervals.length, 1);
  assert.ok(scheduledIntervals[0].delay >= 5_000);
  assert.equal(unrefCalls, 2, "both worker timers must be unref'd");

  const initialPass = scheduledTimeouts[0].callback();
  await workerWriteStarted;
  const overlappingIntervalPass = scheduledIntervals[0].callback();
  releaseWorkerWrite();
  await Promise.all([initialPass, overlappingIntervalPass]);
  assert.equal(pending.size, 0, "the startup scan must deliver a terminal job left by a prior process run");
  assert.equal(attempts.get("record-a"), 4, "the running guard must suppress an overlapping interval pass");
  delete globalThis.__feishuAutomationDeliveryInitialTimer;
  delete globalThis.__feishuAutomationDeliveryTimer;
  delete globalThis.__feishuAutomationDeliveryRunning;
});

test("a delivery pass scans persisted jobs but skips videos that are not terminal", async () => {
  const calls = [];
  const pending = new Map([
    ["terminal-row", { ...delivery("terminal-row"), videoId: "terminal-video" }],
    ["active-row", { ...delivery("active-row"), videoId: "active-video" }],
  ]);
  globalThis.__feishuVideoDeliveryTestHooks = {
    listFeishuAutomationJobVideoIds: () => ["terminal-video", "active-video", "missing-video"],
    getFeishuAutomationJobs: (videoId) => [...pending.values()].filter((job) => job.videoId === videoId),
    getVideo: (videoId) => videoId === "terminal-video"
      ? { id: videoId, productId: "product-1", status: "stopped", transcriptZh: "", errorMessage: null }
      : videoId === "active-video"
        ? { id: videoId, productId: "product-1", status: "processing", transcriptZh: "", errorMessage: null }
        : null,
    getProduct: () => null,
    getFeishuProductCardMapping: () => null,
    getConnectedFeishuChannel: () => ({
      rawClient: { request: async ({ url }) => { calls.push(url); return { code: 0 }; } },
    }),
    deleteFeishuAutomationJob: (job) => pending.delete(job.recordId),
  };

  const result = await automation.runFeishuAutomationDeliveryPass();
  assert.deepEqual(result, { pendingVideos: 3, terminalVideos: 1, deliveredVideos: 1 });
  assert.equal(calls.length, 1);
  assert.equal(pending.has("terminal-row"), false);
  assert.equal(pending.has("active-row"), true, "a processing video must remain pending for a later scan");
});

test("failed-video delivery redacts credentials before writing to Base", async () => {
  const pending = new Map([["record-a", delivery("record-a")]]);
  let writtenFields;
  globalThis.__feishuVideoDeliveryTestHooks = {
    getFeishuAutomationJobs: () => [...pending.values()],
    getVideo: () => ({
      id: "video-1",
      productId: "product-1",
      status: "failed",
      transcriptZh: "",
      errorMessage: "upstream Authorization: Bearer sk-secret-value api_key=also-secret",
    }),
    getProduct: () => null,
    getFeishuProductCardMapping: () => null,
    getConnectedFeishuChannel: () => ({
      rawClient: { request: async ({ data }) => { writtenFields = data.fields; return { code: 0 }; } },
    }),
    deleteFeishuAutomationJob: (job) => pending.delete(job.recordId),
  };

  assert.equal(await automation.completeFeishuAutomation("video-1"), true);
  assert.match(writtenFields.视频分析, /已隐藏/);
  assert.doesNotMatch(JSON.stringify(writtenFields), /sk-secret-value|also-secret|Bearer/i);
  assert.equal(pending.size, 0);
});

test("Node instrumentation starts the durable Feishu delivery worker", () => {
  assert.match(instrumentationSource, /import\("@\/lib\/feishu\/automation"\)/);
  assert.match(instrumentationSource, /startFeishuAutomationDeliveryWorker\(\)/);
  assert.doesNotMatch(automationSource, /\[feishu-automation-delivery\].*error/i);
});
