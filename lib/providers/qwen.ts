import "server-only";

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseJsonLoose } from "@/lib/json-utils";
import { requireProvider } from "@/lib/provider-config";

const MAX_INLINE_VIDEO_BYTES = 6 * 1024 * 1024;

function qwenVideoFps() {
  const configured = Number(process.env.QWEN_VIDEO_FPS || 2);
  return Number.isFinite(configured) ? Math.max(0.1, Math.min(10, configured)) : 2;
}

function qwenVideoModel() {
  return process.env.QWEN_VIDEO_MODEL?.trim() || "qwen3.5-omni-plus";
}

function publicVideoUrl(value: string | null | undefined) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
    return parsed.toString();
  } catch {
    return "";
  }
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

function completeVideoInput(input: { remoteVideoUrl?: string | null; localVideoPath: string }) {
  const remoteUrl = publicVideoUrl(input.remoteVideoUrl);
  if (remoteUrl) {
    return {
      type: "video_url",
      video_url: { url: remoteUrl },
      fps: qwenVideoFps(),
      max_pixels: 655_360,
    };
  }

  const size = statSync(input.localVideoPath).size;
  if (size > MAX_INLINE_VIDEO_BYTES) {
    throw new Error("完整视频超过 Qwen Base64 直传限制，请先压缩视频后重试");
  }
  const data = readFileSync(input.localVideoPath).toString("base64");
  return {
    type: "video_url",
    video_url: { url: `data:${videoMimeType(input.localVideoPath)};base64,${data}` },
    fps: qwenVideoFps(),
    max_pixels: 655_360,
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

async function parseOmniStream(response: Response) {
  const body = await response.text();
  if (!response.ok) {
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
  const text = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .map((line) => streamedText(JSON.parse(line) as Record<string, unknown>))
    .join("")
    .trim();
  if (!text) throw new Error("Qwen 全模态模型没有返回视频分析内容");
  return parseJsonLoose<Record<string, unknown>>(text);
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
  remoteVideoUrl?: string | null;
  localVideoPath: string;
  maxTokens?: number;
  signal?: AbortSignal;
}) {
  const config = requireProvider("qwen");
  const content: Array<Record<string, unknown>> = [
    completeVideoInput(input),
    {
      type: "text",
      text: `${input.prompt}\n你已收到一个包含原始画面和原始音轨的完整 MP4。必须按时间顺序观看并听完整段视频，直接识别口播、音乐、音效、情绪与画面，不得假设另有外部转写。只返回合法 JSON，不要使用 Markdown 代码块。`,
    },
  ];
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: qwenVideoModel(),
      messages: [{ role: "user", content }],
      modalities: ["text"],
      enable_thinking: false,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: input.maxTokens || 4_500,
    }),
    signal: input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });
  return parseOmniStream(response);
}
