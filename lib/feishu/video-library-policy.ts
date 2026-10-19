import { createHash } from "node:crypto";

export const VIDEO_LIBRARY_FIELDS = {
  source: "视频链接", transcript: "原口播", translation: "中文翻译", file: "文件",
  status: "处理状态", error: "失败原因",
} as const;
export const VIDEO_LIBRARY_OUTPUTS = [VIDEO_LIBRARY_FIELDS.transcript, VIDEO_LIBRARY_FIELDS.translation, VIDEO_LIBRARY_FIELDS.file];
export const VIDEO_LIBRARY_SCOPE = { appToken: "GujZbD0psaRxBrs6WSJc5d6anud", tableId: "tblgmuFeWjhWXfRd" } as const;

export function libraryLink(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(libraryLink).find(Boolean) || "";
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return libraryLink(object.link || object.url || object.text || object.value);
  }
  return "";
}

export function libraryEventTime(value: unknown) {
  if (Array.isArray(value) && value.length === 1) return libraryEventTime(value[0]);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return libraryEventTime(object.timestamp ?? object.value ?? object.text);
  }
  const number = typeof value === "number" || typeof value === "string" && /^\d{10,13}$/.test(value)
    ? Number(value) : NaN;
  // Only explicit offsets are accepted for dates; never use the host timezone.
  const milliseconds = Number.isFinite(number) ? number < 1e12 ? number * 1_000 : number
    : typeof value === "string" && /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < Date.UTC(2025, 0, 1) || milliseconds > Date.now() + 60_000) {
    throw new Error("缺少可核验的视频链接修改时间，请检查自动化的事件时间参数");
  }
  return milliseconds;
}

export const libraryDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Compare API-shaped text and attachment values without their expiring URLs. */
export function libraryFieldValue(value: unknown): unknown {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) {
    if (value.some(item => item && typeof item === "object" && "file_token" in item)) {
      return value.map(item => String((item as Record<string, unknown>)?.file_token || "")).filter(Boolean).sort();
    }
    if (value.every(item => item && typeof item === "object" && "text" in item)) return value.map(item => String((item as Record<string, unknown>).text || "")).join("");
    return value.length ? value.map(libraryFieldValue) : "";
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if ("text" in object) return String(object.text || "");
  }
  return value;
}

export function librarySameValue(left: unknown, right: unknown) {
  return JSON.stringify(libraryFieldValue(left)) === JSON.stringify(libraryFieldValue(right));
}

export function libraryOutputSnapshot(fields: Record<string, unknown>) {
  return Object.fromEntries(VIDEO_LIBRARY_OUTPUTS.map(name => [name, fields[name] ?? (name === VIDEO_LIBRARY_FIELDS.file ? [] : "")]));
}

export function libraryOwnedPatch(
  current: Record<string, unknown>, owned: Record<string, unknown>, proposed: Record<string, unknown>,
) {
  const fields: Record<string, unknown> = {}, conflicts: string[] = [];
  for (const [name, value] of Object.entries(proposed)) {
    if (!VIDEO_LIBRARY_OUTPUTS.includes(name as typeof VIDEO_LIBRARY_OUTPUTS[number])) continue;
    if (librarySameValue(current[name], value)) continue;
    if (!librarySameValue(current[name], owned[name])) { conflicts.push(name); continue; }
    fields[name] = value;
  }
  return { fields, conflicts };
}
