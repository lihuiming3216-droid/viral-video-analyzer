import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createIsolatedDatabase } from "./helpers/isolated-mysql.mjs";
import { loadAutomationFixture } from "./helpers/automation-fixture.mjs";
const instrumentationSource = await readFile(new URL("../instrumentation.ts", import.meta.url), "utf8");
const automationSource = await readFile(new URL("../lib/feishu/automation.ts", import.meta.url), "utf8");
test("MySQL per-Base-row deliveries preserve metadata and supersede only the matching row", async (t) => {
  const { database: db, pool, rows, reapplySchema } = await createIsolatedDatabase(t);
  const product = await db.createProduct({ name: "delivery fixture" });
  const video = await db.createVideo({ productId: product.id, sourceType: "tiktok", sourceUrl: "https://example.test/one" });
  const first = { videoId: video.id, appToken: "app-a", tableId: "table-a", recordId: "record-a" };
  const second = { ...first, appToken: "app-b", tableId: "table-b", recordId: "record-b" };
  await db.saveFeishuAutomationJob({ ...first, fieldMap: { status: "旧状态" } });
  await pool.query("UPDATE feishu_automation_jobs SET created_at='2026-08-01T00:00:00.000Z' WHERE video_id=?", [video.id]);
  await reapplySchema();
  assert.equal((await db.getFeishuAutomationJobs(video.id))[0].fieldMap.status, "旧状态");
  await db.saveFeishuAutomationJob({ ...second, fieldMap: { status: "B状态" } });
  await db.saveFeishuAutomationJob({ ...first, fieldMap: { status: "A新状态", webhookSecret: "must-not-persist" } });
  const jobs = await db.getFeishuAutomationJobs(video.id);
  assert.equal(jobs.length, 2);
  assert.deepEqual(await db.listFeishuAutomationJobVideoIds(), [video.id]);
  assert.equal(jobs.find(j => j.recordId === "record-a").fieldMap.status, "A新状态");
  assert.equal(jobs.find(j => j.recordId === "record-a").createdAt, "2026-08-01T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(jobs), /must-not-persist|webhookSecret/);
  assert.deepEqual((await rows("SHOW INDEX FROM feishu_automation_jobs")).filter(i => i.Key_name === "PRIMARY").sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(i => i.Column_name), ["video_id", "app_token", "table_id", "record_id"]);
  const newer = await db.createVideo({ productId: product.id, sourceType: "tiktok", sourceUrl: "https://example.test/two" });
  await db.saveFeishuAutomationJob({ ...first, videoId: newer.id, fieldMap: { status: "最新任务" } });
  assert.deepEqual((await db.getFeishuAutomationJobs(video.id)).map(j => j.recordId), ["record-b"]);
  assert.equal((await db.getFeishuAutomationJobs(newer.id))[0].fieldMap.status, "最新任务");
  await db.deleteFeishuAutomationJob({ ...first, videoId: newer.id });
  await db.deleteFeishuAutomationJob(first);
  assert.deepEqual((await db.getFeishuAutomationJobs(video.id)).map(j => j.recordId), ["record-b"]);
  await db.deleteFeishuAutomationJob(second);
  assert.deepEqual(await db.listFeishuAutomationJobVideoIds(), []);
});
// These cases exercise orchestration with fake Feishu responses. SQL durability
// and delayed retries are exercised separately against real MySQL above.
const hooks = new Proxy({}, { get: (_target, name) => {
    const h = globalThis.__feishuVideoDeliveryTestHooks || {};
    if (name === "getVideo")
      return (...args) => { const v = h.getVideo?.(...args); return v ? { transcriptOriginal: "", transcriptSegments: [], attemptCount: 0, analysisMode: v.status === "failed" ? "product_doc" : "full", ...v } : null; };
    if (name === "getFeishuAutomationJobs")
      return (...args) => (h.getFeishuAutomationJobs?.(...args) || []).map(job => ({ ...job, attempts: job.attempts || 0, fieldMap: { ...Object.fromEntries(Object.keys(automation.defaultFeishuAutomationFieldMap).map(k => [k, ""])), status: "分析状态", productDocument: "产品手卡", analysis: "视频分析", translation: h.getVideo?.(job.videoId)?.transcriptZh ? "中文翻译" : "", ...job.fieldMap } }));
    if (name === "getConnectedFeishuChannel")
      return () => {
        const channel = h.getConnectedFeishuChannel?.();
        return channel ? { ...channel, rawClient: { request: async (req) => {
              if (req.url.endsWith("/fields"))
                return { code: 0, data: { items: Object.values(automation.defaultFeishuAutomationFieldMap).map(field_name => ({ field_name })) } };
              if (req.method === "GET")
                return { code: 0, data: { record: { fields: {} } } };
              return channel.rawClient.request(req);
            } } } : null;
      };
    if (name === "getFeishuProductCardMapping")
      return h[name] || (() => null);
    if (name === "incrementFeishuAutomationJobAttempts")
      return () => { };
    if (name === "listVideoStages")
      return () => [];
    return h[name];
  } });
const automation = await loadAutomationFixture({ after: callback => test.after(callback) }, hooks);
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
          if (recordId === "record-a" && count < 3)
            throw new Error("temporary network failure");
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
  assert.equal(writes.find((write) => write.recordId === "record-a").fields.产品手卡, "https://feishu.cn/docx/record-a");
  assert.equal(writes.find((write) => write.recordId === "record-b").fields.产品手卡, "https://feishu.cn/docx/record-b");
});
test("a superseded Base-row job is rechecked under the row lock and never written", async () => {
  let reads = 0;
  let writes = 0;
  globalThis.__feishuVideoDeliveryTestHooks = {
    getFeishuAutomationJobs: () => (reads++ === 0 ? [delivery("record-a")] : []),
    getVideo: () => ({
      id: "video-1", productId: "product-1", status: "completed", transcriptZh: "旧翻译", errorMessage: null,
    }),
    getProduct: () => ({ id: "product-1", documentUrl: null }),
    getConnectedFeishuChannel: () => ({
      rawClient: { request: async () => { writes += 1; return { code: 0 }; } },
    }),
  };
  assert.equal(await automation.completeFeishuAutomation("video-1"), true);
  assert.equal(writes, 0, "the older completion must not overwrite the newer row generation");
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
          if (recordId === "record-a" && !allowRecordA)
            throw new Error("temporary write failure");
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
  }
  finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
  }
  assert.equal(scheduledTimeouts.length, 1, "worker startup must be a process-wide singleton");
  assert.equal(scheduledTimeouts[0].delay, 2500);
  assert.equal(scheduledIntervals.length, 1);
  assert.ok(scheduledIntervals[0].delay >= 5000);
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
