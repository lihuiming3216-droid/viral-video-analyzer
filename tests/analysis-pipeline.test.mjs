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
    export const recordVideoStage = async (...args) => hooks().recordVideoStage?.(...args);
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
    export const createSceneClip = async (...args) => hooks().createSceneClip?.(...args);
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
    sourceUrl: "https://www.tiktok.com/@demo/video/123", analysisMode: "transcript_only",
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
    translateTranscriptWithQwen: async () => "TokScript 中文翻译",
    syncVideoToProductDocument: async () => deliveries.push({ status: video.status, translation: video.transcriptZh }),
    enqueueVideos: ids => enqueued.push(...ids),
    ...overrides,
  });
  return { video, deliveries, enqueued, patches, run: signal => analysisModule.analyzeVideo(video.id, signal, video.attemptCount) };
}

for (const reason of ["newer-attempt", "manual-text", "stop"]) {
  test(`a late translation respects ${reason}`, async () => {
    let finishTranslation;
    const controller = new AbortController();
    const p = await pipeline({ translateTranscriptWithQwen: () => new Promise(resolve => { finishTranslation = resolve; }) });
    const running = p.run(controller.signal).catch(() => undefined);
    await waitFor(() => Boolean(finishTranslation));
    if (reason === "newer-attempt") p.video.attemptCount += 1;
    if (reason === "manual-text") p.video.transcriptZh = "已保存的翻译";
    if (reason === "stop") controller.abort(new Error("stopped"));
    finishTranslation("旧任务翻译");
    await running;
    assert.notEqual(p.video.transcriptZh, "旧任务翻译");
    if (reason === "manual-text") assert.equal(p.video.transcriptZh, "已保存的翻译");
  });
}

test("原口播 is delivered to Feishu before the media download finishes", async () => {
  const order = [];
  let finishDownload;
  const p = await pipeline({
    fetchTikTok: async () => ({ downloadUrl: "https://cdn.test/v.mp4", transcript: "Early speech.", transcriptZh: "",
      segments: [], stats: {}, raw: {} }),
    deliverEarlyTranscript: async () => { order.push("text"); },
    downloadTikTokVideoWithFallback: () => new Promise(resolve => {
      finishDownload = () => { order.push("file"); resolve({ relativePath: "pipeline-test/original.mp4", source: "TokScript", failures: [] }); };
    }),
  });
  p.video.originalPath = "";
  p.video.transcriptOriginal = "";
  const running = p.run();
  await waitFor(() => order.includes("text") && Boolean(finishDownload));
  finishDownload();
  await running;
  assert.equal(order[0], "text");
});

