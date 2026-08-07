type VideoEventGlobal = typeof globalThis & {
  __videoProgressHandler?: ((videoId: string) => Promise<void> | void) | null;
};

const state = globalThis as VideoEventGlobal;
state.__videoProgressHandler ||= null;

export function setVideoProgressHandler(handler: (videoId: string) => Promise<void> | void) {
  state.__videoProgressHandler = handler;
}

export function emitVideoProgress(videoId: string) {
  try {
    void state.__videoProgressHandler?.(videoId);
  } catch {
    // 消息通知失败不能影响本地视频分析。
  }
}
