import "server-only";
import { createHash } from "node:crypto";
import type { Client } from "@larksuiteoapi/node-sdk";
import { syncProductCardManagedFields } from "@/lib/feishu/document";
import { getProductCatalog } from "@/lib/products/catalog";
import { reorganizeCatalogFromCache } from "@/lib/products/catalog-reorganize";
import { readCatalog } from "@/lib/products/catalog-store";
import { cachedCatalogResult, catalogFields, validatePid } from "@/lib/products/catalog-types";


function reply(body: Record<string, unknown>, options: { status?: number } = {}) {
  return { body, status: options.status || 200 };
}

const labels = {
  sku: "产品SKU", coreFunctions: "产品主要功能", productParameters: "产品参数",
  usageMethod: "使用方法", audience: "适用人群", scenes: "使用场景",
} as const;

function needsBackfill(value: string | undefined) {
  const normalized = (value || "").replace(/\s+/g, "").trim();
  return !normalized || /^(未找到|无法获取|无法分析|暂无|无)$/.test(normalized);
}

/** Legacy maintenance: fill blanks/missing-value markers, never create a card or replace substantive text. */
export async function backfillProductCard(client: Client, rawPid: string, rawDocumentId: string) {
  return writeProductCard(client, rawPid, rawDocumentId, false);
}

/** Explicit overwrite only: use verified existing cache, never request a provider. */
export async function refreshProductCard(client: Client, rawPid: string, rawDocumentId: string) {
  return writeProductCard(client, rawPid, rawDocumentId, true);
}

async function writeProductCard(client: Client, rawPid: string, rawDocumentId: string, refresh: boolean) {
  const pid = validatePid(rawPid.trim());
  const documentId = rawDocumentId.trim();
  if (!/^[A-Za-z0-9_-]{10,191}$/.test(documentId)) {
    return reply({ ok: false, error: "文档 ID 无效" }, { status: 400 });
  }

  const preflight = await syncProductCardManagedFields(client, {
    documentId, mode: "verified-basic", preflightOnly: true, protectRevision: true,
  });
  if (preflight.duplicateLabels.length) {
    return reply({ ok: false, error: `模板字段重复：${preflight.duplicateLabels.join("、")}` }, { status: 409 });
  }
  if (!preflight.currentValues["商品ID"]) {
    return reply({ ok: false, error: "手卡缺少商品 ID，无法确认归属；请先补填正确 PID" }, { status: 409 });
  }
  if (preflight.currentValues["商品ID"] !== pid) {
    return reply({ ok: false, error: "手卡商品 ID 与任务 PID 不一致" }, { status: 409 });
  }
  const requested = Object.entries(labels).filter(([, label]) =>
    !preflight.missingLabels?.includes(label) && (refresh || needsBackfill(preflight.currentValues[label]))).map(([key]) => key);
  if (!requested.length) return reply({ ok: true, state: "complete", filled: [], message: "无需补录" });

  let catalog;
  const current = await readCatalog(pid);
  if (refresh) {
    let stored: unknown;
    try { stored = typeof current?.result_json === "string" ? JSON.parse(current.result_json) : current?.result_json; }
    catch { return reply({ ok: false, error: "商品缓存格式无效，未改动手卡，请管理员核查" }, { status: 409 }); }
    catalog = current?.fetch_state === "ready" && current.analysis_state === "ready" ? cachedCatalogResult(stored, pid) : null;
    if (!catalog) return reply({ ok: false, error: "没有可用的已整理缓存；未改动手卡。请先在后台重新整理商品资料，再刷新这份手卡" }, { status: 409 });
  } else if (current?.fetch_state === "ready" && current.analysis_state === "failed") {
    // Repeated HTTP submissions for the same failed catalog are one repair,
    // not fresh billable reorganizations. Explicit admin reorganization has
    // its own request ID when another paid attempt is really intended.
    const hash = createHash("sha256").update(`backfill:${pid}:${current.updated_at}`).digest("hex").slice(0, 32);
    const recoveryId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
    catalog = await reorganizeCatalogFromCache(pid, recoveryId);
  } else {
    catalog = await getProductCatalog(pid);
  }
  const input: Parameters<typeof syncProductCardManagedFields>[1] = {
    documentId, mode: "verified-basic", derivedOnly: true,
    expectedValues: preflight.currentValues, preserveExistingOnMissing: true, protectRevision: true,
  };
  const filled: string[] = [];
  for (const key of requested) {
    const typed = key as keyof typeof labels;
    const fact = catalog.fields[typed];
    if (!fact || fact.basis === "missing" || needsBackfill(fact.text)) continue;
    if (typed === "coreFunctions") input.coreFunctions = [fact.text];
    else input[typed] = fact.text;
    filled.push(labels[typed]);
  }
  if (!filled.length) {
    return reply({ ok: true, state: "partial", filled, missing: requested.map(key => catalogFields[key as keyof typeof catalogFields]) });
  }
  const result = await syncProductCardManagedFields(client, input);
  const actualFilled = filled.filter(label => ![...result.skippedLabels, ...result.missingLabels].some(skipped => skipped === label));
  return reply({
    ok: true, state: actualFilled.length < requested.length ? "partial" : "complete", filled: actualFilled,
    skipped: result.skippedLabels, missingTemplate: result.missingLabels,
    model: catalog.model,
  });
}
