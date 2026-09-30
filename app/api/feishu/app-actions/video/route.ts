import { after, NextRequest, NextResponse } from "next/server";
import { getFeishuFieldMapping } from "@/lib/database";
import { assertChatgptActionRequest, getChatgptFeishuClient } from "@/lib/feishu/chatgpt-app";
import {
  fitAutomationFieldMapToTable,
  getBaseRecordFields,
  resolveAutomationFields,
} from "@/lib/feishu/automation";
import { payloadFieldMap, safeBackgroundError } from "@/lib/feishu/webhook-shared";
import { isTikTokUrl } from "@/lib/tiktok-product";
import { claimFeishuRequest, feishuRequestReplay, FeishuRequestIdentityError } from "@/lib/feishu/request-dedup";

import { runFeishuInboxPass } from "@/lib/feishu/inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function coordinate(body: Record<string, unknown>, camel: string, snake: string) {
  return String(body[camel] || body[snake] || "").trim();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const appToken = coordinate(body, "appToken", "app_token");
    const tableId = coordinate(body, "tableId", "table_id");
    const recordId = coordinate(body, "recordId", "record_id");
    if (!appToken || !tableId || !recordId) {
      return NextResponse.json({ code: 400, msg: "飞书没有提供当前多维表格或当前行" }, { status: 400 });
    }
    await assertChatgptActionRequest({
      authorization: request.headers.get("authorization"),
      packId: String(body.packId || ""),
      extensionId: String(body.extensionId || ""),
      kind: "video",
    });

    const client = getChatgptFeishuClient();
    const stored = await getFeishuFieldMapping(`${appToken}:${tableId}`);
    const requested = payloadFieldMap(body.fieldMap || body.field_map);
    const fieldMap = await fitAutomationFieldMapToTable(client, {
      appToken,
      tableId,
      fieldMap: { ...stored?.fieldMap, ...requested },
    });
    const fields = await getBaseRecordFields(client, { appToken, tableId, recordId });
    const resolved = resolveAutomationFields(fields, fieldMap, stored?.aliases);
    if (!resolved.videoUrl || !isTikTokUrl(resolved.videoUrl)) {
      return NextResponse.json({ code: 400, msg: "这一行没有有效的 TikTok 视频链接" }, { status: 400 });
    }
    if (![fieldMap.videoFile, fieldMap.transcript, fieldMap.translation].some(Boolean)) {
      return NextResponse.json({ code: 400, msg: "这张表没有视频文件、原口播或中文翻译字段" }, { status: 400 });
    }

    const receipt = await claimFeishuRequest(request.headers, body, ["video-app", appToken, tableId, recordId], { fieldMap: requested },
      { kind: "video", credentialSource: "chatgpt", appToken, tableId, recordId, fields: fields, fieldMap: resolved.map });
    if (receipt?.duplicate) return NextResponse.json(feishuRequestReplay(receipt));
    after(() => runFeishuInboxPass());
    return NextResponse.json({ code: 0, msg: "已接收，正在处理视频", accepted: true, jobId: receipt?.id,
      deduplication: receipt?.identified ? "invocation" : "request_id_missing" });
  } catch (error) {
    const message = safeBackgroundError(error);
    const unauthorized = /身份|授权/.test(message);
    const status = error instanceof FeishuRequestIdentityError ? error.status : unauthorized ? 401 : 500;
    return NextResponse.json({ code: status, msg: message }, { status });
  }
}
