import { NextRequest, NextResponse } from "next/server";
import { runSubtitleBridgeLinkSubtitle } from "@/lib/feishu/automation";
import { safeBackgroundError, subtitleBridgeAuth } from "@/lib/feishu/webhook-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drop-in replacement for the Aliyun subtitle service's
 * POST /feishu/link-subtitle — same request/response shape. Combines the two
 * timestamped-text fields /feishu/tokscript-subtitle already wrote into a
 * bilingual SRT attachment.
 */
export async function POST(request: NextRequest) {
  const auth = subtitleBridgeAuth(request);
  if (auth !== true) {
    return NextResponse.json({ ok: false, error: auth === null ? "subtitle bridge secret is not configured" : "invalid secret" }, { status: auth === null ? 503 : 401 });
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    const appToken = String(body.app_token || "").trim();
    const tableId = String(body.table_id || "").trim();
    const recordId = String(body.record_id || "").trim();
    const transcriptField = String(body.transcript_field || "").trim();
    const translatedTranscriptField = String(body.translated_transcript_field || "").trim();
    const subtitleField = String(body.subtitle_field || "").trim();
    if (!appToken || !tableId || !recordId || !transcriptField || !translatedTranscriptField || !subtitleField) {
      return NextResponse.json({ ok: false, error: "缺少 app_token/table_id/record_id/transcript_field/translated_transcript_field/subtitle_field" }, { status: 400 });
    }
    await runSubtitleBridgeLinkSubtitle({ appToken, tableId, recordId, transcriptField, translatedTranscriptField, subtitleField });
    return NextResponse.json({ ok: true, uploaded: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: safeBackgroundError(error) }, { status: 500 });
  }
}
