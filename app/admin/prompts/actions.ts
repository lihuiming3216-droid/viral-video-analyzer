"use server";

import { revalidatePath } from "next/cache";
import { getPromptDebugCapture, savePromptTemplate } from "@/lib/database";
import {
  analyzeVideoWithQwen,
  TRANSCRIPT_TRANSLATION_PROMPT_SLUG,
  translateTranscriptWithQwen,
  type QwenRequestDiagnostic,
} from "@/lib/providers/qwen";
import { resolveMediaPath } from "@/lib/video-processing";

export async function saveTemplateAction(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const template = String(formData.get("template") || "");
  if (!slug || !template.trim()) return;
  await savePromptTemplate(slug, template);
  revalidatePath("/admin/prompts");
}

function renderTemplate(template: string, inputs: Record<string, unknown>) {
  return template
    .replaceAll("{{PRODUCT_JSON}}", JSON.stringify(inputs.product ?? null))
    .replaceAll("{{TIMELINE_JSON}}", JSON.stringify(inputs.timeline ?? null))
    .replaceAll("{{LEARNING_JSON}}", JSON.stringify(inputs.learningContext ?? null))
    .replaceAll("{{TRANSCRIPT_JSON}}", JSON.stringify(inputs.transcript ?? ""));
}

export interface PromptTestResult {
  ok: boolean;
  error?: string;
  renderedPrompt?: string;
  resultJson?: string;
  diagnostic?: QwenRequestDiagnostic;
  durationMs?: number;
}

export async function runPromptTestAction(_prev: PromptTestResult | null, formData: FormData): Promise<PromptTestResult> {
  const slug = String(formData.get("slug") || "");
  const template = String(formData.get("template") || "");
  const captureId = String(formData.get("captureId") || "");
  if (!captureId) return { ok: false, error: "请先选一条真实历史数据" };

  try {
    if (slug === TRANSCRIPT_TRANSLATION_PROMPT_SLUG) {
      // 口播翻译没有独立的 capture 表，直接把 captureId 输入框当作原文文本用。
      const transcript = captureId;
      const startedAt = Date.now();
      const translation = await translateTranscriptWithQwen({ transcript });
      return {
        ok: true,
        renderedPrompt: renderTemplate(template, { transcript }),
        resultJson: JSON.stringify({ translationZh: translation }, null, 2),
        durationMs: Date.now() - startedAt,
      };
    }

    const capture = await getPromptDebugCapture(captureId);
    if (!capture) return { ok: false, error: "这条历史数据已经找不到了" };
    if (!capture.qwenVideoPath) return { ok: false, error: "这条历史数据没有保留本地视频文件，无法重新请求" };
    const renderedPrompt = renderTemplate(template, capture.inputs);
    const localVideoPath = resolveMediaPath(capture.qwenVideoPath);
    let diagnostic: QwenRequestDiagnostic | undefined;
    const startedAt = Date.now();
    const purpose = capture.inputs.mode === "product_doc" ? "product_doc" : "full";
    const result = await analyzeVideoWithQwen({
      prompt: renderedPrompt,
      localVideoPath,
      purpose,
      onDiagnostic: (value) => { diagnostic = value; },
    });
    return {
      ok: true,
      renderedPrompt,
      resultJson: JSON.stringify(result, null, 2),
      diagnostic,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "测试请求失败" };
  }
}
