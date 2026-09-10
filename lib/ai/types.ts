export const AI_PURPOSES = ["product", "video", "translation"] as const;
export type AiPurpose = typeof AI_PURPOSES[number];
export type AiProvider = "qwen" | "openai" | "compatible";
export type AiSettings = {
  purpose: AiPurpose;
  provider: AiProvider;
  model: string;
  credentialSource: "shared" | "custom";
  baseUrl: string;
  retries: 0 | 1;
  videoAudioConfirmed: boolean;
};
export type AiRuntime = AiSettings & { apiKey: string };

export class AiConfigurationError extends Error {}

export const AI_LABELS: Record<AiPurpose, string> = {
  product: "商品基础资料", video: "手卡视频分析", translation: "中文翻译",
};

export function aiPurpose(value: unknown): AiPurpose {
  if (!AI_PURPOSES.includes(value as AiPurpose)) throw new AiConfigurationError("分析用途无效");
  return value as AiPurpose;
}

/** Only API roots: never accept credentials/query strings or local service URLs. */
export function validateAiBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AiConfigurationError("请填写完整的 HTTPS 接口根地址"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.includes(":") || /^\d+(?:\.\d+){3}$/.test(host)
    || /\/(?:chat\/completions|responses|models)\/?$/.test(url.pathname)) {
    throw new AiConfigurationError("请使用不含密钥和请求路径的 HTTPS 接口根地址，例如 https://example.com/v1");
  }
  return url.toString().replace(/\/+$/, "");
}

export function validateAiSettings(raw: AiSettings): AiSettings {
  const purpose = aiPurpose(raw.purpose);
  if (!["qwen", "openai", "compatible"].includes(raw.provider)) throw new AiConfigurationError("服务商无效");
  if (!["shared", "custom"].includes(raw.credentialSource)) throw new AiConfigurationError("密钥来源无效");
  if (raw.provider === "compatible" && raw.credentialSource !== "custom") throw new AiConfigurationError("自定义兼容接口必须单独填写地址和密钥");
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!model || model.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/.test(model)
    || /(?:https?|ftp):\/\/|^data:|sk-[A-Za-z0-9_-]{8,}/i.test(model)) throw new AiConfigurationError("模型名称为空或格式不正确，请勿在此填写密钥或网址");
  if (raw.retries !== 0 && raw.retries !== 1) throw new AiConfigurationError("额外重试次数只能是0或1，最多请求两次");
  const baseUrl = raw.credentialSource === "custom" ? validateAiBaseUrl(raw.baseUrl) : "";
  if (purpose === "video") {
    if (raw.provider === "openai") throw new AiConfigurationError("此视频入口要求完整MP4含原音轨；当前OpenAI适配不支持此输入，不能改用拆帧或口播代替");
    if (/^qwen3\.7-plus(?:-|$)/.test(model)) throw new AiConfigurationError("qwen3.7-plus用于商品图文，不作为已验证能听原音轨的视频模型");
    if (!raw.videoAudioConfirmed) throw new AiConfigurationError("请确认所选接口和模型支持完整MP4画面与原始音轨");
  }
  return { purpose, provider: raw.provider, model, credentialSource: raw.credentialSource, baseUrl,
    retries: raw.retries, videoAudioConfirmed: purpose === "video" && raw.videoAudioConfirmed };
}
