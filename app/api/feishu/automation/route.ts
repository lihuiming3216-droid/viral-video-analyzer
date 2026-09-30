import { after, NextRequest, NextResponse } from "next/server";
import { automationAuth, doubaoAutomationAuth, payloadFieldMap, payloadFields, safeBackgroundError } from "@/lib/feishu/webhook-shared";
import { claimFeishuRequest, feishuRequestReplay, FeishuRequestIdentityError } from "@/lib/feishu/request-dedup";
import { runFeishuInboxPass } from "@/lib/feishu/inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await request.json() as Record<string, unknown>
      : Object.fromEntries((await request.formData()).entries()) as Record<string, unknown>;
    const standardAuth = automationAuth(request, body);
    const doubaoAuth = doubaoAutomationAuth(request);
    const auth = standardAuth === true || doubaoAuth === true ? true
      : standardAuth === false || doubaoAuth === false ? false : null;
    if (auth === null) return NextResponse.json({ error: "云端尚未配置自动化接口密钥" }, { status: 503 });
    if (!auth) return NextResponse.json({ error: "自动化接口密钥不正确" }, { status: 401 });
    const appToken = String(body.appToken || body.app_token || "").trim();
    const tableId = String(body.tableId || body.table_id || "").trim();
    const recordId = String(body.recordId || body.record_id || "").trim();
    if (!appToken || !tableId || !recordId) return NextResponse.json({ error: "缺少 appToken、tableId 或 recordId" }, { status: 400 });
    const fields = payloadFields(body);
    const fieldMap = payloadFieldMap(body.fieldMap || body.field_map);
    const receipt = await claimFeishuRequest(request.headers, body, ["handcard-webhook", appToken, tableId, recordId], { fields, fieldMap },
      { kind: "handcard", credentialSource: "primary", appToken, tableId, recordId, fields, fieldMap });
    if (receipt?.duplicate) return NextResponse.json(feishuRequestReplay(receipt));
    // The complete input is already committed. This wake-up is an optimization,
    // not the only owner of an acknowledged task; startup/polling can recover it.
    after(() => runFeishuInboxPass());
    // Keep 200: the Base button can surface -8 for an asynchronous 202 response.
    return NextResponse.json({ code: 0, msg: "success", data: { accepted: true, jobId: receipt?.id,
      status: "后台处理中", deduplication: receipt?.identified ? "invocation" : "request_id_missing" } });
  } catch (error) {
    return NextResponse.json({ error: safeBackgroundError(error) }, { status: error instanceof FeishuRequestIdentityError ? error.status : 500 });
  }
}
