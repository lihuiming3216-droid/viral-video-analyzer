import "server-only";

import type { Client } from "@larksuiteoapi/node-sdk";
import {
  createProduct, createVideo, deleteFeishuAutomationJob, getFeishuAutomationJob,
  getProduct, getProductByPid, getVideo, listVideos, saveFeishuAutomationJob,
  updateProduct,
} from "@/lib/database";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { ensureProductDocument } from "@/lib/feishu/document";
import { enqueueVideos } from "@/lib/queue";
import { hasUsableProductInfo, parsePublicProductPage } from "@/lib/product-parser";
import type { AnalysisResult } from "@/lib/types";

export interface FeishuAutomationFieldMap {
  productUrl: string;
  pid: string;
  productName: string;
  productDocument: string;
  videoUrl: string;
  analysis: string;
  translation: string;
  status: string;
}

export const defaultFeishuAutomationFieldMap: FeishuAutomationFieldMap = {
  productUrl: "产品链接",
  pid: "商品ID",
  productName: "产品名称",
  productDocument: "产品文档",
  videoUrl: "视频链接",
  analysis: "视频分析",
  translation: "中文翻译",
  status: "分析状态",
};

export function productUrlFromPid(pid: string) {
  const normalized = pid.trim();
  return normalized ? `https://www.tiktok.com/view/product/${encodeURIComponent(normalized)}` : "";
}

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    return text(item.text ?? item.link ?? item.url ?? item.value ?? item.name ?? item.id);
  }
  return "";
}

function field(fields: Record<string, unknown>, name: string, aliases: string[] = []) {
  for (const key of [name, ...aliases]) {
    if (key in fields) return text(fields[key]);
  }
  return "";
}

function cleanUrl(value: string) {
  return value.replace(/[，。；;、!！?？)）\]】}]+$/g, "");
}

function apiError(response: { code?: number; msg?: string } | null | undefined, fallback: string) {
  if (response?.code && response.code !== 0) throw new Error(response.msg || fallback);
}

function isBaseRolePermissionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /RolePermNotAllow|role has no permissions|1254302|没有权限|无权限/i.test(message);
}

export function resolveAutomationFields(
  fields: Record<string, unknown>,
  inputMap: Partial<FeishuAutomationFieldMap> = {},
) {
  const map = { ...defaultFeishuAutomationFieldMap, ...inputMap };
  const pid = field(fields, map.pid, ["PID", "pid", "商品ID/PID"]);
  const hasExplicitProductUrl = [map.productUrl, "商品链接", "产品链接"]
    .some((key) => key in fields && Boolean(text(fields[key])));
  const documentField = inputMap.productDocument
    || ("产品手卡" in fields || (pid && !hasExplicitProductUrl) ? "产品手卡" : map.productDocument);
  return {
    map: { ...map, productDocument: documentField },
    // PID is the source of truth. Always regenerate the public product URL
    // so the two fields cannot drift apart.
    productUrl: productUrlFromPid(pid) || cleanUrl(field(fields, map.productUrl, ["商品链接", "产品链接"])),
    hasProductUrlField: hasExplicitProductUrl,
    pid,
    productName: field(fields, map.productName, ["商品名称", "产品名", "productName", "product_name"]),
    productDocument: field(fields, documentField, [map.productDocument, "产品手卡", "产品文档"]),
    videoUrl: cleanUrl(field(fields, map.videoUrl, ["样片链接", "视频链接"])),
    analysis: field(fields, map.analysis),
    translation: field(fields, map.translation),
    status: field(fields, map.status),
  };
}

async function patchBaseRecord(
  client: Client,
  input: { appToken: string; tableId: string; recordId: string; fields: Record<string, unknown> },
) {
  const response = await client.request<{ code?: number; msg?: string }>({
    url: `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/records/${encodeURIComponent(input.recordId)}`,
    method: "PUT",
    data: { fields: input.fields },
  });
  apiError(response, "回写飞书多维表格失败");
}

