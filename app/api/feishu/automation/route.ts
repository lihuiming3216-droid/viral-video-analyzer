import { NextRequest, NextResponse } from "next/server";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { handleFeishuAutomation, type FeishuAutomationFieldMap } from "@/lib/feishu/automation";

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

function booleanInput(value: unknown) {
  return value === true || value === "true" || value === "1" || value === 1;
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
    const writeBack = booleanInput(body.writeBack ?? body.write_back);
    if (!appToken || !tableId || !recordId) return NextResponse.json({ error: "缺少 appToken、tableId 或 recordId" }, { status: 400 });
    if (!Object.keys(fields).length) return NextResponse.json({ error: "没有收到多维表格字段" }, { status: 400 });
    const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
    if (!channel) return NextResponse.json({ error: "飞书应用尚未连接" }, { status: 503 });
    const result = await handleFeishuAutomation({
      client: channel.rawClient,
      appToken,
      tableId,
      recordId,
      fields,
      fieldMap: (body.fieldMap || body.field_map || {}) as Partial<FeishuAutomationFieldMap>,
      writeBack,
    });
    const productDocument = result.patch[result.map.productDocument] || result.documentUrl || result.productDocument || "";
    const status = result.patch[result.map.status]
      || (productDocument ? "已生成产品手卡" : "无任务");
    return NextResponse.json({
      ok: true,
      status,
      fields: result.patch,
      patch: result.patch,
      productDocument,
      productUrl: result.patch[result.map.productUrl] || result.productUrl,
      pid: result.pid,
      productName: result.productName,
      analysis: result.patch[result.map.analysis] || "",
      translation: result.patch[result.map.translation] || "",
      writeBack,
      writeBackError: result.writeBackError || "",
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "飞书自动化处理失败" }, { status: 500 });
  }
}
