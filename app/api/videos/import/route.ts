import { NextRequest, NextResponse } from "next/server";
import { createVideo, getProduct, getVideoBySourceUrl, updateVideo } from "@/lib/database";
import { enqueueVideos } from "@/lib/queue";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const productId = String(body.productId || "");
    const urls: string[] = Array.isArray(body.urls) ? body.urls.map(String).map((url: string) => url.trim()).filter(Boolean) : [];
    if (!getProduct(productId)) return NextResponse.json({ error: "请先选择产品" }, { status: 400 });
    if (!urls.length || urls.length > 10) return NextResponse.json({ error: "一次请输入 1–10 条链接" }, { status: 400 });
    const invalid = urls.find((url: string) => {
      try {
        return !new URL(url).hostname.toLowerCase().includes("tiktok.com");
      } catch {
        return true;
      }
    });
    if (invalid) return NextResponse.json({ error: `不是有效的 TikTok 链接：${invalid}` }, { status: 400 });
    const enqueueIds = new Set<string>();
    const videos = urls.map((url: string, index: number) => {
      const duplicate = getVideoBySourceUrl(url);
      if (duplicate) {
        if (duplicate.status === "completed" || ["queued", "downloading", "transcribing", "extracting", "analyzing"].includes(duplicate.status)) {
          return updateVideo(duplicate.id, { product_id: productId })!;
        }
        enqueueIds.add(duplicate.id);
        return updateVideo(duplicate.id, { product_id: productId, error_message: null })!;
      }
      const video = createVideo({ productId, sourceType: "tiktok", sourceUrl: url, title: `待分析视频 ${index + 1}` });
      enqueueIds.add(video.id);
      return video;
    });
    enqueueVideos([...enqueueIds]);
    return NextResponse.json({ videos }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "导入失败" }, { status: 500 });
  }
}
