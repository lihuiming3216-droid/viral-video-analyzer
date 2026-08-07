import { NextRequest, NextResponse } from "next/server";
import { getConnectedFeishuChannel, ensureFeishuConnection } from "@/lib/feishu/runtime";
import { copyFeishuTemplateDocument } from "@/lib/feishu/document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const templateToken = String(body.templateToken || "").trim();
    const name = String(body.name || "产品文档模板测试副本").trim();
    const folderToken = String(body.folderToken || "").trim();
    if (!templateToken) return NextResponse.json({ error: "缺少模板文档 Token" }, { status: 400 });

    const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
    if (!channel) return NextResponse.json({ error: "飞书应用尚未连接" }, { status: 400 });

    const result = await copyFeishuTemplateDocument(channel.rawClient, { templateToken, name, folderToken });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "复制模板失败" }, { status: 500 });
  }
}
