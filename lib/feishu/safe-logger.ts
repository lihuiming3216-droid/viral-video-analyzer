import type { Logger } from "@larksuiteoapi/node-sdk";

/** SDK transport errors contain request headers and tokens. Emit only codes. */
export function safeSdkLogValues(values: unknown[]): unknown[] {
  return values.flatMap(value => {
    if (Array.isArray(value)) return safeSdkLogValues(value);
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const response = item.response as { status?: unknown; data?: { code?: unknown } } | undefined;
    return [{
      ...(typeof item.code === "string" && /^E[A-Z_]{2,40}$/.test(item.code) ? { code: item.code } : {}),
      ...(typeof response?.status === "number" ? { status: response.status } : {}),
      ...(typeof response?.data?.code === "number" ? { apiCode: response.data.code } : {}),
    }];
  });
}

export const safeFeishuLogger: Logger = {
  error: (...values: unknown[]) => console.error("Feishu SDK error", ...safeSdkLogValues(values)),
  warn: (...values: unknown[]) => console.warn("Feishu SDK warning", ...safeSdkLogValues(values)),
  info: () => {}, debug: () => {}, trace: () => {},
};
