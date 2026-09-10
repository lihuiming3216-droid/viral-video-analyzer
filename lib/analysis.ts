import "server-only";

import { randomUUID } from "node:crypto";
import {
  getProduct,
  getPromptTemplate,
  getVideo,
  replaceScenes,
  savePromptDebugCapture,
  updateVideo,
  updateVideoAttemptDiagnostics,
} from "@/lib/database";
import { clampScore, formatTime } from "@/lib/json-utils";
import { getLearningContext, learnFromVideo } from "@/lib/learning";
import { getProviderConfig } from "@/lib/provider-config";
import {
  analyzeVideoWithQwen,
  QwenRequestError,
  translateTranscriptWithQwen,
  type QwenRequestDiagnostic,
} from "@/lib/providers/qwen";
import { fetchTikTok, tokScriptTranscriptFailure } from "@/lib/providers/tokscript";
import { downloadTikTokVideoWithFallback } from "@/lib/tiktok-video-download";
import type {
  AnalysisResult,
  AnalysisScene,
  Product,
  ScoreSet,
  VideoAttemptCallDiagnostic,
  VideoAttemptDiagnostics,
} from "@/lib/types";
import { emitVideoProgress } from "@/lib/video-events";
import {
  createSceneClip,
  downloadMedia,
  extractVideoAssets,
  prepareLocalVideoForQwen,
  resolveMediaPath,
  validateCompleteVideoForQwen,
  type ExtractedScene,
} from "@/lib/video-processing";

