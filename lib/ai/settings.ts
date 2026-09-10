import "server-only";
import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db/pool";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getQwenPurposeModel } from "@/lib/database";
import { getProviderConfig } from "@/lib/provider-config";
import { AI_PURPOSES, AiConfigurationError, validateAiBaseUrl, validateAiSettings, type AiPurpose, type AiRuntime, type AiSettings } from "./types";

interface SettingRow extends RowDataPacket { config_json: AiSettings | string; encrypted_api_key: string | null }

async function readSetting(purpose: AiPurpose) {
  const db = await getPool();
  const [rows] = await db.execute<SettingRow[]>("SELECT config_json,encrypted_api_key FROM ai_purpose_settings WHERE purpose=?", [purpose]);
  return rows[0];
}

function storedConfig(row: SettingRow, purpose: AiPurpose) {
  try {
    const config = validateAiSettings(typeof row.config_json === "string" ? JSON.parse(row.config_json) : row.config_json);
    if (config.purpose !== purpose) throw new Error("purpose mismatch");
    return config;
  }
  catch { throw new AiConfigurationError("已保存的模型设置无效，请在后台修正；不会自动换模型"); }
}

async function initialConfig(purpose: AiPurpose): Promise<AiSettings> {
  // Read legacy selections once per new task until an explicit setting is saved.
  // DB errors propagate: an outage must never silently choose a different model.
  let model = "qwen3.7-plus";
  if (purpose === "translation") model = await getQwenPurposeModel("translation") || "qwen-plus";
  if (purpose === "video") {
    const shared = await getProviderConfig("qwen");
    model = process.env.QWEN_VIDEO_MODEL?.trim() || await getQwenPurposeModel("product_doc") || shared.model || "qwen3.5-omni-plus";
  }
  return { purpose, provider: "qwen", model, credentialSource: "shared", baseUrl: "",
    retries: purpose === "video" ? 1 : 0, videoAudioConfirmed: purpose === "video" && /^qwen(?:3\.5-omni-(?:plus|flash)|3-omni-flash)(?:-|$)/.test(model) };
}

export async function getAiSettings(purpose: AiPurpose) {
  const row = await readSetting(purpose);
  return { config: row ? storedConfig(row, purpose) : await initialConfig(purpose), hasCustomKey: Boolean(row?.encrypted_api_key), saved: Boolean(row) };
}

export async function listAiSettings() {
  return Promise.all(AI_PURPOSES.map(getAiSettings));
}

export async function requireAiRuntime(purpose: AiPurpose): Promise<AiRuntime> {
  const row = await readSetting(purpose);
  const config = validateAiSettings(row ? storedConfig(row, purpose) : await initialConfig(purpose));
  if (config.credentialSource === "custom") {
    const apiKey = decryptSecret(row?.encrypted_api_key);
    if (!apiKey) throw new AiConfigurationError("该用途尚未配置独立密钥，请在后台填写");
    return { ...config, apiKey };
  }
  if (config.provider === "openai") {
    const shared = await getProviderConfig("openai");
    const baseUrl = validateAiBaseUrl(shared.baseUrl);
    // Legacy environment credentials must never travel to a newly entered gateway.
    const apiKey = shared.apiKey || (baseUrl === "https://api.openai.com/v1" ? process.env.OPENAI_API_KEY?.trim() : "");
    if (!shared.enabled || !apiKey) throw new AiConfigurationError("请配置并启用共享OpenAI密钥");
    return { ...config, baseUrl, apiKey };
  }
  const shared = await getProviderConfig("qwen");
  if (!shared.enabled || !shared.apiKey) throw new AiConfigurationError("请配置并启用共享Qwen密钥，或为该用途填写独立配置");
  return { ...config, baseUrl: validateAiBaseUrl(shared.baseUrl), apiKey: shared.apiKey };
}

export async function saveAiSettings(raw: AiSettings, key: { apiKey?: string; clearKey?: boolean }) {
  const config = validateAiSettings(raw);
  const apiKey = key.apiKey?.trim() || "";
  if (apiKey && key.clearKey) throw new AiConfigurationError("填写新密钥和清除密钥不能同时选择");
  if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new AiConfigurationError("密钥格式不正确");
  if (config.credentialSource === "shared" && apiKey) throw new AiConfigurationError("沿用共享密钥时不要填写独立密钥");
  const db = await getPool();
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<SettingRow[]>("SELECT config_json,encrypted_api_key FROM ai_purpose_settings WHERE purpose=? FOR UPDATE", [config.purpose]);
    const previous = rows[0];
    const prior = previous ? storedConfig(previous, config.purpose) : null;
    const destinationChanged = prior && (prior.provider !== config.provider || prior.baseUrl !== config.baseUrl || prior.credentialSource !== config.credentialSource);
    if (config.credentialSource === "custom" && destinationChanged && !apiKey && !key.clearKey && previous?.encrypted_api_key) {
      throw new AiConfigurationError("更换接口地址或服务商时，请重新填写密钥或明确清除旧密钥，避免把旧密钥发往新地址");
    }
    const encrypted = key.clearKey ? null : apiKey ? encryptSecret(apiKey) : previous?.encrypted_api_key || null;
    await connection.execute(
      `INSERT INTO ai_purpose_settings(purpose,config_json,encrypted_api_key,updated_at) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE config_json=VALUES(config_json),encrypted_api_key=VALUES(encrypted_api_key),updated_at=VALUES(updated_at)`,
      [config.purpose, JSON.stringify(config), encrypted, new Date().toISOString()],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally { connection.release(); }
}
