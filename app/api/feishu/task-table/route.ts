import { after, NextRequest, NextResponse } from "next/server";
import { getFeishuFieldMapping } from "@/lib/database";
import { resolveAutomationFields } from "@/lib/feishu/automation";
import { automationAuth, payloadFieldMap, payloadFields, safeBackgroundError } from "@/lib/feishu/webhook-shared";
import { isTikTokUrl } from "@/lib/tiktok-product";
import { claimFeishuRequest, feishuRequestReplay, FeishuRequestIdentityError } from "@/lib/feishu/request-dedup";
import { runFeishuInboxPass } from "@/lib/feishu/inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Task-table videos remain transcript_only: files, TokScript text and translation, no full-video analysis. */
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await request.json() as Record<string, unknown>
      : Object.fromEntries((await request.formData()).entries()) as Record<string, unknown>;
    const auth = automationAuth(request, body);
    if (auth === null) return NextResponse.json({ error: "云端尚未配置自动化接口密钥" }, { status: 503 });
    if (!auth) return NextResponse.json({ error: "自动化接口密钥不正确" }, { status: 401 });
    const appToken = String(body.appToken || body.app_token || "").trim();
    const tableId = String(body.tableId || body.table_id || "").trim();
    const recordId = String(body.recordId || body.record_id || "").trim();
    if (!appToken || !tableId || !recordId) return NextResponse.json({ error: "缺少 appToken、tableId 或 recordId" }, { status: 400 });
    const fields = payloadFields(body);
    const stored = await getFeishuFieldMapping(`${appToken}:${tableId}`);
    const requested = payloadFieldMap(body.fieldMap || body.field_map);
    const resolved = resolveAutomationFields(fields, { ...stored?.fieldMap, ...requested }, stored?.aliases);
    if (!resolved.videoUrl || !isTikTokUrl(resolved.videoUrl)) return NextResponse.json({ error: "这一行没有有效的 TikTok 视频链接" }, { status: 400 });
    const receipt = await claimFeishuRequest(request.headers, body, ["video-webhook", appToken, tableId, recordId], { fields, fieldMap: requested },
      { kind: "video", credentialSource: "primary", appToken, tableId, recordId, fields, fieldMap: resolved.map });
    if (receipt?.duplicate) return NextResponse.json(feishuRequestReplay(receipt));
    after(() => runFeishuInboxPass());
    return NextResponse.json({ code: 0, msg: "success", data: { accepted: true, jobId: receipt?.id,
      status: "后台处理中", deduplication: receipt?.identified ? "invocation" : "request_id_missing" } });
  } catch (error) {
    return NextResponse.json({ error: safeBackgroundError(error) }, { status: error instanceof FeishuRequestIdentityError ? error.status : 500 });
  }
}
