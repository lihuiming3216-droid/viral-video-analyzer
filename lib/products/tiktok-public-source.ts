import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fetchWithProxy } from "@/lib/network";
import { CatalogError, object, validatePid } from "@/lib/products/catalog-types";
import { tiktokProductUrlFromPid } from "@/lib/tiktok-product";

const ROOT = path.join(process.cwd(), ".data/provider-evidence/tiktok-public/us");
const MAX_PUBLIC_RESPONSE_BYTES = 10 * 1024 * 1024;
const hash = (body: Buffer | string) => createHash("sha256").update(body).digest("hex");

export const publicCatalogDirectory = (pid: string) => path.join(ROOT, validatePid(pid));

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function embeddedJson(html: string, id: string) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<script[^>]+id=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/script>`, "i"));
  if (!match?.[1]) return null;
  try { return JSON.parse(match[1]) as unknown; } catch { return null; }
}

function records(value: unknown) {
  const found: Record<string, unknown>[] = [];
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      stack.push(...[...current].reverse());
      continue;
    }
    const record = current as Record<string, unknown>;
    found.push(record);
    stack.push(...Object.values(record).reverse());
  }
  return found;
}

const TRUSTED_IMAGE_HOST_SUFFIXES = [
  "ibyteimg.com", "byteimg.com", "tiktokcdn.com", "tiktokcdn-us.com",
  "tiktokcdn-eu.com", "muscdn.com", "ttcdn-us.com", "ttcdn-eu.com",
] as const;

export function safePublicProductImageUrl(value: unknown) {
  const raw = clean(value);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
    if (!TRUSTED_IMAGE_HOST_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function imageUrls(value: unknown) {
  if (!value || typeof value !== "object") return [] as string[];
  const list = (value as Record<string, unknown>).url_list;
  return (Array.isArray(list) ? list : [])
    .map(safePublicProductImageUrl)
    .filter((url, index, all) => Boolean(url) && all.indexOf(url) === index);
}

function descriptionEvidence(value: unknown) {
  let parsed = value;
  if (typeof parsed === "string" && /^[\s]*[\[{]/.test(parsed)) {
    try { parsed = JSON.parse(parsed); } catch { /* Treat malformed JSON-like content as plain text. */ }
  }
  const texts: string[] = [];
  const detailImages: string[] = [];
  const addText = (candidate: unknown) => {
    const text = clean(candidate);
    if (!text || /^https?:\/\//i.test(text) || texts.includes(text)) return;
    texts.push(text);
  };
  const visitText = (candidate: unknown) => {
    if (typeof candidate === "string") {
      if (/^[\s]*[\[{]/.test(candidate)) {
        try { visitText(JSON.parse(candidate)); return; } catch { /* Keep the original plain text. */ }
      }
      addText(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visitText);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    for (const key of ["text", "t", "content", "description", "text_content", "textContent"]) {
      if (record[key] != null) visitText(record[key]);
    }
  };
  visitText(parsed);
  for (const record of records(parsed)) {
    for (const url of imageUrls(record.image || record).slice(0, 1)) {
      if (!detailImages.includes(url)) detailImages.push(url);
    }
  }
  return { texts, detailImages };
}

function skuName(sku: Record<string, unknown>) {
  const direct = clean(sku.sku_name);
  if (direct) return direct;
  return (Array.isArray(sku.sale_properties) ? sku.sale_properties : [])
    .map(value => value && typeof value === "object"
      ? clean((value as Record<string, unknown>).property_value_name)
      : "")
    .filter(Boolean)
    .join(" / ");
}

/** September 2026 PDP component data; never select recommendation/review records. */
function modernProduct(info: Record<string, unknown>) {
  return {
    ...info,
    name: info.title,
    description: info.desc_blocks,
    product_properties: (Array.isArray(info.specifications) ? info.specifications : []).map(value => {
      const item = object(value);
      return { property_name: item.name, property_values: [{ property_value_name: item.value }] };
    }),
    skus: (Array.isArray(info.skus) ? info.skus : []).map(value => {
      const sku = object(value);
      return {
        ...sku,
        sku_name: (Array.isArray(sku.sku_sale_props) ? sku.sku_sale_props : [])
          .map(part => clean(object(part).prop_value)).filter(Boolean).join(" / "),
        sku_quantity: { available_quantity: sku.stock },
      };
    }),
  };
}

/**
 * Normalize the exact-PID public router payload into the same source shape used
 * by the hand-card catalog. Main-gallery and SKU images remain metadata only;
 * visual evidence contains description-area detail images exclusively.
 */
export function parsePublicTikTokProductHtml(html: string, expectedPid: string, sourceUrl = "") {
  const pid = validatePid(expectedPid);
  const routerData = embeddedJson(html, "__MODERN_ROUTER_DATA__");
  if (!routerData) {
    if (/<title[^>]*>\s*Security Check\s*<\/title>/i.test(html)) {
      throw new CatalogError("TikTok 返回安全验证页，未取得商品资料");
    }
    throw new CatalogError("TikTok 公开商品页没有返回可解析的详情数据");
  }
  const all = records(routerData);
  const models = all.flatMap(record => {
    const model = record.product_model;
    return model && typeof model === "object" ? [model as Record<string, unknown>] : [];
  }).filter(model => clean(model.product_id) === pid && clean(model.name));
  const modern = all.flatMap(record => {
    const info = object(record.product_info);
    return info.product_id === pid && typeof info.title === "string" && info.title.trim()
      && Array.isArray(info.desc_blocks) ? [modernProduct(info)] : [];
  });
  models.unshift(...modern);
  const product = models.sort((left, right) => {
    const score = (item: Record<string, unknown>) => ["description", "images", "skus", "product_properties"]
      .filter(key => item[key] != null).length;
    return score(right) - score(left);
  })[0];
  if (!product) throw new CatalogError("TikTok 公开商品页没有找到与 PID 完全匹配的商品资料");

  const sellerId = clean(product.seller_id);
  const ownShop = object(product.seller);
  const shop = all.find(record => clean(record.shop_name) && (
    clean(record.seller_id) === sellerId || clean(record.shop_id) === sellerId
  ));
  const description = descriptionEvidence(product.description);
  const mainImages = (Array.isArray(product.images) ? product.images : [])
    .flatMap(imageUrls)
    .filter((url, index, values) => values.indexOf(url) === index);
  const specifications = (Array.isArray(product.product_properties) ? product.product_properties : [])
    .flatMap(value => {
      const property = object(value);
      const name = clean(property.property_name);
      const values = (Array.isArray(property.property_values) ? property.property_values : [])
        .map(part => clean(object(part).property_value_name)).filter(Boolean);
      return name && values.length ? [{ name, value: values.join("、") }] : [];
    });
  const priceBySku = Object.assign({}, ...all.map(record => record.skus_price)
    .filter(value => value && typeof value === "object" && !Array.isArray(value))) as Record<string, unknown>;
  const skus = (Array.isArray(product.skus) ? product.skus : []).flatMap(value => {
    const sku = object(value);
    const name = skuName(sku);
    const id = clean(sku.sku_id || sku.id);
    const quantity = object(sku.sku_quantity).available_quantity;
    const price = Object.keys(object(sku.price)).length ? object(sku.price) : object(priceBySku[id]);
    return name ? [{
      sku_id: id,
      sku_name: name,
      available_quantity: quantity != null && Number.isFinite(Number(quantity)) ? Number(quantity) : null,
      price: clean(price.sale_price_decimal || price.sale_price_format),
      currency: clean(price.currency_name || price.currency_symbol),
      sku_image: imageUrls(sku.sku_image)[0] || "",
    }] : [];
  });

  return {
    product_id: pid,
    product_name: clean(product.name),
    product_title: clean(product.name),
    product_description: description.texts.join("\n"),
    product_detail_images: description.detailImages.map(url => ({ url })),
    product_images: mainImages.map(url => ({ url })),
    product_specifications: specifications,
    product_skus: skus,
    shop_name: clean(ownShop.seller_id === sellerId ? ownShop.name : shop?.shop_name),
    seller_id: sellerId,
    _catalog_source: "tiktok-public",
    _source_url: sourceUrl || tiktokProductUrlFromPid(pid),
  } satisfies Record<string, unknown>;
}

async function savePrivate(file: string, body: Buffer | string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readJson(file: string) {
  try {
    if ((await stat(file)).size > MAX_PUBLIC_RESPONSE_BYTES) throw new CatalogError("TikTok 公开商品缓存过大");
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function limitedBody(response: Response) {
  if (!response.body) throw new CatalogError("TikTok 公开商品页返回空响应");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_PUBLIC_RESPONSE_BYTES) throw new CatalogError("TikTok 公开商品页内容超过安全大小");
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

export async function cachedPublicProduct(pid: string) {
  const directory = publicCatalogDirectory(pid);
  const receipt = object(await readJson(path.join(directory, "receipt.json")));
  if (!Object.keys(receipt).length) return null;
  if (receipt.pid !== pid || receipt.source !== "tiktok-public") throw new CatalogError("TikTok 公开商品缓存校验失败");
  if (receipt.state !== "ready") throw new CatalogError("TikTok 公开商品资料不可用");
  const file = path.join(directory, "product.json");
  const body = await readFile(file);
  if (hash(body) !== receipt.productSha256) throw new CatalogError("TikTok 公开商品缓存校验失败");
  const product = object(JSON.parse(body.toString("utf8")));
  if (product.product_id !== pid || product._catalog_source !== "tiktok-public") {
    throw new CatalogError("TikTok 公开商品缓存 PID 不匹配");
  }
  return product;
}

/** Reparse only a checksummed saved response; never performs an HTTP request. */
export async function recoverPublicProductFromSavedPage(pid: string, apply = false) {
  const normalized = validatePid(pid);
  const directory = publicCatalogDirectory(normalized);
  const receiptPath = path.join(directory, "receipt.json");
  const receipt = object(await readJson(receiptPath));
  if (receipt.pid !== normalized || receipt.source !== "tiktok-public" || receipt.state !== "failed") {
    throw new CatalogError("没有可恢复的失败商品页面");
  }
  const file = path.join(directory, "response.html");
  if ((await stat(file)).size > MAX_PUBLIC_RESPONSE_BYTES) throw new CatalogError("TikTok 公开商品缓存过大");
  const body = await readFile(file);
  if (!receipt.responseSha256 || hash(body) !== receipt.responseSha256) {
    throw new CatalogError("TikTok 原始商品页面校验失败，已停止恢复");
  }
  const product = parsePublicTikTokProductHtml(body.toString("utf8"), normalized,
    typeof receipt.finalUrl === "string" ? receipt.finalUrl : tiktokProductUrlFromPid(normalized));
  if (!apply) return product;
  // Keep the failed receipt and original HTML for audit/recovery. Repeated recovery
  // after an interrupted write publishes the same checksummed product.
  await copyFile(receiptPath, path.join(directory, "receipt.before-reparse.json"), constants.COPYFILE_EXCL)
    .catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const productBody = JSON.stringify(product);
  await savePrivate(path.join(directory, "product.json"), productBody);
  await savePrivate(receiptPath, JSON.stringify({
    ...receipt, state: "ready", productSha256: hash(productBody),
    recoveredAt: new Date().toISOString(), recovery: "saved-page-pdp-components-v1",
  }));
  return product;
}

/** Success is cached once. An explicit catalog request may retry a verified free-source failure. */
export async function fetchPublicProductOnce(pid: string, options: { retryFailed?: boolean } = {}) {
  const normalized = validatePid(pid);
  let existing;
  try { existing = await cachedPublicProduct(normalized); }
  catch {
    // Parser repairs always precede another capture. Corruption and wrong-PID
    // evidence are not retryable, and a successful snapshot is never replaced.
    try { return await recoverPublicProductFromSavedPage(normalized, true); }
    catch (error) {
      if (!options.retryFailed) throw error;
      return retryFailedPublicProduct(normalized, error);
    }
  }
  if (existing) return existing;
  const directory = publicCatalogDirectory(normalized);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let marker;
  try { marker = await open(path.join(directory, "request-started.json"), "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CatalogError("TikTok 公开商品页此前读取未完成，已改用备选来源");
    throw error;
  }
  try {
    await marker.writeFile(JSON.stringify({ pid: normalized, startedAt: new Date().toISOString(), automaticRetries: 0 }));
    await marker.sync();
  } finally { await marker.close(); }

  try { return await capturePublicProduct(normalized, tiktokProductUrlFromPid(normalized)); }
  catch (error) {
    if (!options.retryFailed) throw error;
    // Only the owner of this first capture bypasses the click cooldown. At
    // most one alternate free request follows; paid-provider markers are untouched.
    return retryFailedPublicProduct(normalized, error, true);
  }
}

async function retryFailedPublicProduct(pid: string, failure: unknown, immediate = false) {
  const directory = publicCatalogDirectory(pid);
  const receiptFile = path.join(directory, "receipt.json");
  const receiptBody = await readFile(receiptFile);
  const receipt = object(JSON.parse(receiptBody.toString("utf8")));
  const message = failure instanceof Error ? failure.message : "";
  if (receipt.pid !== pid || receipt.source !== "tiktok-public" || receipt.state !== "failed"
    || /校验|PID.*匹配|PID.*一致/.test(message)) throw failure;
  const status = Number(receipt.httpStatus || 0);
  const retryable = status && status !== 200
    ? status === 408 || status === 429 || status >= 500
    : /安全验证页|没有返回可解析的详情数据|读取失败/.test(String(receipt.errorMessage || message));
  if (!retryable) throw failure;
  if (receipt.responseSha256) {
    const file = path.join(directory, "response.html");
    if ((await stat(file)).size > MAX_PUBLIC_RESPONSE_BYTES || hash(await readFile(file)) !== receipt.responseSha256) {
      throw new CatalogError("TikTok 原始商品页面校验失败，已停止恢复");
    }
  }
  const fetchedAt = Date.parse(String(receipt.fetchedAt));
  if (!immediate && (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt < 60_000)) {
    throw new CatalogError("商品公开页刚刚读取失败，请一分钟后再次点击；公开页重试本身不收费");
  }
  // One durable retry per failed generation, even across processes/restarts.
  // Keep every old response and never delete a supplier or model charge marker.
  const generation = hash(receiptBody);
  const archive = path.join(directory, "retries", generation);
  await mkdir(archive, { recursive: true, mode: 0o700 });
  let marker;
  try { marker = await open(path.join(archive, "request-started.json"), "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CatalogError("该次公开页恢复已开始或结果待核查，请稍后查看；不会重复取数");
    throw error;
  }
  try { await marker.writeFile(JSON.stringify({ pid, source: "tiktok-public", startedAt: new Date().toISOString(), previousReceiptSha256: generation })); await marker.sync(); }
  finally { await marker.close(); }
  if (hash(await readFile(receiptFile)) !== generation) throw new CatalogError("商品公开页记录已变化，已停止重复恢复");
  await savePrivate(path.join(archive, "previous-receipt.json"), receiptBody);
  if (receipt.responseSha256) await copyFile(path.join(directory, "response.html"), path.join(archive, "previous-response.html"), constants.COPYFILE_EXCL);
  const primary = tiktokProductUrlFromPid(pid);
  const alternate = `https://shop.tiktok.com/us/pdp/${pid}?source=anchor`;
  const requestedUrl = receipt.requestedUrl === primary ? alternate : primary;
  return capturePublicProduct(pid, requestedUrl, generation);
}

