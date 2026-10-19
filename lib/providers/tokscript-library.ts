import "server-only";

import { fetchWithProxy } from "@/lib/network";
import { requireProvider } from "@/lib/provider-config";
import { TokScriptClient, resolveTokScriptVideoUrl, tokScriptTranscriptFailure } from "@/lib/providers/tokscript";

export type LibraryPart = "transcript" | "translation" | "download";
export type LibraryProviderResult = {
  transcript: string;
  translation: string;
  downloadUrl: string;
  errors: Partial<Record<LibraryPart, string>>;
};

/** No model API fallback: this adapter uses the existing TokScript account. */
export type LibraryProviderHooks = {
  onJob?: (jobId: string) => Promise<void>;
  onTranscript?: (text: string) => Promise<void>;
  onTranslation?: (text: string) => Promise<void>;
  onDownload?: (url: string) => Promise<void>;
};

export function librarySourceKey(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !["www.tiktok.com", "tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"].includes(url.hostname)) {
    throw new Error("仅支持官方 TikTok 视频链接");
  }
  const id = /^\/@[^/]+\/video\/(\d{15,22})\/?$/.exec(url.pathname)?.[1];
  if (id) return `tiktok:${id}`;
  const short = ["vm.tiktok.com", "vt.tiktok.com"].includes(url.hostname)
    ? /^\/[A-Za-z0-9]+\/?$/.test(url.pathname) : /^\/t\/[A-Za-z0-9]+\/?$/.test(url.pathname);
  if (!short) {
    throw new Error("需要单条 TikTok 视频链接，不支持商品、主页或合集");
  }
  return `${url.hostname}${url.pathname.replace(/\/$/, "")}`;
}

