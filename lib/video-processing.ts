import "server-only";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeStatic from "ffprobe-static";
import { fetchWithProxy } from "@/lib/network";

const runFile = promisify(execFile);
const mediaRoot = path.join(process.cwd(), ".data", "media");
const ffmpegPath = ffmpegInstaller.path;
const ffprobePath = ffprobeStatic.path;

export interface ExtractedScene {
  shotIndex: number;
  startSeconds: number;
  endSeconds: number;
  screenshotPath: string;
  clipPath: string | null;
}

function safeExtension(fileName: string, fallback = ".mp4") {
  const extension = path.extname(fileName).toLowerCase();
  return [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"].includes(extension) ? extension : fallback;
}

function normalizedDownloadError(
  error: unknown,
  kind: "video" | "cover",
  timeoutSignal: AbortSignal,
  callerSignal?: AbortSignal,
) {
  if (callerSignal?.aborted) return error instanceof Error ? error : new Error("下载已停止");
  const message = error instanceof Error ? error.message : String(error || "");
  if (timeoutSignal.aborted || /(?:timeout|timed out|aborted due to timeout|etimedout)/i.test(message)) {
    return new Error(`${kind === "video" ? "视频" : "封面"}下载超时`);
  }
  return error instanceof Error ? error : new Error(message || `${kind === "video" ? "视频" : "封面"}下载失败`);
}

export function resolveMediaPath(relativePath: string) {
  const clean = relativePath.replace(/^\/+/, "");
  const resolved = path.resolve(mediaRoot, clean);
  if (!resolved.startsWith(path.resolve(mediaRoot) + path.sep)) throw new Error("媒体路径无效");
  return resolved;
}

export function getMediaRoot() {
  mkdirSync(mediaRoot, { recursive: true });
  return mediaRoot;
}

export async function saveUploadedVideo(videoId: string, file: File) {
  if (file.size > 500 * 1024 * 1024) throw new Error("视频不能超过 500MB");
  const relative = path.join(videoId, `original${safeExtension(file.name)}`);
  const target = resolveMediaPath(relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(await file.arrayBuffer()));
  return relative;
}

export async function saveProductImage(productId: string, file: File) {
  if (file.size > 12 * 1024 * 1024) throw new Error("产品图片不能超过 12MB");
  const extension = file.type.includes("png") ? ".png" : file.type.includes("webp") ? ".webp" : ".jpg";
  const relative = path.join("products", `${productId}${extension}`);
  const target = resolveMediaPath(relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(await file.arrayBuffer()));
  return relative;
}

export async function downloadMedia(
  videoId: string,
  url: string,
  kind: "video" | "cover",
  signal?: AbortSignal,
  options: { timeoutMs?: number } = {},
) {
  // TikTok media hosts are not directly reachable from every cloud region.
  // The shared client honors HTTPS_PROXY without changing local behavior.
  const timeoutSignal = AbortSignal.timeout(Math.max(30_000, options.timeoutMs || 180_000));
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetchWithProxy(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 ViralVideoAnalyzer/1.0" },
      signal: requestSignal,
    });
  } catch (error) {
    throw normalizedDownloadError(error, kind, timeoutSignal, signal);
  }
  if (!response.ok || !response.body) throw new Error(`${kind === "video" ? "视频" : "封面"}下载失败（${response.status}）`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 600 * 1024 * 1024) throw new Error("视频超过 600MB，暂不支持下载");
  const contentType = response.headers.get("content-type") || "";
  const extension = kind === "cover"
    ? contentType.includes("png") ? ".png" : ".jpg"
    : safeExtension(new URL(response.url).pathname);
  const relative = path.join(videoId, kind === "video" ? `original${extension}` : `cover${extension}`);
  const target = resolveMediaPath(relative);
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    // Keep the timeout active while streaming the response body. Previously it
    // only covered response headers, so a stalled body escaped as the raw
    // English error "The operation was aborted due to timeout".
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target), { signal: requestSignal });
  } catch (error) {
    rmSync(target, { force: true });
    throw normalizedDownloadError(error, kind, timeoutSignal, signal);
  }
  return relative;
}

async function probeVideo(absolutePath: string, signal?: AbortSignal) {
  const { stdout } = await runFile(
    ffprobePath,
    ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", absolutePath],
    { maxBuffer: 4 * 1024 * 1024, signal },
  );
  const payload = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<Record<string, unknown>> };
  const stream = payload.streams?.find((item) => item.codec_type === "video");
  return {
    duration: Math.max(0.1, Number(payload.format?.duration || 0)),
    width: Number(stream?.width || 0),
    height: Number(stream?.height || 0),
  };
}

async function detectCuts(absolutePath: string, signal?: AbortSignal) {
  try {
    await runFile(
      ffmpegPath,
      ["-hide_banner", "-i", absolutePath, "-filter:v", "select='gt(scene,0.30)',showinfo", "-f", "null", "-"],
      { maxBuffer: 32 * 1024 * 1024, signal },
    );
    return [] as number[];
  } catch (error) {
    if (signal?.aborted) throw error;
    const stderr = String((error as { stderr?: string }).stderr || "");
    const times = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1]));
    return times.filter((time) => Number.isFinite(time));
  }
}

