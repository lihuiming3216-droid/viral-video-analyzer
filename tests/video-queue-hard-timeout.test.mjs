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
    export const prepareVideoForQueue = async (id, restart) => {
      if (hooks().prepareVideoForQueue) return hooks().prepareVideoForQueue(id, restart);
      const video = hooks().getVideo(id);
      if (!video || video.processingStartedAt || !["queued", "waiting", ...(restart ? ["completed", "failed", "stopped"] : [])].includes(video.status)) return false;
      hooks().updateVideo(id, {status:"queued", error_message:null}); return true;
    };
    export const tryAcquireVideoExecution = async (...args) => hooks().tryAcquireVideoExecution ? hooks().tryAcquireVideoExecution(...args) : {valid:()=>true,release:async()=>{}};
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

test("two workers run concurrently; stopping one neither stops the other nor blocks the next row", async () => {
  const videos = queueState(["stop-one", "keep-two", "next-three"]);
  const running = new Map();
  const finished = [];
  const queue = await loadQueue({
    getVideo: id => videos.get(id),
    updateVideo: (id, patch) => applyPatch(videos.get(id), patch),
    startVideoAttempt: id => ({ attemptId: `attempt-${id}`, attemptNumber: 1 }),
    finishVideoAttempt: (...args) => finished.push(args),
    analyzeVideo: (id, signal) => new Promise(resolve => {
      running.set(id, { signal, finish: () => { videos.get(id).status = "completed"; resolve(); } });
    }),
  }, 5_000);

  await queue.enqueueVideos(["stop-one", "keep-two", "next-three"]);
  await waitFor(() => running.size === 2);
  assert.deepEqual([...running.keys()], ["stop-one", "keep-two"]);
  // A scan of an already running row must not create another execution.
  await queue.enqueueVideos(["keep-two"]);
  assert.equal(running.size, 2);
  await queue.stopVideo("stop-one");
  await waitFor(() => running.has("next-three"));
  assert.equal(running.get("stop-one").signal.aborted, true);
  assert.equal(running.get("keep-two").signal.aborted, false);
  assert.equal(running.get("next-three").signal.aborted, false);
  running.get("keep-two").finish();
  running.get("next-three").finish();
  await waitFor(() => finished.length === 3 && globalThis.__viralQueueActiveIds.size === 0);
  assert.deepEqual(new Map(finished.map(([, id, status]) => [id, status])), new Map([
    ["stop-one", "stopped"], ["keep-two", "completed"], ["next-three", "completed"],
  ]));
});

test("a failed concurrent worker records only its own error and frees a slot", async () => {
  const videos = queueState(["fail-one", "keep-two", "next-three"]);
  const running = new Map(), finished = [];
  const queue = await loadQueue({
    getVideo: id => videos.get(id),
    updateVideo: (id, patch) => applyPatch(videos.get(id), patch),
    startVideoAttempt: id => ({ attemptId: `attempt-${id}`, attemptNumber: 1 }),
    finishVideoAttempt: (...args) => finished.push(args),
    analyzeVideo: (id, signal) => new Promise((resolve, reject) => {
      running.set(id, { signal, reject, finish: () => { videos.get(id).status = "completed"; resolve(); } });
    }),
  }, 5_000);
  await queue.enqueueVideos([...videos.keys()]);
  await waitFor(() => running.size === 2);
  running.get("fail-one").reject(new Error("isolated model failure"));
  await waitFor(() => running.has("next-three"));
  assert.equal(videos.get("fail-one").errorMessage, "isolated model failure");
  assert.equal(videos.get("keep-two").errorMessage, null);
  assert.equal(running.get("keep-two").signal.aborted, false);
  running.get("keep-two").finish();
  running.get("next-three").finish();
  await waitFor(() => finished.length === 3 && globalThis.__viralQueueActiveIds.size === 0);
  assert.deepEqual(finished.find(([, id]) => id === "fail-one"), [
    "attempt-fail-one", "fail-one", "failed", "isolated model failure",
  ]);
  assert.equal(finished.filter(([, , status]) => status === "completed").length, 2);
});

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
    export const recordVideoStage = async (...args) => hooks().recordVideoStage?.(...args);
    export const clampScore = (value) => Number(value) || 0;
    export const formatTime = (value) => String(value);
    export const getLearningContext = () => null;
    export const learnFromVideo = () => undefined;
    export const getProviderConfig = () => ({ enabled: false, apiKey: "" });
    export const analyzeVideoWithQwen = (...args) => hooks().analyzeVideoWithQwen?.(...args);
    export const getVideoAnalysisConfig = () => ({ retries: 1, model: "fixture-model" });
    export class QwenRequestError extends Error {}
    export const getPromptTemplate = async (_slug, _label, template) => ({ template });
    export const savePromptDebugCapture = async () => {};
    export const translateTranscriptWithQwen = (...args) => hooks().translateTranscriptWithQwen?.(...args) || Promise.resolve("");
    export const fetchTikTok = (...args) => hooks().fetchTikTok(...args);
    export const downloadTikTokVideoWithFallback = () => { throw new Error("unexpected fallback"); };
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

test("a task claimed by another process neither starts nor changes its stored state", async () => {
  const videos = queueState(["remote"]); let started = 0;
  const queue = await loadQueue({
    getVideo:id=>videos.get(id), getPendingVideoIds:()=>["remote"], tryAcquireVideoExecution:async()=>null,
    startVideoAttempt:()=>{started++;}, updateVideo:()=>{throw Error("must not alter a remote owner");},
  });
  await queue.resumePendingVideos();
  await waitFor(()=>globalThis.__viralQueueActiveIds.size===0);
  assert.equal(started,0); assert.equal(videos.get("remote").status,"queued");
});

test("crash recovery pauses an already-started provider request without automatic repayment", async () => {
  const videos = queueState(["orphan"]), video = videos.get("orphan");
  video.status = "analyzing"; video.processingStartedAt = new Date().toISOString();
  let starts = 0, cleanup = 0;
  const queue = await loadQueue({
    getVideo:id=>videos.get(id), getPendingVideoIds:()=>["orphan"],
    updateVideo:(id,patch)=>applyPatch(videos.get(id),patch),
    startVideoAttempt:()=>{starts++;}, deleteVideoAttemptCache:()=>{cleanup++;}, finishOpenVideoAttempts:()=>{},
  },5_000);
  await queue.resumePendingVideos();
  await waitFor(()=>video.status === "stopped" && globalThis.__viralQueueActiveIds.size === 0);
  assert.equal(starts,0); assert.equal(cleanup,0); assert.match(video.errorMessage,/核查/);
});

test("a normal wake-up never requeues a completed task; an explicit retry may", async () => {
  const videos = queueState(["done"]), video = videos.get("done"); video.status = "completed";
  let starts = 0;
  const queue = await loadQueue({
    getVideo:id=>videos.get(id), updateVideo:(id,patch)=>applyPatch(videos.get(id),patch),
    startVideoAttempt:()=>({attemptId:"new-attempt",attemptNumber:2}),
    analyzeVideo:async()=>{starts++;video.status="completed";}, finishVideoAttempt:()=>{},
  });
  await queue.enqueueVideos(["done"]); assert.equal(starts,0);
  await queue.enqueueVideos(["done"],{restart:true});
  await waitFor(()=>starts===1 && globalThis.__viralQueueActiveIds.size===0);
});
