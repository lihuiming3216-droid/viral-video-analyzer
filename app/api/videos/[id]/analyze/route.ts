import { NextRequest, NextResponse } from "next/server";
import { getVideo } from "@/lib/database";
import { enqueueVideos } from "@/lib/queue";

export const runtime = "nodejs";

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!(await getVideo(id, false))) return NextResponse.json({ error: "视频不存在" }, { status: 404 });
  await enqueueVideos([id]);
  return NextResponse.json({ ok: true });
}
