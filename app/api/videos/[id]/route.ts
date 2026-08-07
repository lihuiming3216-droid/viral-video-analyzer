import { NextRequest, NextResponse } from "next/server";
import { deleteVideoRecord, getProduct, getVideo, updateVideo } from "@/lib/database";
import { learnFromVideo, refreshLearningProfiles } from "@/lib/learning";
import { deleteVideoMedia } from "@/lib/video-processing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const video = getVideo(id);
  return video ? NextResponse.json({ video }) : NextResponse.json({ error: "视频不存在" }, { status: 404 });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json();
  const values: Record<string, unknown> = {};
  if (body.manualLabel === null || ["优质", "普通", "较差"].includes(body.manualLabel)) values.manual_label = body.manualLabel;
  if (typeof body.manualNotes === "string") values.manual_notes = body.manualNotes;
  if (typeof body.productId === "string" && getProduct(body.productId)) values.product_id = body.productId;
  if (typeof body.title === "string") values.title = body.title;
  const video = updateVideo(id, values);
  if (video?.status === "completed") learnFromVideo(id);
  return video ? NextResponse.json({ video }) : NextResponse.json({ error: "视频不存在" }, { status: 404 });
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const video = getVideo(id, false);
  if (!video) return NextResponse.json({ error: "视频不存在" }, { status: 404 });
  if (!["waiting", "completed", "failed", "stopped"].includes(video.status)) {
    return NextResponse.json({ error: "任务仍在分析，请先停止再删除" }, { status: 409 });
  }
  try {
    deleteVideoMedia(id);
    deleteVideoRecord(id);
    refreshLearningProfiles();
    return NextResponse.json({ ok: true, message: "视频、报告和本地媒体已删除" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除失败" }, { status: 500 });
  }
}
