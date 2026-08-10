import { NextRequest, NextResponse } from "next/server";
import { parsePublicProductPage } from "@/lib/product-parser";
import { canonicalTikTokProductUrl } from "@/lib/tiktok-product";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const pid = String(body.pid || "").trim();
    const productUrl = canonicalTikTokProductUrl(String(body.productUrl || "").trim(), pid);
    if (!productUrl) return NextResponse.json({ error: "缺少产品链接" }, { status: 400 });
    const parsed = await parsePublicProductPage(productUrl, {
      productName: String(body.productName || body.name || "").trim(),
      pid,
    });
    return NextResponse.json({ ok: true, parsed });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "商品页解析失败" }, { status: 500 });
  }
}
