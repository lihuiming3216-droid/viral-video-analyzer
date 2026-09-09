import "server-only";

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getPromptTemplate, getQwenPurposeModel, type QwenPurpose } from "@/lib/database";
import { parseJsonLoose } from "@/lib/json-utils";
import { requireProvider } from "@/lib/provider-config";
import { fetchQwen } from "@/lib/providers/qwen-transport";
import { QWEN_TRANSPORT_ERROR_CODES, type QwenTransportErrorCode } from "@/lib/types";

export const TRANSCRIPT_TRANSLATION_PROMPT_SLUG = "transcript_translation";
export const DEFAULT_TRANSCRIPT_TRANSLATION_TEMPLATE = '把下面 TokScript 提供的完整口播原文翻译成自然、准确、完整的简体中文。只返回 JSON，不要解释：{"translationZh":""}。不要删减、总结、补写。原文：{{TRANSCRIPT_JSON}}';

export const SEGMENT_TRANSLATION_PROMPT_SLUG = "segment_translation";
export const DEFAULT_SEGMENT_TRANSLATION_TEMPLATE = '把下面 TokScript 提供的分段口播原文逐段翻译成自然、准确的简体中文，用于生成双语字幕。严格保持原有分段顺序和数量，不要合并、拆分或跳过任何一段。只返回 JSON，不要解释：{"translations":["第1段中文", "第2段中文"]}。分段原文（JSON数组，每一项是一段的原文文本，按顺序排列）：{{SEGMENTS_JSON}}';

const MAX_INLINE_VIDEO_BYTES = 6 * 1024 * 1024;
const QWEN_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;
const QWEN_TRANSLATION_TIMEOUT_MS = 60 * 1_000;
const MAX_CONCURRENT_QWEN_REQUESTS = 2;

type QwenRequestPriority = "video" | "translation";
type QwenSchedulerGlobal = typeof globalThis & {
  __qwenRequestActive?: number;
  __qwenVideoWaiters?: Array<() => void>;
  __qwenTranslationWaiters?: Array<() => void>;
};

const qwenScheduler = globalThis as QwenSchedulerGlobal;
qwenScheduler.__qwenRequestActive ??= 0;
qwenScheduler.__qwenVideoWaiters ??= [];
qwenScheduler.__qwenTranslationWaiters ??= [];

function drainQwenRequests() {
  while (qwenScheduler.__qwenRequestActive! < MAX_CONCURRENT_QWEN_REQUESTS) {
    const grant = qwenScheduler.__qwenVideoWaiters!.shift()
      || qwenScheduler.__qwenTranslationWaiters!.shift();
    if (!grant) return;
    qwenScheduler.__qwenRequestActive! += 1;
    grant();
  }
}

function acquireQwenRequestSlot(priority: QwenRequestPriority, signal?: AbortSignal) {
  return new Promise<() => void>((resolve, reject) => {
    const waiters = priority === "video"
      ? qwenScheduler.__qwenVideoWaiters!
      : qwenScheduler.__qwenTranslationWaiters!;
    let granted = false;
    const grant = () => {
      granted = true;
      signal?.removeEventListener("abort", onAbort);
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        qwenScheduler.__qwenRequestActive = Math.max(0, qwenScheduler.__qwenRequestActive! - 1);
        drainQwenRequests();
      });
    };
    const onAbort = () => {
      if (granted) return;
      const index = waiters.indexOf(grant);
      if (index >= 0) waiters.splice(index, 1);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Qwen 请求已停止"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    waiters.push(grant);
    signal?.addEventListener("abort", onAbort, { once: true });
    drainQwenRequests();
  });
}

export type QwenRequestErrorCode = "timeout" | "network_error" | "http_error" | "invalid_response";

export class QwenRequestError extends Error {
  override readonly name = "QwenRequestError";

