import "server-only";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
export async function generateBilingualSubtitleFile(segments: TranscriptSegment[]) {
  const usable = segments.filter((segment) => segment.text.trim());
  if (!usable.length) return null;
  const translations = await translateSegmentsWithQwen({ segments: usable });
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