async function setStage(id: string, status: string, stage: string, progress: number) {
  await updateVideo(id, { status, stage, progress, error_message: null });
  emitVideoProgress(id);
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function defaultScores(): ScoreSet {
  return { traffic: 0, conversion: 0, visual: 0, product: 0, audio: 0, rhythm: 0 };
}

function normalizeScene(value: Partial<AnalysisScene>, shotIndex: number): AnalysisScene {
  return {
    shotIndex,
    role: String(value.role || "内容推进"),
    visual: String(value.visual || ""),
    audio: String(value.audio || ""),
    originalText: String(value.originalText || ""),
    translationZh: String(value.translationZh || ""),
    good: String(value.good || ""),
    improve: String(value.improve || ""),
    importance: clampScore(value.importance),
    scoreTraffic: clampScore(value.scoreTraffic),
    scoreConversion: clampScore(value.scoreConversion),
    scoreClarity: clampScore(value.scoreClarity),
    scoreAesthetic: clampScore(value.scoreAesthetic),
    scoreLighting: clampScore(value.scoreLighting),
    scoreProduct: clampScore(value.scoreProduct),
    tags: stringArray(value.tags),
  };
}

function normalizeAnalysis(
  value: Partial<AnalysisResult>,
  sceneCount: number,
  trace: string[],
  transcriptZhOverride = "",
): AnalysisResult {
  const rawScores = value.scores || defaultScores();
  const rawScenes = Array.isArray(value.scenes) ? value.scenes : [];
  const scenes = Array.from({ length: sceneCount }, (_, index) => {
    const matched = rawScenes.find((scene) => Number(scene.shotIndex) === index + 1) || rawScenes[index] || {};
    return normalizeScene(matched, index + 1);
  });
  return {
    summary: String(value.summary || "分析已完成"),
    language: String(value.language || "unknown"),
    translationZh: transcriptZhOverride.trim(),
    scores: {
      traffic: clampScore(rawScores.traffic), conversion: clampScore(rawScores.conversion),
      visual: clampScore(rawScores.visual), product: clampScore(rawScores.product),
      audio: clampScore(rawScores.audio), rhythm: clampScore(rawScores.rhythm),
    },
    hook: {
      timeRange: String(value.hook?.timeRange || "00:00–00:03"),
      type: String(value.hook?.type || "开场钩子"),
      description: String(value.hook?.description || ""),
      whyItWorks: String(value.hook?.whyItWorks || ""),
    },
    viralPoints: Array.isArray(value.viralPoints)
      ? value.viralPoints.map((point) => ({ timeRange: String(point.timeRange || ""), description: String(point.description || ""), reason: String(point.reason || "") }))
      : [],
    strengths: stringArray(value.strengths),
    weaknesses: stringArray(value.weaknesses),
    structureFormula: String(value.structureFormula || ""),
    rewriteScript: String(value.rewriteScript || ""),
    storyboard: Array.isArray(value.storyboard)
      ? value.storyboard.map((item) => ({ shot: String(item.shot || ""), visual: String(item.visual || ""), voiceover: String(item.voiceover || "") }))
      : [],
    scenes,
    modelTrace: trace,
  };
}

export const PROMPT_TEMPLATE_SLUGS = {
  full: "video_analysis_full",
  product_doc: "video_analysis_product_doc",
} as const;

export const PROMPT_TEMPLATE_LABELS: Record<"full" | "product_doc", string> = {
  full: "视频完整分析（full 模式）",
  product_doc: "视频精简分析（product_doc 模式）",
};

// {{PRODUCT_JSON}}/{{TIMELINE_JSON}}/{{LEARNING_JSON}} 是真实数据的占位符，运维后台的 Prompt
// 调试台编辑这份模板时可以改动周围的说明文字，但这三个占位符会在真正请求时被替换成当次的真实输入。
export const DEFAULT_PROMPT_TEMPLATES: Record<"full" | "product_doc", string> = {
  product_doc: `你是 TikTok 带货短视频拆解专家。请用中文输出极简的产品样片分析。

只输出：核心判断、开头钩子、分析爆点、内容结构、产品呈现、用户痛点或情绪、转化方式和可借鉴点。中文翻译由 TokScript 独立链路处理，本请求禁止生成 translationZh 或重复翻译口播。不要输出评分、原视频链接、复拍口播稿或分镜脚本。不要臆造页面或视频没有提供的信息。
所有分析都用短语，不写解释句；只保留“动作+结果”。summary 不超过30个汉字；hook.description、每条 viralPoints、strengths 和 structureFormula 均不超过18个汉字。删除“通过、进行、能够、可以、有效提升、有助于、让用户”等套话。
严格使用以下 JSON 结构：{"summary":"","language":"","hook":{"timeRange":"","type":"","description":"","whyItWorks":""},"viralPoints":[{"timeRange":"","description":"","reason":""}],"strengths":[""],"structureFormula":""}。

产品：{{PRODUCT_JSON}}
镜头时间轴：{{TIMELINE_JSON}}`,
  full: `你是 TikTok 带货短视频拆解专家。请用中文输出视频分析。中文翻译由 TokScript 独立链路处理，本请求禁止生成 translationZh 或重复翻译口播。

目标：分别判断流量潜力和带货转化，不要因为播放量高就默认转化高。分析每个镜头的画面、声音、清晰度、美感、光线、产品主体是否清晰、节奏、情绪和商业作用。

必须识别并标记：0–3 秒钩子、爆点、卖点、信任点、CTA。说明哪里拍得好、为什么有效、哪里需要改。分数均为 0–100。

评分口径：
- 流量：首屏停留、好奇、反差、节奏、信息密度、情绪与完播潜力。
- 转化：产品露出、痛点匹配、利益清晰度、演示说服力、信任、异议处理与 CTA。
- 画面：清晰度、美感、构图、光线、主体分离、字幕可读性。
- 声音：口播清楚度、情绪、音乐和音效对节奏的帮助。

严格按提供的 shotIndex 输出同样数量的 scenes，不增加、不遗漏、不改时间顺序。图片顺序与 shotIndex 一致。

产品：{{PRODUCT_JSON}}
镜头时间轴：{{TIMELINE_JSON}}
长期学习系统提供的产品/品类/团队历史经验：{{LEARNING_JSON}}

历史经验只能用于校准判断和识别可复用规律，不能机械沿用旧分数。人工标签和团队备注的优先级高于未验证案例。

最后生成一份吸收原片优点、但不是逐句抄袭的中文复拍口播稿和分镜脚本。

严格按下面这个 JSON 结构输出，字段名和层级必须完全一致，不要新增外层包装（比如不要包一层 videoAnalysis 或 remakeScript），不要遗漏任何字段，字符串字段没有内容时给空字符串而不是省略：
{
  "summary": "整体判断，200字以内",
  "scores": { "traffic": 0, "conversion": 0, "visual": 0, "product": 0, "audio": 0, "rhythm": 0 },
  "hook": { "timeRange": "00:00–00:03", "type": "钩子类型", "description": "钩子描述", "whyItWorks": "为什么有效" },
  "viralPoints": [ { "timeRange": "00:00–00:00", "description": "爆点描述", "reason": "原因" } ],
  "strengths": ["优点1", "优点2"],
  "weaknesses": ["缺点1", "缺点2"],
  "structureFormula": "内容结构公式，比如 痛点-展示-细节-促销",
  "scenes": [
    {
      "shotIndex": 1,
      "role": "这个镜头的作用，比如 钩子/卖点/信任点/CTA/内容推进",
      "visual": "画面描述",
      "audio": "声音描述（音乐、音效、语气，不是口播原文）",
      "originalText": "这个时间段内的口播原文（英文原文照抄，不翻译）",
      "good": "这个镜头拍得好的地方",
      "improve": "这个镜头可以怎么改",
      "importance": 0,
      "scoreTraffic": 0,
      "scoreConversion": 0,
      "scoreClarity": 0,
      "scoreAesthetic": 0,
      "scoreLighting": 0,
      "scoreProduct": 0,
      "tags": ["标签1", "标签2"]
    }
  ],
  "rewriteScript": "完整的中文复拍口播稿",
  "storyboard": [ { "shot": "镜头编号或说明", "visual": "画面", "voiceover": "口播" } ]
}`,
};

/** Renders the DB-editable template (Prompt 调试台) against the real inputs for this run. */
export async function renderAnalysisPrompt(input: {
  product: Product;
  scenes: Array<{ shotIndex: number; startSeconds: number; endSeconds: number }>;
  learningContext: unknown;
  mode: "full" | "product_doc";
}) {
  const timeline = input.scenes.map((scene) => ({
    shotIndex: scene.shotIndex,
    timeRange: `${formatTime(scene.startSeconds)}–${formatTime(scene.endSeconds)}`,
  }));
  const productPayload = input.mode === "product_doc"
    ? {
      name: input.product.name,
      pid: input.product.pid,
      coreFunctions: input.product.coreFunctions.slice(0, 3),
      usageMethod: input.product.usageMethod,
      targetAudience: input.product.targetAudience,
      usageScenes: input.product.usageScenes,
    }
    : input.product;
  const slug = PROMPT_TEMPLATE_SLUGS[input.mode];
  const templateRow = await getPromptTemplate(slug, PROMPT_TEMPLATE_LABELS[input.mode], DEFAULT_PROMPT_TEMPLATES[input.mode]);
  const prompt = templateRow.template
    .replaceAll("{{PRODUCT_JSON}}", JSON.stringify(productPayload))
    .replaceAll("{{TIMELINE_JSON}}", JSON.stringify(timeline))
    .replaceAll("{{LEARNING_JSON}}", JSON.stringify(input.learningContext ?? null));
  const inputs = { mode: input.mode, product: productPayload, timeline, learningContext: input.learningContext ?? null };
  return { prompt, slug, inputs };
}

async function isConfigured(provider: "qwen") {
  const config = await getProviderConfig(provider);
  return config.enabled && Boolean(config.apiKey);
}

function transientNetworkFailure(error: unknown) {
  if (error instanceof Error && error.name === "TokScriptToolCallError") return false;
  if (error instanceof Error && error.name === "TokScriptRetryableError") return true;
  const message = error instanceof Error ? error.message : String(error || "");
  return /(?:timeout|timed out|aborted due to timeout|fetch failed|econnreset|etimedout|socket|und_err)/i.test(message);
}

function qwenRequestFailure(error: unknown) {
  if (!(error instanceof Error) || error.name !== "QwenRequestError") return null;
  return error as Error & { code?: string; retryable?: boolean };
}

function retryableQwenFailure(error: unknown) {
  return qwenRequestFailure(error)?.retryable === true;
}

function qwenRetryDelayMs() {
  const configured = Number(process.env.QWEN_RETRY_BASE_MS ?? 3_000);
  const base = Number.isFinite(configured) ? Math.max(0, Math.min(30_000, configured)) : 3_000;
  if (!base) return 0;
  return base + Math.floor(Math.random() * Math.min(2_000, base));
}

async function waitForQwenRetry(signal?: AbortSignal) {
  const delayMs = qwenRetryDelayMs();
  signal?.throwIfAborted();
  if (!delayMs) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("视频任务已停止"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function withOneNetworkRetry<T>(
  operation: () => Promise<T>,
  onRetry: () => void,
  signal?: AbortSignal,
) {
  try {
    return await operation();
  } catch (error) {
    if (signal?.aborted || !transientNetworkFailure(error)) throw error;
    onRetry();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    signal?.throwIfAborted();
    return operation();
  }
}

function userFacingAnalysisError(error: unknown, qwenRequests: number) {
  const message = error instanceof Error ? error.message : "未知错误";
  const qwenFailure = qwenRequestFailure(error);
  if (qwenFailure) return qwenRequests === 2 ? `${message}，系统已自动重试一次` : message;
  if (error instanceof Error && error.name === "TokScriptRetryableError") return message;
  if (transientNetworkFailure(error)) {
    if (/Qwen/i.test(message)) return "Qwen 完整视频分析超时，系统已自动重试一次";
    if (/TokScript/i.test(message)) return "TokScript 获取视频超时，系统已自动重试一次";
    return "视频处理网络超时，系统已自动重试一次";
  }
  return message;
}

function isUsableAnalysis(
  value: Record<string, unknown> | undefined,
  sceneCount: number,
  mode: "full" | "product_doc",
) {
  if (!value || typeof value.summary !== "string" || !value.summary.trim()) return false;
  // TokScript owns the transcript translation now. Qwen's video result may
  // omit translation or return it independently; either case must not make a
  // valid video analysis unusable.
  const scores = value.scores;
  const scenes = value.scenes;
  // The table path deliberately asks for a compact object without scene rows
  // or scores. Require one compact analysis section so a truncated response
  // still gets the one allowed retry, but never require translation.
  if (mode === "product_doc") {
    const hook = value.hook;
    return Boolean(
      (hook && typeof hook === "object" && String((hook as Record<string, unknown>).description || "").trim())
      || (Array.isArray(value.viralPoints) && value.viralPoints.some((point) =>
        point && typeof point.description === "string" && point.description.trim()))
      || (Array.isArray(value.strengths) && value.strengths.some((point) =>
        typeof point === "string" && point.trim()))
      || String(value.structureFormula || "").trim()
    );
  }
  return Boolean(
    scores && typeof scores === "object"
    && Array.isArray(scenes)
    && scenes.length >= sceneCount,
  );
}

function transcriptForScene(
  scene: ExtractedScene,
  segments: Array<{ start: number; end: number; text: string }>,
  fallback: string,
) {
  if (!segments.length) return fallback;
  return segments
    .filter((segment) => segment.end >= scene.startSeconds && segment.start <= scene.endSeconds)
    .map((segment) => segment.text)
    .join(" ");
}

async function ownsVideoAttempt(videoId: string, expectedAttemptNumber?: number) {
  if (expectedAttemptNumber === undefined) return true;
  try {
    const video = await getVideo(videoId, false);
    return video?.attemptCount === expectedAttemptNumber;
  } catch {
    return false;
  }
}

async function assertVideoAttempt(videoId: string, signal?: AbortSignal, expectedAttemptNumber?: number) {
  signal?.throwIfAborted();
  if (!(await ownsVideoAttempt(videoId, expectedAttemptNumber))) throw new Error("分析任务已被新的执行替代");
}

function qwenDiagnosticPhase(diagnostic: QwenRequestDiagnostic): VideoAttemptCallDiagnostic["phase"] {
  if (diagnostic.outcome === "success") return "completed";
  if (diagnostic.outcome === "http_error") return "awaiting_first_token";
  if (diagnostic.outcome === "invalid_response") {
    return diagnostic.firstTokenMs === null ? "awaiting_first_token" : "parsing";
  }
  if (diagnostic.headersMs === null) return "awaiting_headers";
  return diagnostic.firstTokenMs === null ? "awaiting_first_token" : "streaming";
}

function qwenCallDiagnostic(
  requestIndex: 1 | 2,
  clientRequestId: string,
  startedAt: string,
  diagnostic: QwenRequestDiagnostic,
): VideoAttemptCallDiagnostic {
  return {
    requestIndex,
    clientRequestId,
    ...(diagnostic.requestId ? { providerRequestId: diagnostic.requestId } : {}),
    phase: qwenDiagnosticPhase(diagnostic),
    outcome: diagnostic.outcome,
    startedAt,
    ...(diagnostic.headersMs === null ? {} : { headersMs: diagnostic.headersMs }),
    ...(diagnostic.firstTokenMs === null ? {} : { firstTokenMs: diagnostic.firstTokenMs }),
    totalMs: diagnostic.totalMs,
    ...(diagnostic.httpStatus === null ? {} : { httpStatus: diagnostic.httpStatus }),
    ...(diagnostic.responseSha256 ? { responseSha256: diagnostic.responseSha256 } : {}),
    ...(diagnostic.errorCode ? { errorCode: diagnostic.errorCode } : {}),
  };
}

export async function analyzeVideo(videoId: string, signal?: AbortSignal, expectedAttemptNumber?: number) {
  const initial = await getVideo(videoId);
  if (!initial) throw new Error("视频不存在");
  const product = await getProduct(initial.productId);
  if (!product) throw new Error("产品档案不存在");
  const analysisMode = initial.analysisMode;
  const trace: string[] = [];
  let transcript = initial.transcriptOriginal;
  let transcriptZh = String(initial.transcriptZh || "");
  let qwenRequests = 0;
  let translationTask: Promise<void> | undefined;
  const deliverProductDocument = () => import("@/lib/feishu/product-doc-sync")
    .then(({ syncVideoToProductDocument }) => syncVideoToProductDocument(videoId))
    .catch(() => false);
  const scheduleTranscriptTranslation = () => {
    if (translationTask) return translationTask;
    if (!transcript.trim() || transcriptZh.trim() || signal?.aborted) return Promise.resolve();
    const transcriptForTranslation = transcript;
    // Memoize before any await: early, completion and failure paths must not
    // translate the same transcript twice. Model failure does not abort this
    // task; an explicit stop, hard timeout or newer execution does.
    translationTask = (async () => {
      if (!(await isConfigured("qwen"))) return;
      await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
      const translated = await translateTranscriptWithQwen({ transcript: transcriptForTranslation, signal });
      await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
      const latest = await getVideo(videoId, false);
      if (!translated.trim() || !latest || latest.status === "stopped") return;
      transcriptZh = String(latest.transcriptZh || "").trim() || translated.trim();
      if (!latest.transcriptZh?.trim()) await updateVideo(videoId, { transcript_zh: transcriptZh });
      emitVideoProgress(videoId);
      void deliverProductDocument();
      void import("@/lib/feishu/automation")
        .then(({ deliverEarlyTranscript }) => deliverEarlyTranscript(videoId))
        .catch(() => undefined);
    })().catch(() => {
      // Translation failure must not change the video-analysis result.
    });
    return translationTask;
  };
  try {
    await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
    let relativeVideoPath = initial.originalPath;
    let transcriptSegments: Array<{ start: number; end: number; text: string }> = [];

    const storedTokScriptFailure = initial.sourceType === "tiktok"
      && tokScriptTranscriptFailure(transcript);
    const needsTokScriptRefresh = initial.sourceType === "tiktok"
      && (!relativeVideoPath || !transcript.trim() || storedTokScriptFailure);
    if (needsTokScriptRefresh) {
      await setStage(videoId, "downloading", "正在通过 TokScript 获取视频和公开数据", 12);
      const tokOptions = {
        includeCover: analysisMode !== "product_doc",
        // One bad/expired document link must never block every later row.
        timeoutMs: analysisMode === "product_doc" ? 90_000 : 180_000,
      };
      const tok = await withOneNetworkRetry(
        () => fetchTikTok(initial.sourceUrl || "", signal, tokOptions),
        () => { void setStage(videoId, "downloading", "获取视频信息较慢，正在自动重试", 14); },
        signal,
      );
      await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
      // File acquisition may fall back independently of the saved transcript.
      const remoteVideoUrl = tok.downloadUrl || "";
      transcript = tok.transcript;
      transcriptZh = tok.transcriptZh || transcriptZh;
      transcriptSegments = tok.segments;
      // Persist metadata before downloading the media. If the CDN is slow, a
      // retry keeps the already-fetched transcript and diagnostics instead of
      // losing the whole TokScript result.
      await updateVideo(videoId, {
        remote_video_url: remoteVideoUrl,
        transcript_original: transcript,
        ...(transcriptZh ? { transcript_zh: transcriptZh } : {}),
        transcript_segments_json: JSON.stringify(transcriptSegments),
        language: tok.language || null,
        // Display metadata must fit MySQL VARCHAR limits without splitting
        // Unicode characters. The complete provider payload is retained below.
        title: Array.from(tok.title || initial.title || "待分析视频").slice(0, 512).join(""),
        account_name: Array.from(tok.accountName || "").slice(0, 191).join(""),
        platform_video_id: tok.platformVideoId || null,
        published_at: tok.publishedAt,
        view_count: tok.stats.views,
        like_count: tok.stats.likes,
        comment_count: tok.stats.comments,
        share_count: tok.stats.shares,
        favorite_count: tok.stats.favorites,
        follower_count: tok.stats.followers,
        stats_captured_at: new Date().toISOString(),
        provider_payload_json: JSON.stringify(tok.raw),
      });
      void scheduleTranscriptTranslation();
      void deliverProductDocument();
      trace.push(relativeVideoPath
        ? "TokScript：已刷新先前无效的口播响应"
        : "TokScript：视频、文案与公开数据");
      if (!relativeVideoPath) {
        await setStage(videoId, "downloading", "正在下载 TikTok 原视频", 22);
        const downloaded = await downloadTikTokVideoWithFallback({
          videoId, sourceUrl: initial.sourceUrl || "", signal,
          requireAudio: analysisMode !== "transcript_only",
          primaryDownload: tok.downloadUrl ? destinationId => withOneNetworkRetry(
            () => downloadMedia(destinationId, tok.downloadUrl, "video", signal, {
              timeoutMs: analysisMode === "product_doc" ? 90_000 : 180_000,
            }),
            () => { void setStage(videoId, "downloading", "原视频下载较慢，正在自动重试", 24); },
            signal,
          ) : undefined,
          beforeSource: async source => {
            await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
            if (source !== "TokScript") {
              await setStage(videoId, "downloading", source === "yt-dlp"
                ? "正在尝试本地工具下载" : "正在尝试网页原视频下载", 24);
            }
          },
        });
        relativeVideoPath = downloaded.relativePath;
        trace.push(...downloaded.failures, `视频文件：${downloaded.source}下载`);
        await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
        const coverPath = tok.coverUrl ? await downloadMedia(videoId, tok.coverUrl, "cover", signal).catch((error) => {
          if (signal?.aborted) throw error;
          return null;
        }) : null;
        await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
        await updateVideo(videoId, { original_path: relativeVideoPath, cover_path: coverPath });
      }
    } else if (initial.sourceType === "tiktok") {
      trace.push("本地缓存：复用已保存的 TikTok 原片和文案");
    }

    // 原口播（and 中文翻译, if available) is ready long before the multi-minute
    // Qwen video analysis below finishes — push it to Feishu now instead of
    // making the row wait for the entire pipeline. Placed after both the
    // fresh-fetch and cached-reuse branches above (e.g. a retried attempt that
    // skips TokScript entirely) so it fires exactly once either way.
    // Best-effort and non-blocking: the terminal completeFeishuAutomation()
    // call later is still the durable, guaranteed delivery.
    if (transcript.trim()) {
      void import("@/lib/feishu/automation")
        .then(({ deliverEarlyTranscript }) => deliverEarlyTranscript(videoId))
        .catch(() => undefined);
      // TokScript doesn't always supply its own translation. Kick the Qwen
      // text-translation fallback off now, in parallel with extract/Qwen video
      // analysis below, instead of waiting until the very end — so 中文翻译 has
      // a real chance to land early too, not just 原口播. (No-ops if TokScript
      // did supply one: transcriptZh.trim() is already true.)
      void scheduleTranscriptTranslation();
    }
    // Upload the original as soon as it exists, independently of analysis.
    void deliverProductDocument();

    if (!relativeVideoPath) throw new Error("没有可分析的视频文件");

    let finalTranslation = "";
    if (analysisMode === "transcript_only") {
      // 任务安排表只需要 文件/原口播/中文翻译/链接字幕/时间戳原口播/时间戳中文——全部
      // 来自 TokScript 本身（或下面这一次轻量文本翻译），不依赖场景拆解或 Qwen 完整
      // 视频分析。那三步（识别镜头/Qwen视频分析/生成报告）只是为 full/product_doc
      // 两种模式的"视频分析"结果服务，任务安排表这条流程从不读取那份结果，直接跳过
      // 能省下真金白银的一次多模态调用和好几分钟的等待。
      await scheduleTranscriptTranslation();
      await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
      finalTranslation = transcriptZh.trim();
      if (finalTranslation) transcriptZh = finalTranslation;
      await updateVideo(videoId, {
        status: "completed",
        stage: "分析完成",
        progress: 100,
        processing_started_at: null,
        transcript_original: transcript,
        ...(finalTranslation ? { transcript_zh: finalTranslation } : {}),
        error_message: null,
      });
    } else {
    await setStage(videoId, "extracting", "正在识别镜头并提取关键画面", 36);
    const assets = await extractVideoAssets(videoId, relativeVideoPath, signal, {
      light: analysisMode === "product_doc",
    });
    await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
    const currentForCover = await getVideo(videoId, false);
    await updateVideo(videoId, {
      duration_seconds: assets.duration,
      cover_path: currentForCover?.coverPath || assets.scenes[0]?.screenshotPath || null,
    });

    const learningContext = analysisMode === "product_doc" ? null : await getLearningContext(product, videoId);
    const learnedExamples = Array.isArray(learningContext?.similarExamples) ? learningContext.similarExamples.length : 0;
    if (learnedExamples) trace.push(`长期学习：参考 ${learnedExamples} 条相似历史经验`);
    const { prompt, slug: promptSlug, inputs: promptInputs } = await renderAnalysisPrompt({
      product, scenes: assets.scenes, learningContext, mode: analysisMode,
    });
    // Qwen must always receive the locally downloaded, verified A/V file. A
    // TokScript download URL is useful for acquiring the source, but asking
    // Qwen to fetch that temporary URL again is both slower and less reliable,
    // and some provider downloads have contained video without an audio track.
    const qwenVideoPath = await prepareLocalVideoForQwen(
      videoId,
      relativeVideoPath,
      assets.duration,
      signal,
    );
    await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
    const qwenLocalVideoPath = resolveMediaPath(qwenVideoPath);
    const qwenMedia = await validateCompleteVideoForQwen(qwenLocalVideoPath, signal);
    await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
    // Prompt 调试台需要真实输入才能重放测试；诊断表 video_attempts.diagnostics_json 明确禁止
    // 存 prompt/原始输入，所以这里落到单独一张表，且从不影响主流程结果。
    if (expectedAttemptNumber !== undefined) {
      savePromptDebugCapture({
        videoId, attemptNumber: expectedAttemptNumber, templateSlug: promptSlug,
        inputs: promptInputs, qwenVideoPath,
      }).catch(() => undefined);
    }
    const qwenCalls: VideoAttemptCallDiagnostic[] = [];
    // A fixed 4500-token cap silently truncated "full" mode responses for
    // videos with enough shots — each scene needs its own visual/audio
    // description, transcript, scores and tags, so the required output grows
    // with scene count. A truncated response still returns HTTP 200, so this
    // showed up as isUsableAnalysis() rejecting an otherwise-successful call,
    // not as a request error. Scale with scene count instead of a flat cap.
    const qwenMaxTokens = analysisMode === "product_doc"
      ? 2_000
      : Math.min(16_000, 2_500 + assets.scenes.length * 700);
    const runQwenRequest = (requestIndex: 1 | 2) => {
      qwenRequests = requestIndex;
      const clientRequestId = randomUUID();
      const startedAt = new Date().toISOString();
      return analyzeVideoWithQwen({
        prompt,
        localVideoPath: qwenLocalVideoPath,
        purpose: analysisMode,
        maxTokens: qwenMaxTokens,
        signal,
        onDiagnostic: async (diagnostic) => {
          const call = qwenCallDiagnostic(requestIndex, clientRequestId, startedAt, diagnostic);
          const priorIndex = qwenCalls.findIndex((item) => item.requestIndex === requestIndex);
          if (priorIndex >= 0) qwenCalls[priorIndex] = call;
          else qwenCalls.push(call);
          qwenCalls.sort((a, b) => a.requestIndex - b.requestIndex);
          if (expectedAttemptNumber === undefined) return;
          const snapshot: VideoAttemptDiagnostics = {
            schemaVersion: 1,
            provider: "qwen",
            model: diagnostic.model,
            inputMode: "local_base64",
            fileBytes: diagnostic.inputBytes,
            inputSha256: diagnostic.inputSha256,
            encodedBytes: 4 * Math.ceil(diagnostic.inputBytes / 3),
            durationMs: Math.round(qwenMedia.duration * 1_000),
            hasAudio: true,
            videoCodec: qwenMedia.videoCodec,
            audioCodec: qwenMedia.audioCodec,
            calls: [...qwenCalls],
          };
          await updateVideoAttemptDiagnostics(videoId, expectedAttemptNumber, snapshot).catch(() => {
            // Diagnostics are best effort and must never change the analysis.
          });
        },
      });
    };
    await setStage(videoId, "analyzing", "正在观看完整视频并分析画面、声音、钩子和转化结构", 66);

    if (!(await isConfigured("qwen"))) throw new Error("请先配置并启用 Qwen，所有 AI 分析只使用 Qwen");
    let rawAnalysis: Partial<AnalysisResult> = {};
    for (const requestIndex of [1, 2] as const) {
      try {
        const candidate = await runQwenRequest(requestIndex);
        await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
        if (!isUsableAnalysis(candidate, assets.scenes.length, analysisMode)) {
          throw new QwenRequestError("invalid_response", true, "Qwen 未返回完整的视频分析，请重试该链接");
        }
        rawAnalysis = candidate;
        trace.push("Qwen：完整 MP4 画面与原始音轨分析");
        break;
      } catch (error) {
        if (signal?.aborted || requestIndex === 2 || !retryableQwenFailure(error)) throw error;
        trace.push("Qwen：首次请求失败，短暂退避后重试一次");
        await waitForQwenRetry(signal);
        await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
      }
    }
    await setStage(videoId, "analyzing", analysisMode === "product_doc" ? "正在生成轻量视频分析" : "正在生成中文深度报告和复拍脚本", 82);

    const analysis = normalizeAnalysis(rawAnalysis, assets.scenes.length, trace, transcriptZh);
    const keyShotIndexes = new Set<number>();
    analysis.scenes.forEach((scene) => {
      if (scene.tags.some((tag) => /钩子|爆点|hook|viral/i.test(tag)) || /钩子|爆点/.test(scene.role)) keyShotIndexes.add(scene.shotIndex);
    });
    if (!keyShotIndexes.size && analysis.scenes.length) {
      keyShotIndexes.add(1);
      const best = [...analysis.scenes].sort((a, b) => b.importance - a.importance)[0];
      if (best) keyShotIndexes.add(best.shotIndex);
    }

    const sceneRows = [];
    for (const base of assets.scenes) {
      signal?.throwIfAborted();
      const result = analysis.scenes[base.shotIndex - 1];
      let clipPath: string | null = null;
      if (analysisMode !== "product_doc" && keyShotIndexes.has(base.shotIndex) && keyShotIndexes.size <= 6) {
        clipPath = await createSceneClip(videoId, relativeVideoPath, base.startSeconds, base.endSeconds, `shot-${base.shotIndex}`, signal).catch((error) => {
          if (signal?.aborted) throw error;
          return null;
        });
      }
      sceneRows.push({
        shotIndex: base.shotIndex,
        startSeconds: base.startSeconds,
        endSeconds: base.endSeconds,
        screenshotPath: base.screenshotPath,
        clipPath,
        role: result.role,
        visualDescription: result.visual,
        audioDescription: result.audio,
        transcriptOriginal: result.originalText || transcriptForScene(base, transcriptSegments, ""),
        translationZh: result.translationZh,
        strengths: result.good,
        weaknesses: result.improve,
        importance: result.importance,
        scoreTraffic: result.scoreTraffic,
        scoreConversion: result.scoreConversion,
        scoreClarity: result.scoreClarity,
        scoreAesthetic: result.scoreAesthetic,
        scoreLighting: result.scoreLighting,
        scoreProduct: result.scoreProduct,
        tags: result.tags,
      });
    }
    await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
    await replaceScenes(videoId, sceneRows);
    await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
    const latestBeforeCompletion = await getVideo(videoId, false);
    finalTranslation = String(latestBeforeCompletion?.transcriptZh || transcriptZh).trim();
    analysis.translationZh = finalTranslation;
    if (finalTranslation) transcriptZh = finalTranslation;
    await updateVideo(videoId, {
      status: "completed",
      stage: "分析完成",
      progress: 100,
      processing_started_at: null,
      score_traffic: analysis.scores.traffic,
      score_conversion: analysis.scores.conversion,
      score_visual: analysis.scores.visual,
      score_product: analysis.scores.product,
      score_audio: analysis.scores.audio,
      score_rhythm: analysis.scores.rhythm,
      summary: analysis.summary,
      hook_summary: analysis.hook.description,
      transcript_original: transcript || analysis.scenes.map((scene) => scene.originalText).filter(Boolean).join(" "),
      ...(finalTranslation ? { transcript_zh: finalTranslation } : {}),
      analysis_json: JSON.stringify(analysis),
      error_message: null,
    });
    }
    // Push the finished result into the matching row immediately. The periodic
    // document scan remains only a safety net and is not the normal delivery
    // path for newly completed videos.
    await deliverProductDocument();
    await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
    // A video created by a Feishu Base automation carries a pending job. Push
    // the compact result back to that exact record after analysis completes.
    void scheduleTranscriptTranslation().then(() => import("@/lib/feishu/automation"))
      .then(({ completeFeishuAutomation }) => completeFeishuAutomation(videoId))
      .catch(() => undefined);
    emitVideoProgress(videoId);
    try {
      await learnFromVideo(videoId);
    } catch {
      // 学习档案失败不能影响已经完成的视频报告。
    }
  } catch (error) {
    const abortReason = signal?.aborted && signal.reason instanceof Error ? signal.reason : null;
    const timedOut = abortReason?.name === "VideoTaskTimeoutError";
    // The queue owns hard-timeout finalization. Keeping that path in one place
    // prevents analyzeVideo and the queue fallback from both publishing the
    // same stopped event when an abort-aware dependency exits quickly.
    if (!timedOut && (await ownsVideoAttempt(videoId, expectedAttemptNumber))) {
      // The two-request loop above is the entire automatic Qwen retry budget.
      // Never re-enqueue the whole task after exhausting it; manual retry is
      // still a new execution, and Feishu delivery retries remain independent.
      await updateVideo(videoId, {
        status: signal?.aborted ? "stopped" : "failed",
        stage: signal?.aborted ? "已停止" : "分析失败",
        error_message: signal?.aborted ? null : userFacingAnalysisError(error, qwenRequests),
        processing_started_at: null,
      });
      void deliverProductDocument();
      void scheduleTranscriptTranslation().then(() => import("@/lib/feishu/automation"))
        .then(({ completeFeishuAutomation }) => completeFeishuAutomation(videoId))
        .catch(() => undefined);
      emitVideoProgress(videoId);
    }
    throw error;
  }
}
