import { NextResponse } from "next/server";
import { restartFeishuConnection } from "@/lib/feishu/runtime";

export const runtime = "nodejs";

export async function POST() {
  try {
    const channel = await restartFeishuConnection();
    if (!channel) return NextResponse.json({ error: "请先启用并保存飞书机器人" }, { status: 400 });
    return NextResponse.json({ ok: true, message: `飞书机器人连接成功：${channel.botIdentity?.name || "爆片分析机器人"}` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "飞书连接失败" }, { status: 500 });
  }
}
