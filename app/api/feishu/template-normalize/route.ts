import { NextRequest, NextResponse } from "next/server";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { normalizeProductTemplate } from "@/lib/feishu/document";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const documentId = String(body.documentId || "").trim();
    if (!documentId) return NextResponse.json({ error: "缺少模板文档 ID" }, { status: 400 });
    const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
    if (!channel) return NextResponse.json({ error: "飞书应用尚未连接" }, { status: 400 });
    const result = await normalizeProductTemplate(channel.rawClient, documentId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "模板字段名更新失败" }, { status: 500 });
  }
}
