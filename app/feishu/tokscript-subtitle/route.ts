import { NextRequest, NextResponse } from "next/server";
import { runSubtitleBridgeTokScriptTimestamps } from "@/lib/feishu/automation";
import { safeBackgroundError, subtitleBridgeAuth } from "@/lib/feishu/webhook-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drop-in replacement for the Aliyun subtitle service's
 * POST /feishu/tokscript-subtitle — same request/response shape. Fetches
 * TokScript's segment timestamps for the original TikTok link and writes the
 * two plain-text timestamped fields (原口播/中文 pairs consumed later by
 * /feishu/link-subtitle).
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
    const videoField = String(body.video_field || "").trim();
    const transcriptField = String(body.transcript_field || "").trim();
    const translatedTranscriptField = String(body.translated_transcript_field || "").trim();
    if (!appToken || !tableId || !recordId || !videoField || !transcriptField || !translatedTranscriptField) {
      return NextResponse.json({ ok: false, error: "缺少 app_token/table_id/record_id/video_field/transcript_field/translated_transcript_field" }, { status: 400 });
    }
    await runSubtitleBridgeTokScriptTimestamps({ appToken, tableId, recordId, videoField, transcriptField, translatedTranscriptField });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: safeBackgroundError(error) }, { status: 500 });
  }
}
