import "server-only";
import { randomUUID } from "node:crypto";
import type { Client } from "@larksuiteoapi/node-sdk";
import { syncProductCardManagedFields } from "@/lib/feishu/document";
import { getProductCatalog } from "@/lib/products/catalog";
import { reorganizeCatalogFromCache } from "@/lib/products/catalog-reorganize";
import { readCatalog } from "@/lib/products/catalog-store";
import { catalogFields, validatePid } from "@/lib/products/catalog-types";


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

/** One-card maintenance endpoint. It never creates a card and never overwrites a populated field. */
export async function backfillProductCard(client: Client, rawPid: string, rawDocumentId: string) {
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
  if (preflight.currentValues["商品ID"] && preflight.currentValues["商品ID"] !== pid) {
    return reply({ ok: false, error: "手卡商品 ID 与任务 PID 不一致" }, { status: 409 });
  }
  const requested = Object.entries(labels).filter(([, label]) => needsBackfill(preflight.currentValues[label])).map(([key]) => key);
  if (!requested.length) return reply({ ok: true, state: "complete", filled: [], message: "无需补录" });

  let catalog;
  const current = await readCatalog(pid);
  if (current?.fetch_state === "ready" && current.analysis_state === "failed") {
    catalog = await reorganizeCatalogFromCache(pid, randomUUID());
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