  constructor(
    readonly code: QwenRequestErrorCode,
    readonly retryable: boolean,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

function transportErrorCode(error: unknown): QwenTransportErrorCode | undefined {
  // fetch wraps socket/parser errors in TypeError.cause. Inspect a bounded
  // chain, copying only allowlisted codes, never messages, URLs or credentials.
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    const code = QWEN_TRANSPORT_ERROR_CODES.find((allowed) => allowed === candidate.code);
    if (code) return code;
    current = candidate.cause;
  }
  return undefined;
}

function qwenVideoFps() {
  const configured = Number(process.env.QWEN_VIDEO_FPS || 2);
  return Number.isFinite(configured) ? Math.max(0.1, Math.min(10, configured)) : 2;
}

// 负责人要求的目标模型是 qwen3.7-plus（审计报告10.1第1条：配置存的是这个，
// 但白名单只认 omni 系列，导致静默回退）。这里放行 qwen3.7-plus 只是让配置的值不再被
// 悄悄替换；它是否真的能听到原始音轨，仍然必须用审计12.2节要求的真实 A/V 验收视频组
// 做验证，不能因为白名单接受了这个名字就当作已验证。
function supportedQwenVideoModel(value: string) {
  return /^qwen(?:3\.7-plus|3\.5-omni-(?:plus|flash)|3-omni-flash)(?:-\d{4}-\d{2}-\d{2})?$/.test(value);
}

// 运维后台下拉建议用的候选名单。full/product_doc 只能从这几个里选——不是因为界面限制，
// 是因为 supportedQwenVideoModel 的白名单只认这几个（DashScope 上新出的模型即使填了也会被
// 静默忽略），列出来是为了让下拉框和真实校验规则保持一致，而不是先造一个界面幻觉。
export const QWEN_VIDEO_MODEL_OPTIONS = ["qwen3.7-plus", "qwen3.5-omni-plus", "qwen3.5-omni-flash", "qwen3-omni-flash"];

// 翻译是纯文本任务，没有代码级白名单限制，这里只是给下拉框一些常见候选，用户仍可以手填任意
// DashScope 模型名。
export const QWEN_TRANSLATION_MODEL_SUGGESTIONS = ["qwen-mt-turbo", "qwen-mt-plus", "qwen-plus", "qwen-turbo", ...QWEN_VIDEO_MODEL_OPTIONS];

export type QwenModelSource = "env" | "override" | "default" | "hardcoded";

/**
 * 完整视频分析、产品手卡精简分析、口播翻译原来共用同一个 provider_settings.qwen.model。
 * 运维后台"Provider 设置"页现在可以给这三个用途分别配置模型；这里按优先级取值：
 * 环境变量 > 该用途的运维后台覆盖 > provider_settings 里的默认模型 > 硬编码兜底。
 * 视频分析用途必须通过音视频白名单校验（不匹配的候选会被跳过，不是报错，也不是直接采用）；
 * 口播翻译是纯文本任务，不受这个限制。
 *
 * 导出这个函数是为了让运维后台能显示"这个用途现在实际生效的是哪个模型、为什么"——不复刻
 * 一份新逻辑，直接调用真实解析逻辑，保证界面显示和实际请求用的模型永远一致。
 */
export async function resolveQwenModel(purpose: QwenPurpose, configuredModel = ""): Promise<{ value: string; source: QwenModelSource }> {
  const dbOverride = ((await getQwenPurposeModel(purpose).catch(() => null)) || "").trim();
  if (purpose === "translation") {
    if (dbOverride) return { value: dbOverride, source: "override" };
    // configuredModel is provider_settings.qwen.model — the default for the
    // *video* purposes (full/product_doc), an omni model that expects actual
    // audio/video content. DashScope rejects it for a pure-text translation
    // request with "Invalid request parameters" (confirmed via a real
    // 双语字幕生成失败 production failure), so translation must never silently
    // inherit it. qwen-mt-turbo (DashScope's dedicated MT endpoint) was tried
    // next and returns perfectly valid JSON in a plain (non-streaming) call —
    // but our real request always uses stream:true, and that endpoint's SSE
    // chunk shape isn't fully compatible with parseOmniStream() below
    // (confirmed live: non-streaming content parses fine, the real streaming
    // call fails with "Expected ':' after property name"). qwen-plus is a
    // general chat model in the same family full/product_doc already stream
    // successfully against, so it doesn't carry that risk.
    return { value: "qwen-plus", source: "hardcoded" };
  }
  const envValue = (process.env.QWEN_VIDEO_MODEL || "").trim();
  const candidates: Array<[string, QwenModelSource]> = [
    [envValue, "env"],
    [dbOverride, "override"],
    [configuredModel.trim(), "default"],
  ];
  const found = candidates.find(([value]) => value && supportedQwenVideoModel(value));
  return found ? { value: found[0], source: found[1] } : { value: "qwen3.5-omni-plus", source: "hardcoded" };
}

async function qwenVideoModel(purpose: "full" | "product_doc", configuredModel = "") {
  return (await resolveQwenModel(purpose, configuredModel)).value;
}

async function qwenTranslationModel(configuredModel = "") {
  return (await resolveQwenModel("translation", configuredModel)).value;
}

function videoMimeType(videoPath: string) {
  switch (path.extname(videoPath).toLowerCase()) {
    case ".avi": return "video/x-msvideo";
    case ".mkv": return "video/x-matroska";
    case ".mov": return "video/quicktime";
    case ".webm": return "video/webm";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".m4a": return "audio/mp4";
    case ".aac": return "audio/aac";
    case ".ogg": return "audio/ogg";
    default: return "video/mp4";
  }
}

function completeVideoInput(input: { localVideoPath: string }) {
  const size = statSync(input.localVideoPath).size;
  if (size > MAX_INLINE_VIDEO_BYTES) {
    throw new Error("完整视频超过 Qwen Base64 直传限制，请先压缩视频后重试");
  }
  const bytes = readFileSync(input.localVideoPath);
  return {
    item: {
      type: "video_url",
      video_url: { url: `data:${videoMimeType(input.localVideoPath)};base64,${bytes.toString("base64")}` },
      fps: qwenVideoFps(),
      max_pixels: 655_360,
    },
    inputBytes: bytes.length,
    inputSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function streamedText(payload: Record<string, unknown>) {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const delta = choices[0] && typeof choices[0] === "object"
    ? (choices[0] as Record<string, unknown>).delta
    : undefined;
  if (!delta || typeof delta !== "object") return "";
  const content = (delta as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => item && typeof item === "object" ? String((item as Record<string, unknown>).text || "") : "")
    .join("");
}

function safeResponseRequestId(response: Response) {
  return response.headers.get("x-request-id")
    || response.headers.get("x-dashscope-request-id")
    || response.headers.get("request-id")
    || "";
}

async function parseOmniStream(response: Response, onFirstToken: (requestId: string) => void) {
  if (!response.ok) {
    const body = await response.text();
    let message = "";
    try {
      const payload = JSON.parse(body) as Record<string, unknown>;
      const error = payload.error as Record<string, unknown> | undefined;
      message = String(error?.message || "");
    } catch {
      // Some gateway failures return HTML or an empty body.
    }
    throw new Error(message || `Qwen 全模态分析失败（${response.status}）`);
  }
  if (!response.body) throw new Error("Qwen 全模态模型没有返回流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let requestId = safeResponseRequestId(response);
  let firstTokenSeen = false;
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") return;
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (!requestId && typeof payload.id === "string") requestId = payload.id;
    const chunk = streamedText(payload);
    if (!chunk) return;
    if (!firstTokenSeen) {
      firstTokenSeen = true;
      onFirstToken(requestId);
    }
    text += chunk;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      lines.forEach(consume);
      if (done) break;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (buffer) consume(buffer);
  text = text.trim();
  if (!text) throw new Error("Qwen 全模态模型没有返回视频分析内容");
  return {
    result: parseJsonLoose<Record<string, unknown>>(text),
    requestId,
    responseSha256: createHash("sha256").update(text).digest("hex"),
  };
}

export interface QwenRequestDiagnostic {
  model: string;
  inputBytes: number;
  inputSha256: string;
  requestId: string;
  httpStatus: number | null;
  headersMs: number | null;
  firstTokenMs: number | null;
  totalMs: number;
  outcome: "success" | "timeout" | "aborted" | "http_error" | "invalid_response" | "network_error";
  responseSha256: string;
  errorCode?: QwenTransportErrorCode;
}

export async function testQwenConnection() {
  const config = await requireProvider("qwen");
  const response = await fetch(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) throw new Error(`Qwen 连接失败（${response.status}），请确认 Base URL 所在地域与 Key 一致`);
  const sharedEndpoint = (() => {
    try {
      return new URL(config.baseUrl).hostname === "dashscope.aliyuncs.com";
    } catch {
      return false;
    }
  })();
  const fullModel = await qwenVideoModel("full", config.model);
  return {
    ok: true,
    message: `连接成功，视频模型 ${fullModel}${sharedEndpoint ? "；建议改用与当前 Key 同地域的 Workspace 专属地址" : ""}`,
  };
}

export async function analyzeVideoWithQwen(input: {
  prompt: string;
  localVideoPath: string;
  /** 完整分析和产品手卡精简分析可以在运维后台分别配置模型；默认 full。 */
  purpose?: "full" | "product_doc";
  maxTokens?: number;
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: QwenRequestDiagnostic) => void | Promise<void>;
}) {
  const config = await requireProvider("qwen");
  const model = await qwenVideoModel(input.purpose || "full", config.model);
  const video = completeVideoInput(input);
  const content: Array<Record<string, unknown>> = [
    video.item,
    {
      type: "text",
      text: `${input.prompt}\n你已收到一个包含原始画面和原始音轨的完整 MP4。必须按时间顺序观看并听完整段视频，直接识别口播、音乐、音效、情绪与画面，不得假设另有外部转写。只返回合法 JSON，不要使用 Markdown 代码块。`,
    },
  ];
  const startedAt = performance.now();
  let response: Response | null = null;
  let requestId = "";
  let headersMs: number | null = null;
  let firstTokenMs: number | null = null;
  let responseSha256 = "";
  let outcome: QwenRequestDiagnostic["outcome"] = "network_error";
  let errorCode: QwenTransportErrorCode | undefined;
  let deadline: AbortSignal | undefined;
  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await acquireQwenRequestSlot("video", input.signal);
    deadline = AbortSignal.timeout(QWEN_REQUEST_TIMEOUT_MS);
    response = await fetchQwen(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        modalities: ["text"],
        enable_thinking: false,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: input.maxTokens || 4_500,
      }),
      signal: input.signal
        ? AbortSignal.any([input.signal, deadline])
        : deadline,
    });
    headersMs = Math.round(performance.now() - startedAt);
    requestId = safeResponseRequestId(response);
    const parsed = await parseOmniStream(response, (streamRequestId) => {
      if (streamRequestId) requestId = streamRequestId;
      firstTokenMs ??= Math.round(performance.now() - startedAt);
    });
    requestId ||= parsed.requestId;
    responseSha256 = parsed.responseSha256;
    outcome = "success";
    return parsed.result;
  } catch (error) {
    errorCode = transportErrorCode(error);
    if (input.signal?.aborted) {
      outcome = "aborted";
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error || "");
    if (deadline?.aborted || errorCode?.includes("TIMEOUT") || errorCode === "ETIMEDOUT"
      || ((!response || response.ok) && /(?:timeout|timed out|aborted due to timeout|etimedout)/i.test(message))) {
      if (deadline?.aborted) errorCode = "REQUEST_TIMEOUT";
      outcome = "timeout";
      throw new QwenRequestError("timeout", true, "Qwen 完整视频分析超时");
    }
    if (response && !response.ok) {
      outcome = "http_error";
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new QwenRequestError(
        "http_error",
        retryable,
        `Qwen 完整视频请求失败（HTTP ${response.status}）`,
        response.status,
      );
    }
    if (error instanceof SyntaxError || /(?:JSON|没有返回|流式响应)/i.test(message)) {
      outcome = "invalid_response";
      // Unlike a deterministic parsing bug, the same multimodal input can get a
      // differently-shaped (and valid) response from the model on a second try
      // — this must count toward the "每任务最多请求 2 次" budget like every
      // other failure mode, not skip straight to a permanent task failure.
      throw new QwenRequestError("invalid_response", true, "Qwen 没有返回可用的视频分析结构");
    }
    outcome = "network_error";
    throw new QwenRequestError("network_error", true, "Qwen 完整视频网络连接失败");
  } finally {
    releaseSlot?.();
    try {
      await input.onDiagnostic?.({
        model,
        inputBytes: video.inputBytes,
        inputSha256: video.inputSha256,
        requestId,
        httpStatus: response?.status ?? null,
        headersMs,
        firstTokenMs,
        totalMs: Math.round(performance.now() - startedAt),
        outcome,
        responseSha256,
        ...(errorCode ? { errorCode } : {}),
      });
    } catch {
      // Diagnostics must never alter the analysis result.
    }
  }
}

