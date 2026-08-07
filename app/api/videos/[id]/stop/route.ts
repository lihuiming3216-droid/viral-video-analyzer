import { NextRequest, NextResponse } from "next/server";
import { getVideo } from "@/lib/database";
import { stopVideo } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stoppableStatuses = new Set(["queued", "downloading", "transcribing", "extracting", "analyzing"]);

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const video = getVideo(id, false);
  if (!video) return NextResponse.json({ error: "视频不存在" }, { status: 404 });
  if (!stoppableStatuses.has(video.status)) {
    return NextResponse.json({ error: "当前任务不需要停止" }, { status: 409 });
  }
  stopVideo(id);
  return NextResponse.json({ ok: true, message: "分析已停止，已保留下载好的本地文件" });
}
