import { NextRequest, NextResponse } from "next/server";
import { createProduct, getProductByPid } from "@/lib/database";
import { syncProductDocument } from "@/lib/feishu/product-doc-sync";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: NextRequest, body: Record<string, unknown>) {
  const expected = process.env.FEISHU_AUTOMATION_WEBHOOK_SECRET?.trim();
  if (!expected) return null;
  return request.headers.get("x-feishu-automation-secret") === expected
    || String(body.secret || "") === expected;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const auth = authorized(request, body);
    if (auth === null) return NextResponse.json({ error: "云端尚未配置同步接口密钥" }, { status: 503 });
    if (!auth) return NextResponse.json({ error: "同步接口密钥不正确" }, { status: 401 });

    const documentId = String(body.documentId || "").trim();
    const name = String(body.name || "").trim();
    const pid = String(body.pid || "").trim();
    const productUrl = String(body.productUrl || "").trim();
    if (!documentId || !name || !pid || !productUrl) {
      return NextResponse.json({ error: "产品文档同步参数不完整" }, { status: 400 });
    }
    const product = getProductByPid(pid) || createProduct({ name, pid, productUrl });
    const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
    if (!channel) return NextResponse.json({ error: "飞书应用尚未连接" }, { status: 503 });
    const result = await syncProductDocument(channel.rawClient, { ...product, documentId });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "产品文档同步失败" }, { status: 500 });
  }
}
