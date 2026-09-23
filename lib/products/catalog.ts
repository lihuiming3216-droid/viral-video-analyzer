import "server-only";
import path from "node:path";
import { requireAiRuntime } from "@/lib/ai/settings";
import { catalogError, CatalogError, validatePid, cachedCatalogResult, type CatalogResult } from "@/lib/products/catalog-types";
import { readCatalog, claimCatalog, claimCatalogCreditRetry, claimCatalogPublicRecovery, markCatalogFetched, claimCatalogAnalysis, finishCatalogAnalysis, failCatalog, readCatalogMetadata, saveCatalogMetadata, type CatalogRow } from "@/lib/products/catalog-store";
import { cachedProduct, fetchProductOnce, prepareCatalogEvidence, catalogDirectory, readPrivateJson, savePrivate, readCreditRejection, archiveCreditRejection, catalogSourceMetadata } from "@/lib/products/catalog-source";
import { cachedPublicProduct, fetchPublicProductOnce } from "@/lib/products/tiktok-public-source";
import { analyzeCatalog } from "@/lib/products/catalog-analyzer";

const inFlight = new Map<string, Promise<CatalogResult>>();
let catalogQueue: Promise<unknown> = Promise.resolve();

function enqueueCatalog<T>(operation: () => Promise<T>): Promise<T> {
  const task = catalogQueue.then(operation);
  catalogQueue = task.catch(() => undefined);
  return task;
}

function supplierItem(item: Record<string, unknown>, publicFailure = false): Record<string, unknown> {
  return {
    ...item,
    _catalog_source: "chuhaijiang",
    ...(publicFailure ? { _source_warning: "TikTok公开商品资料不可用，已使用出海匠备选资料" } : {}),
  };
}

async function cachedCatalogProduct(pid: string): Promise<Record<string, unknown> | null> {
  let publicFailed = false;
  try {
    const item = await cachedPublicProduct(pid);
    if (item) return item;
  } catch {
    publicFailed = true;
  }
  const item = await cachedProduct(pid);
  return item ? supplierItem(item, publicFailed) : null;
}

async function fetchCatalogProductOnce(pid: string): Promise<Record<string, unknown>> {
  try {
    return await fetchPublicProductOnce(pid);
  } catch {
    if (process.env.CHUHAIJIANG_FALLBACK_ENABLED !== "true") {
      throw new CatalogError("TikTok公开商品资料不可用；出海匠付费备选当前已停用");
    }
    if (!process.env.CHUHAIJIANG_API_KEY?.trim()) {
      throw new CatalogError("TikTok公开商品资料不可用，且未配置出海匠备选接口");
    }
    return supplierItem(await fetchProductOnce(pid), true);
  }
}

async function recoverFailedWithPublicSource(pid: string, row: CatalogRow): Promise<Record<string, unknown>> {
  if (!await claimCatalogPublicRecovery(pid, row.updated_at)) {
    throw new CatalogError("该 PID 已开始免费资料恢复，请稍后查看");
  }
  try {
    const item = await fetchPublicProductOnce(pid);
    await markCatalogFetched(pid);
    return item;
  } catch (error) {
    await failCatalog(pid, "fetch", catalogError(error));
    const failed = await readCatalog(pid);
    if (process.env.CHUHAIJIANG_FALLBACK_ENABLED === "true" && failed) {
      const proof = await readCreditRejection(pid);
      if (proof) return retryCreditRejection(pid, failed);
    }
    throw error;
  }
}

async function rememberCatalogProduct(pid: string, item: Record<string, unknown>) {
  const metadata = catalogSourceMetadata(pid, item);
  await saveCatalogMetadata(metadata);
  return metadata;
}

/** Exact source metadata for DB/product-card writeback; never invokes a provider. */
export async function getProductMetadataByPid(pid: string) {
  validatePid(pid);
  const existing = await readCatalogMetadata(pid);
  if (existing) return existing;
  const item = await cachedCatalogProduct(pid);
  if (!item) return null;
  return rememberCatalogProduct(pid, item);
}

/** Paid legacy recovery exists only behind an explicit operator switch. */
async function retryCreditRejection(pid: string, row: CatalogRow): Promise<Record<string, unknown>> {
  const proof = row.analysis_state === "waiting" && !row.result_json ? await readCreditRejection(pid) : null;
  if (!proof) throw new CatalogError(row.error_message);
  if (process.env.CHUHAIJIANG_FALLBACK_ENABLED !== "true") throw new CatalogError("出海匠付费备选当前已停用");
  if (!process.env.CHUHAIJIANG_API_KEY?.trim()) throw new CatalogError("未配置出海匠接口密钥，请管理员配置后再点击");
  if (!await claimCatalogCreditRetry(pid, row.updated_at)) throw new CatalogError("该 PID 已开始重试，请稍后查看手卡，不会重复取数");
  try {
    await archiveCreditRejection(pid, proof);
    const item = supplierItem(await fetchProductOnce(pid), true);
    await markCatalogFetched(pid);
    return item;
  } catch (error) {
    await failCatalog(pid, "fetch", catalogError(error));
    throw error;
  }
}