export interface QwenTranscribedSegment {
  start: number;
  end: number;
  text: string;
  translated: string;
}

// DashScope's Qwen-Omni "input_audio" content type only documents these
// formats (help.aliyun.com/model-studio/qwen-omni): AMR, WAV, 3GP/3GPP, AAC,
// MP3. Anything else (.m4a, .ogg, ...) has no confirmed mapping, so it's
// deliberately left out rather than guessed at — see the throw below.
const AUDIO_FORMAT_BY_EXTENSION: Record<string, string> = {
  ".mp3": "mp3", ".wav": "wav", ".aac": "aac", ".amr": "amr", ".3gp": "3gp", ".3gpp": "3gpp",
};

/**
 * Transcribe (and translate) an arbitrary local audio/video file by actually
 * listening to it — for media that never goes through TokScript (e.g. an
 * employee-recorded dub track uploaded straight into a Base attachment
 * field, which has no TikTok URL for TokScript to fetch). Reuses the same
 * base64-inline multimodal channel as analyzeVideoWithQwen() for video
 * files. A pure audio file needs the "input_audio" content type, confirmed
 * against Alibaba Cloud's own Qwen-Omni docs after two real DashScope 400s
 * on the same test .mp3 ruled out guessing: {data: <raw base64>, format}
 * ("provided URL does not appear to be valid" — data must be a data: URI,
 * just with no MIME type before the semicolon, unlike video_url/image_url),
 * and a made-up "audio_url" type ("Unexpected item type in content").
 */
