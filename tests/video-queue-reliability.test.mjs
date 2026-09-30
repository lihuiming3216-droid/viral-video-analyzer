import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {createIsolatedDatabase} from "./helpers/isolated-mysql.mjs";
import test from "node:test";
import ts from "typescript";

const queueSource = await readFile(new URL("../lib/queue.ts", import.meta.url), "utf8");

test("explicit submissions always create a fresh task for a repeated link", async () => {
  const [route, handler, automation] = await Promise.all([
    readFile(new URL("../app/api/videos/import/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/feishu/handler.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/feishu/automation.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(route, /getVideoBySourceUrl/);
  assert.doesNotMatch(handler, /sourceUrl === url/);
  assert.doesNotMatch(automation, /getVideoBySourceUrl/);
  assert.match(route, /createVideo/);
  assert.match(handler, /createVideo/);
  assert.match(automation, /createVideo/);
});

test("MySQL permits independent repeated links and preserves attempts and per-row deliveries", async t => {
  const {database:db, rows, pool, reapplySchema}=await createIsolatedDatabase(t);
  const product=await db.createProduct({name:"重复链接产品"});
  const url="https://www.tiktok.com/t/repeat-link/";
  const original=await db.createVideo({productId:product.id,sourceType:"tiktok",sourceUrl:url});
  await db.saveFeishuAutomationJob({videoId:original.id,appToken:"app",tableId:"table",recordId:"record",fieldMap:{}});
  await pool.query("UPDATE videos SET created_at='2026-08-01T00:00:00.000Z' WHERE id=?",[original.id]);
  await reapplySchema();
  const repeated=await db.createVideo({productId:product.id,sourceType:"tiktok",sourceUrl:url});
  assert.notEqual(repeated.id,original.id);
  assert.equal((await db.getVideoBySourceUrl(url)).id,repeated.id);
  assert.equal((await rows("SHOW INDEX FROM videos")).filter(index=>index.Non_unique===0&&index.Column_name==="source_url").length,0);
  assert.equal((await db.getFeishuAutomationJobs(original.id)).length,1);
  const attempt=await db.startVideoAttempt(repeated.id);
  await db.updateVideo(repeated.id,{status:"failed",error_message:"Qwen 返回字段不完整"});
  await db.finishVideoAttempt(attempt.attemptId,repeated.id,"failed","Qwen 返回字段不完整");
  const [recorded]=await rows("SELECT * FROM video_attempts WHERE video_id=?",[repeated.id]);
  assert.equal(recorded.status,"failed");assert.equal(recorded.error_message,"Qwen 返回字段不完整");
  assert.ok(recorded.started_at);assert.ok(recorded.finished_at);
});

async function loadQueue(hooks, timeoutMs = 5_000) {
  globalThis.__videoQueueReliabilityHooks = hooks;
  const stub = `
    const hooks = () => globalThis.__videoQueueReliabilityHooks;
    export const finishOpenVideoAttempts = (...args) => hooks().finishOpenVideoAttempts?.(...args);
    export const finishVideoAttempt = (...args) => hooks().finishVideoAttempt?.(...args);
    export const getPendingVideoIds = (...args) => hooks().getPendingVideoIds?.(...args) || [];
    export const prepareVideoForQueue = async (id, restart) => {
      const video = hooks().getVideo(id);
      if (!video || video.processingStartedAt || !["queued", "waiting", ...(restart ? ["completed", "failed", "stopped"] : [])].includes(video.status)) return false;
      hooks().updateVideo(id, {status:"queued", error_message:null}); return true;
    };
    export const tryAcquireVideoExecution = async () => ({valid:()=>true,release:async()=>{}});
    export const getVideo = (...args) => hooks().getVideo?.(...args) || null;
    export const replaceScenes = (...args) => hooks().replaceScenes?.(...args);
    export const startVideoAttempt = (...args) => hooks().startVideoAttempt?.(...args);
    export const updateVideo = (...args) => hooks().updateVideo?.(...args);
    export const analyzeVideo = (...args) => hooks().analyzeVideo?.(...args);
    export const emitVideoProgress = (...args) => hooks().emitVideoProgress?.(...args);
    export const deleteVideoAttemptCache = (...args) => hooks().deleteVideoAttemptCache?.(...args);
  `;
  const stubUrl = `data:text/javascript;base64,${Buffer.from(stub).toString("base64")}`;
  let compiled = ts.transpileModule(queueSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  compiled = compiled
    .replace('import "server-only";', "")
    .replaceAll('"@/lib/database"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/analysis"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/video-events"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/video-processing"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/video-execution"', JSON.stringify(stubUrl))
    .replace("30 * 60 * 1_000", String(timeoutMs));
  delete globalThis.__viralQueue;
  delete globalThis.__viralQueueScheduling;
  delete globalThis.__viralQueueActiveIds;
  delete globalThis.__viralQueueControllers;
  delete globalThis.__viralQueueRecovering;
  delete globalThis.__viralQueueDeferred;
  return import(`data:text/javascript;base64,${Buffer.from(`${compiled}\n// ${Math.random()}`).toString("base64")}`);
}

function waitFor(check, timeoutMs = 1_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("condition timed out"));
      setTimeout(poll, 2);
    };
    poll();
  });
}

test("queue starts exactly two videos and starts the third after one finishes", async () => {
  const videos = new Map(["a", "b", "c"].map((id) => [id, { id, status: "queued", sourceType: "tiktok", originalPath: null, errorMessage: null }]));
  const resolvers = new Map();
  const started = [];
  let active = 0;
  let maxActive = 0;
  const queue = await loadQueue({
    getVideo: (id) => videos.get(id),
    updateVideo: (id, patch) => Object.assign(videos.get(id), {
      status: patch.status || videos.get(id).status,
      errorMessage: patch.error_message === undefined ? videos.get(id).errorMessage : patch.error_message,
    }),
    startVideoAttempt: (id) => ({ attemptId: `attempt-${id}` }),
    finishVideoAttempt: () => {},
    analyzeVideo: (id) => new Promise((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(id);
      resolvers.set(id, () => {
        active -= 1;
        videos.get(id).status = "completed";
        resolve();
      });
    }),
  });
  queue.enqueueVideos(["a", "b", "c"]);
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ["a", "b"]);
  assert.equal(maxActive, 2);
  resolvers.get("a")();
  await waitFor(() => started.length === 3);
  assert.equal(started[2], "c");
  assert.equal(maxActive, 2);
  resolvers.get("b")();
  resolvers.get("c")();
});

test("an overlong task stops independently, records the error and clears only TikTok cache", async () => {
  const video = { id: "timeout", status: "queued", sourceType: "tiktok", originalPath: "timeout/original.mp4", errorMessage: null };
  const cleaned = [];
  const attempts = [];
  const queue = await loadQueue({
    getVideo: () => video,
    updateVideo: (_id, patch) => Object.assign(video, {
      status: patch.status || video.status,
      errorMessage: patch.error_message === undefined ? video.errorMessage : patch.error_message,
      originalPath: patch.original_path === undefined ? video.originalPath : patch.original_path,
    }),
    startVideoAttempt: () => ({ attemptId: "attempt-timeout" }),
    finishVideoAttempt: (...args) => attempts.push(args),
    replaceScenes: () => {},
    deleteVideoAttemptCache: (...args) => cleaned.push(args),
    analyzeVideo: (_id, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        video.status = "stopped";
        video.errorMessage = signal.reason.message;
        reject(signal.reason);
      }, { once: true });
    }),
  }, 25);
  queue.enqueueVideos([video.id]);
  await waitFor(() => attempts.length === 1);
  assert.equal(video.status, "stopped");
  assert.match(video.errorMessage, /超过30分钟/);
  assert.deepEqual(cleaned, [[video.id, null]]);
  assert.equal(video.originalPath, null);
  assert.equal(attempts[0][2], "stopped");
  assert.match(attempts[0][3], /超过30分钟/);
});

