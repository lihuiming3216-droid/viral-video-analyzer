import "server-only";
import { getRawProviderSetting, saveProviderSetting } from "@/lib/database";
import { encryptSecret } from "@/lib/crypto";
import type { ProviderName } from "@/lib/types";
import { AiConfigurationError, validateAiBaseUrl } from "./types";

export async function saveSharedProvider(input: { provider: string; baseUrl: string; model: string; enabled: boolean; apiKey?: string; clearKey?: boolean }) {
  if (!["qwen", "openai", "tokscript"].includes(input.provider)) throw new AiConfigurationError("服务商无效");
  const provider = input.provider as ProviderName;
  const baseUrl = validateAiBaseUrl(input.baseUrl);
  const apiKey = input.apiKey?.trim() || "";
  if (apiKey && input.clearKey) throw new AiConfigurationError("填写新密钥和清除密钥不能同时选择");
  if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new AiConfigurationError("密钥格式不正确");
  const current = await getRawProviderSetting(provider);
  if (current?.encrypted_api_key && current.base_url !== baseUrl && !apiKey && !input.clearKey) {
    throw new AiConfigurationError("更换接口地址时请重新填写或明确清除密钥，避免把旧密钥发往新地址");
  }
  return saveProviderSetting({ provider, baseUrl, model: input.model.trim(), enabled: input.enabled,
    encryptedApiKey: input.clearKey ? null : apiKey ? encryptSecret(apiKey) : undefined });
}
