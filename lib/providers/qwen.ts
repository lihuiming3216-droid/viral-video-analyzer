import "server-only";

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseJsonLoose } from "@/lib/json-utils";
import { requireProvider } from "@/lib/provider-config";

const MAX_INLINE_VIDEO_BYTES = 6 * 1024 * 1024;
const QWEN_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;

function qwenVideoFps() {
  const configured = Number(process.env.QWEN_VIDEO_FPS || 2);
  return Number.isFinite(configured) ? Math.max(0.1, Math.min(10, configured)) : 2;
}

function qwenVideoModel() {
  return process.env.QWEN_VIDEO_MODEL?.trim() || "qwen3.5-omni-plus";
}

function videoMimeType(videoPath: string) {
  switch (path.extname(videoPath).toLowerCase()) {
    case ".avi": return "video/x-msvideo";
    case ".mkv": return "video/x-matroska";
    case ".mov": return "video/quicktime";
    case ".webm": return "video/webm";
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
}

export async function testQwenConnection() {
  const config = requireProvider("qwen");
  const response = await fetch(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) throw new Error(`Qwen 连接失败（${response.status}），请确认 Base URL 所在地域与 Key 一致`);
  return { ok: true, message: `连接成功，视频模型 ${qwenVideoModel()}` };
}

export async function analyzeVideoWithQwen(input: {
  prompt: string;
  localVideoPath: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: QwenRequestDiagnostic) => void;
}) {
  const config = requireProvider("qwen");
  const model = qwenVideoModel();
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
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
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
        ? AbortSignal.any([input.signal, AbortSignal.timeout(QWEN_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(QWEN_REQUEST_TIMEOUT_MS),
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
    if (input.signal?.aborted) {
      outcome = "aborted";
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error || "");
    if (/(?:timeout|timed out|aborted due to timeout|etimedout)/i.test(message)) {
      outcome = "timeout";
      throw new Error("Qwen 完整视频分析超时");
    }
    outcome = response && !response.ok
      ? "http_error"
      : error instanceof SyntaxError || /(?:JSON|没有返回|流式响应)/i.test(message)
        ? "invalid_response"
        : "network_error";
    throw error;
  } finally {
    try {
      input.onDiagnostic?.({
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
      });
    } catch {
      // Diagnostics must never alter the analysis result.
    }
  }
}
