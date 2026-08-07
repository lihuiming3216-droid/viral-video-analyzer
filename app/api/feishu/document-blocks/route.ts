import { NextRequest, NextResponse } from "next/server";
import { getConnectedFeishuChannel, ensureFeishuConnection } from "@/lib/feishu/runtime";
import { listFeishuDocumentBlocks } from "@/lib/feishu/document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const documentId = request.nextUrl.searchParams.get("documentId")?.trim() || "";
    if (!documentId) return NextResponse.json({ error: "缺少文档 ID" }, { status: 400 });
    const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
    if (!channel) return NextResponse.json({ error: "飞书应用尚未连接" }, { status: 400 });
    const blockId = request.nextUrl.searchParams.get("blockId")?.trim() || "";
    if (blockId) {
      const response = await channel.rawClient.request({
        url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`,
        method: "GET",
        params: { document_revision_id: "-1" },
      });
      return NextResponse.json({ ok: true, block: response });
    }
    const blocks = await listFeishuDocumentBlocks(channel.rawClient, documentId);
    return NextResponse.json({ ok: true, blocks });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取文档结构失败" }, { status: 500 });
  }
}
