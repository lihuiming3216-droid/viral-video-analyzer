import { NextRequest, NextResponse } from "next/server";
import { runSubtitleBridgeAudioSubtitle } from "@/lib/feishu/automation";
import { safeBackgroundError, subtitleBridgeAuth } from "@/lib/feishu/webhook-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drop-in replacement for the Aliyun subtitle service's POST /feishu/subtitle
 * — same request/response shape, so switching a Base automation's "发送HTTP
 * 请求" action here is only ever a URL host change. Transcribes the
 * employee-uploaded dub file itself (audio_field); unrelated to TokScript,
 * which only ever sees the original TikTok video.
 */
export async function POST(request: NextRequest) {
  if (subtitleBridgeAuth(request) === false) {
    return NextResponse.json({ ok: false, error: "invalid secret" }, { status: 401 });
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    const appToken = String(body.app_token || "").trim();
    const tableId = String(body.table_id || "").trim();
    const recordId = String(body.record_id || "").trim();
    const audioField = String(body.audio_field || "").trim();
    const subtitleField = String(body.subtitle_field || "").trim();
    const targetLanguage = String(body.target_language || "").trim();
    if (!appToken || !tableId || !recordId || !audioField || !subtitleField) {
      return NextResponse.json({ ok: false, error: "缺少 app_token/table_id/record_id/audio_field/subtitle_field" }, { status: 400 });
    }
    await runSubtitleBridgeAudioSubtitle({ appToken, tableId, recordId, audioField, subtitleField, targetLanguage });
    return NextResponse.json({ ok: true, uploaded: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: safeBackgroundError(error) }, { status: 500 });
  }
}
