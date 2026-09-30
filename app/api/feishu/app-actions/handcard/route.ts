import { after, NextRequest, NextResponse } from "next/server";
import { getFeishuFieldMapping } from "@/lib/database";
import { assertChatgptActionRequest, getChatgptFeishuClient } from "@/lib/feishu/chatgpt-app";
import {
  fitAutomationFieldMapToTable,
  getBaseRecordFields,
} from "@/lib/feishu/automation";
import { payloadFieldMap, safeBackgroundError } from "@/lib/feishu/webhook-shared";
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
      kind: "handcard",
    });

    const client = getChatgptFeishuClient();
    const stored = await getFeishuFieldMapping(`${appToken}:${tableId}`);
    const requested = payloadFieldMap(body.fieldMap || body.field_map);
    const fieldMap = await fitAutomationFieldMapToTable(client, {
      appToken,
      tableId,
      fieldMap: { ...stored?.fieldMap, ...requested },
    });
    if (!fieldMap.productDocument) {
      return NextResponse.json({ code: 400, msg: "这张表缺少“产品手卡”或“产品文档”字段" }, { status: 400 });
    }
    const rowFields = await getBaseRecordFields(client, { appToken, tableId, recordId });
    // The card button only creates/fills the card. A video link in the same row
    // belongs to the separate video action and must not be queued by this click.
    const productFields = { ...rowFields };
    for (const name of new Set([fieldMap.videoUrl, "视频链接", "样片链接"])) {
      if (name) delete productFields[name];
    }

    const receipt = await claimFeishuRequest(request.headers, body, ["handcard-app", appToken, tableId, recordId], { fieldMap: requested },
      { kind: "handcard", credentialSource: "chatgpt", appToken, tableId, recordId, fields: productFields, fieldMap: { ...fieldMap, videoUrl: "" } });
    if (receipt?.duplicate) return NextResponse.json(feishuRequestReplay(receipt));
    after(() => runFeishuInboxPass());
    return NextResponse.json({ code: 0, msg: "已接收，正在补录手卡", accepted: true, jobId: receipt?.id,
      deduplication: receipt?.identified ? "invocation" : "request_id_missing" });
  } catch (error) {
    const message = safeBackgroundError(error);
    const unauthorized = /身份|授权/.test(message);
    const status = error instanceof FeishuRequestIdentityError ? error.status : unauthorized ? 401 : 500;
    return NextResponse.json({ code: status, msg: message }, { status });
  }
}
