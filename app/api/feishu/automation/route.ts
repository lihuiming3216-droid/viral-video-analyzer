import { after, NextRequest, NextResponse } from "next/server";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import {
  handleFeishuAutomation,
  hydrateAutomationProductFields,
  resolveAutomationFields,
  updateProductCardStatus,
  type FeishuAutomationFieldMap,
} from "@/lib/feishu/automation";
import { automationAuth, payloadFieldMap, payloadFields, safeBackgroundError } from "@/lib/feishu/webhook-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function hydrateMissingProductCardFields(input: {
  client: { request<T>(options: Record<string, unknown>): Promise<T> };
  appToken: string;
  tableId: string;
  recordId: string;
  fields: Record<string, unknown>;
  fieldMap: Partial<FeishuAutomationFieldMap>;
}) {
  const current = resolveAutomationFields(input.fields, input.fieldMap);
  if (current.productName && current.pid) return input.fields;

  const response = await input.client.request<{
    code?: number;
    msg?: string;
    data?: { record?: { fields?: Record<string, unknown> } };
  }>({
    url: `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/records/${encodeURIComponent(input.recordId)}`,
    method: "GET",
  });
  if (response.code && response.code !== 0) {
    throw new Error(response.msg || "读取飞书当前行产品名称和 PID 失败");
  }
  const latestFields = response.data?.record?.fields || {};
  return hydrateAutomationProductFields(input.fields, latestFields, input.fieldMap);
}

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await request.json() as Record<string, unknown>
      : Object.fromEntries((await request.formData()).entries()) as Record<string, unknown>;
    const auth = automationAuth(request, body);
    if (auth === null) return NextResponse.json({ error: "云端尚未配置自动化接口密钥" }, { status: 503 });
    if (!auth) return NextResponse.json({ error: "自动化接口密钥不正确" }, { status: 401 });
    const appToken = String(body.appToken || body.app_token || "").trim();
    const tableId = String(body.tableId || body.table_id || "").trim();
    const recordId = String(body.recordId || body.record_id || "").trim();
    const fields = payloadFields(body);
    if (!appToken || !tableId || !recordId) return NextResponse.json({ error: "缺少 appToken、tableId 或 recordId" }, { status: 400 });
    const fieldMap = payloadFieldMap(body.fieldMap || body.field_map);
    // Every accepted click schedules one refresh. The handler itself holds a
    // per-Base-record lock across shell -> PID cache -> document sync,
    // so concurrent clicks serialize without silently dropping a click.
    after(async () => {
      const startedAt = Date.now();
      let jobFields = fields;
      try {
        const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
        if (!channel) throw new Error("飞书应用尚未连接");
        jobFields = await hydrateMissingProductCardFields({
          client: channel.rawClient,
          appToken,
          tableId,
          recordId,
          fields,
          fieldMap,
        });
        // The first external write is deliberately the newly created/reused
        // hand-card URL inside handleFeishuAutomation. Product-data organization
        // and even status-column failures must come after the document exists.
        const result = await handleFeishuAutomation({
          client: channel.rawClient,
          appToken,
          tableId,
          recordId,
          fields: jobFields,
          fieldMap,
          // Background jobs must write the result themselves. The Feishu HTTP
          // action has already received its immediate acknowledgement.
          writeBack: true,
        });
        console.info("[feishu-automation] completed", {
          recordId,
          pid: result.pid,
          productName: result.productName,
          documentUrl: result.documentUrl,
          documentReady: result.documentReady,
          productCardStatus: result.productCardStatus,
          productCardWarning: result.productCardWarning,
          productRefreshError: result.productRefreshError,
          durationMs: Date.now() - startedAt,
          writeBackError: result.writeBackError,
        });
      } catch (error) {
        const message = safeBackgroundError(error);
        try {
          const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
          // Always write the failure here — this only runs when the whole
          // handler threw, meaning nothing else touched this row (a video URL
          // being present in the payload doesn't mean a video was actually
          // created; e.g. a missing-产品名称/PID failure throws before that
          // ever happens, and skipping the write left the row silently blank).
          if (channel) {
            await updateProductCardStatus({
              client: channel.rawClient,
              appToken,
              tableId,
              recordId,
              status: `失败：${message}`,
              fieldName: fieldMap.productCardStatus,
            });
          }
        } catch (writeBackError) {
          console.error("[feishu-automation] status write-back failed", {
            recordId,
            error: safeBackgroundError(writeBackError),
          });
        }
        console.error("[feishu-automation] failed", {
          recordId,
          durationMs: Date.now() - startedAt,
          error: message,
        });
      }
    });
    // Feishu's automation runner accepts any 2xx response, but the Base button
    // client can still surface its internal `-8` toast for an asynchronous 202
    // response. Return a conventional, minimal 200 success envelope instead.
    // The background job remains responsible for creating and writing the card.
    return NextResponse.json({
      code: 0,
      msg: "success",
      data: {
        accepted: true,
        status: "后台处理中",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: safeBackgroundError(error) }, { status: 500 });
  }
}