/** Remove caption syntax only; never shorten, paraphrase or deduplicate speech. */
export function libraryCaptionText(value: unknown) {
  if (typeof value !== "string") return "";
  const raw = value.replace(/^\uFEFF/, "").trim();
  if (!raw || tokScriptTranscriptFailure(raw)) return "";
  const lines = raw.split(/\r?\n/);
  const timing = /^(?:(?:\d{2,}:)?\d{2}:\d{2}[.,]\d{1,3}|\d{2,}:\d{2}:\d{2})\s*-->\s*/;
  const captions = /^WEBVTT(?:\s|$)/.test(raw) || lines.some(line => timing.test(line.trim()));
  if (!captions) return raw;
  return lines.filter((line, index) => {
    const text = line.trim();
    if (!text || /^WEBVTT(?:\s|$)/.test(text) || timing.test(text)) return false;
    // Caption sequence identifiers are structural only immediately before a cue.
    if (/^\d+$/.test(text) && timing.test((lines[index + 1] || "").trim())) return false;
    return true;
  }).map(line => line.replace(/<\/?(?:c(?:\.[^ >]+)?|b|i|u|v|lang)(?:\s[^>]*)?>|<\d{2}:\d{2}(?::\d{2})?[.,]\d{3}>/g, "").trim()).filter(Boolean).join("\n");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toolPayload(result: Record<string, unknown>) {
  if (result.isError) throw new Error("TokScript 返回工具错误");
  if (result.structuredContent) return record(result.structuredContent);
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks.map(block => record(block)).filter(block => block.type === "text").map(block => String(block.text || "")).join("\n");
  try { return record(JSON.parse(text)); } catch { throw new Error("TokScript 未返回可核验的结构化结果"); }
}

function text(record: Record<string, unknown>, key: string) {
  return typeof record[key] === "string" ? record[key] as string : "";
}

export function libraryOriginalTranscript(payload: Record<string, unknown>, expected: string) {
  const source = text(payload, "source_url");
  // get_tiktok_transcript is a single-video request and may omit source_url.
  // Never reinterpret a stored bulk/translated library entry as original speech.
  if (source && librarySourceKey(source) !== librarySourceKey(expected)) throw new Error("TokScript 原文来源与视频不一致");
  if (payload.is_bulk || payload.is_collection || Array.isArray(payload.items)) throw new Error("TokScript 未返回单条视频的原口播");
  const raw = payload.transcript;
  const segments = record(raw).segments;
  if (Array.isArray(segments) && segments.some(segment => typeof record(segment).text !== "string")) {
    throw new Error("TokScript 原口播分段不完整，不能静默丢弃内容");
  }
  const transcript = libraryCaptionText(Array.isArray(segments)
    ? segments.map(segment => text(record(segment), "text")).join("\n") : raw);
  if (!transcript) throw new Error("TokScript 未取得原口播，不能判定为无口播");
  return transcript;
}

export function libraryExportTranslation(payload: unknown, expected: string) {
  if (!Array.isArray(payload)) throw new Error("TokScript 翻译导出格式不受支持");
  const rows = payload.map(record).filter(row => {
    try { return librarySourceKey(text(row, "source_url")) === librarySourceKey(expected); } catch { return false; }
  });
  if (rows.length !== 1) throw new Error("TokScript 翻译缺少唯一匹配的视频来源");
  const translated = libraryCaptionText(rows[0].transcript);
  if (!translated) throw new Error("TokScript 未返回中文全文翻译");
  if (translated.length > 40 && !/[\u3400-\u9fff]/u.test(translated)) throw new Error("TokScript 返回的长文本不是中文翻译");
  return translated;
}

async function exportJson(url: string, signal: AbortSignal) {
  const address = new URL(url);
  if (address.protocol !== "https:" || address.username || address.password || address.port
    || !/(?:^|\.)(?:r2\.dev|tokscript\.com)$/.test(address.hostname)) throw new Error("TokScript 翻译文件地址未通过校验");
  const response = await fetchWithProxy(address, { redirect: "error", signal });
  if (!response.ok || !response.body) throw new Error("TokScript 翻译文件暂时无法读取");
  const maximum = 8 * 1024 * 1024;
  if (Number(response.headers.get("content-length") || 0) > maximum) {
    await response.body.cancel();
    throw new Error("TokScript 翻译文件超过安全上限");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error("TokScript 翻译文件超过安全上限");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Error("TokScript 翻译文件不是有效 JSON"); }
}

function downloadUrl(payload: Record<string, unknown>) {
  // These are explicit media fields, never a caption/title or source page URL.
  const candidates = [payload.download_url, payload.downloadUrl, payload.video_url,
    record(payload.data).download_url, record(payload.data).downloadUrl, record(payload.data).video_url];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.port) continue;
    if (/(?:^|\.)(?:tokscript\.com|r2\.dev|tiktokcdn\.com|tiktokcdn-us\.com|tiktokv\.com|byteoversea\.com|ibytedtos\.com|akamaized\.net)$/.test(url.hostname)) return url.toString();
  }
  throw new Error("TokScript 未返回可核验的视频下载地址");
}