function buildBoundaries(duration: number, detected: number[]) {
  let points = [0, ...detected.filter((time) => time > 0.6 && time < duration - 0.35), duration]
    .sort((a, b) => a - b)
    .filter((value, index, array) => index === 0 || value - array[index - 1] > 0.65);
  if (duration > 3 && !points.some((time) => time >= 2.6 && time <= 3.4)) points.push(3);
  points = points.sort((a, b) => a - b);
  const expanded: number[] = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const previous = expanded.at(-1)!;
    const current = points[index];
    const gap = current - previous;
    if (gap > 6) {
      const pieces = Math.ceil(gap / 5);
      for (let piece = 1; piece < pieces; piece += 1) expanded.push(previous + (gap * piece) / pieces);
    }
    expanded.push(current);
  }
  if (expanded.length > 37) {
    const sampled = [0];
    const step = duration / 30;
    for (let time = step; time < duration; time += step) sampled.push(time);
    sampled.push(duration);
    return sampled;
  }
  return expanded;
}

async function extractScreenshot(videoPath: string, seconds: number, outputPath: string, signal?: AbortSignal) {
  await runFile(
    ffmpegPath,
    ["-y", "-ss", seconds.toFixed(3), "-i", videoPath, "-frames:v", "1", "-vf", "scale='min(960,iw)':-2", "-q:v", "2", outputPath],
    { maxBuffer: 8 * 1024 * 1024, signal },
  );
}

export async function extractVideoAssets(
  videoId: string,
  relativeVideoPath: string,
  signal?: AbortSignal,
  options: { light?: boolean; includeAudio?: boolean } = {},
) {
  const absoluteVideoPath = resolveMediaPath(relativeVideoPath);
  signal?.throwIfAborted();
  const metadata = await probeVideo(absoluteVideoPath, signal);
  if (metadata.duration > 600.5) throw new Error("视频超过 10 分钟，请上传更短版本");
  // Table automation only needs a few visual checkpoints. Avoid the expensive
  // scene-cut pass and dozens of screenshots in the lightweight path.
  const boundaries = options.light
    ? [0, metadata.duration / 3, (metadata.duration * 2) / 3, metadata.duration]
    : buildBoundaries(metadata.duration, await detectCuts(absoluteVideoPath, signal));
  const shotsDir = resolveMediaPath(path.join(videoId, "shots"));
  mkdirSync(shotsDir, { recursive: true });
  const scenes: ExtractedScene[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    signal?.throwIfAborted();
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const timestamp = Math.min(end - 0.05, start + Math.min(1.2, Math.max(0.15, (end - start) / 2)));
    const relativeScreenshot = path.join(videoId, "shots", `${String(index + 1).padStart(2, "0")}.jpg`);
    await extractScreenshot(absoluteVideoPath, timestamp, resolveMediaPath(relativeScreenshot), signal);
    scenes.push({
      shotIndex: index + 1,
      startSeconds: Number(start.toFixed(2)),
      endSeconds: Number(end.toFixed(2)),
      screenshotPath: relativeScreenshot,
      clipPath: null,
    });
  }
  if (options.includeAudio === false) {
    return { ...metadata, scenes, audioPath: null as string | null };
  }
  const audioRelative = path.join(videoId, `audio-${randomUUID().slice(0, 6)}.mp3`);
  const audioAbsolute = resolveMediaPath(audioRelative);
  try {
    await runFile(
      ffmpegPath,
      ["-y", "-i", absoluteVideoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audioAbsolute],
      { maxBuffer: 8 * 1024 * 1024, signal },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ...metadata, scenes, audioPath: null as string | null };
  }
  return { ...metadata, scenes, audioPath: audioRelative };
}

export async function splitAudioForQwenAsr(relativeAudioPath: string, durationSeconds: number, signal?: AbortSignal) {
  if (durationSeconds <= 295) return [relativeAudioPath];
  const source = resolveMediaPath(relativeAudioPath);
  const chunksDirectory = path.join(path.dirname(source), `asr-${randomUUID().slice(0, 6)}`);
  mkdirSync(chunksDirectory, { recursive: true });
  await runFile(
    ffmpegPath,
    ["-y", "-i", source, "-f", "segment", "-segment_time", "270", "-reset_timestamps", "1", "-c", "copy", path.join(chunksDirectory, "chunk-%02d.mp3")],
    { maxBuffer: 8 * 1024 * 1024, signal },
  );
  return readdirSync(chunksDirectory)
    .filter((name) => /^chunk-\d+\.mp3$/.test(name))
    .sort()
    .map((name) => path.relative(mediaRoot, path.join(chunksDirectory, name)));
}

export async function createSceneClip(videoId: string, relativeVideoPath: string, start: number, end: number, label: string, signal?: AbortSignal) {
  const duration = Math.max(0.5, Math.min(10, end - start));
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "highlight";
  const relative = path.join(videoId, "clips", `${safeLabel}-${Math.round(start * 10)}.mp4`);
  const absolute = resolveMediaPath(relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  try {
    await runFile(
      ffmpegPath,
      ["-y", "-ss", start.toFixed(3), "-i", resolveMediaPath(relativeVideoPath), "-t", duration.toFixed(3), "-c", "copy", "-movflags", "+faststart", absolute],
      { maxBuffer: 8 * 1024 * 1024, signal },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    await runFile(
      ffmpegPath,
      ["-y", "-ss", start.toFixed(3), "-i", resolveMediaPath(relativeVideoPath), "-t", duration.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-movflags", "+faststart", absolute],
      { maxBuffer: 16 * 1024 * 1024, signal },
    );
  }
  return relative;
}

export function readMedia(relativePath: string) {
  const absolute = resolveMediaPath(relativePath);
  if (!existsSync(absolute)) return null;
  return readFileSync(absolute);
}

export function deleteVideoMedia(videoId: string) {
  const target = resolveMediaPath(videoId);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}

export function contentTypeForMedia(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
  } as Record<string, string>)[extension] || "application/octet-stream";
}
