import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const queueSource = await readFile(new URL("../lib/queue.ts", import.meta.url), "utf8");
const analysisSource = await readFile(new URL("../lib/analysis.ts", import.meta.url), "utf8");

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

async function loadQueue(hooks, timeoutMs = 25) {
  globalThis.__videoQueueHardTimeoutHooks = hooks;
  const stub = `
    const hooks = () => globalThis.__videoQueueHardTimeoutHooks;
    export const finishOpenVideoAttempts = (...args) => hooks().finishOpenVideoAttempts?.(...args);
    export const finishVideoAttempt = (...args) => hooks().finishVideoAttempt?.(...args);
    export const getPendingVideoIds = (...args) => hooks().getPendingVideoIds?.(...args) || [];
    export const getStaleProcessingVideoIds = (...args) => hooks().getStaleProcessingVideoIds?.(...args) || [];
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
    .replace("30 * 60 * 1_000", String(timeoutMs));
  delete globalThis.__viralQueue;
  delete globalThis.__viralQueueScheduling;
  delete globalThis.__viralQueueActiveIds;
  delete globalThis.__viralQueueControllers;
  return import(`data:text/javascript;base64,${Buffer.from(`${compiled}\n// ${Math.random()}`).toString("base64")}`);
}

function queueState(ids) {
  return new Map(ids.map((id) => [id, {
    id,
    status: "queued",
    sourceType: "tiktok",
    originalPath: `${id}/original.mp4`,
    errorMessage: null,
  }]));
}

function applyPatch(video, patch) {
  Object.assign(video, {
    status: patch.status || video.status,
    errorMessage: patch.error_message === undefined ? video.errorMessage : patch.error_message,
    originalPath: patch.original_path === undefined ? video.originalPath : patch.original_path,
  });
}

test("hard timeout releases both workers even when analysis ignores abort", async () => {
  const videos = queueState(["stuck-a", "stuck-b", "next"]);
  const started = [];
  const finished = [];
  const emitted = [];
  const queue = await loadQueue({
    getVideo: (id) => videos.get(id),
    updateVideo: (id, patch) => applyPatch(videos.get(id), patch),
    startVideoAttempt: (id) => ({ attemptId: `attempt-${id}`, attemptNumber: 1 }),
    finishVideoAttempt: (...args) => finished.push(args),
    replaceScenes: () => {},
    deleteVideoAttemptCache: () => {},
    emitVideoProgress: (id) => emitted.push(id),
    analyzeVideo: (id, _signal, attemptNumber) => {
      started.push([id, attemptNumber]);
      if (id !== "next") return new Promise(() => {});
      videos.get(id).status = "completed";
      return Promise.resolve();
    },
  });

  queue.enqueueVideos(["stuck-a", "stuck-b", "next"]);
  await waitFor(() => started.some(([id]) => id === "next"));
  await waitFor(() => finished.some((entry) => entry[1] === "next"));
  await waitFor(() => videos.get("stuck-a").status === "stopped" && videos.get("stuck-b").status === "stopped");
  assert.deepEqual(started.slice(0, 2), [["stuck-a", 1], ["stuck-b", 1]]);
  assert.equal(videos.get("stuck-a").status, "stopped");
  assert.equal(videos.get("stuck-b").status, "stopped");
  assert.ok(emitted.includes("stuck-a"));
  assert.ok(emitted.includes("stuck-b"));
});

test("cleanup and attempt-log failures cannot block the next queued task", async () => {
  const videos = queueState(["fault-a", "fault-b", "next"]);
  const started = [];
  const fallbacks = [];
  const queue = await loadQueue({
    getVideo: (id) => videos.get(id),
    updateVideo: (id, patch) => applyPatch(videos.get(id), patch),
    startVideoAttempt: (id) => ({ attemptId: `attempt-${id}`, attemptNumber: 1 }),
    finishVideoAttempt: (_attemptId, id) => {
      if (id !== "next") throw new Error("attempt store unavailable");
    },
    finishOpenVideoAttempts: (...args) => fallbacks.push(args),
    replaceScenes: () => {},
    deleteVideoAttemptCache: () => { throw new Error("cache unavailable"); },
    analyzeVideo: (id) => {
      started.push(id);
      if (id !== "next") return new Promise(() => {});
      videos.get(id).status = "completed";
      return Promise.resolve();
    },
  });

  queue.enqueueVideos(["fault-a", "fault-b", "next"]);
  await waitFor(() => started.includes("next"));
  await waitFor(() => fallbacks.some(([id]) => id === "fault-a") && fallbacks.some(([id]) => id === "fault-b"));
  assert.ok(fallbacks.some(([id, status]) => id === "fault-a" && status === "stopped"));
  assert.ok(fallbacks.some(([id, status]) => id === "fault-b" && status === "stopped"));
  assert.match(videos.get("fault-a").errorMessage, /缓存清理失败/);
});

async function loadAnalysis(hooks) {
  globalThis.__lateAnalysisGuardHooks = hooks;
  const stub = `
    const hooks = () => globalThis.__lateAnalysisGuardHooks;
    export const getProduct = (...args) => hooks().getProduct(...args);
    export const getVideo = (...args) => hooks().getVideo(...args);
    export const replaceScenes = (...args) => hooks().replaceScenes?.(...args);
    export const updateVideo = (...args) => hooks().updateVideo?.(...args);
    export const updateVideoAttemptDiagnostics = (...args) => hooks().updateVideoAttemptDiagnostics?.(...args);
    export const clampScore = (value) => Number(value) || 0;
    export const formatTime = (value) => String(value);
    export const getLearningContext = () => null;
    export const learnFromVideo = () => undefined;
    export const getProviderConfig = () => ({ enabled: false, apiKey: "" });
    export const analyzeVideoWithQwen = (...args) => hooks().analyzeVideoWithQwen?.(...args);
    export const translateTranscriptWithQwen = (...args) => hooks().translateTranscriptWithQwen?.(...args) || Promise.resolve("");
    export const fetchTikTok = (...args) => hooks().fetchTikTok(...args);
    export const tokScriptTranscriptFailure = () => false;
    export const transcriptAndTranslationAgree = () => true;
    export const emitVideoProgress = (...args) => hooks().emitVideoProgress?.(...args);
    export const createSceneClip = () => Promise.resolve(null);
    export const downloadMedia = () => Promise.resolve("");
    export const extractVideoAssets = () => Promise.resolve({ duration: 1, scenes: [] });
    export const prepareLocalVideoForQwen = (_id, path) => Promise.resolve(path);
    export const resolveMediaPath = (value) => value;
    export const validateCompleteVideoForQwen = () => Promise.resolve({ duration: 1, width: 1, height: 1, videoCodec: "h264", audioCodec: "aac" });
  `;
  const stubUrl = `data:text/javascript;base64,${Buffer.from(stub).toString("base64")}`;
  let compiled = ts.transpileModule(analysisSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  compiled = compiled
    .replace('import "server-only";', "")
    .replaceAll(/"@\/lib\/[^"]+"/g, JSON.stringify(stubUrl));
  return import(`data:text/javascript;base64,${Buffer.from(`${compiled}\n// ${Math.random()}`).toString("base64")}`);
}

test("a detached old attempt cannot overwrite a newer execution", async () => {
  let attemptCount = 1;
  let rejectTokScript;
  const patches = [];
  const analysis = await loadAnalysis({
    getVideo: () => ({
      id: "late",
      productId: "product",
      sourceType: "tiktok",
      sourceUrl: "https://www.tiktok.com/t/example/",
      analysisMode: "product_doc",
      originalPath: null,
      remoteVideoUrl: null,
      transcriptOriginal: "",
      attemptCount,
      title: "late",
    }),
    getProduct: () => ({ id: "product", name: "产品", pid: "", coreFunctions: [], usageMethod: "", targetAudience: "", usageScenes: "" }),
    updateVideo: (_id, patch) => patches.push(patch),
    fetchTikTok: () => new Promise((_resolve, reject) => { rejectTokScript = reject; }),
  });
  const controller = new AbortController();
  const pending = analysis.analyzeVideo("late", controller.signal, 1).catch((error) => error);
  await waitFor(() => patches.some((patch) => patch.status === "downloading"));
  const reason = new Error("处理超过30分钟");
  reason.name = "VideoTaskTimeoutError";
  controller.abort(reason);
  attemptCount = 2;
  rejectTokScript(reason);
  await pending;
  assert.equal(
    patches.filter((patch) => ["completed", "failed", "stopped"].includes(patch.status)).length,
    0,
    "the old attempt must not write a terminal status after a newer attempt starts",
  );
});

test("analysis leaves hard-timeout terminal publishing to the queue", async () => {
  let rejectTokScript;
  const patches = [];
  const emitted = [];
  const analysis = await loadAnalysis({
    getVideo: () => ({
      id: "timeout-owner",
      productId: "product",
      sourceType: "tiktok",
      sourceUrl: "https://www.tiktok.com/t/example/",
      analysisMode: "product_doc",
      originalPath: null,
      remoteVideoUrl: null,
      transcriptOriginal: "",
      attemptCount: 1,
      title: "timeout-owner",
    }),
    getProduct: () => ({ id: "product", name: "产品", pid: "", coreFunctions: [], usageMethod: "", targetAudience: "", usageScenes: "" }),
    updateVideo: (_id, patch) => patches.push(patch),
    emitVideoProgress: (id) => emitted.push(id),
    fetchTikTok: () => new Promise((_resolve, reject) => { rejectTokScript = reject; }),
  });
  const controller = new AbortController();
  const pending = analysis.analyzeVideo("timeout-owner", controller.signal, 1).catch((error) => error);
  await waitFor(() => patches.some((patch) => patch.status === "downloading"));
  const emittedBeforeTimeout = emitted.length;
  const reason = new Error("处理超过30分钟");
  reason.name = "VideoTaskTimeoutError";
  controller.abort(reason);
  rejectTokScript(reason);
  await pending;
  assert.equal(patches.some((patch) => ["completed", "failed", "stopped"].includes(patch.status)), false);
  assert.equal(emitted.length, emittedBeforeTimeout, "analysis must not publish a second terminal event");
});
