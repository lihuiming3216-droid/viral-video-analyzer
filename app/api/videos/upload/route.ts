import { NextRequest, NextResponse } from "next/server";
import { createVideo, getProduct, updateVideo } from "@/lib/database";
import { enqueueVideos } from "@/lib/queue";
import { saveUploadedVideo } from "@/lib/video-processing";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const productId = String(form.get("productId") || "");
    const files = form.getAll("files").filter((file): file is File => file instanceof File && file.size > 0);
    if (!getProduct(productId)) return NextResponse.json({ error: "请先选择产品" }, { status: 400 });
    if (!files.length || files.length > 10) return NextResponse.json({ error: "一次请选择 1–10 个视频" }, { status: 400 });
    const videos = [];
    for (const file of files) {
      if (!file.type.startsWith("video/")) return NextResponse.json({ error: `${file.name} 不是视频文件` }, { status: 400 });
      const video = createVideo({ productId, sourceType: "upload", sourceFileName: file.name, title: file.name });
      const originalPath = await saveUploadedVideo(video.id, file);
      videos.push(updateVideo(video.id, { original_path: originalPath })!);
    }
    enqueueVideos(videos.map((video) => video.id));
    return NextResponse.json({ videos }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "上传失败" }, { status: 500 });
  }
}
