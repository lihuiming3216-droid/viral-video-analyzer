import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fetchWithProxy } from "@/lib/network";
import { CatalogError, exactProduct, object, validatePid, type CatalogEvidence } from "@/lib/products/catalog-types";

const ROOT = path.join(process.cwd(), ".data/provider-evidence/chuhaijiang/us");
export const MAX_CATALOG_IMAGES = 8;
const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
export const catalogDirectory = (pid: string) => path.join(ROOT, validatePid(pid));
const creditsMessage = "出海匠余额不足，商品资料尚未获取；请充值后再次点击“补录手卡”重试";

function insufficientCredits(body: Buffer) {
  try { return ["INSUFFICIENT_CREDITS", "INSUFFICIENT_BALANCE"].includes(String(object(JSON.parse(body.toString("utf8"))).code)); }
  catch { return false; }
}

/** Only a checksummed, explicit credit rejection can release a failed claim. */
export async function readCreditRejection(pid: string): Promise<string | null> {
  const directory = catalogDirectory(pid);
  const receipt = object(await readPrivateJson(path.join(directory, "receipt.json")));
  if (receipt.pid !== pid || receipt.country !== "us" || receipt.httpStatus !== 402) return null;
  if (await readPrivateJson(path.join(directory, "organized.json"))
    || await readPrivateJson(path.join(directory, "analysis-started.json"))) return null;
  const file = path.join(directory, "response.json");
  try {
    if ((await stat(file)).size > 10 * 1024 * 1024) return null;
    const body = await readFile(file);
    return hash(body) === receipt.sha256 && insufficientCredits(body) ? hash(body) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Called only after winning the DB retry claim. Preserve the complete rejected attempt. */
export async function archiveCreditRejection(pid: string, expectedHash: string) {
  if (await readCreditRejection(pid) !== expectedHash) throw new CatalogError("商品取数记录已变化，已停止重试，请管理员检查");
  const archive = path.join(ROOT, "credit-rejections");
  await mkdir(archive, { recursive: true, mode: 0o700 });
  await rename(catalogDirectory(pid), path.join(archive, `${pid}-${randomUUID()}`));
  for (const directory of [archive, ROOT]) {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

export async function claimAnalysisFile(pid: string, runId?: string) {
  if (runId && !/^[a-f0-9-]{36}$/.test(runId)) throw new CatalogError("资料重新整理任务标识无效");
  const directory = runId ? path.join(catalogDirectory(pid), "reorganizations", runId) : catalogDirectory(pid);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let file;
  try { file = await open(path.join(directory, "analysis-started.json"), "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CatalogError("这个 PID 已提交过图文整理，但没有完整结果；不会自动重复请求");
    throw error;
  }
  try { await file.writeFile(JSON.stringify({ pid, startedAt: new Date().toISOString() })); await file.sync(); }
  finally { await file.close(); }
  const parent = await open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

export async function readPrivateJson(file: string) {
  try {
    if ((await stat(file)).size > 10 * 1024 * 1024) throw new CatalogError("商品缓存过大，请管理员检查");
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Atomic, durable files: a crash must not turn an incomplete response into a cache hit.
export async function savePrivate(file: string, body: Buffer | string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function limitedBody(response: Response, limit: number) {
  if (!response.body) throw new CatalogError("服务返回空响应");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) throw new CatalogError("服务返回内容超过安全大小，已停止");
      chunks.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export async function cachedProduct(pid: string) {
  const directory = catalogDirectory(pid);
  const receipt = object(await readPrivateJson(path.join(directory, "receipt.json")));
  if (!Object.keys(receipt).length) return null;
  const file = path.join(directory, "response.json");
  if ((await stat(file)).size > 10 * 1024 * 1024) throw new CatalogError("商品缓存过大");
  const body = await readFile(file);
  if (receipt.pid !== pid || receipt.country !== "us" || hash(body) !== receipt.sha256) {
    throw new CatalogError("商品缓存校验失败，不会自动重新取数");
  }
  if (receipt.httpStatus === 402 && insufficientCredits(body)) throw new CatalogError(creditsMessage);
  if (receipt.httpStatus !== 200) throw new CatalogError("商品缓存校验失败，不会自动重新取数");
  return exactProduct(JSON.parse(body.toString("utf8")), pid);
}

export async function fetchProductOnce(pid: string) {
  const existing = await cachedProduct(pid);
  if (existing) return existing;
  const key = process.env.CHUHAIJIANG_API_KEY?.trim();
  if (!key) throw new CatalogError("未配置出海匠接口密钥，请管理员配置后再点击");
  const directory = catalogDirectory(pid);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Never clear this marker here. Only a DB-claimed credit rejection may be archived.
  let marker;
  try { marker = await open(path.join(directory, "request-started.json"), "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CatalogError("这个 PID 已请求过，但没有完整可用的结果；不会自动再次收费取数");
    throw error;
  }
  try {
    await marker.writeFile(JSON.stringify({ pid, country: "us", startedAt: new Date().toISOString(), automaticRetries: 0 }));
    await marker.sync();
  } finally { await marker.close(); }
  const directoryHandle = await open(directory, "r");
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  const response = await fetchWithProxy(`https://openapi.gateway.chuhaijiang.com/open/v1/products/${pid}?country=us&include=channel,core`, {
    headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(45_000),
  });
  const body = await limitedBody(response, 10 * 1024 * 1024);
  await savePrivate(path.join(directory, "response.json"), body);
  await savePrivate(path.join(directory, "receipt.json"), JSON.stringify({
    pid, country: "us", fetchedAt: new Date().toISOString(), httpStatus: response.status,
    bytes: body.length, sha256: hash(body), automaticRetries: 0,
  }));
  if (response.status === 402 && insufficientCredits(body)) throw new CatalogError(creditsMessage);
  if (!response.ok) throw new CatalogError(`出海匠取数失败（HTTP ${response.status}），不会自动再次收费请求`);
  return exactProduct(JSON.parse(body.toString("utf8")), pid);
}

export function imageMime(body: Buffer) {
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (body[0] === 255 && body[1] === 216 && body[2] === 255) return "image/jpeg";
  if (body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new CatalogError("图片内容不是支持的图片格式");
}

export function imageCandidates(item: Record<string, unknown>) {
  const images = Array.isArray(item.product_images) ? item.product_images : [];
  const props = Array.isArray(item.product_sku_props) ? item.product_sku_props : [];
  const candidates: Array<{ label: string; image: Record<string, unknown>; kind: "product" | "sku" }> =
    images.map((image, index) => ({ label: `商品图${index + 1}`, image: object(image), kind: "product" }));
  for (const prop of props.map(object)) {
    for (const value of (Array.isArray(prop.sale_prop_values) ? prop.sale_prop_values : []).map(object)) {
      if (value.image) candidates.push({ label: String(value.prop_value || "SKU图片"), image: object(value.image), kind: "sku" });
    }
  }
  return candidates.map(({ label, image, kind }, index) => ({ label, index, kind, url: String(image.url || image.thumb_url || "") }));
}

/** Keep both overview and variant evidence while bounding vision-token cost. */
export function selectCatalogImages(candidates: ReturnType<typeof imageCandidates>) {
  if (candidates.length <= MAX_CATALOG_IMAGES) return candidates;
  const product = candidates.filter(candidate => candidate.kind === "product");
  const sku = candidates.filter(candidate => candidate.kind === "sku");
  const selected = [...product.slice(0, 4), ...sku.slice(0, 4)];
  const selectedIndexes = new Set(selected.map(candidate => candidate.index));
  for (const candidate of candidates) {
    if (selected.length >= MAX_CATALOG_IMAGES) break;
    if (!selectedIndexes.has(candidate.index)) {
      selected.push(candidate);
      selectedIndexes.add(candidate.index);
    }
  }
  return selected.sort((left, right) => left.index - right.index);
}

// Signed image URLs are private cache data, never model text or log messages.
function removeUrls(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/https?:\/\/[^\s<>"']+/g, "[链接省略]");
  if (Array.isArray(value)) return value.map(removeUrls);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/url|image|token|secret/i.test(key)).map(([key, part]) => [key, removeUrls(part)]));
  return value;
}

export async function prepareCatalogEvidence(pid: string, item: Record<string, unknown>, options: { cacheOnly?: boolean } = {}): Promise<CatalogEvidence> {
  const directory = catalogDirectory(pid);
  const fields = Object.fromEntries(Object.entries(item).filter(([key]) =>
    /^(product_name|product_title|product_specifications|product_sku_props)$/.test(key) || /description|detail|feature|function|instruction|usage/i.test(key)));
  const text = JSON.stringify(removeUrls(fields));
  if (text.length > 100_000) throw new CatalogError("商品文字资料过长，已保留原文，需管理员处理");
  const allCandidates = imageCandidates(item);
  const candidates = selectCatalogImages(allCandidates);
  const prior = await readPrivateJson(path.join(directory, "image-manifest.json"));
  const oldManifest = Array.isArray(prior) ? prior.map(object) : [];
  const manifest: Record<string, unknown>[] = [];
  const evidence: CatalogEvidence = { pid, text, images: [], warnings: [] };
  if (allCandidates.length > candidates.length) {
    evidence.warnings.push(`商品图片共${allCandidates.length}张；为控制费用，本次选取${candidates.length}张代表图（兼顾主图与SKU图）`);
  }
  let totalBytes = 0;
  const deadline = AbortSignal.timeout(90_000);
  for (const candidate of candidates) {
    const id = `image-${candidate.index + 1}`;
    try {
      const url = new URL(candidate.url);
      if (url.protocol !== "https:" || url.hostname !== "oss-t.chuhaijiang.com" || url.username || url.password || url.port) throw new CatalogError("图片来源不在已验证范围内");
      const entry = oldManifest[candidate.index];
      let body: Buffer | undefined;
      // Import the earlier evidence trial using basename + digest, never its old absolute path.
      if (entry && entry.label === candidate.label && /^[a-f0-9]{64}$/.test(String(entry.sha256))) {
        const file = path.join(directory, "images", path.basename(String(entry.file)));
        try {
          if ((await stat(file)).size <= 8 * 1024 * 1024) {
            const bytes = await readFile(file);
            if (hash(bytes) === entry.sha256) body = bytes;
          }
        } catch { /* Only the saved signed image URL may be tried; never repeat the paid detail call. */ }
      }
      if (!body) {
        if (options.cacheOnly) throw new CatalogError("重新整理只使用已存图片，不发起下载请求");
        const response = await fetchWithProxy(url, {
          redirect: "error", signal: AbortSignal.any([deadline, AbortSignal.timeout(25_000)]),
        });
        if (!response.ok) { await response.body?.cancel(); throw new CatalogError("图片下载失败"); }
        body = await limitedBody(response, 8 * 1024 * 1024);
      }
      const mime = imageMime(body); // Some valid images are served as application/octet-stream.
      totalBytes += body.length;
      if (totalBytes > 25 * 1024 * 1024) throw new CatalogError("商品图片总大小超过 25 MB");
      const file = `${String(candidate.index + 1).padStart(2, "0")}.${mime.split("/")[1]}`;
      if (!options.cacheOnly) await savePrivate(path.join(directory, "images", file), body);
      manifest.push({ label: candidate.label, file, bytes: body.length, sha256: hash(body) });
      evidence.images.push({ id, label: candidate.label, dataUrl: `data:${mime};base64,${body.toString("base64")}` });
    } catch {
      manifest.push({ label: candidate.label, failed: true });
      evidence.warnings.push(`${id}（${candidate.label.slice(0, 60)}）无法获取图片信息`);
    }
  }
  if (!options.cacheOnly) await savePrivate(path.join(directory, "image-manifest.json"), JSON.stringify(manifest));
  if (!evidence.images.length) evidence.warnings.push("无法获取图片信息；仅根据接口文字整理");
  return evidence;
}
