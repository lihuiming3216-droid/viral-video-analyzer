import "server-only";

import type { Client } from "@larksuiteoapi/node-sdk";
import {
  createProduct, createVideo,
  deleteFeishuAutomationJob, getFeishuAutomationJobs,
  getFeishuProductCardMapping, getProduct, getProductByPid, getVideo, getVideoBySourceUrl,
  listFeishuAutomationJobVideoIds, saveFeishuAutomationJob, updateProduct, updateVideo,
  upsertFeishuProductCardMapping,
} from "@/lib/database";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { ensureProductCardByPid } from "@/lib/feishu/document";
import { enqueueVideos } from "@/lib/queue";
import { conciseProductDocAnalysis } from "@/lib/product-doc-analysis";

export interface FeishuAutomationFieldMap {
  productUrl: string;
  pid: string;
  productName: string;
  productDocument: string;
  productCardStatus: string;
  videoUrl: string;
  analysis: string;
  translation: string;
  status: string;
}

export const defaultFeishuAutomationFieldMap: FeishuAutomationFieldMap = {
  productUrl: "产品链接",
  pid: "商品ID",
  productName: "产品名称",
  productDocument: "产品手卡",
  productCardStatus: "手卡状态",
  videoUrl: "视频链接",
  analysis: "视频分析",
  translation: "中文翻译",
  status: "分析状态",
};

const productIdentityLockState = globalThis as typeof globalThis & {
  __viralProductIdentityLocks?: Map<string, Promise<void>>;
};
const productIdentityLocks = productIdentityLockState.__viralProductIdentityLocks
  ||= new Map<string, Promise<void>>();

async function withAutomationLock<T>(key: string, operation: () => Promise<T> | T) {
  const previous = productIdentityLocks.get(key) || Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  productIdentityLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (productIdentityLocks.get(key) === tail) productIdentityLocks.delete(key);
  }
}

function withProductIdentityLock<T>(pid: string, operation: () => Promise<T> | T) {
  return withAutomationLock(`product:${pid}`, operation);
}

function withProductCardRecordLock<T>(
  input: { appToken: string; tableId: string; recordId: string },
  operation: () => Promise<T> | T,
) {
  // Serialize repeated clicks for one Base row. Document creation itself also
  // holds a PID lock so different rows with the same PID share one card.
  const stableKey = JSON.stringify([
    input.appToken.trim(),
    input.tableId.trim(),
    input.recordId.trim(),
  ]);
  return withAutomationLock(`product-card-record:${stableKey}`, operation);
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

function urlText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return cleanUrl(value.trim());
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = urlText(item);
      if (candidate) return candidate;
    }
    return "";
  }
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    return urlText(item.link ?? item.url ?? item.value ?? item.text);
  }
  return "";
}

function field(fields: Record<string, unknown>, name: string, aliases: string[] = []) {
  for (const key of [name, ...aliases]) {
    if (key in fields) return text(fields[key]);
  }
  return "";
}