function conciseAnalysis(video: NonNullable<ReturnType<typeof getVideo>>) {
  const analysis = video.analysis as AnalysisResult | null;
  const hook = analysis?.hook;
  const points = Array.isArray(analysis?.viralPoints) ? analysis.viralPoints : [];
  const strengths = Array.isArray(analysis?.strengths) ? analysis.strengths : [];
  const summary = String(video.summary || "通过痛点切入、产品演示和场景证明推动转化。")
    .split(/(?<=[。！？])/)
    .filter((sentence) => !/(评分|分数|潜力\s*[高低]|\d+\s*分|转化率)/.test(sentence))
    .join("")
    .trim();
  return [
    `核心判断：${summary || "通过痛点切入、产品演示和场景证明推动转化。"}`,
    hook?.description ? `开头钩子：${hook.description}` : "",
    points.slice(0, 3).map((point) => `分析爆点：${point.description || point.reason || "突出产品价值并推动继续观看"}`).join("\n"),
    strengths.length ? `可借鉴点：${strengths.slice(0, 2).join("；")}` : "",
    analysis?.structureFormula ? `内容结构：${analysis.structureFormula}` : "",
  ].filter(Boolean).join("\n").trim();
}

export async function completeFeishuAutomation(videoId: string) {
  const job = getFeishuAutomationJob(videoId);
  const video = getVideo(videoId);
  if (!job || !video || !["completed", "failed", "stopped"].includes(video.status)) return false;
  const product = getProduct(video.productId);
  const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
  if (!channel) throw new Error("飞书应用尚未连接，无法回写自动化结果");
  const map = { ...defaultFeishuAutomationFieldMap, ...job.fieldMap };
  const fields: Record<string, unknown> = {
    [map.status]: video.status === "completed" ? "已完成" : video.status === "failed" ? "失败" : "已停止",
  };
  if (video.status === "completed") {
    fields[map.analysis] = conciseAnalysis(video);
    fields[map.translation] = video.transcriptZh || "暂无中文翻译";
    if (product?.documentUrl) fields[map.productDocument] = product.documentUrl;
  } else if (video.errorMessage) {
    fields[map.analysis] = `处理失败：${video.errorMessage}`;
  }
  try {
    await patchBaseRecord(channel.rawClient, { ...job, fields });
  } catch (error) {
    if (!isBaseRolePermissionError(error)) throw error;
    return false;
  }
  deleteFeishuAutomationJob(videoId);
  return true;
}

