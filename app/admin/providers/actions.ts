"use server";

import { revalidatePath } from "next/cache";
import { encryptSecret } from "@/lib/crypto";
import { saveProviderSetting, saveQwenPurposeModel } from "@/lib/database";
import { testQwenConnection } from "@/lib/providers/qwen";
import { testTokScriptConnection } from "@/lib/providers/tokscript";
import type { ProviderName } from "@/lib/types";
import { QWEN_PURPOSES } from "./qwen-purposes";

export async function saveProviderAction(formData: FormData) {
  const provider = String(formData.get("provider") || "") as ProviderName;
  const baseUrl = String(formData.get("baseUrl") || "").trim();
  const model = String(formData.get("model") || "").trim();
  const enabled = formData.get("enabled") === "on";
  const apiKey = String(formData.get("apiKey") || "").trim();
  const clearKey = formData.get("clearKey") === "on";
  await saveProviderSetting({
    provider,
    baseUrl,
    model,
    enabled,
    encryptedApiKey: clearKey ? null : apiKey ? encryptSecret(apiKey) : undefined,
  });
  revalidatePath("/admin/providers");
}

export async function saveQwenPurposeModelsAction(formData: FormData) {
  for (const { key } of QWEN_PURPOSES) {
    await saveQwenPurposeModel(key, String(formData.get(`purpose_${key}`) || ""));
  }
  revalidatePath("/admin/providers");
}

export interface ProviderTestResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export async function testProviderAction(_prev: ProviderTestResult | null, formData: FormData): Promise<ProviderTestResult> {
  const provider = String(formData.get("provider") || "");
  try {
    const result = provider === "tokscript"
      ? await testTokScriptConnection()
      : provider === "qwen"
        ? await testQwenConnection()
        : { ok: false, message: "未知的 provider" };
    revalidatePath("/admin/providers");
    return { ok: true, message: result.message };
  } catch (error) {
    revalidatePath("/admin/providers");
    return { ok: false, error: error instanceof Error ? error.message : "测试请求失败" };
  }
}
