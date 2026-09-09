import "server-only";

import type { NextRequest } from "next/server";
import type { FeishuAutomationFieldMap } from "@/lib/feishu/automation";

/** Shared by every /api/feishu/* webhook that Base automations POST into. */
export function automationAuth(request: NextRequest, body: Record<string, unknown>) {
  const expected = process.env.FEISHU_AUTOMATION_WEBHOOK_SECRET?.trim();
  if (!expected) return null;
  return request.headers.get("x-feishu-automation-secret") === expected
    || String(body.secret || "") === expected;
}

/**
 * Shared by the three /feishu/(subtitle|tokscript-subtitle|link-subtitle)
 * routes — deliberately its own secret/header name (X-Subtitle-Secret)
 * matching the Aliyun subtitle service these replace, so migrating a Base
 * automation's "发送HTTP请求" action is only ever a URL host change, never a
 * header/body edit too.
 */
export function subtitleBridgeAuth(request: NextRequest) {
  const expected = process.env.FEISHU_SUBTITLE_BRIDGE_SECRET?.trim();
  if (!expected) return null;
  return request.headers.get("x-subtitle-secret") === expected;
}

export function payloadFields(body: Record<string, unknown>) {
  const direct = body.fields;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  const record = body.record;
  if (record && typeof record === "object") {
    const fields = (record as Record<string, unknown>).fields;
    if (fields && typeof fields === "object" && !Array.isArray(fields)) return fields as Record<string, unknown>;
  }
  const data = body.data;
  if (data && typeof data === "object") {
    const nested = (data as Record<string, unknown>).record;
    if (nested && typeof nested === "object") {
      const fields = (nested as Record<string, unknown>).fields;
      if (fields && typeof fields === "object" && !Array.isArray(fields)) return fields as Record<string, unknown>;
    }
  }
  const controlKeys = new Set(["appToken", "app_token", "tableId", "table_id", "recordId", "record_id", "secret", "fieldMap", "field_map"]);
  const directFields = Object.fromEntries(Object.entries(body).filter(([key]) => !controlKeys.has(key)));
  return directFields;
}

export function payloadFieldMap(value: unknown): Partial<FeishuAutomationFieldMap> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Partial<FeishuAutomationFieldMap>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Partial<FeishuAutomationFieldMap>
      : {};
  } catch {
    return {};
  }
}

export function safeBackgroundError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "飞书自动化处理失败");
  return message
    .replace(/\bauthorization\s*:\s*(?:bearer|basic)?\s*\S+/gi, "[已隐藏]")
    .replace(/\bbearer\s+\S+/gi, "[已隐藏]")
    .replace(/(?:api[_ -]?key|app[_ -]?secret|webhook[_ -]?secret)\s*[:=]?\s*\S+/gi, "[已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360) || "飞书自动化处理失败";
}
