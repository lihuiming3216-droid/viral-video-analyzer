import "server-only";

import {
  getProduct,
  getVideo,
  updateVideo,
  recordVideoStage,
} from "@/lib/database";
import { translateTranscriptWithQwen } from "@/lib/providers/qwen";
import { fetchTikTok, tokScriptTranscriptFailure } from "@/lib/providers/tokscript";
import { downloadTikTokVideoWithFallback } from "@/lib/tiktok-video-download";
import { emitVideoProgress } from "@/lib/video-events";
import { downloadMedia } from "@/lib/video-processing";

async function setStage(id: string, status: string, stage: string, progress: number) {
  await updateVideo(id, { status, stage, progress, error_message: null });
  emitVideoProgress(id);
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

function userFacingAnalysisError(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  const qwenFailure = qwenRequestFailure(error);
  if (qwenFailure) return message;
  if (error instanceof Error && error.name === "TokScriptRetryableError") return message;
  if (transientNetworkFailure(error)) {
    if (/TokScript/i.test(message)) return "TokScript 获取视频超时，系统已自动重试一次";
    return "视频处理网络超时，系统已自动重试一次";
  }
  return message;
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
  const video = await getVideo(videoId, false);
  if (!video || video.status === "stopped") throw new Error("视频任务已停止");
  if (expectedAttemptNumber !== undefined && video.attemptCount !== expectedAttemptNumber) throw new Error("分析任务已被新的执行替代");
}

export async function analyzeVideo(videoId: string, signal?: AbortSignal, expectedAttemptNumber?: number) {
  const initial = await getVideo(videoId);
  if (!initial) throw new Error("视频不存在");
  const product = await getProduct(initial.productId);
  if (!product) throw new Error("产品档案不存在");
  const analysisMode = initial.analysisMode;
  const stageAttempt = expectedAttemptNumber ?? initial.attemptCount ?? 0;
  const recordStage = (stage: Parameters<typeof recordVideoStage>[2], state: Parameters<typeof recordVideoStage>[3], error = "") =>
    recordVideoStage(videoId, stageAttempt, stage, state, error);
  const trace: string[] = [];
  let transcript = initial.transcriptOriginal;
  let transcriptZh = String(initial.transcriptZh || "");
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
      await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
      await recordStage("translation", "running");
      const translated = await translateTranscriptWithQwen({ transcript: transcriptForTranslation, signal });
      await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
      const latest = await getVideo(videoId, false);
      if (!translated.trim()) throw new Error("未返回有效中文翻译");
      if (!latest || latest.status === "stopped") return;
      transcriptZh = String(latest.transcriptZh || "").trim() || translated.trim();
      if (!latest.transcriptZh?.trim()) await updateVideo(videoId, { transcript_zh: transcriptZh });
      await recordStage("translation", "completed");
      emitVideoProgress(videoId);
      void deliverProductDocument();
      void import("@/lib/feishu/automation")
        .then(({ deliverEarlyTranscript }) => deliverEarlyTranscript(videoId))
        .catch(() => undefined);
    })().catch(async () => {
      // Keep the failure durable without changing the video-analysis result or
      // copying an untrusted provider response into user-visible diagnostics.
      await recordStage("translation", "failed", signal?.aborted ? "翻译已停止，其他已完成结果保留" : "中文翻译失败，原口播及其他结果保留").catch(() => undefined);
    });
    return translationTask;
  };
  let textDelivered = false;
  const deliverTextEarly = () => {
    if (textDelivered) return;
    textDelivered = true;
    void import("@/lib/feishu/automation")
      .then(({ deliverEarlyTranscript }) => deliverEarlyTranscript(videoId))
      .catch(() => undefined);
  };
  try {
    await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
    let relativeVideoPath = initial.originalPath;
    let transcriptSegments = initial.transcriptSegments || [];

    const storedTokScriptFailure = initial.sourceType === "tiktok"
      && tokScriptTranscriptFailure(transcript);
    const needsTokScriptRefresh = initial.sourceType === "tiktok"
      && (!relativeVideoPath || !transcript.trim() || storedTokScriptFailure);
    if (needsTokScriptRefresh) {
      await setStage(videoId, "downloading", "正在通过 TokScript 获取视频和公开数据", 12);
      const tokOptions = {
        allowPartial: true,
        includeTranscript: !transcript.trim() || Boolean(storedTokScriptFailure),
        includeDownload: !relativeVideoPath,
        // Covers were only shown by the retired web workspace; skipping the
        // sequential cover call returns the transcript sooner.
        includeCover: false,
        // One bad/expired document link must never block every later row.
        timeoutMs: analysisMode === "product_doc" ? 90_000 : 180_000,
      };
      await recordStage("transcript", tokOptions.includeTranscript ? "running" : "completed");
      await recordStage("download", relativeVideoPath ? "completed" : "running");
      const tok = await withOneNetworkRetry(
        () => fetchTikTok(initial.sourceUrl || "", signal, tokOptions),
        () => { void setStage(videoId, "downloading", "获取视频信息较慢，正在自动重试", 14); },
        signal,
      );
      await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
      // File acquisition may fall back independently of the saved transcript.
      const remoteVideoUrl = tok.downloadUrl || "";
      transcript = tok.transcript || (storedTokScriptFailure ? "" : transcript);
      transcriptZh = tok.transcriptZh || transcriptZh;
      if (tok.transcript) transcriptSegments = tok.segments;
      await recordStage("transcript", transcript.trim() ? "completed" : "failed", tok.transcriptError || (transcript.trim() ? "" : "TokScript 未返回有效口播"));
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
      // Text first: write 原口播 (and any TokScript translation) to Feishu now,
      // without waiting for the media download or the Qwen translation.
      if (transcript.trim()) deliverTextEarly();
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
        await updateVideo(videoId, { original_path: relativeVideoPath });
        await recordStage("download", "completed");
      }
    } else if (initial.sourceType === "tiktok") {
      trace.push("本地缓存：复用已保存的 TikTok 原片和文案");
      await recordStage("transcript", "completed");
      await recordStage("download", "completed");
    }

    // Cached reuse (e.g. a retried attempt) skips TokScript above; deliver the
    // stored text here. Best-effort: completeFeishuAutomation() stays the
    // durable, terminal delivery.
    if (transcript.trim()) {
      deliverTextEarly();
      void scheduleTranscriptTranslation();
    }
    // Upload the original as soon as it exists, independently of analysis.
    void deliverProductDocument();

    if (!relativeVideoPath) throw new Error("没有可用的视频文件");
    if (transcriptZh.trim()) await recordStage("translation", "completed");
    else if (!transcript.trim()) await recordStage("translation", "skipped", "尚无可翻译的有效口播，不将提取失败当作无口播");

    // Only file + speech + translation are produced. Full multimodal video
    // analysis (and its scenes/report) was retired on 2026-10-31.
    await recordStage("analysis", "skipped");
    await scheduleTranscriptTranslation();
    await assertVideoAttempt(videoId, signal, expectedAttemptNumber);
    const finalTranslation = transcriptZh.trim();
    await updateVideo(videoId, {
      status: "completed",
      stage: transcript.trim() && finalTranslation ? "处理完成" : "部分完成，请查看各环节结果",
      progress: 100,
      processing_started_at: null,
      transcript_original: transcript,
      ...(finalTranslation ? { transcript_zh: finalTranslation } : {}),
      error_message: null,
    });
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
  } catch (error) {
    const abortReason = signal?.aborted && signal.reason instanceof Error ? signal.reason : null;
    // Recovery alone publishes the interruption after an execution lock is lost.
    if (abortReason?.name === "VideoExecutionLostError") throw error;
    await recordStage("download", "failed", signal?.aborted ? "该环节已停止" : "视频获取未完成，已取得的口播和翻译保留").catch(() => undefined);
    if (!transcript.trim()) {
      await recordStage("transcript", "failed", "口播提取未完成，不应判定为无口播").catch(() => undefined);
      await recordStage("translation", "skipped", "尚无可翻译的有效口播").catch(() => undefined);
    }
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
        stage: signal?.aborted ? "已停止" : "处理失败",
        error_message: signal?.aborted ? null : userFacingAnalysisError(error),
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
