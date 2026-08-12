import "server-only";

import type { Client } from "@larksuiteoapi/node-sdk";
import {
  claimFeishuProductCardDocument, clearProductDocumentLink, createProduct, createVideo,
  deleteFeishuAutomationJob, getFeishuAutomationJobs,
  getFeishuProductCardMapping, getProduct, getProductByPid, getVideo, getVideoBySourceUrl,
  listFeishuAutomationJobVideoIds, mergeVerifiedProductFacts, saveFeishuAutomationJob, updateProduct, updateVideo,
  upsertFeishuProductCardMapping,
} from "@/lib/database";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { ensureProductCardShell, syncProductCardManagedFields } from "@/lib/feishu/document";
import { enqueueVideos } from "@/lib/queue";
import { extractProductIdFromUrl, isExactTikTokProductSource, parsePublicProductPage } from "@/lib/product-parser";
import { conciseProductDocAnalysis } from "@/lib/product-doc-analysis";
import { isTikTokUrl } from "@/lib/tiktok-product";

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
  // The Base coordinates, rather than PID, are the stable identity of a hand
  // card. Holding this lock across read -> parse -> DB merge -> document sync
  // prevents two clicks on one row from publishing different partial snapshots.
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
  const pid = extractProductIdFromUrl(productUrl);
  const suppliedPid = field(fields, map.pid, ["PID", "pid", "商品ID/PID"]);
  const documentField = inputMap.productDocument
    || ("产品手卡" in fields ? "产品手卡" : "产品文档" in fields ? "产品文档" : map.productDocument);
  return {
    map: { ...map, productDocument: documentField },
    // The exact PDP URL is the source of truth. Generic /view/product links
    // are less reliable on the production server, so never replace a supplied
    // product link with a URL reconstructed from PID.
    productUrl,
    pid,
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

function trustedExistingDocumentUrl(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && (host === "feishu.cn" || host.endsWith(".feishu.cn")
        || host === "larksuite.com" || host.endsWith(".larksuite.com"))
      && /^\/docx\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
      ? value
      : "";
  } catch {
    return "";
  }
}

