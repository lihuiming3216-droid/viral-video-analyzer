import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/analysis.ts", import.meta.url), "utf8");

async function loadAnalysis(hooks) {
  globalThis.__analysisQwenLocalRetryHooks = hooks;
  const stubSource = `
    const hooks = () => globalThis.__analysisQwenLocalRetryHooks;
    export const getProduct = (...args) => hooks().getProduct(...args);
    export const getVideo = (...args) => hooks().getVideo(...args);
    export const replaceScenes = (...args) => hooks().replaceScenes?.(...args);
    export const updateVideo = (...args) => hooks().updateVideo?.(...args);
    export const updateVideoAttemptDiagnostics = (...args) => hooks().updateVideoAttemptDiagnostics?.(...args);
    export const clampScore = (value) => Number(value) || 0;
    export const formatTime = (value) => String(value);
    export const getLearningContext = () => null;
    export const learnFromVideo = (...args) => hooks().learnFromVideo?.(...args);
    export const getProviderConfig = () => ({ enabled: true, apiKey: "test-key" });
    export const analyzeVideoWithQwen = (...args) => hooks().analyzeVideoWithQwen(...args);
    export const translateTranscriptWithQwen = (...args) => hooks().translateTranscriptWithQwen?.(...args) || Promise.resolve("");
    export const fetchTikTok = (...args) => hooks().fetchTikTok?.(...args);
    export const tokScriptTranscriptFailure = () => false;
    export const transcriptAndTranslationAgree = () => true;
    export const emitVideoProgress = (...args) => hooks().emitVideoProgress?.(...args);
    export const createSceneClip = (...args) => hooks().createSceneClip?.(...args);
    export const downloadMedia = (...args) => hooks().downloadMedia?.(...args);
    export const extractVideoAssets = (...args) => hooks().extractVideoAssets(...args);
    export const prepareLocalVideoForQwen = (...args) => hooks().prepareLocalVideoForQwen(...args);
    export const resolveMediaPath = (...args) => hooks().resolveMediaPath(...args);
    export const validateCompleteVideoForQwen = (...args) => hooks().validateCompleteVideoForQwen(...args);
    export const syncCompletedVideoToProductDocument = (...args) => hooks().syncCompletedVideoToProductDocument?.(...args);
    export const completeFeishuAutomation = (...args) => hooks().completeFeishuAutomation?.(...args);
  `;
  const stubUrl = `data:text/javascript;base64,${Buffer.from(stubSource).toString("base64")}`;
  let compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  compiled = compiled
    .replace('import "server-only";', "")
    .replaceAll(/"@\/lib\/[^\"]+"/g, JSON.stringify(stubUrl));
  return import(`data:text/javascript;base64,${Buffer.from(`${compiled}\n// ${Math.random()}`).toString("base64")}`);
}

function qwenDiagnostic(requestIndex, inputSha256) {
  return {
    model: "qwen3.5-omni-plus",
    inputBytes: 4_800_000,
    inputSha256,
    requestId: `provider-request-${requestIndex}`,
    httpStatus: 200,
    headersMs: 10,
    firstTokenMs: 20,
    totalMs: 30,
    outcome: "success",
    responseSha256: String(requestIndex).repeat(64),
  };
}

test("one attempt uses one local complete MP4, persists two Qwen calls, and never overwrites the original", async () => {
  const videoId = "local-qwen-retry";
  const attemptNumber = 7;
  const originalPath = `${videoId}/original.mp4`;
  const proxyRelativePath = `${videoId}/qwen-full-video.mp4`;
  const proxyAbsolutePath = `/private/media/${proxyRelativePath}`;
  const inputSha256 = "a".repeat(64);
  const patches = [];
  const prepared = [];
  const qwenInputs = [];
  const diagnosticSnapshots = [];
  const initial = {
    id: videoId,
    productId: "product-1",
    sourceType: "tiktok",
    sourceUrl: "https://www.tiktok.com/@example/video/123",
    analysisMode: "product_doc",
    originalPath,
    remoteVideoUrl: "https://temporary.example/source.mp4?token=must-not-reach-qwen",
    transcriptOriginal: "This is the complete spoken script.",
    attemptCount: attemptNumber,
    title: "test video",
    coverPath: null,
  };

  const analysis = await loadAnalysis({
    getVideo: () => initial,
    getProduct: () => ({
      id: "product-1",
      name: "测试产品",
      pid: "pid-1",
      coreFunctions: [],
      usageMethod: "",
      targetAudience: "",
      usageScenes: "",
    }),
    updateVideo: (_id, patch) => patches.push(patch),
    replaceScenes: () => undefined,
    extractVideoAssets: async () => ({
      duration: 12.5,
      scenes: [{
        shotIndex: 1,
        startSeconds: 0,
        endSeconds: 12.5,
        screenshotPath: `${videoId}/shot-1.jpg`,
      }],
    }),
    prepareLocalVideoForQwen: async (...args) => {
      prepared.push(args);
      return proxyRelativePath;
    },
    resolveMediaPath: (value) => {
      assert.equal(value, proxyRelativePath);
      return proxyAbsolutePath;
    },
    validateCompleteVideoForQwen: async (value) => {
      assert.equal(value, proxyAbsolutePath);
      return {
        duration: 12.5,
        width: 720,
        height: 1280,
        videoCodec: "h264",
        audioCodec: "aac",
      };
    },
    analyzeVideoWithQwen: async (input) => {
      const requestIndex = qwenInputs.length + 1;
      qwenInputs.push(input);
      input.onDiagnostic(qwenDiagnostic(requestIndex, inputSha256));
      if (requestIndex === 1) {
        return { summary: "第一轮缺少翻译", translationZh: "" };
      }
      if (requestIndex === 2) {
        return {
          summary: "第二轮完整",
          language: "en",
          translationZh: "这是完整的中文口播翻译。",
          hook: { timeRange: "00:00-00:03", type: "钩子", description: "直击痛点", whyItWorks: "信息直接" },
          viralPoints: [],
          strengths: [],
          structureFormula: "痛点-演示-转化",
        };
      }
      throw new Error("不应发起第三次 Qwen 请求");
    },
    updateVideoAttemptDiagnostics: (id, attempt, snapshot) => {
      assert.equal(id, videoId);
      assert.equal(attempt, attemptNumber);
      diagnosticSnapshots.push(structuredClone(snapshot));
      return true;
    },
  });

  await analysis.analyzeVideo(videoId, undefined, attemptNumber);

  assert.deepEqual(prepared, [[videoId, originalPath, 12.5, undefined]]);
  assert.equal(qwenInputs.length, 2, "an unusable first response permits exactly one retry");
  assert.ok(qwenInputs.every((input) => input.localVideoPath === proxyAbsolutePath));
  assert.ok(qwenInputs.every((input) => !("remoteVideoUrl" in input)));

  assert.equal(diagnosticSnapshots.length, 2);
  assert.deepEqual(diagnosticSnapshots[0].calls.map((call) => call.requestIndex), [1]);
  assert.deepEqual(diagnosticSnapshots[1].calls.map((call) => call.requestIndex), [1, 2]);
  assert.ok(diagnosticSnapshots.every((snapshot) => snapshot.inputSha256 === inputSha256));
  assert.ok(diagnosticSnapshots.every((snapshot) => snapshot.inputMode === "local_base64"));

  assert.equal(
    patches.some((patch) => Object.hasOwn(patch, "original_path")),
    false,
    "the Qwen proxy must not replace the persisted original_path",
  );
  assert.equal(initial.originalPath, originalPath);
  assert.equal(patches.at(-1).status, "completed");
});

test("a finalized TokScript tool error is not retried as a whole fetch", async () => {
  const videoId = "tokscript-tool-error-boundary";
  const attemptNumber = 3;
  const patches = [];
  let fetchCalls = 0;
  const initial = {
    id: videoId,
    productId: "product-1",
    sourceType: "tiktok",
    sourceUrl: "https://www.tiktok.com/@example/video/123",
    analysisMode: "product_doc",
    originalPath: null,
    remoteVideoUrl: null,
    transcriptOriginal: "",
    attemptCount: attemptNumber,
    title: "test video",
    coverPath: null,
  };
  const analysis = await loadAnalysis({
    getVideo: () => initial,
    getProduct: () => ({
      id: "product-1",
      name: "测试产品",
      pid: "pid-1",
      coreFunctions: [],
      usageMethod: "",
      targetAudience: "",
      usageScenes: "",
    }),
    updateVideo: (_id, patch) => patches.push(patch),
    fetchTikTok: async () => {
      fetchCalls += 1;
      const error = new Error("TokScript 工具返回错误（stage=download; category=timeout; attempts=2）：工具调用超时");
      error.name = "TokScriptToolCallError";
      throw error;
    },
  });

  await assert.rejects(
    analysis.analyzeVideo(videoId, undefined, attemptNumber),
    /stage=download/,
  );
  assert.equal(fetchCalls, 1, "the provider already exhausted the one per-tool retry");
  assert.equal(patches.at(-1).status, "failed");
  assert.equal(
    patches.at(-1).error_message,
    "TokScript 工具返回错误（stage=download; category=timeout; attempts=2）：工具调用超时",
  );

  const retryPatches = [];
  fetchCalls = 0;
  const retryAnalysis = await loadAnalysis({
    getVideo: () => initial,
    getProduct: () => ({
      id: "product-1",
      name: "测试产品",
      pid: "pid-1",
      coreFunctions: [],
      usageMethod: "",
      targetAudience: "",
      usageScenes: "",
    }),
    updateVideo: (_id, patch) => retryPatches.push(patch),
    fetchTikTok: async () => {
      fetchCalls += 1;
      const error = new Error("TokScript 前置调用失败（stage=connect; category=network_error）：服务网络异常");
      error.name = "TokScriptRetryableError";
      throw error;
    },
  });
  await assert.rejects(
    retryAnalysis.analyzeVideo(videoId, undefined, attemptNumber),
    /category=network_error/,
  );
  assert.equal(fetchCalls, 2, "a safe setup network error keeps the existing one whole-fetch retry");
  assert.equal(
    retryPatches.at(-1).error_message,
    "TokScript 前置调用失败（stage=connect; category=network_error）：服务网络异常",
  );
});
