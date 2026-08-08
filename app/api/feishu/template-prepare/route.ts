import { NextRequest, NextResponse } from "next/server";
import { getConnectedFeishuChannel, ensureFeishuConnection } from "@/lib/feishu/runtime";
import {
  deleteFeishuChildRange,
  insertFeishuTableColumn,
  insertFeishuTextBlocks,
  insertProductPropsSection,
  updateFeishuTextBlock,
} from "@/lib/feishu/document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const documentId = String(body.documentId || "").trim();
    if (!documentId) return NextResponse.json({ error: "缺少文档 ID" }, { status: 400 });
    const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
    if (!channel) return NextResponse.json({ error: "飞书应用尚未连接" }, { status: 400 });

    if (body.insertTableColumn?.tableBlockId) {
      await insertFeishuTableColumn(
        channel.rawClient,
        documentId,
        String(body.insertTableColumn.tableBlockId),
        Number(body.insertTableColumn.columnIndex || 0),
      );
    }
    if (body.deleteChildren?.parentBlockId) {
      await deleteFeishuChildRange(
        channel.rawClient,
        documentId,
        String(body.deleteChildren.parentBlockId),
        Number(body.deleteChildren.startIndex),
        Number(body.deleteChildren.endIndex),
      );
    }

    let propsSection = null;
    if (body.insertPropsSection?.parentBlockId) {
      propsSection = await insertProductPropsSection(
        channel.rawClient,
        documentId,
        String(body.insertPropsSection.parentBlockId),
        Number(body.insertPropsSection.index || 0),
      );
    }

    for (const item of Array.isArray(body.updates) ? body.updates : []) {
      await updateFeishuTextBlock(
        channel.rawClient,
        documentId,
        String(item.blockId || ""),
        String(item.content || ""),
      );
    }

    let inserted: Array<Record<string, unknown>> = [];
    if (body.insert?.parentBlockId && Array.isArray(body.insert.contents)) {
      inserted = await insertFeishuTextBlocks(
        channel.rawClient,
        documentId,
        String(body.insert.parentBlockId),
        Number(body.insert.index || 0),
        body.insert.contents.map(String),
      );
    }
    return NextResponse.json({ ok: true, inserted, propsSection });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "准备模板失败" }, { status: 500 });
  }
}
