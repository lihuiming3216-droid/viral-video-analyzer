import "server-only";
import path from "node:path";
import { requireAiRuntime } from "@/lib/ai/settings";
import { catalogError, CatalogError, validatePid, cachedCatalogResult, type CatalogResult } from "@/lib/products/catalog-types";
import { readCatalog, claimCatalog, markCatalogFetched, claimCatalogAnalysis, finishCatalogAnalysis, failCatalog } from "@/lib/products/catalog-store";
import { cachedProduct, fetchProductOnce, prepareCatalogEvidence, catalogDirectory, readPrivateJson, savePrivate } from "@/lib/products/catalog-source";
import { analyzeCatalog } from "@/lib/products/catalog-analyzer";

const inFlight = new Map<string, Promise<CatalogResult>>();
let catalogQueue: Promise<unknown> = Promise.resolve();

/** One paid source request and one automatic organization per PID, across all buttons/cards. */
export function getProductCatalog(pid: string): Promise<CatalogResult> {
  validatePid(pid);
  const active = inFlight.get(pid);
  if (active) return active;
  // One product pipeline per process bounds image/base64 memory. This queue is
  // separate from the existing two-video analysis queue and never changes it.
  const task = catalogQueue.then(() => runCatalog(pid)).finally(() => { inFlight.delete(pid); });
  catalogQueue = task.catch(() => undefined);
  inFlight.set(pid, task);
  return task;
}

async function runCatalog(pid: string): Promise<CatalogResult> {
  let row = await readCatalog(pid);
  if (row?.analysis_state === "ready" && row.result_json) {
    const result = typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json;
    return cachedCatalogResult(result, pid)!;
  }
  if (row?.fetch_state === "failed" || row?.analysis_state === "failed") throw new CatalogError(row.error_message);
  let item = await cachedProduct(pid);
  const resultFile = path.join(catalogDirectory(pid), "organized.json");
  const durable = cachedCatalogResult(await readPrivateJson(resultFile), pid);
  if (!row) {
    // Missing credentials should not burn the once-only request slot.
    if (!durable) await requireAiRuntime("product");
    if (!item && !process.env.CHUHAIJIANG_API_KEY?.trim()) throw new CatalogError("未配置出海匠接口密钥，请管理员配置后再点击");
    const owner = await claimCatalog(pid);
    if (owner && !item) {
      try { item = await fetchProductOnce(pid); }
      catch (error) { await failCatalog(pid, "fetch", catalogError(error)); throw error; }
    }
    row = await readCatalog(pid);
  }
  if (!item) throw new CatalogError("该 PID 的取数已开始或结果待核查，不会自动重复收费；请稍后再点击查看");
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
