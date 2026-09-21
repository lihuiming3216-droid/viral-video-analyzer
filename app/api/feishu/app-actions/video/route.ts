import { after, NextRequest, NextResponse } from "next/server";
import { createVideo, getFeishuFieldMapping, saveFeishuAutomationJob } from "@/lib/database";
import { assertChatgptActionRequest, getChatgptFeishuClient } from "@/lib/feishu/chatgpt-app";
import {
  fitAutomationFieldMapToTable,
  getBaseRecordFields,
  patchBaseRecord,
  resolveAutomationFields,
} from "@/lib/feishu/automation";
import { findOrCreateProduct } from "@/lib/feishu/product-lookup";
import { payloadFieldMap, safeBackgroundError } from "@/lib/feishu/webhook-shared";
import { enqueueVideos } from "@/lib/queue";
import { isTikTokUrl } from "@/lib/tiktok-product";

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
    const stored = await getFeishuFieldMapping(`${appToken}:${tableId}`).catch(() => null);
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

    after(async () => {
      try {
        const product = await findOrCreateProduct(resolved.productName || "飞书任务表待命名", resolved.pid);
        const video = await createVideo({
          productId: product.id,
          sourceType: "tiktok",
          sourceUrl: resolved.videoUrl,
          title: resolved.productName || "任务表视频",
          analysisMode: "transcript_only",
        });
        await saveFeishuAutomationJob({
          videoId: video.id,
          appToken,
          tableId,
          recordId,
          fieldMap: { ...fieldMap },
          credentialSource: "chatgpt",
        });
        await enqueueVideos([video.id]);
        if (fieldMap.status) {
          await patchBaseRecord(client, {
            appToken,
            tableId,
            recordId,
            fields: { [fieldMap.status]: "排队中" },
          });
        }
        console.info("[feishu-chatgpt-video] queued", { recordId, videoId: video.id, pid: product.pid });
      } catch (error) {
        console.error("[feishu-chatgpt-video] failed", { recordId, error: safeBackgroundError(error) });
      }
    });

    return NextResponse.json({ code: 0, msg: "已接收，正在处理视频", accepted: true });
  } catch (error) {
    const message = safeBackgroundError(error);
    const unauthorized = /身份|授权/.test(message);
    return NextResponse.json({ code: unauthorized ? 401 : 500, msg: message }, { status: unauthorized ? 401 : 500 });
  }
}
