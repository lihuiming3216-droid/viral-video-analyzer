import "server-only";

import {
  finishOpenVideoAttempts,
  finishVideoAttempt,
  getPendingVideoIds,
  getStaleProcessingVideoIds,
  getVideo,
  replaceScenes,
  startVideoAttempt,
  updateVideo,
} from "@/lib/database";
import { analyzeVideo } from "@/lib/analysis";
import { emitVideoProgress } from "@/lib/video-events";
import { deleteVideoAttemptCache } from "@/lib/video-processing";

const MAX_CONCURRENT_VIDEOS = 2;
const VIDEO_TASK_TIMEOUT_MS = 30 * 60 * 1_000;
const VIDEO_TASK_TIMEOUT_MESSAGE = "处理超过30分钟，已自动停止并清理缓存";

type QueueGlobal = typeof globalThis & {
  __viralQueue?: Set<string>;
  __viralQueueScheduling?: boolean;
  __viralQueueActiveIds?: Set<string>;
  __viralQueueControllers?: Map<string, AbortController>;
};

const state = globalThis as QueueGlobal;
state.__viralQueue ||= new Set<string>();
state.__viralQueueScheduling ||= false;
state.__viralQueueActiveIds ||= new Set<string>();
state.__viralQueueControllers ||= new Map<string, AbortController>();

function timeoutError() {
  const error = new Error(VIDEO_TASK_TIMEOUT_MESSAGE);
  error.name = "VideoTaskTimeoutError";
  return error;
}

function cleanTimedOutVideo(videoId: string) {
  const video = getVideo(videoId, false);
  if (!video) return;
  const preservedUpload = video.sourceType === "upload" ? video.originalPath : null;
  deleteVideoAttemptCache(videoId, preservedUpload);
  replaceScenes(videoId, []);
  updateVideo(videoId, {
    cover_path: null,
    ...(video.sourceType === "tiktok" ? { original_path: null } : {}),
  });
}

function safeVideo(videoId: string) {
  try {
    return getVideo(videoId, false);
  } catch {
    return null;
  }
}

function settleAttempt(
  attempt: ReturnType<typeof startVideoAttempt> | null,
  videoId: string,
  status: "completed" | "failed" | "stopped",
  errorMessage: string,
) {
  if (!attempt) return;
  // A one-off SQLite/filesystem fault must not turn into an unhandled promise
  // rejection or leave the worker slot occupied. Retry the durable write once;
  // terminal failed/stopped attempts also have a broad fallback for old rows.
  for (let retry = 0; retry < 2; retry += 1) {
    try {
      finishVideoAttempt(attempt.attemptId, videoId, status, errorMessage);
      return;
    } catch {
      // Retry once below.
    }
  }
  if (status !== "completed") {
    try {
      finishOpenVideoAttempts(videoId, status, errorMessage);
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
  let attempt: ReturnType<typeof startVideoAttempt> | null = null;
  const reason = timeoutError();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    attempt = startVideoAttempt(videoId);
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
    const latest = safeVideo(videoId);
    const timedOut = controller.signal.reason === reason;
    if (latest && latest.status !== "completed" && timedOut) {
      updateVideo(videoId, {
        status: "stopped",
        stage: "处理超时",
        error_message: VIDEO_TASK_TIMEOUT_MESSAGE,
        processing_started_at: null,
      });
    } else if (latest && !["failed", "stopped", "completed"].includes(latest.status)) {
      const message = error instanceof Error ? error.message : "分析失败";
      updateVideo(videoId, {
        status: controller.signal.aborted ? "stopped" : "failed",
        stage: controller.signal.aborted ? "已停止" : "分析失败",
        error_message: controller.signal.aborted ? null : message,
        processing_started_at: null,
      });
    }
  } finally {
    if (timer) clearTimeout(timer);
    let latest = safeVideo(videoId);
    if (controller.signal.reason === reason && latest?.status !== "completed") {
      let cleanupFailed = false;
      try {
        cleanTimedOutVideo(videoId);
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) {
        try {
          updateVideo(videoId, {
            status: "stopped",
            stage: "处理超时",
            error_message: `${VIDEO_TASK_TIMEOUT_MESSAGE}；部分缓存清理失败，请人工检查`,
            processing_started_at: null,
          });
        } catch {
          // The queue must still release this worker slot.
        }
      }
      latest = safeVideo(videoId);
    }
    const status = latest?.status === "completed"
      ? "completed"
      : latest?.status === "stopped"
        ? "stopped"
        : "failed";
    settleAttempt(attempt, videoId, status, latest?.errorMessage || "");
    if (controller.signal.reason === reason) {
      try {
        // The hard-timeout path may win while analyzeVideo is permanently
        // stuck and therefore can never emit its own terminal event. This keeps
        // Feishu bot cards and other progress consumers from staying active.
        emitVideoProgress(videoId);
      } catch {
        // Delivery remains best-effort; the durable terminal row is authoritative.
      }
    }
    state.__viralQueueControllers!.delete(videoId);
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

export function enqueueVideos(ids: string[]) {
  ids.forEach((id) => {
    if (state.__viralQueueActiveIds!.has(id)) return;
    updateVideo(id, { status: "queued", stage: "已加入队列", progress: 2, error_message: null });
    emitVideoProgress(id);
    state.__viralQueue!.add(id);
  });
  schedule();
}

export function resumePendingVideos() {
  const cutoff = new Date(Date.now() - VIDEO_TASK_TIMEOUT_MS).toISOString();
  const staleIds = new Set(getStaleProcessingVideoIds(cutoff));
  staleIds.forEach((id) => {
    let message = VIDEO_TASK_TIMEOUT_MESSAGE;
    try {
      cleanTimedOutVideo(id);
    } catch {
      message += "；部分缓存清理失败，请人工检查";
    }
    try {
      updateVideo(id, {
        status: "stopped",
        stage: "处理超时",
        progress: 0,
        error_message: message,
        processing_started_at: null,
      });
    } catch {
      // Continue closing the durable attempt and the remaining stale tasks.
    }
    try {
      finishOpenVideoAttempts(id, "stopped", message);
    } catch {
      // Startup must not fail because one historical attempt log is unavailable.
    }
    try {
      emitVideoProgress(id);
    } catch {
      // Progress delivery is best-effort.
    }
  });
  getPendingVideoIds().forEach((id) => {
    if (!staleIds.has(id) && !state.__viralQueueActiveIds!.has(id)) state.__viralQueue!.add(id);
  });
  schedule();
}

export function stopVideo(id: string) {
  const removedFromQueue = state.__viralQueue!.delete(id);
  const controller = state.__viralQueueControllers!.get(id);
  if (controller && !controller.signal.aborted) controller.abort(new Error("用户停止分析"));
  updateVideo(id, { status: "stopped", stage: "已停止", error_message: null, processing_started_at: null });
  emitVideoProgress(id);
  return Boolean(removedFromQueue || controller || state.__viralQueueActiveIds!.has(id));
}
