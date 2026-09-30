import "server-only";

import {
  finishOpenVideoAttempts,
  finishVideoAttempt,
  getPendingVideoIds,
  getVideo,
  prepareVideoForQueue,
  replaceScenes,
  startVideoAttempt,
  updateVideo,
} from "@/lib/database";
import { analyzeVideo } from "@/lib/analysis";
import { emitVideoProgress } from "@/lib/video-events";
import { deleteVideoAttemptCache } from "@/lib/video-processing";
import { tryAcquireVideoExecution, type VideoExecutionLease } from "@/lib/video-execution";

const MAX_CONCURRENT_VIDEOS = 2;
const VIDEO_TASK_TIMEOUT_MS = 30 * 60 * 1_000;
const VIDEO_TASK_TIMEOUT_MESSAGE = "处理超过30分钟，已自动停止并清理缓存";

type QueueGlobal = typeof globalThis & {
  __viralQueue?: Set<string>;
  __viralQueueScheduling?: boolean;
  __viralQueueActiveIds?: Set<string>;
  __viralQueueControllers?: Map<string, AbortController>;
  __viralQueueRecoveryTimer?: ReturnType<typeof setInterval>;
  __viralQueueRecovering?: boolean;
  __viralQueueDeferred?: Set<string>;
};

const state = globalThis as QueueGlobal;
state.__viralQueue ||= new Set<string>();
state.__viralQueueScheduling ||= false;
state.__viralQueueActiveIds ||= new Set<string>();
state.__viralQueueControllers ||= new Map<string, AbortController>();
state.__viralQueueDeferred ||= new Set<string>();

function timeoutError() {
  const error = new Error(VIDEO_TASK_TIMEOUT_MESSAGE);
  error.name = "VideoTaskTimeoutError";
  return error;
}

async function cleanTimedOutVideo(videoId: string) {
  const video = await getVideo(videoId, false);
  if (!video) return;
  const preservedUpload = video.sourceType === "upload" ? video.originalPath : null;
  deleteVideoAttemptCache(videoId, preservedUpload);
  await replaceScenes(videoId, []);
  await updateVideo(videoId, {
    cover_path: null,
    ...(video.sourceType === "tiktok" ? { original_path: null } : {}),
  });
}

async function safeVideo(videoId: string) {
  try {
    return await getVideo(videoId, false);
  } catch {
    return null;
  }
}

async function settleAttempt(
  attempt: Awaited<ReturnType<typeof startVideoAttempt>> | null,
  videoId: string,
  status: "completed" | "failed" | "stopped",
  errorMessage: string,
) {
  if (!attempt) return;
  // A one-off MySQL/filesystem fault must not turn into an unhandled promise
  // rejection or leave the worker slot occupied. Retry the durable write once;
  // terminal failed/stopped attempts also have a broad fallback for old rows.
  for (let retry = 0; retry < 2; retry += 1) {
    try {
      await finishVideoAttempt(attempt.attemptId, videoId, status, errorMessage);
      return;
    } catch {
      // Retry once below.
    }
  }
  if (status !== "completed") {
    try {
      await finishOpenVideoAttempts(videoId, status, errorMessage);
    } catch {
      // The video row is already terminal; a later maintenance pass can repair
      // an unavailable attempt log without blocking the queue.
    }
  }
}

function waitForAbort(signal: AbortSignal) {
  let remove: () => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      const reason = signal.reason instanceof Error ? signal.reason : new Error("视频分析已停止");
      reject(reason);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  return { promise, remove };
}