function productDocumentIdFromUrl(value: string) {
  try {
    return decodeURIComponent(new URL(value).pathname.match(/^\/docx\/([A-Za-z0-9_-]+)\/?$/)?.[1] || "");
  } catch {
    return "";
  }
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

function factItems(value: string) {
  return String(value || "")
    .split(/[；;\n]+/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function mergeFactItems(existing: string, verified: string) {
  const items = [...factItems(existing)];
  const seen = new Set(items.map((item) => item.normalize("NFKC").toLowerCase()));
  for (const item of factItems(verified)) {
    const normalized = item.normalize("NFKC").toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    items.push(item);
  }
  return items.join("；");
}

function mergeParameterFacts(existing: string, verified: string) {
  const incoming = factItems(verified);
  const incomingKeys = new Set(incoming.map((item) => item.split(/[：:]/, 1)[0].trim())
    .filter(Boolean)
    .map((key) => key.normalize("NFKC").toLowerCase()));
  const retained = factItems(existing).filter((item) => {
    const key = item.split(/[：:]/, 1)[0].trim().normalize("NFKC").toLowerCase();
    return !key || !incomingKeys.has(key);
  });
  return mergeFactItems(retained.join("；"), verified);
}

function mergeCoreFunctions(existing: string[], verified: string[]) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of [...(existing || []), ...(verified || [])]) {
    const item = String(value || "").replace(/\s+/g, " ").trim();
    const normalized = item.normalize("NFKC").toLowerCase();
    if (!item || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(item);
  }
  return result.slice(0, 8);
}

function parsedVerificationSummary(parsed: Awaited<ReturnType<typeof parsePublicProductPage>>) {
  return parsed.verification || null;
}

function productLinkInputError(input: { productUrl: string; extractedPid: string }) {
  if (!input.productUrl) return "缺少产品链接";
  if (!isTikTokUrl(input.productUrl)) return "产品链接必须是 HTTPS TikTok 链接";
  if (!input.extractedPid) return "产品链接中没有可识别的商品 PID";
  if (!isExactTikTokProductSource(input.productUrl, input.extractedPid)) {
    return "产品链接必须是 HTTPS TikTok 官方商品详情页，且链接中的 PID 不能冲突";
  }
  return "";
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
  let retainedVerifiedSnapshot = false;
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
  let mappingBefore = getFeishuProductCardMapping(mappingKey);
  const extractedPid = resolved.pid;
  const linkInputError = productLinkInputError({
    productUrl: resolved.productUrl,
    extractedPid,
  });
  const refreshInputError = [resolved.productName ? "" : "缺少产品名称", linkInputError]
    .filter(Boolean)
    .join("；");
  const effectivePid = linkInputError ? "" : extractedPid;
  const requestedName = resolved.productName || "";
  const effectiveName = requestedName || (effectivePid ? "待补产品" : mappingBefore?.lastProductName || "待补产品");
  const existingProduct = effectivePid ? getProductByPid(effectivePid) : null;
  const previousVerifiedPid = mappingBefore?.lastProductPid || "";
  const previousVerifiedUrl = mappingBefore?.lastProductUrl || existingProduct?.productUrl || "";
  const preservePreviousIdentity = Boolean(linkInputError && previousVerifiedPid);
  const identityName = preservePreviousIdentity
    ? mappingBefore?.lastProductName || "待补产品"
    : effectiveName;
  const identityPid = preservePreviousIdentity ? previousVerifiedPid : effectivePid;
  const identityUrl = preservePreviousIdentity ? previousVerifiedUrl : resolved.productUrl;
  const suppliedDocumentUrl = trustedExistingDocumentUrl(resolved.productDocument);
  let shellDocumentId = mappingBefore?.documentId || "";
  let shellDocumentUrl = mappingBefore?.documentUrl || "";
  if (!shellDocumentId && suppliedDocumentUrl) {
    const suppliedDocumentId = productDocumentIdFromUrl(suppliedDocumentUrl);
    if (suppliedDocumentId && claimFeishuProductCardDocument(mappingKey, {
      documentId: suppliedDocumentId,
      documentUrl: suppliedDocumentUrl,
    })) {
      // Claim before ensureProductCardShell performs any identity/permission
      // mutation. A legacy URL already owned by another Base row is ignored
      // and this row receives its own stable shell instead.
      shellDocumentId = suppliedDocumentId;
      shellDocumentUrl = suppliedDocumentUrl;
      mappingBefore = getFeishuProductCardMapping(mappingKey);
    }
  }
  const shell = await ensureProductCardShell(input.client, {
    recordKey: mappingKey,
    // Product-card documents are stable per Base record. Falling back to the
    // product's canonical document here made sequential clicks share one card
    // while concurrent clicks created two, so the result depended on timing.
    existingDocumentId: shellDocumentId || null,
    existingDocumentUrl: shellDocumentUrl || null,
    name: identityName,
    productUrl: identityUrl,
    pid: identityPid,
    deferIdentity: true,
  });
  documentUrl = shell.documentUrl;
  if (!shellDocumentId) {
    const claimed = claimFeishuProductCardDocument(mappingKey, {
      documentId: shell.documentId,
      documentUrl: shell.documentUrl,
    });
    if (!claimed) throw new Error("当前飞书记录的产品手卡与其他记录冲突，已停止关联");
    mappingBefore = getFeishuProductCardMapping(mappingKey);
  }
  productCardWarning = [shell.permissionWarning, shell.ownershipWarning]
    .filter(Boolean)
    .map((warning) => safeAutomationFailure(warning))
    .join("；");

  // Stage one is committed independently: a parser/provider failure can no
  // longer make the user lose the product-card document that was just made.
  queuePatch({ [resolved.map.productDocument]: shell.documentUrl });
  await flushPatch();
  if (effectivePid && effectivePid !== resolved.suppliedPid) {
    queuePatch({ [resolved.map.pid]: effectivePid });
    await flushPatch();
  }
  productCardStatus = "手卡已就绪，资料刷新中";
  queuePatch({ [resolved.map.productCardStatus]: productCardStatus });
  await flushPatch();

  try {
    upsertFeishuProductCardMapping({
      ...mappingKey,
      documentId: shell.documentId,
      documentUrl: shell.documentUrl,
    });
    const mappedProductBefore = mappingBefore?.productId
      ? getProduct(mappingBefore.productId)
      : null;
    // Validate the complete managed area before changing even one block. This
    // prevents an old/non-template document from being half rewritten before
    // a missing label is discovered.
    const preflight = await syncProductCardManagedFields(input.client, {
      documentId: shell.documentId,
      mode: "verified-basic",
      preflightOnly: true,
    });
    if (preflight.missingLabels?.length) {
      throw new Error(`产品手卡模板缺少基础字段：${preflight.missingLabels.join("、")}`);
    }
    if (preflight.duplicateLabels?.length) {
      throw new Error(`产品手卡模板存在重复基础字段：${preflight.duplicateLabels.join("、")}`);
    }

    const preflightValues = preflight.currentValues || {};
    const documentManagedPid = String(preflightValues["商品ID"] || "").trim();
    const documentHasDerivedFacts = [
      "产品SKU", "产品主要功能", "产品参数", "使用方法", "适用人群", "使用场景",
    ].some((label) => Boolean(String(preflightValues[label as keyof typeof preflightValues] || "").trim()));
    const confirmedPidSwitch = Boolean(identityPid && [
      mappingBefore?.managedProductPid,
      mappingBefore?.lastProductPid,
      mappedProductBefore?.pid,
      documentManagedPid,
    ].some((previousPid) => Boolean(previousPid && previousPid !== identityPid)));
    const unknownDocumentFactOwner = Boolean(
      identityPid && !documentManagedPid && documentHasDerivedFacts,
    );
    const recoveredDifferentDocument = Boolean(
      mappingBefore?.documentId && mappingBefore.documentId !== shell.documentId,
    );
    // Never clear an existing same-PID card merely because it predates the new
    // mapping marker. That was the cause of historical cards becoming empty
    // before a provider request later failed. A newly copied template must
    // still have every example value removed, and a recovered/different-PID
    // document must drop old facts before its new identity is written.
    const mustIsolatePreviousProduct = !shell.reused
      || recoveredDifferentDocument
      || confirmedPidSwitch
      || unknownDocumentFactOwner;
    if (mustIsolatePreviousProduct) {
      const cleared = await syncProductCardManagedFields(input.client, {
        documentId: shell.documentId,
        mode: "verified-basic",
        clearDerived: true,
        derivedOnly: true,
      });
      if (cleared.missingLabels?.length) {
        throw new Error(`产品手卡模板缺少基础字段：${cleared.missingLabels.join("、")}`);
      }
      // An empty managed area is safe to bind to the new identity even when a
      // later provider request fails. Never set this marker merely because the
      // three identity blocks were patched: historical derived facts may still
      // belong to a different PID until they are isolated or restored.
      if (identityPid) {
        upsertFeishuProductCardMapping({ ...mappingKey, managedProductPid: identityPid });
      }
    }
    const identitySync = await syncProductCardManagedFields(input.client, {
      documentId: shell.documentId,
      mode: "identity",
      name: identityName,
      productUrl: identityUrl,
      pid: identityPid,
    });
    if (identitySync.missingLabels?.length) {
      throw new Error(`产品手卡模板缺少基础字段：${identitySync.missingLabels.join("、")}`);
    }
    // Link/PID identity is independently verifiable before AI extraction. Save
    // it now so a later bad temporary link can retain the same complete tuple.
    // managedProductPid is deliberately omitted until the derived area was
    // isolated, restored from a trusted DB snapshot, or finally synchronized.
    upsertFeishuProductCardMapping({
      ...mappingKey,
      lastProductPid: identityPid,
      lastProductUrl: identityUrl,
      lastProductName: identityName,
    });
    if (refreshInputError) throw new Error(refreshInputError);
    product = await withProductIdentityLock(effectivePid, () => {
      const current = getProductByPid(effectivePid);
      if (current) return current;
      return createProduct({
        name: effectiveName,
        pid: effectivePid,
        productUrl: resolved.productUrl,
        documentId: shell.documentId,
        documentUrl: shell.documentUrl,
      });
    });
    if (!product) throw new Error("创建产品档案失败");
    const previouslyMappedProduct = mappingBefore?.productId
      && mappingBefore.productId !== product.id
      ? mappedProductBefore || getProduct(mappingBefore.productId)
      : null;
    if (previouslyMappedProduct?.documentId === shell.documentId) {
      // The Base row has switched to another PID and its stable shell is being
      // repurposed. Detach the old product's compatibility/canonical link so a
      // later sync of that product cannot overwrite this row's new card.
      clearProductDocumentLink(previouslyMappedProduct.id);
    }
    if (!product.documentId || !product.documentUrl) {
      product = updateProduct(product.id, {
        documentId: shell.documentId,
        documentUrl: shell.documentUrl,
      }) || product;
    }
    upsertFeishuProductCardMapping({ ...mappingKey, productId: product.id });

    retainedVerifiedSnapshot = product.verifiedPid === effectivePid
      && Boolean(product.evidenceVersion)
      && Boolean(
        product.sku
        || product.coreFunctions.length
        || product.productParameters
        || product.usageMethod
        || product.targetAudience
        || product.usageScenes,
      );
    if (retainedVerifiedSnapshot) {
      const restored = await syncProductCardManagedFields(input.client, {
        documentId: shell.documentId,
        mode: "verified-basic",
        sku: product.sku,
        coreFunctions: product.coreFunctions,
        productParameters: product.productParameters,
        usageMethod: product.usageMethod,
        audience: product.targetAudience,
        scenes: product.usageScenes,
        clearDerived: true,
      });
      if (restored.missingLabels?.length) {
        throw new Error(`产品手卡模板缺少基础字段：${restored.missingLabels.join("、")}`);
      }
      upsertFeishuProductCardMapping({ ...mappingKey, managedProductPid: effectivePid });
    }

    // Every click performs a new exact-link/PID parse. Cached product facts
    // never skip this refresh and never certify a failed request.
    const parsed = await parsePublicProductPage(resolved.productUrl, {
      productName: effectiveName,
      pid: effectivePid,
    });
    const verification = parsedVerificationSummary(parsed);
    if (!verification
      || verification.verifiedFactCount <= 0
      || !verification.evidenceVersion
      || !isExactTikTokProductSource(verification.sourceUrl, effectivePid)) {
      throw new Error("商品资料解析失败：没有取得任何逐条可验证的商品事实");
    }
    const parsedProductId = product.id;
    product = await withProductIdentityLock(effectivePid, () => {
      // Parsing deliberately happens outside this short lock. Re-read the
      // latest certified snapshot only after parsing, then derive the merge
      // input and commit it atomically so concurrent Base rows cannot replace
      // one another's partial facts with a stale pre-parse snapshot.
      let current = getProductByPid(effectivePid)
        || getProduct(parsedProductId)
        || product!;
      const verifiedFields = new Set(verification.verifiedFields);
      const parsedSku = verifiedFields.has("sku") ? parsed.sku : "";
      const parsedCoreFunctions = verifiedFields.has("coreFunctions") ? parsed.coreFunctions : [];
      const parsedProductParameters = verifiedFields.has("productParameters") ? parsed.productParameters : "";
      const parsedUsageMethod = verifiedFields.has("usageMethod") ? parsed.usageMethod : "";
      const parsedAudience = verifiedFields.has("audience") ? parsed.audience : "";
      const parsedScenes = verifiedFields.has("scenes") ? parsed.scenes : "";
      const sameVerifiedProduct = current.verifiedPid === effectivePid
        && current.evidenceVersion === verification.evidenceVersion;
      const mergedCoreFunctions = parsedCoreFunctions.length
        ? mergeCoreFunctions(sameVerifiedProduct ? current.coreFunctions : [], parsedCoreFunctions)
        : undefined;
      const mergedProductParameters = parsedProductParameters
        ? mergeParameterFacts(sameVerifiedProduct ? current.productParameters : "", parsedProductParameters)
        : undefined;
      const mergedUsageMethod = parsedUsageMethod
        ? mergeFactItems(sameVerifiedProduct ? current.usageMethod : "", parsedUsageMethod)
        : undefined;
      const mergedAudience = parsedAudience
        ? mergeFactItems(sameVerifiedProduct ? current.targetAudience : "", parsedAudience)
        : undefined;
      const mergedScenes = parsedScenes
        ? mergeFactItems(sameVerifiedProduct ? current.usageScenes : "", parsedScenes)
        : undefined;
      current = updateProduct(current.id, {
        productUrl: resolved.productUrl,
        name: identityName,
        pid: effectivePid,
      }) || current;
      return mergeVerifiedProductFacts(current.id, {
        pid: effectivePid,
        sourceUrl: verification.sourceUrl,
        evidenceVersion: verification.evidenceVersion,
        verifiedAt: new Date().toISOString(),
        sku: parsedSku || undefined,
        coreFunctions: mergedCoreFunctions,
        productParameters: mergedProductParameters,
        usageMethod: mergedUsageMethod,
        targetAudience: mergedAudience,
        usageScenes: mergedScenes,
        sourceTitle: parsed.sourceTitle || undefined,
        sourceDescription: parsed.sourceDescription || undefined,
        sourceImageUrls: parsed.sourceImageUrls.length ? parsed.sourceImageUrls : undefined,
        visualEvidence: parsed.visualEvidence || undefined,
        visualAnalysisStatus: parsed.visualAnalysisStatus === "completed" ? "completed" : undefined,
      });
    });
    const synchronized = await syncProductCardManagedFields(input.client, {
      documentId: shell.documentId,
      mode: "verified-basic",
      name: effectiveName,
      productUrl: resolved.productUrl,
      pid: effectivePid,
      // The database helper has already merged this click's atomic facts with
      // the same PID/version snapshot. Synchronize that complete certified
      // snapshot, not only the fields returned by this one provider attempt.
      // This also replaces unversioned legacy/template facts only after at
      // least one new fact has passed verification; parse failures never clear
      // the existing card.
      sku: product.sku,
      coreFunctions: product.coreFunctions,
      productParameters: product.productParameters,
      usageMethod: product.usageMethod,
      audience: product.targetAudience,
      scenes: product.usageScenes,
      clearDerived: true,
    });
    if (synchronized.missingLabels?.length) {
      throw new Error(`产品手卡模板缺少基础字段：${synchronized.missingLabels.join("、")}`);
    }
    upsertFeishuProductCardMapping({
      ...mappingKey,
      productId: product.id,
      documentId: shell.documentId,
      documentUrl: shell.documentUrl,
      lastProductPid: effectivePid,
      lastProductUrl: resolved.productUrl,
      lastProductName: effectiveName,
      managedProductPid: effectivePid,
    });
    if (verification.status === "partial") {
      const missing = verification.missingFields.length;
      productCardStatus = `部分完成：已写入 ${verification.verifiedFactCount} 条可信资料${missing ? `，${missing} 项暂无可验证证据` : ""}`;
    } else {
      productCardStatus = productCardWarning
        ? "手卡已就绪，资料已刷新，但文档权限待修复"
        : "已完成";
    }
  } catch (error) {
    productRefreshError = safeAutomationFailure(error);
    const identitySuffix = shell.identityWarning ? "；基础信息写入待重试" : "";
    const retainedSuffix = retainedVerifiedSnapshot ? "；已保留上次逐条验证通过的资料" : "";
    productCardStatus = `手卡已就绪，资料刷新失败：${productRefreshError}${retainedSuffix}${identitySuffix}`.slice(0, 500);
  }
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
