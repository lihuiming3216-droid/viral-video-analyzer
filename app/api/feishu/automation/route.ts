import { after, NextRequest, NextResponse } from "next/server";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { handleFeishuAutomation, type FeishuAutomationFieldMap } from "@/lib/feishu/automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const activeProductJobs = new Set<string>();

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
    if (!Object.keys(fields).length) return NextResponse.json({ error: "没有收到多维表格字段" }, { status: 400 });
    const fieldMap = (body.fieldMap || body.field_map || {}) as Partial<FeishuAutomationFieldMap>;
    const jobKey = `${appToken}:${tableId}:${recordId}`;
    if (!activeProductJobs.has(jobKey)) {
      activeProductJobs.add(jobKey);
      after(async () => {
        const startedAt = Date.now();
        try {
          const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
          if (!channel) throw new Error("飞书应用尚未连接");
          const result = await handleFeishuAutomation({
            client: channel.rawClient,
            appToken,
            tableId,
            recordId,
            fields,
            fieldMap,
            // Background jobs must write the result themselves. The Feishu
            // HTTP action has already received its immediate acknowledgement.
            writeBack: true,
          });
          console.info("[feishu-automation] completed", {
            recordId,
            pid: result.pid,
            productName: result.productName,
            documentUrl: result.documentUrl,
            durationMs: Date.now() - startedAt,
            writeBackError: result.writeBackError,
          });
        } catch (error) {
          console.error("[feishu-automation] failed", {
            recordId,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          activeProductJobs.delete(jobKey);
        }
      });
    }
    return NextResponse.json({
      ok: true,
      accepted: true,
      status: activeProductJobs.has(jobKey) ? "后台处理中" : "任务已受理",
      fields: {},
      patch: {},
      productDocument: "",
      writeBack: true,
      writeBackError: "",
    }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "飞书自动化处理失败" }, { status: 500 });
  }
}
