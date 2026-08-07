import "server-only";

import { decryptSecret } from "@/lib/crypto";
import { getRawProviderSetting } from "@/lib/database";
import type { ProviderName } from "@/lib/types";

export function getProviderConfig(provider: ProviderName) {
  const row = getRawProviderSetting(provider);
  if (!row) throw new Error(`没有找到 ${provider} 配置`);
  return {
    provider,
    apiKey: decryptSecret(row.encrypted_api_key ? String(row.encrypted_api_key) : ""),
    baseUrl: String(row.base_url || "").replace(/\/$/, ""),
    model: String(row.model || ""),
    enabled: Boolean(row.enabled),
  };
}

export function requireProvider(provider: ProviderName) {
  const config = getProviderConfig(provider);
  if (!config.enabled) throw new Error(`${provider} 已停用`);
  if (!config.apiKey) throw new Error(`请先在设置页配置 ${provider} API Key`);
  return config;
}