async function capturePublicProduct(normalized: string, requestedUrl: string, retryFrom = "") {
  const directory = publicCatalogDirectory(normalized);
  let response: Response | undefined;
  let body = Buffer.alloc(0);
  try {
    response = await fetchWithProxy(requestedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
    });
    body = await limitedBody(response);
    await savePrivate(path.join(directory, "response.html"), body);
    if (!response.ok) throw new CatalogError(`TikTok 公开商品页返回 HTTP ${response.status}`);
    const product = parsePublicTikTokProductHtml(body.toString("utf8"), normalized, response.url);
    const productBody = JSON.stringify(product);
    await savePrivate(path.join(directory, "product.json"), productBody);
    await savePrivate(path.join(directory, "receipt.json"), JSON.stringify({
      pid: normalized,
      source: "tiktok-public",
      state: "ready",
      requestedUrl,
      finalUrl: response.url,
      fetchedAt: new Date().toISOString(),
      httpStatus: response.status,
      responseBytes: body.length,
      responseSha256: hash(body),
      productSha256: hash(productBody),
      automaticRetries: retryFrom ? 1 : 0,
      ...(retryFrom ? { retryFrom } : {}),
    }));
    return product;
  } catch (error) {
    await savePrivate(path.join(directory, "receipt.json"), JSON.stringify({
      pid: normalized,
      source: "tiktok-public",
      state: "failed",
      requestedUrl,
      ...(response ? { httpStatus: response.status, finalUrl: response.url } : {}),
      errorMessage: error instanceof CatalogError ? error.message : "TikTok 公开商品页读取失败",
      fetchedAt: new Date().toISOString(),
      responseBytes: body.length,
      responseSha256: body.length ? hash(body) : "",
      automaticRetries: retryFrom ? 1 : 0,
      ...(retryFrom ? { retryFrom } : {}),
    })).catch(() => undefined);
    if (error instanceof CatalogError) throw error;
    throw new CatalogError("TikTok 公开商品页读取失败");
  }
}
