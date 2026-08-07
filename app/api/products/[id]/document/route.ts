import { NextRequest, NextResponse } from "next/server";
import { getProduct, getProductByPid } from "@/lib/database";
import { ensureProductDocument } from "@/lib/feishu/document";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const product = getProduct(id);
    if (!product) return NextResponse.json({ error: "产品不存在" }, { status: 404 });
    const samePid = product.pid ? getProductByPid(product.pid) : null;
    const target = samePid || product;
    const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
    if (!channel) return NextResponse.json({ error: "飞书应用尚未连接" }, { status: 400 });
    const result = await ensureProductDocument(channel.rawClient, target, body);
    return NextResponse.json({ ok: true, product: target, result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建产品文档失败" }, { status: 500 });
  }
}