// A real request against the live account confirmed qwen3.7-plus (this
// deployment's configured "full" video-analysis model) rejects audio-only
// input outright: "An incorrect modal `audio` was entered, which may not be
// supported by the model...". qwen3.5-omni-plus/qwen3.5-omni-flash/
// qwen3-omni-flash all accepted the same request and returned 200 — so
// audio-only transcription intentionally does NOT reuse whatever model an
// admin has configured for "full" (that's tuned for video, not this), and
// instead pins one of the confirmed-working Omni models directly.
const AUDIO_TRANSCRIPTION_MODEL = "qwen3.5-omni-plus";

export async function transcribeMediaWithQwen(input: {
  localMediaPath: string;
  targetLanguage: string;
  signal?: AbortSignal;
}): Promise<QwenTranscribedSegment[]> {
  const config = await requireProvider("qwen");
  const size = statSync(input.localMediaPath).size;
  if (size > MAX_INLINE_VIDEO_BYTES) {
    throw new Error("音频/视频文件超过 Qwen Base64 直传限制，请先压缩后重试");
  }
  const bytes = readFileSync(input.localMediaPath);
  const ext = path.extname(input.localMediaPath).toLowerCase();
  const audioFormat = AUDIO_FORMAT_BY_EXTENSION[ext];
  const isLikelyAudioExt = [".m4a", ".ogg", ".flac", ".wma"].includes(ext);
  if (!audioFormat && isLikelyAudioExt) {
    throw new Error(`Qwen 音频转写暂不支持 ${ext} 格式（官方仅确认支持 mp3/wav/aac/amr/3gp/3gpp），请先转成其中一种格式再重试`);
  }
  const model = audioFormat ? AUDIO_TRANSCRIPTION_MODEL : await qwenVideoModel("full", config.model);
  const content: Array<Record<string, unknown>> = [
    audioFormat
      ? { type: "input_audio", input_audio: { data: `data:;base64,${bytes.toString("base64")}`, format: audioFormat } }
      : { type: "video_url", video_url: { url: `data:${videoMimeType(input.localMediaPath)};base64,${bytes.toString("base64")}` } },
    {
      type: "text",
      text: `你收到一段完整的音频/视频文件。请逐句听写原始语音内容（不要假设另有外部转写），并把每一句翻译成${input.targetLanguage || "简体中文"}。`
        + '严格按以下 JSON 结构返回，不要使用 Markdown 代码块，不要新增外层包装：'
        + '{"segments":[{"start":0.0,"end":2.5,"text":"原文","translated":"译文"}]}。'
        + 'start/end 是这一句在音频里的起止秒数（数字，支持小数）；如果整段没有可听写的人声，返回 {"segments":[]}。',
    },
  ];
  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await acquireQwenRequestSlot("video", input.signal);
    const response = await fetchQwen(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        modalities: ["text"],
        enable_thinking: false,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 4_500,
      }),
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(QWEN_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(QWEN_REQUEST_TIMEOUT_MS),
    });
    const parsed = await parseOmniStream(response, () => undefined);
    const rawSegments = Array.isArray((parsed.result as { segments?: unknown[] })?.segments)
      ? (parsed.result as { segments: unknown[] }).segments
      : [];
    return rawSegments.map((item) => {
      const row = item as Record<string, unknown>;
      return {
        start: Number(row.start) || 0,
        end: Number(row.end) || 0,
        text: String(row.text || "").trim(),
        translated: String(row.translated || "").trim(),
      };
    }).filter((segment) => segment.text);
  } finally {
    releaseSlot?.();
  }
}

