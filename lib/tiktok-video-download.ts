import "server-only";

import { createWriteStream, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetchWithProxy } from "@/lib/network";
import { resolveTokScriptVideoUrl } from "@/lib/providers/tokscript";
import {
  downloadTikTokVideoWithYtDlp,
  resolveMediaPath,
  validateDownloadedVideoFile,
} from "@/lib/video-processing";

// Independently implemented from the public page's data contract. No cobalt
// service, source-code dependency, account cookies, or paid API is required.
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const PAGE_LIMIT = 8 * 1024 * 1024;
const VIDEO_LIMIT = 600 * 1024 * 1024;
const PAGE_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"]);
const MEDIA_DOMAINS = ["tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokv.com", "byteoversea.com", "ibytedtos.com", "akamaized.net"];

type DownloadSource = "TokScript" | "yt-dlp" | "网页";

class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TikTokDownloadError";
  }
}

function checkedUrl(input: string | URL, media = false) {
  let url: URL;
  try { url = new URL(input); } catch { throw new DownloadError("下载地址无效"); }
  const allowed = media
    ? MEDIA_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
    : PAGE_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !allowed) {
    throw new DownloadError("下载地址不在允许的 TikTok 域名内");
  }
  return url;
}

function videoIdFromUrl(input: string) {
  return /^\/@[^/]*\/video\/(\d{15,22})\/?$/.exec(checkedUrl(input).pathname)?.[1];
}

function byteLimit(maximum: number, onBytes?: (bytes: number) => void) {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      onBytes?.(total);
      callback(total > maximum ? new DownloadError("下载内容超过大小限制") : null, chunk);
    },
  });
}

/** Follow only approved redirects, never a provider-supplied arbitrary host. */
async function requestSource(input: string, signal: AbortSignal, media = false, cookie = "") {
  let url = checkedUrl(input, media);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    signal.throwIfAborted();
    const response = await fetchWithProxy(url, {
      redirect: "manual", signal,
      headers: { "User-Agent": USER_AGENT, Referer: "https://www.tiktok.com/", "Accept-Encoding": "identity", ...(cookie ? { Cookie: cookie } : {}) },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new DownloadError("下载重定向缺少地址");
      url = checkedUrl(new URL(location, url), media);
      continue;
    }
    if (!response.ok || response.status === 206 || !response.body) {
      await response.body?.cancel();
      throw new DownloadError(`请求失败（HTTP ${response.status}）`);
    }
    return response;
  }
  throw new DownloadError("下载重定向次数过多");
}

