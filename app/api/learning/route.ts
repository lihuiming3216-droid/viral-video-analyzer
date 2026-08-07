import { NextResponse } from "next/server";
import { getLearningOverview } from "@/lib/learning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getLearningOverview());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取学习档案失败" },
      { status: 500 },
    );
  }
}