async function runVideo(videoId: string) {
  const controller = new AbortController();
  state.__viralQueueControllers!.set(videoId, controller);
  let attempt: Awaited<ReturnType<typeof startVideoAttempt>> | null = null;
  const reason = timeoutError();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lease: VideoExecutionLease | null = null;
  try {
    lease = await tryAcquireVideoExecution(videoId, controller);
    if (!lease) { state.__viralQueueDeferred!.add(videoId); return; }
    const current = await getVideo(videoId, false);
    if (!current) return;
    if (["completed", "failed", "stopped", "waiting"].includes(current.status)) {
      if (current.processingStartedAt && current.status !== "waiting") {
        await finishOpenVideoAttempts(videoId, current.status as "completed" | "failed" | "stopped", current.errorMessage || "");
        await updateVideo(videoId, { processing_started_at: null });
      }
      return;
    }
    if (current.processingStartedAt || current.status !== "queued") {
      // A session lock is free but execution had begun: the former process died.
      // It may have already paid for a provider request. Never blindly replay it.
      const started = Date.parse(current.processingStartedAt || current.updatedAt);
      const expired = Number.isFinite(started) && Date.now() - started >= VIDEO_TASK_TIMEOUT_MS;
      let message = expired ? VIDEO_TASK_TIMEOUT_MESSAGE : "服务中断，已停止自动续跑；供应商请求可能已产生，请核查已保存结果后再主动重试";
      if (expired) try { await cleanTimedOutVideo(videoId); } catch { message += "；部分缓存清理失败，请人工检查"; }
      if (!lease.valid()) return;
      await updateVideo(videoId, { status: "stopped", stage: expired ? "处理超时" : "中断待核查", error_message: message, processing_started_at: null });
      await finishOpenVideoAttempts(videoId, "stopped", message);
      emitVideoProgress(videoId);
      return;
    }
    controller.signal.throwIfAborted();
    attempt = await startVideoAttempt(videoId);
    const aborted = waitForAbort(controller.signal);
    timer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(reason);
    }, VIDEO_TASK_TIMEOUT_MS);
    timer.unref?.();
    const analysis = analyzeVideo(videoId, controller.signal, attempt.attemptNumber);
    // Promise.race releases the worker even if a dependency ignores abort. The
    // losing analysis promise remains observed so a late rejection is harmless.
    void analysis.catch(() => undefined);
    try {
      await Promise.race([analysis, aborted.promise]);
    } finally {
      aborted.remove();
    }
  } catch (error) {
    if (!lease?.valid()) { state.__viralQueueDeferred!.add(videoId); return; }
    const latest = await safeVideo(videoId);
    const timedOut = controller.signal.reason === reason;
    if (latest && latest.status !== "completed" && timedOut) {
      await updateVideo(videoId, {
        status: "stopped",
        stage: "处理超时",
        error_message: VIDEO_TASK_TIMEOUT_MESSAGE,
        processing_started_at: null,
      });
    } else if (latest && !["failed", "stopped", "completed"].includes(latest.status)) {
      const message = error instanceof Error ? error.message : "分析失败";
      await updateVideo(videoId, {
        status: controller.signal.aborted ? "stopped" : "failed",
        stage: controller.signal.aborted ? "已停止" : "分析失败",
        error_message: controller.signal.aborted ? null : message,
        processing_started_at: null,
      });
    }
  } finally {
    if (timer) clearTimeout(timer);
    try {
      if (attempt && lease?.valid()) {
        let latest = await safeVideo(videoId);
        if (controller.signal.reason === reason && latest?.status !== "completed") {
          let cleanupFailed = false;
          try { await cleanTimedOutVideo(videoId); } catch { cleanupFailed = true; }
          if (cleanupFailed) {
            try {
              await updateVideo(videoId, {
                status: "stopped", stage: "处理超时",
                error_message: `${VIDEO_TASK_TIMEOUT_MESSAGE}；部分缓存清理失败，请人工检查`,
                processing_started_at: null,
              });
            } catch { /* The queue must still release this worker slot. */ }
          }
          latest = await safeVideo(videoId);
        }
        const status = latest?.status === "completed" ? "completed" : latest?.status === "stopped" ? "stopped" : "failed";
        await settleAttempt(attempt, videoId, status, latest?.errorMessage || "");
        if (controller.signal.reason === reason) {
          try {
            // Analysis can ignore abort forever; publish the durable timeout.
            emitVideoProgress(videoId);
          } catch { /* Delivery is best-effort; the terminal row is authoritative. */ }
        }
      }
    } finally {
      await lease?.release();
      state.__viralQueueControllers!.delete(videoId);
    }
  }
}

function schedule() {
  if (state.__viralQueueScheduling) return;
  state.__viralQueueScheduling = true;
  try {
    while (state.__viralQueueActiveIds!.size < MAX_CONCURRENT_VIDEOS && state.__viralQueue!.size) {
      const videoId = state.__viralQueue!.values().next().value as string;
      state.__viralQueue!.delete(videoId);
      if (state.__viralQueueActiveIds!.has(videoId)) continue;
      state.__viralQueueActiveIds!.add(videoId);
      void runVideo(videoId)
        .catch(() => undefined)
        .finally(() => {
          state.__viralQueueActiveIds!.delete(videoId);
          schedule();
        })
        .catch(() => undefined);
    }
  } finally {
    state.__viralQueueScheduling = false;
  }
}

export async function enqueueVideos(ids: string[], options: { restart?: boolean } = {}) {
  for (const id of ids) {
    if (state.__viralQueueActiveIds!.has(id)) continue;
    if (!await prepareVideoForQueue(id, Boolean(options.restart))) continue;
    emitVideoProgress(id);
    state.__viralQueue!.add(id);
  }
  schedule();
}

export async function resumePendingVideos(inboxOnly = false) {
  if (state.__viralQueueRecovering) return;
  state.__viralQueueRecovering = true;
  try {
    const pending = [...await getPendingVideoIds(inboxOnly), ...state.__viralQueueDeferred!];
    state.__viralQueueDeferred!.clear();
    pending.forEach((id) => {
      if (!state.__viralQueueActiveIds!.has(id)) state.__viralQueue!.add(id);
    });
    schedule();
  } finally { state.__viralQueueRecovering = false; }
}

/** DB-only discovery; periodic runs admit only atomically bound inbox videos
 * and known queued tasks deferred by locks. Legacy multi-step creation must
 * finish its binding before enqueueing, not be preempted by this new timer. */
export function startVideoQueueWorker() {
  if (state.__viralQueueRecoveryTimer) return;
  void resumePendingVideos().catch(() => undefined);
  state.__viralQueueRecoveryTimer = setInterval(() => void resumePendingVideos(true).catch(() => undefined), 10_000);
  state.__viralQueueRecoveryTimer.unref?.();
}

export async function stopVideo(id: string) {
  state.__viralQueueDeferred!.delete(id);
  const removedFromQueue = state.__viralQueue!.delete(id);
  const controller = state.__viralQueueControllers!.get(id);
  if (controller && !controller.signal.aborted) controller.abort(new Error("用户停止分析"));
  // Keep the active-attempt marker until its owner has really stopped. This
  // prevents a quick remote stop/retry from hiding the stop from its heartbeat.
  await updateVideo(id, { status: "stopped", stage: "已停止", error_message: null });
  emitVideoProgress(id);
  return Boolean(removedFromQueue || controller || state.__viralQueueActiveIds!.has(id));
}