/** Read the supplier's exact-PID title without invoking AI or guessing from a URL. */
export function getProductNameByPid(pid: string): Promise<string> {
  validatePid(pid);
  // Share the catalog queue so a name lookup cannot race a same-process fetch.
  // The existing DB claim and durable request marker protect other processes.
  return enqueueCatalog(async () => {
    const existing = await readCatalog(pid);
    let item = existing?.fetch_state === "failed"
      ? await recoverFailedWithPublicSource(pid, existing) : await cachedCatalogProduct(pid);
    if (!item) {
      const row = await readCatalog(pid);
      if (row?.fetch_state === "failed") throw new CatalogError(row.error_message);
      if (row) throw new CatalogError("该 PID 已取数或正在取数，但没有可用的原始资料；不会自动重复收费，请稍后重试或手动填写产品名称");
      if (!await claimCatalog(pid)) throw new CatalogError("该 PID 的取数已开始，不会重复收费；请稍后重试或手动填写产品名称");
      try { item = await fetchCatalogProductOnce(pid); }
      catch (error) { await failCatalog(pid, "fetch", catalogError(error)); throw error; }
      await markCatalogFetched(pid);
    }
    await rememberCatalogProduct(pid, item);
    // Only documented title fields are accepted. Never coerce an object,
    // generate a placeholder, or use a related/recommended product's name.
    for (const key of ["product_name", "product_title"]) {
      const value = item[key];
      if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ");
    }
    throw new CatalogError("该 PID 的商品资料没有可用的产品名称，请在表格中补填产品名称后再点击；已保留资料，不会重复收费取数");
  });
}

/** One paid source request and one automatic organization per PID, across all buttons/cards. */
export function getProductCatalog(pid: string): Promise<CatalogResult> {
  validatePid(pid);
  const active = inFlight.get(pid);
  if (active) return active;
  // One product pipeline per process bounds image/base64 memory. This queue is
  // separate from the existing two-video analysis queue and never changes it.
  const task = enqueueCatalog(() => runCatalog(pid)).finally(() => { inFlight.delete(pid); });
  inFlight.set(pid, task);
  return task;
}

async function runCatalog(pid: string): Promise<CatalogResult> {
  let row = await readCatalog(pid);
  if (row?.analysis_state === "ready" && row.result_json) {
    const result = typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json;
    return cachedCatalogResult(result, pid)!;
  }
  if (row?.analysis_state === "failed") throw new CatalogError(row.error_message);
  if (row?.fetch_state === "failed") await requireAiRuntime("product");
  let item = row?.fetch_state === "failed" ? await recoverFailedWithPublicSource(pid, row) : await cachedCatalogProduct(pid);
  if (row?.fetch_state === "failed") row = await readCatalog(pid);
  const resultFile = path.join(catalogDirectory(pid), "organized.json");
  const durable = cachedCatalogResult(await readPrivateJson(resultFile), pid);
  if (!row) {
    // Missing credentials should not burn the once-only request slot.
    if (!durable) await requireAiRuntime("product");
    const owner = await claimCatalog(pid);
    if (owner && !item) {
      try { item = await fetchCatalogProductOnce(pid); }
      catch (error) { await failCatalog(pid, "fetch", catalogError(error)); throw error; }
    }
    row = await readCatalog(pid);
  }
  if (!item) throw new CatalogError("该 PID 的取数已开始或结果待核查，不会自动重复收费；请稍后再点击查看");
  await rememberCatalogProduct(pid, item);
  await markCatalogFetched(pid);
  if (row?.analysis_state === "requested") {
    const recovered = cachedCatalogResult(await readPrivateJson(resultFile), pid);
    if (recovered) {
      await finishCatalogAnalysis(pid, recovered);
      return recovered;
    }
  }
  const config = durable ? undefined : await requireAiRuntime("product");
  if (!await claimCatalogAnalysis(pid)) {
    throw new CatalogError("该 PID 的资料整理已开始或结果待核查；不会自动重复请求，请稍后再点击查看");
  }
  let organizedSaved = false;
  try {
    const recovered = cachedCatalogResult(await readPrivateJson(resultFile), pid);
    if (recovered) {
      organizedSaved = true;
      await finishCatalogAnalysis(pid, recovered);
      return recovered;
    }
    const evidence = await prepareCatalogEvidence(pid, item);
    const result = await analyzeCatalog(evidence, config);
    await savePrivate(resultFile, JSON.stringify(result));
    organizedSaved = true;
    await finishCatalogAnalysis(pid, result);
    return result;
  } catch (error) {
    // Keep requested if the result is already durable but the DB write failed;
    // the next click recovers it instead of calling the model again.
    if (!organizedSaved) await failCatalog(pid, "analysis", catalogError(error));
    throw error;
  }
}
