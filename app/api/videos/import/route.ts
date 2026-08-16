import { NextRequest, NextResponse } from "next/server";
import { createVideo, getProduct } from "@/lib/database";
import { enqueueVideos } from "@/lib/queue";
import { isTikTokUrl } from "@/lib/tiktok-product";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const productId = String(body.productId || "");
    const urls: string[] = Array.isArray(body.urls) ? body.urls.map(String).map((url: string) => url.trim()).filter(Boolean) : [];
    if (!getProduct(productId)) return NextResponse.json({ error: "请先选择产品" }, { status: 400 });
    if (!urls.length || urls.length > 10) return NextResponse.json({ error: "一次请输入 1–10 条链接" }, { status: 400 });
    const invalid = urls.find((url: string) => !isTikTokUrl(url));
    if (invalid) return NextResponse.json({ error: `不是有效的 TikTok 链接：${invalid}` }, { status: 400 });
    const videos = urls.map((url: string, index: number) => {
      return createVideo({ productId, sourceType: "tiktok", sourceUrl: url, title: `待分析视频 ${index + 1}` });
    });
    enqueueVideos(videos.map((video) => video.id));
    return NextResponse.json({ videos }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "导入失败" }, { status: 500 });
  }
}
