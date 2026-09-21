import { after, NextRequest, NextResponse } from "next/server";
import { getFeishuFieldMapping } from "@/lib/database";
import { assertChatgptActionRequest, getChatgptFeishuClient } from "@/lib/feishu/chatgpt-app";
import {
  fitAutomationFieldMapToTable,
  getBaseRecordFields,
  handleFeishuAutomation,
  updateProductCardStatus,
} from "@/lib/feishu/automation";
import { payloadFieldMap, safeBackgroundError } from "@/lib/feishu/webhook-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function coordinate(body: Record<string, unknown>, camel: string, snake: string) {
  return String(body[camel] || body[snake] || "").trim();
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json() as Record<string, unknown>;
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
    const stored = await getFeishuFieldMapping(`${appToken}:${tableId}`).catch(() => null);
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

    after(async () => {
      const startedAt = Date.now();
      try {
        const result = await handleFeishuAutomation({
          client,
          appToken,
          tableId,
          recordId,
          fields: productFields,
          fieldMap,
          writeBack: true,
        });
        console.info("[feishu-chatgpt-handcard] completed", {
          recordId,
          pid: result.pid,
          documentReady: result.documentReady,
          durationMs: Date.now() - startedAt,
          writeBackError: result.writeBackError,
        });
      } catch (error) {
        const message = safeBackgroundError(error);
        try {
          if (fieldMap.productCardStatus) {
            await updateProductCardStatus({
              client,
              appToken,
              tableId,
              recordId,
              status: `失败：${message}`,
              fieldName: fieldMap.productCardStatus,
            });
          }
        } catch (writeError) {
          console.error("[feishu-chatgpt-handcard] status write-back failed", {
            recordId,
            error: safeBackgroundError(writeError),
          });
        }
        console.error("[feishu-chatgpt-handcard] failed", {
          recordId,
          durationMs: Date.now() - startedAt,
          error: message,
        });
      }
    });

    return NextResponse.json({ code: 0, msg: "已接收，正在补录手卡", accepted: true });
  } catch (error) {
    const message = safeBackgroundError(error);
    const unauthorized = /身份|授权/.test(message);
    return NextResponse.json({ code: unauthorized ? 401 : 500, msg: message }, { status: unauthorized ? 401 : 500 });
  }
}
