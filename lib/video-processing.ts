import "server-only";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeStatic from "ffprobe-static";
import { fetchWithProxy } from "@/lib/network";

const runFile = promisify(execFile);
const mediaRoot = path.join(process.cwd(), ".data", "media");
const ffmpegPath = ffmpegInstaller.path;
const ffprobePath = ffprobeStatic.path;

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
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${kind === "video" ? "视频" : "封面"}下载失败（${response.status}）`);
  }
  const length = Number(response.headers.get("content-length") || 0);
  const maxBytes = (kind === "video" ? 600 : 12) * 1024 * 1024;
  const tooLarge = () => new Error(kind === "video" ? "视频超过 600MB，暂不支持下载" : "封面超过 12MB，暂不支持下载");
  if (length > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const contentType = response.headers.get("content-type") || "";
  const extension = kind === "cover"
    ? contentType.includes("png") ? ".png" : ".jpg"
    : safeExtension(new URL(response.url || url).pathname);
  const relative = path.join(videoId, kind === "video" ? `original${extension}` : `cover${extension}`);
  const target = resolveMediaPath(relative);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.part`;
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? tooLarge() : null, chunk);
    },
  });
  try {
    // Keep the timeout active while streaming the response body. Previously it
    // only covered response headers, so a stalled body escaped as the raw
    // English error "The operation was aborted due to timeout".
    await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(temporary), { signal: requestSignal });
    if (!bytes) throw new Error("下载内容为空");
    renameSync(temporary, target);
  } catch (error) {
    throw normalizedDownloadError(error, kind, timeoutSignal, signal);
  } finally {
    rmSync(temporary, { force: true });
  }
  return relative;
}

/**
 * Local downloader candidate. The caller owns fallback selection and gives
 * each candidate a private destination; a file is not accepted on exit alone.
 */
export async function downloadTikTokVideoWithYtDlp(videoId: string, url: string, signal?: AbortSignal) {
  const relative = path.join(videoId, "original.mp4");
  const target = resolveMediaPath(relative);
  mkdirSync(path.dirname(target), { recursive: true });
  const timeoutSignal = AbortSignal.timeout(180_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    await runFile("yt-dlp", [
      "--ignore-config", "--no-progress",
      "--retries", "0", "--fragment-retries", "0", "--extractor-retries", "0",
      "--no-playlist",
      "-f", "mp4/bestvideo+bestaudio/best",
      "--merge-output-format", "mp4",
      "-o", target,
      url,
    ], { signal: requestSignal, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    rmSync(target, { force: true });
    throw normalizedDownloadError(error, "video", timeoutSignal, signal);
  }
  if (!existsSync(target)) throw new Error("yt-dlp 未生成视频文件");
  return relative;
}

async function probeVideo(absolutePath: string, signal?: AbortSignal) {
  const { stdout } = await runFile(
    ffprobePath,
    ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", absolutePath],
    { maxBuffer: 4 * 1024 * 1024, signal },
  );
  const payload = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<Record<string, unknown>> };
  const videoStream = payload.streams?.find((item) => item.codec_type === "video");
  const audioStream = payload.streams?.find((item) => item.codec_type === "audio");
  return {
    duration: Math.max(0.1, Number(payload.format?.duration || 0)),
    width: Number(videoStream?.width || 0),
    height: Number(videoStream?.height || 0),
    videoCodec: String(videoStream?.codec_name || ""),
    audioCodec: String(audioStream?.codec_name || ""),
  };
}

/** Check a newly acquired fallback file without changing or transcribing it. */
export async function validateDownloadedVideoFile(
  absolutePath: string,
  signal?: AbortSignal,
  options: { requireAudio?: boolean; decode?: boolean } = {},
) {
  const metadata = await probeVideo(absolutePath, signal);
  if (!metadata.videoCodec) throw new Error("完整视频缺少视频轨");
  // Keep the original sound: a file without its audio track is not delivered.
  if (options.requireAudio !== false && !metadata.audioCodec) throw new Error("完整视频缺少音频轨");
  if (!Number.isFinite(metadata.duration) || metadata.duration <= 0.1 || metadata.duration > 600.5) {
    throw new Error("下载视频时长无效或超过 10 分钟");
  }
  if (options.decode !== false) await runFile(ffmpegPath, [
    "-hide_banner", "-nostdin", "-v", "error", "-xerror",
    "-i", absolutePath, "-map", "0:v:0", "-map", options.requireAudio === false ? "0:a:0?" : "0:a:0", "-f", "null", "-",
  ], { maxBuffer: 1024 * 1024, signal });
  return metadata;
}

/**
 * Remove files produced by an unsuccessful attempt. TikTok originals are
 * downloaded cache and are removed with the task directory; an explicitly
 * preserved original file is kept.
 */
export function deleteVideoAttemptCache(videoId: string, preservedOriginalPath?: string | null) {
  const target = resolveMediaPath(videoId);
  if (!existsSync(target)) return;
  const preserved = preservedOriginalPath ? resolveMediaPath(preservedOriginalPath) : null;
  if (!preserved || path.dirname(preserved) !== target) {
    rmSync(target, { recursive: true, force: true });
    return;
  }
  for (const entry of readdirSync(target)) {
    const child = path.join(target, entry);
    if (child === preserved) continue;
    rmSync(child, { recursive: true, force: true });
  }
}

/** Recursively sums file sizes under the media root, for the ops console's disk-usage widget. */
export function getMediaUsageBytes() {
  const root = getMediaRoot();
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  walk(root);
  return total;
}

/** Whole-volume disk usage for the drive holding the media root (not just media size). */
export function getDiskUsage() {
  try {
    const stats = statfsSync(getMediaRoot());
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
  } catch {
    return null;
  }
}

