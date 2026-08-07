import "server-only";

import { createReadStream, readFileSync } from "node:fs";
import OpenAI from "openai";
import { parseJsonLoose, readTextFromModelResponse } from "@/lib/json-utils";
import { fetchOpenAI, getOutboundProxyUrl } from "@/lib/network";
import { requireProvider } from "@/lib/provider-config";
import type { AnalysisResult, Product } from "@/lib/types";

const MAX_ANALYSIS_FRAMES = 8;

export const analysisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "language", "scores", "hook", "viralPoints", "strengths", "weaknesses", "structureFormula", "rewriteScript", "storyboard", "scenes"],
  properties: {
    summary: { type: "string" },
    language: { type: "string" },
    scores: {
      type: "object",
      additionalProperties: false,
      required: ["traffic", "conversion", "visual", "product", "audio", "rhythm"],
      properties: Object.fromEntries(["traffic", "conversion", "visual", "product", "audio", "rhythm"].map((key) => [key, { type: "integer", minimum: 0, maximum: 100 }])),
    },
    hook: {
      type: "object",
      additionalProperties: false,
      required: ["timeRange", "type", "description", "whyItWorks"],
      properties: {
        timeRange: { type: "string" }, type: { type: "string" }, description: { type: "string" }, whyItWorks: { type: "string" },
      },
    },
    viralPoints: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["timeRange", "description", "reason"],
        properties: { timeRange: { type: "string" }, description: { type: "string" }, reason: { type: "string" } },
      },
    },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    structureFormula: { type: "string" },
    rewriteScript: { type: "string" },
    storyboard: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["shot", "visual", "voiceover"],
        properties: { shot: { type: "string" }, visual: { type: "string" }, voiceover: { type: "string" } },
      },
    },
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["shotIndex", "role", "visual", "audio", "originalText", "translationZh", "good", "improve", "importance", "scoreTraffic", "scoreConversion", "scoreClarity", "scoreAesthetic", "scoreLighting", "scoreProduct", "tags"],
        properties: {
          shotIndex: { type: "integer" }, role: { type: "string" }, visual: { type: "string" }, audio: { type: "string" },
          originalText: { type: "string" }, translationZh: { type: "string" }, good: { type: "string" }, improve: { type: "string" },
          importance: { type: "integer", minimum: 0, maximum: 100 },
          scoreTraffic: { type: "integer", minimum: 0, maximum: 100 }, scoreConversion: { type: "integer", minimum: 0, maximum: 100 },
          scoreClarity: { type: "integer", minimum: 0, maximum: 100 }, scoreAesthetic: { type: "integer", minimum: 0, maximum: 100 },
          scoreLighting: { type: "integer", minimum: 0, maximum: 100 }, scoreProduct: { type: "integer", minimum: 0, maximum: 100 },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export async function testOpenAIConnection() {
  const config = requireProvider("openai");
  try {
    const response = await fetchOpenAI(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as {
      data?: Array<{ id?: string }>;
      error?: { code?: string; message?: string };
    };
    if (!response.ok) {
      const detail = payload.error?.message || payload.error?.code || `HTTP ${response.status}`;
      throw new Error(`OpenAI 连接失败：${detail}`);
    }
    const models = new Set((payload.data || []).map((item) => item.id).filter(Boolean));
    const modelNotice = models.size && !models.has(config.model)
      ? `；当前账号未列出 ${config.model}，请在模型名称中改用账号可用模型`
      : `，默认模型 ${config.model}`;
    return {
      ok: true,
      message: `连接成功${modelNotice}${getOutboundProxyUrl() ? "（已自动使用系统代理）" : ""}`,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("OpenAI 连接失败")) throw error;
    throw new Error(`无法访问 OpenAI：${error instanceof Error ? error.message : "网络请求失败"}。请确认系统代理正在运行。`);
  }
}

export async function transcribeAudio(audioPath: string, signal?: AbortSignal) {
  const config = requireProvider("openai");
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, fetch: fetchOpenAI });
  const result = await client.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: "gpt-4o-transcribe",
    response_format: "json",
  }, { signal });
  return result.text || "";
}

export async function analyzeFramesWithOpenAI(input: {
  prompt: string;
  framePaths: string[];
  product: Product;
  qwenContext?: unknown;
  signal?: AbortSignal;
}) {
  const config = requireProvider("openai");
  const content: Array<Record<string, unknown>> = [
    {
      type: "input_text",
        text: `${input.prompt}\n\n${input.qwenContext ? `补充初审结果：${JSON.stringify(input.qwenContext)}` : ""}`,
    },
  ];
  input.framePaths.slice(0, MAX_ANALYSIS_FRAMES).forEach((framePath, index) => {
    const base64 = readFileSync(framePath).toString("base64");
    content.push({
      type: "input_image",
      image_url: `data:image/jpeg;base64,${base64}`,
      detail: index < 2 ? "high" : "low",
    });
  });
  const body = {
    model: config.model || "gpt-4.1-mini",
    input: [{ role: "user", content }],
    text: {
      format: { type: "json_schema", name: "viral_video_analysis", strict: true, schema: analysisSchema },
    },
  };
  const response = await fetchOpenAI(`${config.baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as Record<string, unknown> | undefined;
    throw new Error(String(error?.message || `OpenAI 分析失败（${response.status}）`));
  }
  return parseJsonLoose<AnalysisResult>(readTextFromModelResponse(payload));
}
