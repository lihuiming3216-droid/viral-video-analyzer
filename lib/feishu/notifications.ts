import "server-only";

import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { getProduct, getVideo, updateVideo } from "@/lib/database";
import { learnFromVideo } from "@/lib/learning";
import { enqueueVideos } from "@/lib/queue";
import { buildErrorCard, buildProgressCard, buildResultCard } from "@/lib/feishu/cards";
import { ensureFeishuReportDocument, grantReportAccess } from "@/lib/feishu/document";
import { getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import {
  createFeishuDelivery, getFeishuBatch, getFeishuDelivery, getFeishuDeliveryByCardMessage, getFeishuTarget,
  getFeishuDocument, getFeishuSettings, listFeishuBatchDeliveries, listOpenFeishuDeliveries,
  refreshFeishuBatchStats, updateFeishuDelivery,
} from "@/lib/feishu/store";
import type { FeishuDelivery, ManualLabel, VideoRecord } from "@/lib/types";

type NotificationGlobal = typeof globalThis & { __feishuDeliveryLocks?: Set<string> };
const state = globalThis as NotificationGlobal;
state.__feishuDeliveryLocks ||= new Set<string>();

function localReportUrl(videoId: string) {
  return `${getFeishuSettings().publicBaseUrl.replace(/\/+$/, "")}/?video=${encodeURIComponent(videoId)}`;
}

function deliveryItem(delivery: FeishuDelivery) {
  const video = getVideo(delivery.videoId, false);
  if (!video) return null;
  return {
    ...video,
    status: ["delivered", "historical"].includes(delivery.status) ? delivery.status : video.status,
    documentUrl: delivery.documentUrl,
  } as VideoRecord & { documentUrl?: string | null };
}

export async function updateFeishuBatchCard(batchId: string, channel = getConnectedFeishuChannel()) {
  if (!channel) return;
  const batch = refreshFeishuBatchStats(batchId);
  if (!batch?.progressMessageId) return;
  const deliveries = listFeishuBatchDeliveries(batchId);
  const items = deliveries.map(deliveryItem).filter(Boolean) as Array<VideoRecord & { documentUrl?: string | null }>;
  const product = items[0] ? getProduct(items[0].productId) : null;
  await channel.updateCard(batch.progressMessageId, buildProgressCard({
    productName: product?.name || items[0]?.productName || "待识别产品",
    pid: product?.pid || "",
    senderOpenId: batch.senderOpenId,
    items,
  }));
}

async function sendOrUpdateResult(channel: LarkChannel, delivery: FeishuDelivery, video: VideoRecord, documentUrl: string, historical = false) {
  const card = buildResultCard(video, {
    documentUrl,
    localReportUrl: localReportUrl(video.id),
    senderOpenId: delivery.senderOpenId,
    historical,
  });
  const batch = delivery.batchId ? getFeishuBatch(delivery.batchId) : null;
  const canReplaceProgress = Boolean(delivery.cardMessageId && (!batch || batch.total === 1));
  if (canReplaceProgress) {
    await channel.updateCard(delivery.cardMessageId!, card);
    return delivery.cardMessageId!;
  }
  const sent = await channel.send(delivery.chatId, { card }, {
    ...(delivery.replyToMessageId ? { replyTo: delivery.replyToMessageId } : {}),
    replyInThread: delivery.chatType === "group",
  });
  return sent.messageId;
}

export async function deliverCompletedVideo(deliveryId: string, channel = getConnectedFeishuChannel()) {
  if (!channel || state.__feishuDeliveryLocks!.has(deliveryId)) return;
  state.__feishuDeliveryLocks!.add(deliveryId);
  try {
    const delivery = getFeishuDelivery(deliveryId);
    if (!delivery || ["delivered", "historical"].includes(delivery.status)) return;
    const video = getVideo(delivery.videoId);
    if (!video) throw new Error("本地视频记录不存在");
    if (video.status !== "completed") return;
    updateFeishuDelivery(delivery.id, { status: "documenting", errorMessage: "" });
    if (delivery.batchId) await updateFeishuBatchCard(delivery.batchId, channel).catch(() => undefined);
    const report = await ensureFeishuReportDocument(channel.rawClient, video.id);
    await grantReportAccess(channel.rawClient, report.documentId, {
      chatType: delivery.chatType,
      chatId: delivery.chatId,
      senderOpenId: delivery.senderOpenId,
    });
    const latest = getFeishuDelivery(delivery.id)!;
    const historical = delivery.status === "historical_pending";
    const messageId = await sendOrUpdateResult(channel, latest, video, report.documentUrl, historical);
    updateFeishuDelivery(delivery.id, {
      cardMessageId: messageId,
      documentId: report.documentId,
      documentUrl: report.documentUrl,
      status: historical ? "historical" : "delivered",
      errorMessage: "",
    });
    if (delivery.batchId) await updateFeishuBatchCard(delivery.batchId, channel).catch(() => undefined);
  } catch (error) {
    const delivery = getFeishuDelivery(deliveryId);
    const message = error instanceof Error ? error.message : "生成飞书报告失败";
    if (delivery) {
      updateFeishuDelivery(delivery.id, { status: "failed", errorMessage: message });
      if (delivery.cardMessageId) {
        await channel.updateCard(delivery.cardMessageId, buildErrorCard({
          message, senderOpenId: delivery.senderOpenId, retryVideoId: delivery.videoId,
        })).catch(() => undefined);
      } else {
        await channel.send(delivery.chatId, { card: buildErrorCard({
          message, senderOpenId: delivery.senderOpenId, retryVideoId: delivery.videoId,
        }) }, {
          ...(delivery.replyToMessageId ? { replyTo: delivery.replyToMessageId } : {}),
          replyInThread: delivery.chatType === "group",
        }).catch(() => undefined);
      }
      if (delivery.batchId) await updateFeishuBatchCard(delivery.batchId, channel).catch(() => undefined);
    }
  } finally {
    state.__feishuDeliveryLocks!.delete(deliveryId);
  }
}

async function failDelivery(channel: LarkChannel, delivery: FeishuDelivery, video: VideoRecord) {
  const status = video.status === "stopped" ? "stopped" : "failed";
  const message = video.status === "stopped" ? "分析已停止，可以点击重试。" : video.errorMessage || "视频分析失败";
  updateFeishuDelivery(delivery.id, { status, errorMessage: message });
  const card = buildErrorCard({ message, senderOpenId: delivery.senderOpenId, retryVideoId: video.id });
  if (delivery.cardMessageId) await channel.updateCard(delivery.cardMessageId, card).catch(() => undefined);
  else await channel.send(delivery.chatId, { card }, {
    ...(delivery.replyToMessageId ? { replyTo: delivery.replyToMessageId } : {}),
    replyInThread: delivery.chatType === "group",
  }).catch(() => undefined);
  if (delivery.batchId) await updateFeishuBatchCard(delivery.batchId, channel).catch(() => undefined);
}

export async function notifyFeishuVideoProgress(videoId: string) {
  const channel = getConnectedFeishuChannel();
  if (!channel) return;
  const video = getVideo(videoId, false);
  if (!video) return;
  const deliveries = listOpenFeishuDeliveries(videoId);
  const batchIds = [...new Set(deliveries.map((item) => item.batchId).filter(Boolean))] as string[];
  await Promise.all(batchIds.map((batchId) => updateFeishuBatchCard(batchId, channel).catch(() => undefined)));
  for (const delivery of deliveries) {
    const batch = delivery.batchId ? getFeishuBatch(delivery.batchId) : null;
    if (delivery.cardMessageId && (!batch || batch.total === 1) && !["completed", "failed", "stopped"].includes(video.status)) {
      const product = getProduct(video.productId);
      await channel.updateCard(delivery.cardMessageId, buildProgressCard({
        productName: product?.name || video.productName,
        pid: product?.pid || "",
        senderOpenId: delivery.senderOpenId,
        items: [video],
      })).catch(() => undefined);
    }
    if (video.status === "completed") void deliverCompletedVideo(delivery.id, channel);
    if (["failed", "stopped"].includes(video.status)) await failDelivery(channel, delivery, video);
  }
}

export async function applyFeishuCardAction(channel: LarkChannel, input: {
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  value: unknown;
}) {
  const value = input.value && typeof input.value === "object" ? input.value as Record<string, unknown> : {};
  const action = String(value.action || "");
  const videoId = String(value.videoId || "");
  const video = getVideo(videoId);
  if (!video) return;

  if (action === "label" && ["优质", "普通", "较差"].includes(String(value.label))) {
    const label = String(value.label) as Exclude<ManualLabel, null>;
    updateVideo(videoId, { manual_label: label });
    learnFromVideo(videoId);
    const latest = getVideo(videoId)!;
    const document = getFeishuDocument(videoId);
    const documentUrl = document ? String(document.document_url) : "";
    if (documentUrl) await channel.updateCard(input.messageId, buildResultCard(latest, {
      documentUrl,
      localReportUrl: localReportUrl(videoId),
      selectedLabel: label,
    }));
    return;
  }

  if (action === "reanalyze") {
    let delivery = getFeishuDeliveryByCardMessage(input.messageId, videoId);
    if (!delivery) delivery = createFeishuDelivery({
      videoId,
      chatId: input.chatId,
      chatType: getFeishuTarget(input.chatId)?.targetType || "group",
      senderOpenId: input.operatorOpenId,
    });
    updateFeishuDelivery(delivery.id, { cardMessageId: input.messageId, status: "queued", errorMessage: "" });
    updateVideo(videoId, { status: "queued", stage: "已重新加入队列", progress: 2, error_message: null });
    const product = getProduct(video.productId);
    await channel.updateCard(input.messageId, buildProgressCard({
      productName: product?.name || video.productName, pid: product?.pid || "", senderOpenId: input.operatorOpenId,
      items: [getVideo(videoId, false)!],
    }));
    enqueueVideos([videoId]);
  }
}
