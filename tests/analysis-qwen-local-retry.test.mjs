import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function waitFor(check) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("expected task event did not arrive");
}

const source = await readFile(new URL("../lib/analysis.ts", import.meta.url), "utf8");

async function loadAnalysis(hooks) {
  globalThis.__analysisQwenLocalRetryHooks = hooks;
  const stubSource = `
    const hooks = () => globalThis.__analysisQwenLocalRetryHooks;
    export const getProduct = (...args) => hooks().getProduct(...args);
    export const getVideo = (...args) => hooks().getVideo(...args);
    export const replaceScenes = (...args) => hooks().replaceScenes?.(...args);
    export const updateVideo = (...args) => hooks().updateVideo?.(...args);
    export const updateVideoAttemptDiagnostics = async (...args) => hooks().updateVideoAttemptDiagnostics?.(...args);
    export const getPromptTemplate = async (_slug, _label, template) => ({ template });
    export const savePromptDebugCapture = async () => {};
    export const clampScore = (value) => Number(value) || 0;
    export const formatTime = (value) => String(value);
    export const getLearningContext = () => null;
    export const learnFromVideo = (...args) => hooks().learnFromVideo?.(...args);
    export const getProviderConfig = () => ({ enabled: true, apiKey: "test-key" });
    export const analyzeVideoWithQwen = (...args) => hooks().analyzeVideoWithQwen(...args);
    export const getVideoAnalysisConfig = () => ({ retries: hooks().retries ?? 1, model: "fixture-model" });
    export class QwenRequestError extends Error {
      name = "QwenRequestError";
      constructor(code, retryable, message) { super(message); this.code = code; this.retryable = retryable; }
    }
    export const translateTranscriptWithQwen = (...args) => hooks().translateTranscriptWithQwen?.(...args) || Promise.resolve("");
    export const fetchTikTok = (...args) => hooks().fetchTikTok?.(...args);
    export const downloadTikTokVideoWithFallback = (...args) => hooks().downloadTikTokVideoWithFallback(...args);
    export const tokScriptTranscriptFailure = () => false;
    export const transcriptAndTranslationAgree = () => true;
    export const emitVideoProgress = (...args) => hooks().emitVideoProgress?.(...args);
    export const createSceneClip = (...args) => hooks().createSceneClip?.(...args);
    export const downloadMedia = (...args) => hooks().downloadMedia?.(...args);
    export const extractVideoAssets = (...args) => hooks().extractVideoAssets(...args);
    export const prepareLocalVideoForQwen = (...args) => hooks().prepareLocalVideoForQwen(...args);
    export const resolveMediaPath = (...args) => hooks().resolveMediaPath(...args);
    export const validateCompleteVideoForQwen = (...args) => hooks().validateCompleteVideoForQwen(...args);
    export const syncVideoToProductDocument = (...args) => hooks().syncVideoToProductDocument?.(...args);
    export const deliverEarlyTranscript = async (...args) => hooks().deliverEarlyTranscript?.(...args);
    export const enqueueVideos = (...args) => hooks().enqueueVideos?.(...args);
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
    model: "qwen3.7-plus",
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

function retryableQwenError(message = "Qwen 完整视频网络连接失败") {
  const error = new Error(message);
  error.name = "QwenRequestError";
  error.code = "network_error";
  error.retryable = true;
  return error;
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
    // A stalled text-only translation must not block the full-video analysis.
    translateTranscriptWithQwen: () => new Promise(() => {}),
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
      if (requestIndex === 1) {
        await input.onDiagnostic({
          ...qwenDiagnostic(requestIndex, inputSha256),
          requestId: "",
          httpStatus: null,
          headersMs: null,
          firstTokenMs: null,
          outcome: "network_error",
          errorCode: "ECONNRESET",
          responseSha256: "",
        });
        throw retryableQwenError();
      }
      if (requestIndex === 2) {
        await input.onDiagnostic(qwenDiagnostic(requestIndex, inputSha256));
        return {
          summary: "第二轮完整",
          language: "en",
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

  const priorRetryDelay = process.env.QWEN_RETRY_BASE_MS;
  process.env.QWEN_RETRY_BASE_MS = "0";
  try {
    await analysis.analyzeVideo(videoId, undefined, attemptNumber);
  } finally {
    if (priorRetryDelay === undefined) delete process.env.QWEN_RETRY_BASE_MS;
    else process.env.QWEN_RETRY_BASE_MS = priorRetryDelay;
  }

  assert.deepEqual(prepared, [[videoId, originalPath, 12.5, undefined]]);
  assert.equal(qwenInputs.length, 2, "a retryable network failure permits exactly one retry");
  assert.ok(qwenInputs.every((input) => input.localVideoPath === proxyAbsolutePath));
  assert.ok(qwenInputs.every((input) => !("remoteVideoUrl" in input)));

  assert.equal(diagnosticSnapshots.length, 2);
  assert.deepEqual(diagnosticSnapshots[0].calls.map((call) => call.requestIndex), [1]);
  assert.equal(diagnosticSnapshots[0].calls[0].errorCode, "ECONNRESET");
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

test("a structurally incomplete Qwen response exhausts the single permitted retry", async () => {
  const videoId = "local-qwen-incomplete";
  const attemptNumber = 2;
  const patches = [];
  let qwenCalls = 0;
  const initial = {
    id: videoId,
    productId: "product-1",
    sourceType: "tiktok",
    sourceUrl: "https://www.tiktok.com/@example/video/456",
    analysisMode: "product_doc",
    originalPath: `${videoId}/original.mp4`,
    remoteVideoUrl: null,
    transcriptOriginal: "Complete spoken script.",
    transcriptZh: "完整口播翻译。",
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
      duration: 8,
      scenes: [{
        shotIndex: 1,
        startSeconds: 0,
        endSeconds: 8,
        screenshotPath: `${videoId}/shot-1.jpg`,
      }],
    }),
    prepareLocalVideoForQwen: async () => `${videoId}/qwen-full-video.mp4`,
    resolveMediaPath: () => `/private/media/${videoId}/qwen-full-video.mp4`,
    validateCompleteVideoForQwen: async () => ({
      duration: 8,
      width: 720,
      height: 1280,
      videoCodec: "h264",
      audioCodec: "aac",
    }),
    analyzeVideoWithQwen: async () => {
      qwenCalls += 1;
      return { summary: "只有摘要，结构不完整", strengths: [], viralPoints: [] };
    },
  });

  const priorRetryDelay = process.env.QWEN_RETRY_BASE_MS;
  process.env.QWEN_RETRY_BASE_MS = "0";
  try {
    await assert.rejects(analysis.analyzeVideo(videoId, undefined, attemptNumber), /Qwen 未返回完整的视频分析/);
  } finally {
    if (priorRetryDelay === undefined) delete process.env.QWEN_RETRY_BASE_MS;
    else process.env.QWEN_RETRY_BASE_MS = priorRetryDelay;
  }
  assert.equal(qwenCalls, 2);
  assert.equal(patches.at(-1).status, "failed");
  assert.equal(patches.at(-1).error_message, "Qwen 未返回完整的视频分析，请重试该链接，系统已自动重试一次");
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

async function pipeline(overrides = {}) {
  const video = {
    id: "pipeline-test", productId: "product", sourceType: "tiktok",
    sourceUrl: "https://www.tiktok.com/@demo/video/123", analysisMode: "product_doc",
    originalPath: "pipeline-test/original.mp4", transcriptOriginal: "The TokScript original speech.",
    transcriptZh: "", attemptCount: 1, status: "queued", title: "test",
  };
  const deliveries = [], enqueued = [], patches = [];
  const analysisModule = await loadAnalysis({
    getVideo: () => ({ ...video }),
    getProduct: () => ({ id: "product", name: "产品", coreFunctions: [] }),
    updateVideo: (_id, patch) => {
      patches.push(patch);
      const aliases = { transcript_zh: "transcriptZh", original_path: "originalPath", error_message: "errorMessage" };
      for (const [key, value] of Object.entries(patch)) video[aliases[key] || key] = value;
    },
    prepareLocalVideoForQwen: async () => "pipeline-test/qwen-full-video.mp4",
    resolveMediaPath: path => path,
    validateCompleteVideoForQwen: async () => ({ duration: 8, videoCodec: "h264", audioCodec: "aac" }),
    extractVideoAssets: async () => ({ duration: 8, scenes: [{ shotIndex: 1, startSeconds: 0, endSeconds: 8 }] }),
    analyzeVideoWithQwen: async () => ({ summary: "视频结论", hook: { description: "展示产品" } }),
    translateTranscriptWithQwen: async () => "TokScript 中文翻译",
    syncVideoToProductDocument: async () => deliveries.push({ status: video.status, translation: video.transcriptZh }),
    enqueueVideos: ids => enqueued.push(...ids),
    ...overrides,
  });
  return { video, deliveries, enqueued, patches, run: signal => analysisModule.analyzeVideo(video.id, signal, video.attemptCount) };
}

test("the first execution stops after two video errors; a late single translation still delivers", async () => {
  let calls = 0, translations = 0, finishTranslation;
  const p = await pipeline({
    analyzeVideoWithQwen: async () => { calls += 1; throw retryableQwenError(); },
    translateTranscriptWithQwen: ({ transcript }) => {
      assert.equal(transcript, "The TokScript original speech.");
      translations += 1;
      return new Promise(resolve => { finishTranslation = resolve; });
    },
  });
  const prior = process.env.QWEN_RETRY_BASE_MS;
  process.env.QWEN_RETRY_BASE_MS = "0";
  try {
    await assert.rejects(p.run(), /Qwen/);
    await waitFor(() => translations === 1);
    assert.equal(p.video.status, "failed");
    finishTranslation("来自 TokScript 的迟到翻译");
    await waitFor(() => p.deliveries.some(d => d.status === "failed" && d.translation === "来自 TokScript 的迟到翻译"));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 2);
    assert.equal(translations, 1);
    assert.deepEqual(p.enqueued, []);
    assert.equal(p.video.originalPath, "pipeline-test/original.mp4");
    assert.equal(p.video.status, "failed");
  } finally {
    if (prior === undefined) delete process.env.QWEN_RETRY_BASE_MS;
    else process.env.QWEN_RETRY_BASE_MS = prior;
  }
});

test("video success does not wait for translation or use a translation invented in video JSON", async () => {
  let finishTranslation, translations = 0;
  const p = await pipeline({
    analyzeVideoWithQwen: async () => ({
      summary: "视频结论", hook: { description: "产品演示" }, translationZh: "无口播",
    }),
    translateTranscriptWithQwen: () => {
      translations += 1;
      return new Promise(resolve => { finishTranslation = resolve; });
    },
  });
  await p.run();
  assert.equal(p.video.status, "completed");
  assert.equal(p.video.transcriptZh, "");
  assert.equal(JSON.parse(p.video.analysis_json).translationZh, "");
  finishTranslation("真实原口播的翻译");
  await waitFor(() => p.deliveries.some(d => d.status === "completed" && d.translation === "真实原口播的翻译"));
  assert.equal(translations, 1);
});

test("text-translation failure cannot reject successful video analysis", async () => {
  let translations = 0;
  const p = await pipeline({ translateTranscriptWithQwen: async () => { translations += 1; throw new Error("text API unavailable"); } });
  await p.run();
  assert.equal(p.video.status, "completed");
  assert.equal(translations, 1);
  assert.equal(p.video.transcriptZh, "");
});

for (const reason of ["newer-attempt", "manual-text", "stop"]) {
  test(`a late translation respects ${reason}`, async () => {
    let finishTranslation;
    const controller = new AbortController();
    const p = await pipeline({ translateTranscriptWithQwen: () => new Promise(resolve => { finishTranslation = resolve; }) });
    await p.run(controller.signal);
    if (reason === "newer-attempt") p.video.attemptCount += 1;
    if (reason === "manual-text") p.video.transcriptZh = "已保存的翻译";
    if (reason === "stop") controller.abort(new Error("stopped"));
    finishTranslation("旧任务翻译");
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.notEqual(p.video.transcriptZh, "旧任务翻译");
    if (reason === "manual-text") assert.equal(p.video.transcriptZh, "已保存的翻译");
  });
}

test("a permanent video rejection is not retried and does not falsely claim a retry", async () => {
  let calls = 0;
  const p = await pipeline({ analyzeVideoWithQwen: async () => {
    calls += 1;
    const error = retryableQwenError("Qwen 完整视频请求失败（HTTP 400）");
    error.retryable = false;
    throw error;
  } });
  await assert.rejects(p.run(), /HTTP 400/);
  assert.equal(calls, 1);
  assert.doesNotMatch(p.video.errorMessage, /已自动重试/);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(p.enqueued, []);
});

test("transcript-only completion shares the one early translation and never calls video analysis", async () => {
  let translations = 0;
  const p = await pipeline({
    analyzeVideoWithQwen: () => { throw new Error("must not analyze video"); },
    translateTranscriptWithQwen: async () => { translations += 1; return "纯翻译"; },
  });
  p.video.analysisMode = "transcript_only";
  await p.run();
  assert.equal(p.video.status, "completed");
  assert.equal(p.video.transcriptZh, "纯翻译");
  assert.equal(translations, 1);
});

test("an existing TokScript Chinese transcript needs no text-model request", async () => {
  let translations = 0;
  const p = await pipeline({ translateTranscriptWithQwen: async () => { translations += 1; return "unwanted"; } });
  p.video.transcriptZh = "TokScript 已返回中文版";
  await p.run();
  assert.equal(translations, 0);
  assert.equal(p.video.transcriptZh, "TokScript 已返回中文版");
});

test("no voiceover does not skip complete-video analysis or trigger another transcription", async () => {
  let videoCalls = 0, translationCalls = 0;
  const p = await pipeline({
    analyzeVideoWithQwen: async input => {
      videoCalls += 1;
      assert.equal(input.localVideoPath, "pipeline-test/qwen-full-video.mp4");
      return { summary: "纯画面产品演示", hook: { description: "直接展示使用过程" } };
    },
    translateTranscriptWithQwen: async () => { translationCalls += 1; return "unexpected"; },
  });
  p.video.transcriptOriginal = "背景音乐，无有效产品口播";
  p.video.transcriptZh = "背景音乐，无有效产品口播";
  await p.run();
  assert.equal(videoCalls, 1);
  assert.equal(translationCalls, 0);
  assert.equal(p.video.status, "completed");
  assert.equal(p.video.transcriptZh, "背景音乐，无有效产品口播");
});

test("an unverified missing audio track makes zero Qwen video calls but does not block the file or translation", async () => {
  let videoCalls = 0;
  const p = await pipeline({
    prepareLocalVideoForQwen: async () => { throw new Error("完整视频缺少音频轨，无法进行 Qwen 全模态分析"); },
    analyzeVideoWithQwen: async () => { videoCalls += 1; throw new Error("must not run"); },
  });
  await assert.rejects(p.run(), /缺少音频轨/);
  await waitFor(() => p.deliveries.some(d => d.status === "failed" && d.translation === "TokScript 中文翻译"));
  assert.equal(videoCalls, 0);
  assert.deepEqual(p.enqueued, []);
  assert.equal(p.video.originalPath, "pipeline-test/original.mp4");
  assert.equal(p.video.status, "failed");
});

test("stopping the first video request cannot start the second request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const p = await pipeline({ analyzeVideoWithQwen: async () => {
    calls += 1;
    controller.abort(new Error("user stopped"));
    throw retryableQwenError();
  } });
  await assert.rejects(p.run(controller.signal));
  assert.equal(calls, 1);
  assert.equal(p.video.status, "stopped");
  assert.deepEqual(p.enqueued, []);
});

test("a newly downloaded fallback file reaches Qwen while the TokScript translation stays independent", async () => {
  let downloadCalls = 0, providerCalls = 0, videoCalls = 0;
  const p = await pipeline({
    fetchTikTok: async () => {
      providerCalls += 1;
      return { downloadUrl: "https://cdn.example/expired.mp4", transcript: "Original TokScript speech.",
        transcriptZh: "TokScript 已返回的中文", segments: [], stats: {}, raw: {} };
    },
    downloadTikTokVideoWithFallback: async input => {
      downloadCalls += 1;
      assert.equal(input.videoId, "pipeline-test");
      assert.equal(typeof input.primaryDownload, "function");
      await input.beforeSource("网页");
      return { relativePath: "pipeline-test/download-unique/2/original.mp4", source: "网页", failures: ["yt-dlp：无法读取 TikTok 页面"] };
    },
    prepareLocalVideoForQwen: async (_id, original) => {
      assert.equal(original, "pipeline-test/download-unique/2/original.mp4");
      return "pipeline-test/qwen-full-video.mp4";
    },
    translateTranscriptWithQwen: async () => { throw new Error("must not translate existing Chinese text"); },
    analyzeVideoWithQwen: async input => {
      videoCalls += 1;
      assert.equal(input.localVideoPath, "pipeline-test/qwen-full-video.mp4");
      assert.equal("remoteVideoUrl" in input, false);
      return { summary: "视频结论", hook: { description: "产品演示" } };
    },
  });
  p.video.originalPath = "";
  p.video.transcriptOriginal = "";
  await p.run();
  assert.equal(providerCalls, 1);
  assert.equal(downloadCalls, 1);
  assert.equal(videoCalls, 1);
  assert.equal(p.video.status, "completed");
  assert.equal(p.video.transcriptZh, "TokScript 已返回的中文");
  assert.equal(p.video.originalPath, "pipeline-test/download-unique/2/original.mp4");
  assert.ok(JSON.parse(p.video.analysis_json).modelTrace.includes("视频文件：网页下载"));
});

test("exhausted download fallbacks do not discard a successful TokScript translation or run Qwen video analysis", async () => {
  let videoCalls = 0;
  const p = await pipeline({
    fetchTikTok: async () => ({ downloadUrl: "", transcript: "Original speech.", transcriptZh: "仍须保留的中文", segments: [], stats: {}, raw: {} }),
    downloadTikTokVideoWithFallback: async () => { throw new Error("视频下载失败（网页：请求失败）"); },
    analyzeVideoWithQwen: async () => { videoCalls += 1; },
  });
  p.video.originalPath = "";
  p.video.transcriptOriginal = "";
  await assert.rejects(p.run(), /视频下载失败/);
  await waitFor(() => p.deliveries.some(value => value.translation === "仍须保留的中文"));
  assert.equal(videoCalls, 0);
  assert.equal(p.video.transcriptZh, "仍须保留的中文");
  assert.equal(p.video.originalPath, "");
  assert.equal(p.video.status, "failed");
});

test("overlong provider metadata fits MySQL without truncating the original payload or blocking download", async () => {
  const fullTitle = "📦".repeat(800), fullAccount = "名".repeat(300);
  let downloads = 0;
  const p = await pipeline({
    fetchTikTok: async () => ({ title: fullTitle, accountName: fullAccount, downloadUrl: "", transcript: "Original provider speech.",
      transcriptZh: "已有中文", segments: [], stats: {}, raw: { transcript: { title: fullTitle, username: fullAccount } } }),
    downloadTikTokVideoWithFallback: async () => {
      downloads++;
      const metadata = p.patches.find(patch => patch.provider_payload_json);
      assert.equal(Array.from(metadata.title).length, 512);
      assert.equal(metadata.title, "📦".repeat(512));
      assert.equal(Array.from(metadata.account_name).length, 191);
      assert.equal(JSON.parse(metadata.provider_payload_json).transcript.title, fullTitle);
      return { relativePath: "pipeline-test/download-test/1/original.mp4", source: "网页", failures: [] };
    },
  });
  p.video.analysisMode = "transcript_only";
  p.video.originalPath = "";
  p.video.transcriptOriginal = "";
  await p.run();
  assert.equal(downloads, 1);
  assert.equal(p.video.status, "completed");
  assert.equal(p.video.transcriptZh, "已有中文");
});
