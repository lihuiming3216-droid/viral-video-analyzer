import { after, NextRequest, NextResponse } from "next/server";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import {
  handleFeishuAutomation,
  hydrateAutomationProductFields,
  resolveAutomationFields,
  updateProductCardStatus,
  type FeishuAutomationFieldMap,
} from "@/lib/feishu/automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function automationAuth(request: NextRequest, body: Record<string, unknown>) {
  const expected = process.env.FEISHU_AUTOMATION_WEBHOOK_SECRET?.trim();
  if (!expected) return null;
  return request.headers.get("x-feishu-automation-secret") === expected
    || String(body.secret || "") === expected;
}

function payloadFields(body: Record<string, unknown>) {
  const direct = body.fields;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  const record = body.record;
  if (record && typeof record === "object") {
    const fields = (record as Record<string, unknown>).fields;
    if (fields && typeof fields === "object" && !Array.isArray(fields)) return fields as Record<string, unknown>;
  }
  const data = body.data;
  if (data && typeof data === "object") {
    const nested = (data as Record<string, unknown>).record;
    if (nested && typeof nested === "object") {
      const fields = (nested as Record<string, unknown>).fields;
      if (fields && typeof fields === "object" && !Array.isArray(fields)) return fields as Record<string, unknown>;
    }
  }
  const controlKeys = new Set(["appToken", "app_token", "tableId", "table_id", "recordId", "record_id", "secret", "fieldMap", "field_map"]);
  const directFields = Object.fromEntries(Object.entries(body).filter(([key]) => !controlKeys.has(key)));
  return directFields;
}

function payloadFieldMap(value: unknown): Partial<FeishuAutomationFieldMap> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Partial<FeishuAutomationFieldMap>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Partial<FeishuAutomationFieldMap>
      : {};
  } catch {
    return {};
  }
}

function safeBackgroundError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "飞书自动化处理失败");
  return message
    .replace(/\bauthorization\s*:\s*(?:bearer|basic)?\s*\S+/gi, "[已隐藏]")
    .replace(/\bbearer\s+\S+/gi, "[已隐藏]")
    .replace(/(?:api[_ -]?key|app[_ -]?secret|webhook[_ -]?secret)\s*[:=]?\s*\S+/gi, "[已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360) || "飞书自动化处理失败";
}

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
    // per-Base-record lock across shell -> capture -> merge -> document sync,
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
        // hand-card URL inside handleFeishuAutomation. Product-page parsing
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
          if (channel && !jobFields[fieldMap.videoUrl || "视频链接"] && !jobFields["样片链接"]) {
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
    return NextResponse.json({
      ok: true,
      accepted: true,
      status: "后台处理中",
      fields: {},
      patch: {},
      productDocument: "",
      writeBack: true,
      writeBackError: "",
    }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: safeBackgroundError(error) }, { status: 500 });
  }
}