function urlField(fields: Record<string, unknown>, name: string, aliases: string[] = []) {
  for (const key of [name, ...aliases]) {
    if (key in fields) return urlText(fields[key]);
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
  const productUrl = urlField(fields, map.productUrl, ["商品链接", "产品链接"]);
  const suppliedPid = field(fields, map.pid, ["PID", "pid", "商品ID/PID"]);
  const documentField = inputMap.productDocument
    || ("产品手卡" in fields ? "产品手卡" : "产品文档" in fields ? "产品文档" : map.productDocument);
  return {
    map: { ...map, productDocument: documentField },
    // Product-link analysis is disabled. The explicit Base PID is the only
    // document identity; a number found inside an unrelated URL is never used.
    productUrl,
    pid: suppliedPid,
    suppliedPid,
    productName: field(fields, map.productName, ["商品名称", "产品名", "productName", "product_name"]),
    productDocument: urlField(fields, documentField, [map.productDocument, "产品手卡", "产品文档"]),
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

export async function updateProductCardStatus(input: {
  client: Client;
  appToken: string;
  tableId: string;
  recordId: string;
  status: string;
  fieldName?: string;
}) {
  await patchBaseRecord(input.client, {
    appToken: input.appToken,
    tableId: input.tableId,
    recordId: input.recordId,
    fields: { [input.fieldName?.trim() || "手卡状态"]: input.status.slice(0, 500) },
  });
}

function safeAutomationFailure(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "资料刷新失败");
  return raw
    .replace(/\bauthorization\s*:\s*(?:bearer|basic)?\s*\S+/gi, "[已隐藏]")
    .replace(/\bbearer\s+\S+/gi, "[已隐藏]")
    .replace(/(?:api[_ -]?key|app[_ -]?secret|webhook[_ -]?secret)\s*[:=]?\s*\S+/gi, "[已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360) || "资料刷新失败";
}

export async function completeFeishuAutomation(videoId: string) {
  const jobs = getFeishuAutomationJobs(videoId);
  const video = getVideo(videoId);
  if (!jobs.length || !video || !["completed", "failed", "stopped"].includes(video.status)) return false;
  const product = getProduct(video.productId);
  try {
    const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
    if (!channel) return false;
    let allDelivered = true;
    for (const job of jobs) {
      try {
        const productCardMapping = getFeishuProductCardMapping({
          appToken: job.appToken,
          tableId: job.tableId,
          recordId: job.recordId,
        });
        const map = { ...defaultFeishuAutomationFieldMap, ...job.fieldMap };
        const fields: Record<string, unknown> = {
          [map.status]: video.status === "completed" ? "已完成" : video.status === "failed" ? "失败" : "已停止",
        };
        if (video.status === "completed") {
          fields[map.analysis] = conciseProductDocAnalysis(video);
          fields[map.translation] = video.transcriptZh || "暂无中文翻译";
          const mappedDocumentUrl = productCardMapping?.documentUrl || product?.documentUrl;
          if (mappedDocumentUrl) fields[map.productDocument] = mappedDocumentUrl;
        } else if (video.errorMessage) {
          fields[map.analysis] = `处理失败：${safeAutomationFailure(video.errorMessage)}`;
        }
        let delivered = false;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await patchBaseRecord(channel.rawClient, { ...job, fields });
            delivered = true;
            break;
          } catch (error) {
            if (isBaseRolePermissionError(error) || attempt === 3) break;
            await new Promise((resolve) => setTimeout(resolve, attempt * 100));
          }
        }
        if (!delivered) {
          allDelivered = false;
          continue;
        }
        deleteFeishuAutomationJob(job);
      } catch {
        // A single Base row must never prevent the remaining deliveries. The
        // untouched job is the durable retry marker for a later completion run.
        allDelivered = false;
      }
    }
    return allDelivered;
  } catch {
    // Connection failures are retryable too; retain every delivery without
    // propagating provider messages that might contain credentials.
    return false;
  }
}

const automationDeliveryWorkerState = globalThis as typeof globalThis & {
  __feishuAutomationDeliveryInitialTimer?: ReturnType<typeof setTimeout>;
  __feishuAutomationDeliveryTimer?: ReturnType<typeof setInterval>;
  __feishuAutomationDeliveryRunning?: boolean;
};

export async function runFeishuAutomationDeliveryPass() {
  const pendingVideoIds = listFeishuAutomationJobVideoIds();
  let terminalVideos = 0;
  let deliveredVideos = 0;
  for (const videoId of pendingVideoIds) {
    const video = getVideo(videoId);
    if (!video || !["completed", "failed", "stopped"].includes(video.status)) continue;
    terminalVideos += 1;
    try {
      if (await completeFeishuAutomation(videoId)) deliveredVideos += 1;
    } catch {
      // The database job is the durable retry marker. Never log provider/Base
      // errors here because they can contain authorization material.
    }
  }
  return { pendingVideos: pendingVideoIds.length, terminalVideos, deliveredVideos };
}

function automationDeliveryWorkerInterval() {
  const configured = Number(process.env.FEISHU_AUTOMATION_DELIVERY_INTERVAL_MS || 30_000);
  return Number.isFinite(configured) ? Math.max(5_000, configured) : 30_000;
}

export function startFeishuAutomationDeliveryWorker() {
  if (automationDeliveryWorkerState.__feishuAutomationDeliveryTimer) return;
  const run = async () => {
    if (automationDeliveryWorkerState.__feishuAutomationDeliveryRunning) return;
    automationDeliveryWorkerState.__feishuAutomationDeliveryRunning = true;
    try {
      await runFeishuAutomationDeliveryPass();
    } catch {
      // A later fixed-interval pass will retry; do not emit sensitive errors.
    } finally {
      automationDeliveryWorkerState.__feishuAutomationDeliveryRunning = false;
    }
  };
  automationDeliveryWorkerState.__feishuAutomationDeliveryInitialTimer = setTimeout(run, 2_500);
  automationDeliveryWorkerState.__feishuAutomationDeliveryInitialTimer.unref();
  automationDeliveryWorkerState.__feishuAutomationDeliveryTimer = setInterval(
    run,
    automationDeliveryWorkerInterval(),
  );
  automationDeliveryWorkerState.__feishuAutomationDeliveryTimer.unref();
}

type FeishuAutomationInput = {
  client: Client;
  appToken: string;
  tableId: string;
  recordId: string;
  fields: Record<string, unknown>;
  fieldMap?: Partial<FeishuAutomationFieldMap>;
  writeBack?: boolean;
};

export async function handleFeishuAutomation(input: FeishuAutomationInput) {
  return withProductCardRecordLock(input, () => handleFeishuAutomationUnlocked(input));
}

async function handleFeishuAutomationUnlocked(input: FeishuAutomationInput) {
  const resolved = resolveAutomationFields(input.fields, input.fieldMap);
  const patch: Record<string, unknown> = {};
  const pendingPatch: Record<string, unknown> = {};
  const writeBack = input.writeBack === true;
  let documentUrl = "";
  let writeBackError = "";
  const writeBackFailures = new Map<string, string>();
  let productRefreshError = "";
  let productCardWarning = "";
  let productCardStatus = "";
  let product = null as ReturnType<typeof getProductByPid>;

  const queuePatch = (fields: Record<string, unknown>) => {
    Object.assign(patch, fields);
    Object.assign(pendingPatch, fields);
  };
  const flushPatch = async () => {
    if (!writeBack || !Object.keys(pendingPatch).length) return;
    const snapshot = Object.entries(pendingPatch);
    for (const [key, value] of snapshot) {
      try {
        await patchBaseRecord(input.client, {
          appToken: input.appToken,
          tableId: input.tableId,
          recordId: input.recordId,
          fields: { [key]: value },
        });
        if (pendingPatch[key] === value) delete pendingPatch[key];
        writeBackFailures.delete(key);
      } catch (error) {
        writeBackFailures.set(key, safeAutomationFailure(error));
      }
    }
    writeBackError = [...writeBackFailures.entries()]
      .map(([fieldName, message]) => `${fieldName}：${message}`)
      .join("；")
      .slice(0, 500);
  };

  const mappingKey = {
    appToken: input.appToken,
    tableId: input.tableId,
    recordId: input.recordId,
  };
  const effectivePid = resolved.pid.trim();
  const effectiveName = resolved.productName.trim();
  if (!effectiveName) throw new Error("缺少产品名称，无法按“产品名称_PID”命名手卡");
  if (!effectivePid) throw new Error("缺少商品 PID，无法按“产品名称_PID”命名手卡");
  if (!/^\d+$/.test(effectivePid)) throw new Error("商品 PID 格式不正确，必须只包含数字");

  // Only an explicit Feishu button click reaches this handler. The product
  // folder and exact `_PID` title suffix are authoritative; row fields and
  // cached mappings never select or create a document.
  const shell = await ensureProductCardByPid(input.client, {
    name: effectiveName,
    pid: effectivePid,
  });
  documentUrl = shell.documentUrl;

  productCardWarning = [shell.permissionWarning, shell.ownershipWarning]
    .filter(Boolean)
    .map((warning) => safeAutomationFailure(warning))
    .join("；");

  // Product-link analysis is intentionally disabled. The button now only
  // creates/adopts the PID's template document, renames it, and returns it for
  // manual editing. No template block or user-authored content is modified.
  queuePatch({ [resolved.map.productDocument]: shell.documentUrl });
  await flushPatch();

  product = await withProductIdentityLock(effectivePid, () => {
    const current = getProductByPid(effectivePid);
    if (current) {
      return updateProduct(current.id, {
        name: effectiveName,
        pid: effectivePid,
        productUrl: resolved.productUrl,
        documentId: shell.documentId,
        documentUrl: shell.documentUrl,
      }) || current;
    }
    return createProduct({
      name: effectiveName,
      pid: effectivePid,
      productUrl: resolved.productUrl,
      documentId: shell.documentId,
      documentUrl: shell.documentUrl,
    });
  });
  if (!product) throw new Error("创建产品档案失败");

  upsertFeishuProductCardMapping({
    ...mappingKey,
    productId: product.id,
    documentId: shell.documentId,
    documentUrl: shell.documentUrl,
    lastProductPid: effectivePid,
    lastProductUrl: resolved.productUrl,
    lastProductName: effectiveName,
    managedProductPid: "",
  });

  productCardStatus = productCardWarning
    ? "手卡已就绪，请手动填写；文档权限待修复"
    : "手卡已就绪，请手动填写";
  productRefreshError = "";
  // Give the critical document-link field one final independent attempt before
  // publishing the terminal status. Never tell the user "已完成" while the row
  // still has no hand-card link, even if parsing and document sync succeeded.
  await flushPatch();
  const documentWriteFailure = writeBackFailures.get(resolved.map.productDocument);
  if (writeBack && documentWriteFailure) {
    productCardStatus = `手卡已创建，但表格手卡链接回写待重试：${documentWriteFailure}`.slice(0, 500);
  }
  queuePatch({ [resolved.map.productCardStatus]: productCardStatus });

  if (resolved.videoUrl) {
    const targetProduct = product || getProductByPid(resolved.pid) || getProduct("system-unclassified");
    if (!targetProduct) throw new Error("无法找到可归档视频的产品档案");
    const matchedVideo = getVideoBySourceUrl(resolved.videoUrl);
    const existing = matchedVideo && matchedVideo.productId !== targetProduct.id
      ? updateVideo(matchedVideo.id, { product_id: targetProduct.id })
      : matchedVideo;
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
      queuePatch({
        [resolved.map.status]: "已完成",
        [resolved.map.analysis]: conciseProductDocAnalysis(video),
        [resolved.map.translation]: video.transcriptZh || "暂无中文翻译",
        [resolved.map.productDocument]: shell.documentUrl,
      });
    } else {
      enqueueVideos([video.id]);
      queuePatch({ [resolved.map.status]: "排队中" });
    }
  }

  await flushPatch();
  return {
    ...resolved,
    productName: effectiveName,
    pid: effectivePid,
    patch,
    documentUrl,
    documentReady: true,
    productCardStatus,
    productCardWarning,
    productRefreshError,
    writeBackError,
  };
}
