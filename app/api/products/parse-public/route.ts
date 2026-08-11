import { NextRequest, NextResponse } from "next/server";
import { isExactTikTokProductSource, parsePublicProductPage, productIdFromOfficialTikTokPath } from "@/lib/product-parser";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const pid = String(body.pid || "").trim();
    const productUrl = String(body.productUrl || "").trim();
    if (!productUrl) return NextResponse.json({ error: "缺少产品链接" }, { status: 400 });
    const expectedPid = pid || productIdFromOfficialTikTokPath(productUrl);
    if (!isExactTikTokProductSource(productUrl, expectedPid)) {
      return NextResponse.json({ error: "产品链接必须是 HTTPS TikTok 官方商品详情页，且链接 PID 必须与商品ID一致" }, { status: 400 });
    }
    const parsed = await parsePublicProductPage(productUrl, {
      productName: String(body.productName || body.name || "").trim(),
      pid: expectedPid,
    });
    return NextResponse.json({ ok: true, parsed });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "商品页解析失败" }, { status: 500 });
  }
}
