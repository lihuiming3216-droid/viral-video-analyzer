import "server-only";

import { readFileSync } from "node:fs";
import { parseJsonLoose, readTextFromModelResponse } from "@/lib/json-utils";
import { requireProvider } from "@/lib/provider-config";

const MAX_ANALYSIS_FRAMES = 8;

export async function testQwenConnection() {
  const config = requireProvider("qwen");
  const response = await fetch(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) throw new Error(`Qwen 连接失败（${response.status}），请确认 Base URL 所在地域与 Key 一致`);
  return { ok: true, message: `连接成功，默认模型 ${config.model}` };
}

export async function analyzeVideoWithQwen(input: {
  prompt: string;
  remoteVideoUrl?: string | null;
  framePaths: string[];
  maxTokens?: number;
  signal?: AbortSignal;
}) {
  const config = requireProvider("qwen");
  const content: Array<Record<string, unknown>> = [];
  input.framePaths.slice(0, MAX_ANALYSIS_FRAMES).forEach((framePath) => {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${readFileSync(framePath).toString("base64")}` },
    });
  });
  content.push({ type: "text", text: `${input.prompt}\n只返回合法 JSON，不要使用 Markdown 代码块。` });
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model || "qwen3.7-plus",
      messages: [{ role: "user", content }],
      response_format: { type: "json_object" },
      enable_thinking: false,
      stream: false,
      max_tokens: input.maxTokens || 4_500,
    }),
    signal: input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as Record<string, unknown> | undefined;
    throw new Error(String(error?.message || `Qwen 分析失败（${response.status}）`));
  }
  return parseJsonLoose<Record<string, unknown>>(readTextFromModelResponse(payload));
}

export async function transcribeAudioWithQwen(audioPath: string, signal?: AbortSignal) {
  const config = requireProvider("qwen");
  const audio = readFileSync(audioPath);
  if (audio.length > 10 * 1024 * 1024) throw new Error("音频超过 Qwen 单次转写的 10MB 限制");
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.QWEN_ASR_MODEL || "qwen3-asr-flash",
      messages: [{
        role: "user",
        content: [{
          type: "input_audio",
          input_audio: { data: `data:audio/mpeg;base64,${audio.toString("base64")}` },
        }],
      }],
      stream: false,
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as Record<string, unknown> | undefined;
    throw new Error(String(error?.message || `Qwen 语音转写失败（${response.status}）`));
  }
  const transcript = readTextFromModelResponse(payload).trim();
  if (!transcript) throw new Error("Qwen 没有返回语音转写内容");
  return transcript;
}