/**
 * Translate TokScript's transcript without sending the video to Qwen. This is
 * intentionally independent from the full-video analysis request so a slow or
 * failed multimodal call cannot erase an otherwise valid translation.
 */
export async function translateTranscriptWithQwen(input: {
  transcript: string;
  signal?: AbortSignal;
}) {
  const transcript = input.transcript.trim();
  if (!transcript) return "";
  const config = await requireProvider("qwen");
  // Translation is deliberately shorter than full-video analysis. It runs in
  // the background and must never occupy a video worker for ten minutes.
  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await acquireQwenRequestSlot("translation", input.signal);
    const templateRow = await getPromptTemplate(
      TRANSCRIPT_TRANSLATION_PROMPT_SLUG,
      "口播翻译",
      DEFAULT_TRANSCRIPT_TRANSLATION_TEMPLATE,
    );
    const promptText = templateRow.template.replaceAll("{{TRANSCRIPT_JSON}}", JSON.stringify(transcript));
    const timeoutSignal = AbortSignal.timeout(QWEN_TRANSLATION_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetchQwen(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: await qwenTranslationModel(config.model),
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text: promptText,
          }],
        }],
        modalities: ["text"],
        enable_thinking: false,
        stream: true,
        max_tokens: 4_500,
      }),
      signal,
    });
    const parsed = await parseOmniStream(response, () => undefined);
    const result = parsed.result as Record<string, unknown>;
    const translation = String(result.translationZh || result.translation_zh || result.translation || "").trim();
    if (!translation) throw new Error("Qwen 未返回口播中文翻译");
    return translation;
  } finally {
    releaseSlot?.();
  }
}

