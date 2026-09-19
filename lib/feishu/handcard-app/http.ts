import "server-only";
import { NextResponse } from "next/server";
import { HandcardAppError } from "@/lib/feishu/handcard-app/core";

export const privateHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

export function appError(error: unknown) {
  return NextResponse.json({ error: error instanceof HandcardAppError ? error.message : "暂时无法完成，请稍后重试；仍失败时请联系管理员。" },
    { status: error instanceof HandcardAppError ? error.status : 500, headers: privateHeaders });
}

const requests = new Map<string, { count: number; expires: number }>();
export function rateLimit(key: string) {
  const now = Date.now();
  if (requests.size >= 2048) {
    for (const [key, value] of requests) if (value.expires <= now) requests.delete(key);
    if (requests.size >= 2048) throw new HandcardAppError("使用人数较多，请稍后再试。", 429);
  }
  const current = requests.get(key);
  if (current && current.expires > now) {
    if (current.count >= 20) throw new HandcardAppError("操作过于频繁，请一分钟后再试。", 429);
    current.count++;
  } else requests.set(key, { count: 1, expires: now + 60_000 });
}

export async function smallJson(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new HandcardAppError("请求格式不正确。", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new HandcardAppError("请求内容为空。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new HandcardAppError("请求内容过长。", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HandcardAppError("请求内容不是有效的对象。"); }
}
