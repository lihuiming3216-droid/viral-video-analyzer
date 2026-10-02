export const catalogFields = {
  coreFunctions: "产品主要功能", sku: "产品SKU", productParameters: "产品参数",
  usageMethod: "使用方法", audience: "适用人群", scenes: "使用场景",
} as const;
export type CatalogField = keyof typeof catalogFields;
export const CATALOG_PENDING_TEXT = "待补齐";
export function isMissingCatalogText(value: string | undefined) {
  return /^(待补齐|未找到|无法获取|无法分析|暂无|无)?$/.test((value || "").replace(/\s+/g, ""));
}

/** A placeholder is not a product fact and may only occupy a missing field. */
export function pendingCatalogCardInput(currentValues: Partial<Record<string, string>>, missingLabels: readonly string[] = []) {
  const input: Partial<Record<Exclude<CatalogField, "coreFunctions">, string> & { coreFunctions: string[] }> = {};
  for (const [key, label] of Object.entries(catalogFields)) {
    if (missingLabels.includes(label) || !isMissingCatalogText(currentValues[label])) continue;
    if (key === "coreFunctions") input.coreFunctions = [CATALOG_PENDING_TEXT];
    else input[key as Exclude<CatalogField, "coreFunctions">] = CATALOG_PENDING_TEXT;
  }
  return input;
}
export type CatalogFact = { text: string; basis: "direct" | "inference" | "missing"; evidence: string[] };
export type CatalogResult = {
  pid: string; fields: Record<CatalogField, CatalogFact>; warnings: string[];
  model: string; createdAt: string;
};
export type CatalogImage = { id: string; label: string; dataUrl: string };
export type CatalogEvidence = { pid: string; text: string; images: CatalogImage[]; warnings: string[] };
export type CatalogSourceMetadata = {
  pid: string;
  source: "tiktok-public" | "chuhaijiang";
  title: string;
  shopName: string;
  description: string;
  mainImageUrls: string[];
  sourceUrl: string;
  updatedAt: string;
};
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export class CatalogError extends Error {}
export function catalogError(error: unknown) {
  return error instanceof CatalogError ? error.message : "商品资料处理失败，已保留缓存；请联系管理员检查，不会自动重复收费请求";
}
export function validatePid(pid: string) {
  if (!/^\d{6,30}$/.test(pid)) throw new CatalogError("商品 PID 格式不正确");
  return pid;
}
export function exactProduct(payload: unknown, pid: string) {
  const items = object(object(payload).data).items;
  if (!Array.isArray(items)) throw new CatalogError("出海匠没有返回商品资料，已停止，不会自动重新取数");
  const matches = items.map(object).filter(item => item.product_id === pid || (!item.product_id && item.id === pid));
  if (matches.length !== 1 || (matches[0].id && matches[0].id !== pid)) {
    throw new CatalogError("出海匠返回的商品 PID 不唯一或不匹配，已停止");
  }
  return matches[0];
}

export function cachedCatalogResult(value: unknown, pid: string): CatalogResult | null {
  if (value === null) return null;
  const result = object(value);
  if (result.pid !== pid || typeof result.model !== "string" || typeof result.createdAt !== "string"
    || !Array.isArray(result.warnings) || !result.warnings.every(w => typeof w === "string")
    || !Object.keys(catalogFields).every(key => {
      const fact = object(object(result.fields)[key]);
      return typeof fact.text === "string" && ["direct", "inference", "missing"].includes(String(fact.basis))
        && Array.isArray(fact.evidence) && fact.evidence.every(id => typeof id === "string");
    })) throw new CatalogError("商品整理缓存不完整或 PID 不匹配，已停止写入");
  return value as CatalogResult;
}

/** Old main/SKU image numbers must not become current detail-image evidence. */
export function restrictCachedCatalogEvidence(result: CatalogResult, images: CatalogImage[]): CatalogResult {
  const allowed = new Set(["product-text", ...images.filter(image =>
    /^image-[1-8]$/.test(image.id) && image.label === `详情图${image.id.slice(6)}`).map(image => image.id)]);
  const fields = { ...result.fields };
  const warnings = [...result.warnings];
  for (const key of Object.keys(catalogFields) as CatalogField[]) {
    const fact = fields[key];
    if (fact.basis !== "missing" && (!fact.evidence.length || !fact.evidence.every(id => allowed.has(id)))) {
      fields[key] = { text: "未找到", basis: "missing", evidence: [] };
      warnings.push(`${catalogFields[key]}的旧缓存来源不符合当前文字/详情图规则，未复用；已有手卡内容不改动`);
    }
  }
  return { ...result, fields, warnings: [...new Set(warnings)] };
}
