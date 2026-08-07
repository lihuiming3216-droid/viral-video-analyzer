import { NextRequest, NextResponse } from "next/server";
import { getProduct, getVideo } from "@/lib/database";
import { buildProgressCard } from "@/lib/feishu/cards";
import { deliverCompletedVideo } from "@/lib/feishu/notifications";
import { ensureFeishuConnection } from "@/lib/feishu/runtime";
import { createFeishuDelivery, getFeishuTarget, updateFeishuDelivery, upsertFeishuTarget } from "@/lib/feishu/store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const video = getVideo(String(body.videoId || ""), false);
    if (!video) return NextResponse.json({ error: "视频不存在" }, { status: 404 });
    if (video.status !== "completed") return NextResponse.json({ error: "视频分析完成后才能发送到飞书" }, { status: 409 });
    const target = getFeishuTarget(String(body.targetId || ""));
    if (!target) return NextResponse.json({ error: "请选择一个已经和机器人产生过会话的人或群" }, { status: 400 });
    const channel = await ensureFeishuConnection();
    if (!channel) return NextResponse.json({ error: "飞书机器人尚未连接" }, { status: 409 });
    const product = getProduct(video.productId);
    const delivery = createFeishuDelivery({
      videoId: video.id,
      chatId: target.targetId,
      chatType: target.targetType,
      senderOpenId: target.senderOpenId,
      source: "web",
    });
    const sent = await channel.send(target.targetId, { card: buildProgressCard({
      productName: product?.name || video.productName,
      pid: product?.pid || "",
      items: [{ ...video, status: "analyzing", stage: "正在生成并归档飞书文档", progress: 96 }],
    }) });
    updateFeishuDelivery(delivery.id, { cardMessageId: sent.messageId, status: "documenting" });
    upsertFeishuTarget({
      targetId: target.targetId,
      targetType: target.targetType,
      name: target.name,
      senderOpenId: target.senderOpenId,
    });
    void deliverCompletedVideo(delivery.id, channel);
    return NextResponse.json({ ok: true, message: "报告正在发送到飞书", deliveryId: delivery.id }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "发送到飞书失败" }, { status: 500 });
  }
}
