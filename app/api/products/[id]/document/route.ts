import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Product cards may only be created or associated by the Feishu row button. */
export async function POST() {
  return NextResponse.json({
    error: "产品手卡只能通过飞书表格按钮生成或关联",
  }, { status: 410 });
}