export async function handleFeishuAutomation(input: {
  client: Client;
  appToken: string;
  tableId: string;
  recordId: string;
  fields: Record<string, unknown>;
  fieldMap?: Partial<FeishuAutomationFieldMap>;
  writeBack?: boolean;
}) {
  const resolved = resolveAutomationFields(input.fields, input.fieldMap);
  const patch: Record<string, unknown> = {};
  const writeBack = input.writeBack === true;
  let documentUrl = "";
  let writeBackError = "";
  // PID and the team's Chinese product name are the only trigger fields.
  // The public product URL is always derived from PID.
  if (!resolved.pid || !resolved.productName) return { ...resolved, patch, documentUrl, writeBackError };
  let parsed = null;
  const effectivePid = resolved.pid;
  const effectiveName = resolved.productName;
  let product = effectivePid ? getProductByPid(effectivePid) : null;

  if (!product && (effectiveName || effectivePid || resolved.productUrl)) {
    product = createProduct({ name: effectiveName || "未命名产品", pid: effectivePid, productUrl: resolved.productUrl });
  }

  if (product && (resolved.productUrl && product.productUrl !== resolved.productUrl || effectiveName && product.name !== effectiveName || effectivePid && product.pid !== effectivePid)) {
    product = updateProduct(product.id, {
      productUrl: resolved.productUrl || product.productUrl,
      name: effectiveName || product.name,
      pid: effectivePid || product.pid,
    }) || product;
  }

  if (effectivePid && effectivePid !== resolved.pid) patch[resolved.map.pid] = effectivePid;
  if (resolved.hasProductUrlField && resolved.productUrl) patch[resolved.map.productUrl] = resolved.productUrl;

  // Product docs need the PID, the team's Chinese name, and the generated URL.
  if (product && effectiveName && effectivePid && resolved.productUrl) {
    if (!hasUsableProductInfo(product) && resolved.productUrl) {
      parsed = parsed || await parsePublicProductPage(resolved.productUrl, {
        productName: effectiveName,
        pid: effectivePid,
      });
      if (parsed) {
        product = updateProduct(product.id, {
          productUrl: resolved.productUrl,
          sku: parsed.sku || product.sku,
          sellingPoints: parsed.sellingPoints,
          targetAudience: parsed.audience,
          coreFunctions: parsed.coreFunctions,
          productParameters: parsed.productParameters,
          usageMethod: parsed.usageMethod,
          usageScenes: parsed.scenes,
          sourceTitle: parsed.sourceTitle,
          sourceDescription: parsed.sourceDescription,
          name: effectiveName,
          pid: effectivePid || product.pid,
        }) || product;
      }
    }
    if (!hasUsableProductInfo(product)) {
      throw new Error("商品资料不足，已停止生成空白产品手卡，请稍后重试");
    }
    const result = await ensureProductDocument(input.client, product, {
      coreFunctions: product.coreFunctions,
      productParameters: product.productParameters,
      usageMethod: product.usageMethod,
      audience: product.targetAudience,
      scenes: product.usageScenes,
      sellingPoints: product.sellingPoints,
      propImages: product.propImages,
    });
    documentUrl = result.documentUrl;
    // Keep the webhook idempotent. Feishu may fire an automation again after
    // our record update, so writing an unchanged document URL wastes requests
    // and can create a self-triggering loop in less restrictive workflows.
    if (cleanUrl(resolved.productDocument) !== result.documentUrl) {
      patch[resolved.map.productDocument] = result.documentUrl;
    }
  }

  if (resolved.videoUrl) {
    const targetProduct = product || getProductByPid(resolved.pid) || getProduct("system-unclassified");
    if (!targetProduct) throw new Error("无法找到可归档视频的产品档案");
    const existing = listVideos({ productId: targetProduct.id }).find((video) => video.sourceUrl === resolved.videoUrl);
    const video = existing || createVideo({
      productId: targetProduct.id,
      sourceType: "tiktok",
      sourceUrl: resolved.videoUrl,
      title: effectiveName ? `${effectiveName}样片` : "飞书自动化样片",
      analysisMode: "product_doc",
    });
    if (writeBack) {
      saveFeishuAutomationJob({
        videoId: video.id,
        appToken: input.appToken,
        tableId: input.tableId,
        recordId: input.recordId,
        fieldMap: resolved.map,
      });
    }
    if (existing?.status === "completed") {
      // Reusing a finished URL must not spend API tokens a second time.
      if (writeBack) await completeFeishuAutomation(video.id);
      patch[resolved.map.status] = "已完成";
      patch[resolved.map.analysis] = conciseAnalysis(video);
      patch[resolved.map.translation] = video.transcriptZh || "暂无中文翻译";
      if (targetProduct.documentUrl) patch[resolved.map.productDocument] = targetProduct.documentUrl;
    } else {
      enqueueVideos([video.id]);
      patch[resolved.map.status] = "排队中";
    }
  }

  if (writeBack && Object.keys(patch).length) {
    try {
      await patchBaseRecord(input.client, {
        appToken: input.appToken,
        tableId: input.tableId,
        recordId: input.recordId,
        fields: patch,
      });
    } catch (error) {
      if (!isBaseRolePermissionError(error)) throw error;
      writeBackError = error instanceof Error ? error.message : "飞书应用没有 Base 记录写入权限";
    }
  }
  return { ...resolved, productName: effectiveName, pid: effectivePid, patch, documentUrl, writeBackError };
}
