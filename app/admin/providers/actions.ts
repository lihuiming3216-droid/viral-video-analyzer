"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/require-admin";
import { saveAiSettings } from "@/lib/ai/settings";
import { saveSharedProvider } from "@/lib/ai/shared-settings";
import { AiConfigurationError, aiPurpose, type AiSettings } from "@/lib/ai/types";
import { testQwenConnection } from "@/lib/providers/qwen";
import { testTokScriptConnection } from "@/lib/providers/tokscript";

export async function saveProviderAction(_previous: ProviderTestResult | null, formData: FormData): Promise<ProviderTestResult> {
  await requireAdmin();
  const provider = String(formData.get("provider") || "");
  const baseUrl = String(formData.get("baseUrl") || "").trim();
  const model = String(formData.get("model") || "").trim();
  const enabled = formData.get("enabled") === "on";
  const apiKey = String(formData.get("apiKey") || "").trim();
  const clearKey = formData.get("clearKey") === "on";
  try {
    await saveSharedProvider({ provider, baseUrl, model, enabled, apiKey, clearKey });
    revalidatePath("/admin/providers");
    return { ok: true, message: "已保存；不会重跑历史任务" };
  } catch (error) { return { ok: false, error: error instanceof AiConfigurationError ? error.message : "保存失败，请检查后台配置" }; }
}

export async function saveAiPurposeAction(_previous: ProviderTestResult | null, formData: FormData): Promise<ProviderTestResult> {
  await requireAdmin();
  try {
    await saveAiSettings({
      purpose: aiPurpose(formData.get("purpose")), provider: String(formData.get("provider")) as AiSettings["provider"],
      model: String(formData.get("model") || ""), credentialSource: String(formData.get("credentialSource")) as AiSettings["credentialSource"],
      baseUrl: String(formData.get("baseUrl") || ""), retries: Number(formData.get("retries")) as 0 | 1,
      videoAudioConfirmed: formData.get("videoAudioConfirmed") === "on",
    }, { apiKey: String(formData.get("apiKey") || ""), clearKey: formData.get("clearKey") === "on" });
    revalidatePath("/admin/providers");
    return { ok: true, message: "已保存；新请求使用此配置，历史资料不自动重跑" };
  } catch (error) { return { ok: false, error: error instanceof AiConfigurationError ? error.message : "保存失败，请检查数据库连接" }; }
}

export interface ProviderTestResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export async function testProviderAction(_prev: ProviderTestResult | null, formData: FormData): Promise<ProviderTestResult> {
  await requireAdmin();
  const provider = String(formData.get("provider") || "");
  try {
    const result = provider === "tokscript"
      ? await testTokScriptConnection()
      : provider === "qwen"
        ? await testQwenConnection()
        : { ok: false, message: "未知的 provider" };
    revalidatePath("/admin/providers");
    return { ok: result.ok, message: result.message };
  } catch (error) {
    revalidatePath("/admin/providers");
    return { ok: false, error: error instanceof AiConfigurationError ? error.message : "连接检查失败，请核对服务商地址、地域和密钥" };
  }
}