test("a completed analysis is never erased if timeout fires during final delivery", async () => {
  const video = { id: "delivering", status: "queued", sourceType: "tiktok", originalPath: "delivering/original.mp4", errorMessage: null };
  const cleaned = [];
  const attempts = [];
  const queue = await loadQueue({
    getVideo: () => video,
    updateVideo: (_id, patch) => Object.assign(video, {
      status: patch.status || video.status,
      errorMessage: patch.error_message === undefined ? video.errorMessage : patch.error_message,
    }),
    startVideoAttempt: () => ({ attemptId: "attempt-delivering" }),
    finishVideoAttempt: (...args) => attempts.push(args),
    deleteVideoAttemptCache: (...args) => cleaned.push(args),
    analyzeVideo: (_id, signal) => new Promise((resolve) => {
      video.status = "completed";
      signal.addEventListener("abort", resolve, { once: true });
    }),
  }, 25);
  queue.enqueueVideos([video.id]);
  await waitFor(() => attempts.length === 1);
  assert.equal(video.status, "completed");
  assert.deepEqual(cleaned, []);
  assert.equal(attempts[0][2], "completed");
});

test("startup stops stale processing tasks but preserves an uploaded original", async () => {
  const video = { id: "legacy", status: "analyzing", sourceType: "upload", originalPath: "legacy/original.mov", errorMessage: null, processingStartedAt:"2020-01-01T00:00:00.000Z" };
  const cleaned = [];
  const queue = await loadQueue({
    getPendingVideoIds: () => [video.id],
    getVideo: () => video,
    updateVideo: (_id, patch) => Object.assign(video, {
      status: patch.status || video.status,
      errorMessage: patch.error_message === undefined ? video.errorMessage : patch.error_message,
    }),
    replaceScenes: () => {},
    finishOpenVideoAttempts: () => {},
    deleteVideoAttemptCache: (...args) => cleaned.push(args),
  });
  await queue.resumePendingVideos();
  await waitFor(() => video.status === "stopped");
  assert.equal(video.status, "stopped");
  assert.match(video.errorMessage, /超过30分钟/);
  assert.deepEqual(cleaned, [[video.id, video.originalPath]]);
});
