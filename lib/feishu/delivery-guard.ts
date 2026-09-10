/** Pure Base-delivery policy. No provider calls, authentication, or storage. */
export class FeishuDeliveryBlockedError extends Error {
  constructor(public reason: string, message: string) {
    super(message);
    this.name = "FeishuDeliveryBlockedError";
  }
}

export function permanentDeliveryFailure(error: unknown) {
  if (error instanceof FeishuDeliveryBlockedError) return error;
  const message = error instanceof Error ? error.message : String(error || "");
  if (/RecordIdNotFound/i.test(message)) return new FeishuDeliveryBlockedError("record_missing", "目标行不存在，已暂停写回");
  if (/FieldNameNotFound/i.test(message)) return new FeishuDeliveryBlockedError("field_missing", "目标字段不存在，请修正字段对应后恢复写回");
  return null;
}

export function fieldHasContent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.some(fieldHasContent);
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    if ("text" in item) return fieldHasContent(item.text) || fieldHasContent(item.link || item.url);
    return Object.values(item).some(fieldHasContent);
  }
  return true;
}

export function emptyFieldPatch(current: Record<string, unknown>, proposed: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(proposed).filter(([name, value]) => (
    name && fieldHasContent(value) && !fieldHasContent(current[name])
  )));
}

function linkText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(linkText).find(Boolean) || "";
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return linkText(item.link || item.url || item.text);
  }
  return "";
}

export function assertDeliverySource(sourceUrl: string, currentValue: unknown) {
  const normalize = (value: string) => {
    try {
      const url = new URL(value);
      const id = /\/@[^/]+\/video\/(\d+)\/?$/.exec(url.pathname)?.[1];
      return id && /(^|\.)tiktok\.com$/.test(url.hostname)
        ? `tiktok-video:${id}` : `${url.protocol}//${url.hostname}${url.pathname.replace(/\/$/, "")}`;
    } catch { return value; }
  };
  if (!sourceUrl || normalize(sourceUrl) !== normalize(linkText(currentValue))) {
    throw new FeishuDeliveryBlockedError("source_changed", "该行视频链接已变化，已停止旧任务写回");
  }
}

export function assertDeliveryFields(columns: string[], names: string[]) {
  const available = new Set(columns);
  if (names.some(name => name && !available.has(name))) {
    throw new FeishuDeliveryBlockedError("field_missing", "字段对应包含不存在的列，已暂停写回；请修正配置");
  }
}