/** Per-task polling is bounded; it never reads or scans a Feishu table. */
export async function fetchLibraryVideo(
  source: string, hooks: LibraryProviderHooks = {}, signal?: AbortSignal,
): Promise<LibraryProviderResult> {
  librarySourceKey(source);
  const config = await requireProvider("tokscript");
  const timeout = AbortSignal.timeout(180_000);
  const currentSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const client = new TokScriptClient(config.baseUrl, config.apiKey, currentSignal);
  const result: LibraryProviderResult = { transcript: "", translation: "", downloadUrl: "", errors: {} };
  const sourceUrl = await resolveTokScriptVideoUrl(source, currentSignal);
  librarySourceKey(sourceUrl);
  // TokScript's library is keyed by source URL and can reuse an original as a
  // translated cache hit. Keep deterministic, separate URL keys per language;
  // both still resolve to and are verified against the identical TikTok ID.
  const originalUrl = new URL(sourceUrl);
  originalUrl.hostname = "www.tiktok.com";
  originalUrl.search = "";
  originalUrl.hash = "";
  const translatedUrl = new URL(originalUrl);
  translatedUrl.searchParams.set("tokscript_translation", "zh-CN");
  await client.connect();
  const tools = await client.listTools();
  const names = new Set(tools.map(tool => tool.name));
  const call = async (name: string, args: Record<string, unknown>) => {
    currentSignal.throwIfAborted();
    if (!names.has(name)) throw new Error("当前 TokScript 账号缺少所需工具");
    return toolPayload(await client.callToolArguments(name, args));
  };
  const downloads = (async () => {
    try {
      const tool = tools.find(tool => tool.name === "download_video");
      if (!tool) throw new Error("当前账号没有 TokScript 下载工具");
      const raw = toolPayload(await client.callTool(tool, sourceUrl));
      result.downloadUrl = downloadUrl(raw);
      await hooks.onDownload?.(result.downloadUrl);
    } catch { result.errors.download = signal?.aborted ? "视频获取已停止" : "视频获取或回填失败，其他成功结果保留"; }
  })();
  const originalRequest = (async () => {
    if (!names.has("get_tiktok_transcript")) throw new Error("当前账号没有 TokScript 原口播工具");
    const deadline = AbortSignal.timeout(60_000);
    const originalClient = new TokScriptClient(config.baseUrl, config.apiKey, signal ? AbortSignal.any([signal, deadline]) : deadline);
    await originalClient.connect();
    // Explicit JSON keeps new extractions and cached WEBVTT responses in the
    // same strict parser. Do not select a preferred/translated language.
    return libraryOriginalTranscript(toolPayload(await originalClient.callToolArguments("get_tiktok_transcript", { video_url: originalUrl.toString(), format: "json" })), sourceUrl);
  })();
  const originals = (async () => {
    try {
      result.transcript = await originalRequest;
      await hooks.onTranscript?.(result.transcript);
    } catch { result.errors.transcript = signal?.aborted ? "原口播获取已停止" : "TokScript 原口播提取或回填失败，不能判定为无口播"; }
  })();
  const transcripts = (async () => {
    // TokScript writes original and translated entries into the same library.
    // Sequence those provider calls to avoid an original response racing the
    // Chinese export. An original failure still permits the translation; its
    // separate 60s deadline never aborts the translation/download client.
    await originalRequest.catch(() => undefined);
    let completed: Record<string, unknown> | undefined;
    try {
      // One known submission. An uncertain timeout must never resubmit blindly.
      const job = await call("submit_transcript_job", { urls: [translatedUrl.toString()], target_language: "zh-CN" });
      const jobId = text(job, "job_id");
      if (!jobId || text(job, "target_language") !== "zh-CN") throw new Error("TokScript 未确认中文任务编号");
      await hooks.onJob?.(jobId);
      for (;;) {
        currentSignal.throwIfAborted();
        const status = await call("get_job_status", { job_id: jobId, include_results: true });
        if (status.status === "failed") throw new Error("TokScript 任务失败");
        if (status.status === "complete") { completed = status; break; }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(done, 2_000);
          function done() { currentSignal.removeEventListener("abort", abort); resolve(); }
          function abort() { clearTimeout(timer); currentSignal.removeEventListener("abort", abort); reject(currentSignal.reason); }
          if (currentSignal.aborted) abort();
          else currentSignal.addEventListener("abort", abort, { once: true });
        });
      }
    } catch { result.errors.translation = "TokScript 中文任务失败或超时，其他成功结果保留"; }
    if (!completed) return;
    try {
      if (completed.transcript_ready !== true) throw new Error("TokScript 任务结束但没有有效口播");
      const key = text(completed, "result_key");
      if (!key) throw new Error("TokScript 未提供翻译结果编号");
      const exported = await call("export_results", { result_key: key, format: "json" });
      result.translation = libraryExportTranslation(await exportJson(text(exported, "download_url"), currentSignal), sourceUrl);
      delete result.errors.translation;
      await hooks.onTranslation?.(result.translation);
    } catch { result.errors.translation = signal?.aborted ? "中文翻译已停止" : "TokScript 中文全文获取或回填失败，其他成功结果保留"; }
  })();
  await Promise.all([downloads, originals, transcripts]);
  signal?.throwIfAborted();
  return result;
}
