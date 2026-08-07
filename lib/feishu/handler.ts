import "server-only";

import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { createProduct, createVideo, listProducts, listVideos, updateProduct, updateVideo } from "@/lib/database";
import { enqueueVideos } from "@/lib/queue";
import { buildErrorCard, buildProgressCard } from "@/lib/feishu/cards";
import { parseFeishuSubmission } from "@/lib/feishu/parser";
import { applyFeishuCardAction, deliverCompletedVideo } from "@/lib/feishu/notifications";
import { setVideoProgressHandler } from "@/lib/video-events";
import {
  createFeishuBatch, createFeishuDelivery, recordFeishuEvent, updateFeishuBatch,
  updateFeishuDelivery, upsertFeishuTarget,
} from "@/lib/feishu/store";
import type { FeishuDelivery, VideoRecord } from "@/lib/types";

function eventId(raw: unknown) {
  if (!raw || typeof raw !== "object") return "";
  const record = raw as Record<string, unknown>;
  const header = record.header && typeof record.header === "object" ? record.header as Record<string, unknown> : null;
  return String(record.event_id || header?.event_id || "");
}

function findOrCreateProduct(name: string, pid: string) {
  const products = listProducts();
  if (pid) {
    const byPid = products.find((product) => product.pid && product.pid.toLowerCase() === pid.toLowerCase());
    if (byPid) return byPid;
  }
  const sameName = products.filter((product) => product.name.trim().toLowerCase() === name.trim().toLowerCase());
  const compatible = sameName.find((product) => !pid || !product.pid || product.pid.toLowerCase() === pid.toLowerCase());
  if (compatible) {
    if (pid && !compatible.pid) return updateProduct(compatible.id, { pid })!;
    return compatible;
  }
  return createProduct({ name, pid, category: "飞书待补充", notes: "由飞书机器人收到视频链接后自动创建" });
}

async function enrichTarget(channel: LarkChannel, input: {
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
}) {
  try {
    if (input.chatType === "group") {
      const info = await channel.getChatInfo(input.chatId);
      upsertFeishuTarget({ targetId: input.chatId, targetType: input.chatType, senderOpenId: input.senderOpenId, name: info.name || "飞书群聊" });
      return;
    }
    const response = await channel.rawClient.contact.v3.user.get({
      path: { user_id: input.senderOpenId },
      params: { user_id_type: "open_id", department_id_type: "open_department_id" },
    });
    const name = response.data?.user?.name || "飞书成员";
    upsertFeishuTarget({ targetId: input.chatId, targetType: input.chatType, senderOpenId: input.senderOpenId, name });
  } catch {
    // 名称补全失败不影响接收和返回报告。
  }
}

function replyOptions(messageId: string, chatType: "p2p" | "group") {
  return { replyTo: messageId, replyInThread: chatType === "group" };
}

export function registerFeishuHandlers(channel: LarkChannel) {
  setVideoProgressHandler((videoId) => import("@/lib/feishu/notifications").then(({ notifyFeishuVideoProgress }) => notifyFeishuVideoProgress(videoId)));
  channel.on("message", async (message) => {
    if (!recordFeishuEvent(message.messageId, eventId(message.raw))) return;
    const chatType = message.chatType === "p2p" ? "p2p" : "group";
    upsertFeishuTarget({
      targetId: message.chatId,
      targetType: chatType,
      name: chatType === "group" ? "飞书群聊" : message.senderName || "飞书成员",
      senderOpenId: message.senderId,
    });
    void enrichTarget(channel, { chatId: message.chatId, chatType, senderOpenId: message.senderId });

    const parsed = parseFeishuSubmission(message.content);
    if (parsed.error) {
      await channel.send(message.chatId, { card: buildErrorCard({
        title: "请按正确格式发送",
        senderOpenId: message.senderId,
        message: `${parsed.error}\n\n示例：\n多功能充电宝 PID：123456 https://www.tiktok.com/t/...\n\n一次最多可以发送 10 条 TikTok 链接。`,
      }) }, replyOptions(message.messageId, chatType));
      return;
    }

    const product = findOrCreateProduct(parsed.productName, parsed.pid);
    const existing = listVideos();
    const batch = createFeishuBatch({
      sourceMessageId: message.messageId,
      chatId: message.chatId,
      chatType,
      senderOpenId: message.senderId,
      total: parsed.urls.length,
    });
    const videos: VideoRecord[] = [];
    const deliveries: FeishuDelivery[] = [];
    const enqueueIds = new Set<string>();

    parsed.urls.forEach((url, index) => {
      const duplicate = existing.find((video) => video.sourceUrl === url);
      let video: VideoRecord;
      let deliveryStatus = "queued";
      if (duplicate) {
        video = updateVideo(duplicate.id, { product_id: product.id })!;
        if (duplicate.status === "completed") deliveryStatus = "historical_pending";
        else if (!["queued", "downloading", "transcribing", "extracting", "analyzing"].includes(duplicate.status)) {
          video = updateVideo(duplicate.id, {
            status: "queued", stage: "已重新加入队列", progress: 2, error_message: null,
          })!;
          enqueueIds.add(video.id);
        }
      } else {
        video = createVideo({
          productId: product.id,
          sourceType: "tiktok",
          sourceUrl: url,
          title: `${product.name} · 飞书样片 ${index + 1}`,
        });
        enqueueIds.add(video.id);
      }
      videos.push(video);
      deliveries.push(createFeishuDelivery({
        videoId: video.id,
        batchId: batch.id,
        chatId: message.chatId,
        chatType,
        senderOpenId: message.senderId,
        replyToMessageId: message.messageId,
        status: deliveryStatus,
      }));
    });

    const sent = await channel.send(message.chatId, { card: buildProgressCard({
      productName: product.name,
      pid: product.pid,
      senderOpenId: message.senderId,
      items: videos,
    }) }, replyOptions(message.messageId, chatType));
    updateFeishuBatch(batch.id, { progressMessageId: sent.messageId, status: "processing" });
    if (deliveries.length === 1) updateFeishuDelivery(deliveries[0].id, { cardMessageId: sent.messageId });

    deliveries.filter((delivery) => delivery.status === "historical_pending")
      .forEach((delivery) => void deliverCompletedVideo(delivery.id, channel));
    if (enqueueIds.size) enqueueVideos([...enqueueIds]);
  });

  channel.on("cardAction", async (event) => {
    await applyFeishuCardAction(channel, {
      messageId: event.messageId,
      chatId: event.chatId,
      operatorOpenId: event.operator.openId,
      value: event.action.value,
    });
  });

  channel.on("botAdded", (event) => {
    upsertFeishuTarget({
      targetId: event.chatId,
      targetType: "group",
      name: "飞书群聊",
      senderOpenId: event.operator.openId,
    });
    void enrichTarget(channel, { chatId: event.chatId, chatType: "group", senderOpenId: event.operator.openId });
  });
}