test("transcript-only completion shares the one early translation and never calls video analysis", async () => {
  let translations = 0;
  const p = await pipeline({
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

test("exhausted download fallbacks do not discard a successful TokScript translation", async () => {
  const p = await pipeline({
    fetchTikTok: async () => ({ downloadUrl: "", transcript: "Original speech.", transcriptZh: "仍须保留的中文", segments: [], stats: {}, raw: {} }),
    downloadTikTokVideoWithFallback: async () => { throw new Error("视频下载失败（网页：请求失败）"); },
  });
  p.video.originalPath = "";
  p.video.transcriptOriginal = "";
  await assert.rejects(p.run(), /视频下载失败/);
  await waitFor(() => p.deliveries.some(value => value.translation === "仍须保留的中文"));
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

test("TokScript speech failure still delivers a video and records separate stage failures", async () => {
  for (const mode of ["product_doc","transcript_only"]) {
    const stages = []; let analyses = 0, translations = 0;
    const p = await pipeline({
      recordVideoStage: (...args) => stages.push(args),
      fetchTikTok: async (_url,_signal,options) => {
        assert.equal(options.allowPartial,true);
        return {downloadUrl:"https://cdn.test/video.mp4",transcript:"",transcriptZh:"",transcriptError:"口播提取失败",segments:[],stats:{},raw:{}};
      },
      downloadTikTokVideoWithFallback: async () => ({relativePath:"pipeline-test/original.mp4",source:"TokScript",failures:[]}),
      analyzeVideoWithQwen: async () => { analyses++; return {summary:"真实视频结论",hook:{description:"完整视频演示"}}; },
      translateTranscriptWithQwen: async () => { translations++; return "不应该调用"; },
    });
    p.video.originalPath = ""; p.video.transcriptOriginal = ""; p.video.analysisMode = mode;
    await p.run();
    assert.equal(p.video.status,"completed"); assert.equal(p.video.originalPath,"pipeline-test/original.mp4");
    assert.equal(p.video.transcriptZh,""); assert.equal(translations,0);
    assert.equal(analyses,0, "both handcards and task tables skip video models");
    assert.ok(stages.some(([, ,stage,state])=>stage === "analysis" && state === "skipped"));
    assert.ok(stages.some(([, ,stage,state])=>stage === "download" && state === "completed"));
    assert.ok(stages.some(([, ,stage,state])=>stage === "transcript" && state === "failed"));
    assert.ok(stages.some(([, ,stage,state])=>stage === "translation" && state === "skipped"));
  }
});

test("a translation error is durable and does not fail the file and speech result", async () => {
  const stages = [];
  const p = await pipeline({ recordVideoStage:(...args)=>stages.push(args), translateTranscriptWithQwen:async()=>{throw Error("secret provider body");} });
  await p.run();
  await waitFor(()=>stages.some(([, ,stage,state])=>stage === "translation" && state === "failed"));
  assert.equal(p.video.status,"completed"); assert.equal(p.video.transcriptZh,"");
  assert.doesNotMatch(JSON.stringify(stages),/secret provider body/);
});

for (const cachedFile of [true, false]) {
  for (const providerChinese of [true, false]) {
    test(`handcard skips every video-analysis step and preserves file/translation: cached=${cachedFile}, Chinese=${providerChinese}`, async () => {
      const stages = [];
      let fetches = 0, downloads = 0, translations = 0, forbiddenCalls = 0;
      const forbidden = () => { forbiddenCalls += 1; throw Error("handcards must not enter the analysis pipeline"); };
      const p = await pipeline({
        recordVideoStage: (...args) => stages.push(args),
        fetchTikTok: async (_url, _signal, options) => {
          fetches += 1;
          assert.equal(options.includeCover, false);
          assert.equal(options.timeoutMs, 90_000);
          return { downloadUrl: "https://cdn.test/video.mp4", transcript: "The TokScript original speech.",
            transcriptZh: providerChinese ? "TokScript 已返回中文版" : "", coverUrl: "https://cdn.test/unused-cover.jpg", segments: [], stats: {}, raw: {} };
        },
        downloadTikTokVideoWithFallback: async input => {
          downloads += 1;
          assert.equal(input.requireAudio, true, "keep the existing original audio-track protection");
          return { relativePath: "pipeline-test/original.mp4", source: "TokScript", failures: [] };
        },
        translateTranscriptWithQwen: async ({ transcript }) => {
          translations += 1;
          assert.equal(transcript, "The TokScript original speech.");
          return "TokScript 原口播的中文翻译";
        },
        extractVideoAssets: forbidden, prepareLocalVideoForQwen: forbidden,
        validateCompleteVideoForQwen: forbidden, analyzeVideoWithQwen: forbidden,
        replaceScenes: forbidden, createSceneClip: forbidden, learnFromVideo: forbidden,
        downloadMedia: forbidden,
      });
      p.video.analysisMode = "product_doc";
      p.video.summary = "已有历史分析";
      p.video.analysis_json = '{"summary":"已有历史分析"}';
      p.video.transcriptZh = cachedFile && providerChinese ? "TokScript 已返回中文版" : "";
      if (!cachedFile) { p.video.originalPath = ""; p.video.transcriptOriginal = ""; }
      await p.run();
      await waitFor(() => p.deliveries.some(d => d.status === "completed" && d.translation));
      assert.equal(forbiddenCalls, 0);
      assert.equal(fetches, cachedFile ? 0 : 1);
      assert.equal(downloads, cachedFile ? 0 : 1);
      assert.equal(translations, providerChinese ? 0 : 1);
      assert.equal(p.video.originalPath, "pipeline-test/original.mp4");
      assert.equal(p.video.summary, "已有历史分析", "retirement must not delete saved historical results");
      assert.equal(p.video.analysis_json, '{"summary":"已有历史分析"}');
      assert.equal(p.patches.some(patch => "analysis_json" in patch || "summary" in patch || "score_traffic" in patch), false);
      assert.ok(stages.some(([, ,stage,state]) => stage === "analysis" && state === "skipped"));
      assert.equal(stages.some(([, ,stage,state]) => stage === "analysis" && state === "running"), false);
      assert.deepEqual(p.enqueued, []);
    });
  }
}