/**
 * Translate TokScript's timestamped segments one-for-one, preserving order and
 * count so each translation can be re-attached to its original start/end for
 * a bilingual subtitle file. A count mismatch is treated as a hard failure —
 * silently misaligning a translation with the wrong timestamp is worse than
 * skipping the subtitle for this attempt.
 */
export async function translateSegmentsWithQwen(input: {
  segments: Array<{ start: number; end: number; text: string }>;
  signal?: AbortSignal;
}): Promise<string[]> {
  const segments = input.segments.filter((segment) => segment.text.trim());
  if (!segments.length) return [];
  const config = await requireProvider("qwen");
  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await acquireQwenRequestSlot("translation", input.signal);
    const templateRow = await getPromptTemplate(
      SEGMENT_TRANSLATION_PROMPT_SLUG,
      "分段口播翻译（字幕用）",
      DEFAULT_SEGMENT_TRANSLATION_TEMPLATE,
    );
    const promptText = templateRow.template.replaceAll(
      "{{SEGMENTS_JSON}}",
      JSON.stringify(segments.map((segment) => segment.text)),
    );
    const timeoutSignal = AbortSignal.timeout(QWEN_TRANSLATION_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetchQwen(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: await qwenTranslationModel(config.model),
        messages: [{ role: "user", content: [{ type: "text", text: promptText }] }],
        modalities: ["text"],
        enable_thinking: false,
        stream: true,
        max_tokens: 8_000,
      }),
      signal,
    });
    const parsed = await parseOmniStream(response, () => undefined);
    const result = parsed.result as Record<string, unknown>;
    const translations = Array.isArray(result.translations) ? result.translations.map((value) => String(value ?? "").trim()) : [];
    if (translations.length !== segments.length) {
      throw new Error(`Qwen 返回的分段翻译数量（${translations.length}）跟原文分段数量（${segments.length}）不一致`);
    }
    return translations;
  } finally {
    releaseSlot?.();
  }
}