function webVideoDetail(html: string, expectedId: string) {
  const script = /<script\b(?=[^>]*\bid\s*=\s*["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'])[^>]*>([\s\S]*?)<\/script\s*>/i.exec(html)?.[1];
  let detail;
  try {
    detail = JSON.parse(script || "")["__DEFAULT_SCOPE__"]?.["webapp.video-detail"];
  } catch { throw new DownloadError("网页未提供可读取的视频详情"); }
  if (!detail || detail.statusMsg || (detail.statusCode !== undefined && Number(detail.statusCode) !== 0)) {
    throw new DownloadError("视频详情暂不可用或需要登录");
  }
  const item = detail.itemInfo?.itemStruct;
  if (item?.id !== expectedId) throw new DownloadError("网页视频与原链接不一致");
  if (item.isContentClassified || item.privateItem || item.secret) throw new DownloadError("视频存在访问限制");
  if (item.imagePost) throw new DownloadError("此链接是图集，不是完整视频");
  if (typeof item.video?.playAddr !== "string" || !item.video.playAddr) throw new DownloadError("网页未提供视频播放地址");
  const duration = Number(item.video.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new DownloadError("网页未提供有效视频时长");
  if (duration > 600.5) throw new DownloadError("视频超过 10 分钟");
  return { url: checkedUrl(item.video.playAddr, true).toString(), duration };
}

/** One bounded attempt. Bytes and guest cookies stay local, never in logs/DB. */
async function downloadFromWeb(destinationId: string, sourceUrl: string, callerSignal?: AbortSignal) {
  const timeout = AbortSignal.timeout(90_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    const id = videoIdFromUrl(sourceUrl);
    if (!id) throw new DownloadError("链接未解析到 TikTok 视频编号");
    const response = await requestSource(`https://www.tiktok.com/@i/video/${id}`, signal);
    const cookies = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const chunks: Buffer[] = [];
    await pipeline(Readable.fromWeb(response.body as never), byteLimit(PAGE_LIMIT), async function (stream) {
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    }, { signal });
    const detail = webVideoDetail(Buffer.concat(chunks).toString("utf8"), id);
    const media = await requestSource(detail.url, signal, true, cookies);
    const length = Number(media.headers.get("content-length") || 0);
    const contentType = (media.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (length > VIDEO_LIMIT || !["video/mp4", "application/octet-stream", "binary/octet-stream"].includes(contentType)) {
      await media.body?.cancel();
      throw new DownloadError(length > VIDEO_LIMIT ? "视频超过 600MB" : "下载响应不是 MP4 文件");
    }
    const relative = path.join(destinationId, "original.mp4");
    const target = resolveMediaPath(relative);
    mkdirSync(path.dirname(target), { recursive: true });
    let received = 0;
    await pipeline(Readable.fromWeb(media.body as never), byteLimit(VIDEO_LIMIT, count => { received = count; }), createWriteStream(target, { flags: "wx" }), { signal });
    if (!received || (length && length !== received)) throw new DownloadError("视频文件下载不完整");
    const metadata = await validateDownloadedVideoFile(target, signal);
    if (Math.abs(metadata.duration - detail.duration) > Math.max(2, detail.duration * 0.05)) {
      throw new DownloadError("下载视频时长与原页面不一致");
    }
    signal.throwIfAborted();
    return relative;
  } catch (error) {
    callerSignal?.throwIfAborted();
    if (timeout.aborted) throw new DownloadError("网页下载超时");
    throw error;
  }
}

function safeFailure(error: unknown) {
  if (error instanceof DownloadError) return error.message;
  const message = error instanceof Error ? error.message : "";
  if (/缺少音频轨/.test(message)) return "文件缺少音频轨";
  if (/缺少视频轨/.test(message)) return "文件缺少视频轨";
  if (/timeout|timed out|超时/i.test(message)) return "下载超时";
  if (/Unexpected response from webpage/.test(message)) return "无法读取 TikTok 页面";
  const status = /(?:HTTP\s*|下载失败（)([45]\d\d)/i.exec(message)?.[1];
  return status ? `下载失败（HTTP ${status}）` : "下载或文件校验失败";
}

/**
 * A failed candidate owns its own directory. Never overwrite an earlier
 * original or let a cancelled request remove another attempt's media.
 * Provider transcript/translation and model retries are outside this module.
 */
export async function downloadTikTokVideoWithFallback(input: {
  videoId: string;
  sourceUrl: string;
  primaryDownload?: (destinationId: string) => Promise<string>;
  requireAudio?: boolean;
  signal?: AbortSignal;
  beforeSource: (source: DownloadSource) => Promise<void>;
}) {
  input.signal?.throwIfAborted();
  const root = resolveMediaPath(input.videoId);
  mkdirSync(root, { recursive: true });
  const attemptDirectory = mkdtempSync(path.join(root, "download-"));
  const attemptId = path.join(input.videoId, path.basename(attemptDirectory));
  const failures: string[] = [];
  let succeeded = false;
  let videoOnly: { relativePath: string; source: DownloadSource; directory: string } | undefined;
  let resolvedSource: Promise<string> | undefined;
  const sourceUrl = () => resolvedSource ??= (async () => {
    checkedUrl(input.sourceUrl);
    if (videoIdFromUrl(input.sourceUrl)) return input.sourceUrl;
    // Reuse the existing official short-link resolver; this makes no MCP call.
    try {
      return await resolveTokScriptVideoUrl(input.sourceUrl, input.signal, (url, init) =>
        fetchWithProxy(checkedUrl(url instanceof Request ? url.url : url), init));
    } catch {
      input.signal?.throwIfAborted();
      // Keep the existing ability for yt-dlp to resolve a short link itself.
      // Only a caller stop/deadline, not an ordinary resolver error, ends it.
      return input.sourceUrl;
    }
  })();
  const candidates: Array<{ source: DownloadSource; run: (id: string) => Promise<string> }> = [
    ...(input.primaryDownload ? [{ source: "TokScript" as const, run: input.primaryDownload }] : []),
    { source: "yt-dlp", run: async id => downloadTikTokVideoWithYtDlp(id, await sourceUrl(), input.signal) },
    { source: "网页", run: async id => downloadFromWeb(id, await sourceUrl(), input.signal) },
  ];
  try {
    for (const [index, candidate] of candidates.entries()) {
      input.signal?.throwIfAborted();
      // Ownership/deadline errors must escape, never be treated as a provider
      // failure and accidentally start another network request.
      await input.beforeSource(candidate.source);
      input.signal?.throwIfAborted();
      const destinationId = path.join(attemptId, String(index));
      const destination = resolveMediaPath(destinationId);
      try {
        const relativePath = await candidate.run(destinationId);
        input.signal?.throwIfAborted();
        const absolutePath = resolveMediaPath(relativePath);
        if (!absolutePath.startsWith(destination + path.sep)) throw new DownloadError("下载文件位置无效");
        const size = statSync(absolutePath).size;
        if (!size || size > VIDEO_LIMIT) throw new DownloadError("视频文件大小无效");
        // The web candidate has already decoded and checked both tracks.
        if (candidate.source !== "网页") {
          const timeout = AbortSignal.timeout(20_000);
          const metadata = await validateDownloadedVideoFile(absolutePath, input.signal ? AbortSignal.any([input.signal, timeout]) : timeout, { requireAudio: false, decode: false });
          if (input.requireAudio !== false && !metadata.audioCodec) {
            // Preserve the existing independent file-delivery behaviour if
            // every complete-A/V source fails. Qwen still rejects this file
            // at its unchanged mandatory audio gate; no silent track is added.
            videoOnly ??= { relativePath, source: candidate.source, directory: destination };
            throw new DownloadError("文件缺少音频轨");
          }
        }
        input.signal?.throwIfAborted();
        if (videoOnly) rmSync(videoOnly.directory, { recursive: true, force: true });
        succeeded = true;
        return { relativePath, source: candidate.source, failures };
      } catch (error) {
        if (videoOnly?.directory !== destination) rmSync(destination, { recursive: true, force: true });
        input.signal?.throwIfAborted();
        failures.push(`${candidate.source}：${safeFailure(error)}`);
      }
    }
    if (videoOnly) {
      input.signal?.throwIfAborted();
      succeeded = true;
      return { relativePath: videoOnly.relativePath, source: videoOnly.source, failures };
    }
    throw new DownloadError(`视频下载失败（${failures.join("；")}）`);
  } finally {
    if (!succeeded) rmSync(attemptDirectory, { recursive: true, force: true });
  }
}
