import "server-only";

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { getPool } from "@/lib/db/pool";
import { execute, queryRows } from "@/lib/db/query";
import { getMediaRoot, resolveMediaPath } from "@/lib/video-processing";

/**
 * Local TikTok originals are a download cache: the file a task produced is
 * already attached in Feishu, and a retry downloads it again. Keep them for
 * MEDIA_RETENTION_DAYS (default 30, 0 disables) and then free the disk.
 *
 * Only finished TikTok tasks with no pending Feishu delivery are pruned, and
 * the database stops pointing at the file before it is deleted, so a later
 * retry or handcard sync never tries to upload a missing file.
 */
const TERMINAL = ["completed", "failed", "stopped"];
const BATCH = 200;

type RetentionGlobal = typeof globalThis & { __mediaRetentionTimer?: NodeJS.Timeout; __mediaRetentionRunning?: boolean };
const state = globalThis as RetentionGlobal;

export function mediaRetentionDays() {
  const configured = Number(process.env.MEDIA_RETENTION_DAYS ?? 30);
  return Number.isFinite(configured) && configured >= 0 ? configured : 30;
}

export async function pruneExpiredMedia(options: { now?: Date; days?: number } = {}) {
  const days = options.days ?? mediaRetentionDays();
  if (!days) return { pruned: 0 };
  const cutoff = new Date((options.now ?? new Date()).getTime() - days * 86_400_000).toISOString();
  const pool = await getPool();
  const mediaRoot = path.resolve(getMediaRoot());
  let pruned = 0;
  for (;;) {
    const candidates = await queryRows(pool, `
      SELECT v.id, v.original_path FROM videos v
      WHERE v.source_type='tiktok' AND v.status IN (?, ?, ?) AND v.updated_at < ?
        AND v.original_path IS NOT NULL AND v.original_path <> ''
        AND NOT EXISTS (SELECT 1 FROM feishu_automation_jobs j WHERE j.video_id=v.id)
      ORDER BY v.updated_at LIMIT ?`, [...TERMINAL, cutoff, BATCH]);
    if (!candidates.length) break;
    for (const row of candidates) {
      const id = String(row.id);
      const released = await execute(pool,
        `UPDATE videos SET original_path=NULL, cover_path=NULL
          WHERE id=? AND original_path=? AND status IN (?, ?, ?)`,
        [id, row.original_path, ...TERMINAL]);
      if (released.affectedRows !== 1) continue;
      const directory = resolveMediaPath(id);
      // Never leave the media root, and only remove a task's own folder.
      if (path.dirname(directory) === mediaRoot && path.basename(directory) === id && existsSync(directory)) {
        rmSync(directory, { recursive: true, force: true });
      }
      pruned += 1;
    }
    if (candidates.length < BATCH) break;
  }
  return { pruned };
}

async function runPass() {
  if (state.__mediaRetentionRunning) return;
  state.__mediaRetentionRunning = true;
  try {
    const { pruned } = await pruneExpiredMedia();
    if (pruned) console.info(`[media-retention] 已清理 ${pruned} 个超过 ${mediaRetentionDays()} 天的本机原片`);
  } catch (error) {
    console.warn(`[media-retention] 清理失败：${error instanceof Error ? error.message : "未知错误"}`);
  } finally {
    state.__mediaRetentionRunning = false;
  }
}

/** First pass 10 minutes after start, then every 6 hours. */
export function startMediaRetentionWorker() {
  if (state.__mediaRetentionTimer) return;
  const first = setTimeout(() => {
    void runPass();
    state.__mediaRetentionTimer = setInterval(() => void runPass(), 6 * 60 * 60 * 1_000);
    state.__mediaRetentionTimer.unref?.();
  }, 10 * 60 * 1_000);
  first.unref?.();
  state.__mediaRetentionTimer = first;
}
