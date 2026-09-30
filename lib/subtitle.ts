import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatTime } from "@/lib/json-utils";
import { translateSegmentsWithQwen } from "@/lib/providers/qwen";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

function srtTimestamp(seconds: number) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** Bilingual SRT: each cue shows the original line, then its Chinese translation. */
export function buildBilingualSrt(segments: TranscriptSegment[], translations: string[]) {
  return segments.map((segment, index) => {
    const lines = [segment.text.trim(), translations[index]?.trim()].filter(Boolean);
    return [
      String(index + 1),
      `${srtTimestamp(segment.start)} --> ${srtTimestamp(segment.end)}`,
      ...lines,
    ].join("\n");
  }).join("\n\n");
}

/**
 * Plain-text timeline: one "[MM:SS–MM:SS] text" line per segment, using the
 * same MM:SS convention as scene time ranges elsewhere (lib/json-utils.ts's
 * formatTime) rather than inventing a separate format. TokScript's segments
 * are whole-second granularity — there is no per-word timestamp source (see
 * get_tiktok_transcript's schema: `format` only toggles json/text output
 * shape, not timestamp precision), so this is the finest granularity
 * available, matching what 音频字幕/双语SRT already uses.
 */
export function buildTimestampedText(segments: TranscriptSegment[], texts: string[]) {
  return segments
    .map((segment, index) => `[${formatTime(segment.start)}–${formatTime(segment.end)}] ${(texts[index] || segment.text).trim()}`)
    .join("\n");
}

/**
 * Translate the already-extracted TokScript segments and write a bilingual SRT
 * to a throwaway temp file (caller uploads it, then discards). Returns null
 * when there is nothing to subtitle (no segments) rather than an empty file.
 * Also returns the per-segment translations so the caller can reuse them for
 * the plain-text timestamped fields without a second Qwen call.
 */
const subtitleWork = new Map<string, Promise<string[]>>();

async function cachedTranslations(segments: TranscriptSegment[], cacheKey?: string) {
  if (!cacheKey) return translateSegmentsWithQwen({ segments });
  // Scope by task, not source URL: the same video in another handcard remains
  // an independent task. Only successful translations survive delivery retries.
  const key = createHash("sha256").update(JSON.stringify([cacheKey, segments])).digest("hex");
  const existing = subtitleWork.get(key);
  if (existing) return existing;
  const work = (async () => {
    const directory = path.join(process.cwd(), ".data", "subtitle-cache");
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, `${key}.json`);
    const budgetTarget = path.join(directory, createHash("sha256").update(cacheKey).digest("hex"));
    try {
      const cached: unknown = JSON.parse(await readFile(target, "utf8"));
      if (Array.isArray(cached) && cached.length === segments.length
        && cached.every(value => typeof value === "string" && value.trim())) return cached as string[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const beforeRequest = async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          // Reserve before the network call. A crash/timeout is uncertain,
          // never permission to charge again beyond the two-request budget.
          await writeFile(`${budgetTarget}.request-${attempt}`, JSON.stringify({ requestedAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      throw new Error("字幕翻译已达到本次任务两次请求上限；其他结果保留");
    };
    const translations = await translateSegmentsWithQwen({ segments, beforeRequest });
    if (translations.length !== segments.length || translations.some(value => !value?.trim())) {
      throw new Error("字幕翻译不完整，未缓存结果");
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(translations), { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    return translations;
  })();
  subtitleWork.set(key, work);
  try { return await work; } finally { subtitleWork.delete(key); }
}

export async function generateBilingualSubtitleFile(segments: TranscriptSegment[], cacheKey?: string) {
  const usable = segments.filter((segment) => segment.text.trim());
  if (!usable.length) return null;
  const translations = await cachedTranslations(usable, cacheKey);
  const srt = buildBilingualSrt(usable, translations);
  const dir = await mkdtemp(path.join(tmpdir(), "viral-subtitle-"));
  const filePath = path.join(dir, "subtitle.srt");
  await writeFile(filePath, srt, "utf8");
  return {
    filePath,
    segments: usable,
    translations,
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => undefined),
  };
}
