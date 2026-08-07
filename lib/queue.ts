import "server-only";

import { getPendingVideoIds, updateVideo } from "@/lib/database";
import { analyzeVideo } from "@/lib/analysis";
import { emitVideoProgress } from "@/lib/video-events";

type QueueGlobal = typeof globalThis & {
  __viralQueue?: Set<string>;
  __viralQueueRunning?: boolean;
  __viralQueueActiveId?: string | null;
  __viralQueueControllers?: Map<string, AbortController>;
};

const state = globalThis as QueueGlobal;
state.__viralQueue ||= new Set<string>();
state.__viralQueueRunning ||= false;
state.__viralQueueActiveId ||= null;
state.__viralQueueControllers ||= new Map<string, AbortController>();

async function drain() {
  if (state.__viralQueueRunning) return;
  state.__viralQueueRunning = true;
  try {
    while (state.__viralQueue?.size) {
      const id = state.__viralQueue.values().next().value as string;
      state.__viralQueue.delete(id);
      state.__viralQueueActiveId = id;
      const controller = new AbortController();
      state.__viralQueueControllers!.set(id, controller);
      try {
        await analyzeVideo(id, controller.signal);
      } catch {
        // The video row already carries a safe, user-facing error message.
      } finally {
        state.__viralQueueControllers!.delete(id);
        state.__viralQueueActiveId = null;
      }
    }
  } finally {
    state.__viralQueueRunning = false;
  }
}

export function enqueueVideos(ids: string[]) {
  ids.forEach((id) => {
    updateVideo(id, { status: "queued", stage: "已加入队列", progress: 2, error_message: null });
    emitVideoProgress(id);
    if (state.__viralQueueActiveId !== id) state.__viralQueue?.add(id);
  });
  void drain();
}

export function resumePendingVideos() {
  getPendingVideoIds().forEach((id) => {
    if (state.__viralQueueActiveId !== id) state.__viralQueue?.add(id);
  });
  void drain();
}

export function stopVideo(id: string) {
  const removedFromQueue = state.__viralQueue?.delete(id) || false;
  const controller = state.__viralQueueControllers?.get(id);
  if (controller && !controller.signal.aborted) controller.abort(new Error("用户停止分析"));
  updateVideo(id, { status: "stopped", stage: "已停止", error_message: null });
  emitVideoProgress(id);
  return Boolean(removedFromQueue || controller || state.__viralQueueActiveId === id);
}
