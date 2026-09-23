import "server-only";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db/pool";
import type { CatalogResult, CatalogSourceMetadata } from "@/lib/products/catalog-types";

export interface CatalogRow extends RowDataPacket {
  pid: string; fetch_state: "requested" | "ready" | "failed";
  analysis_state: "waiting" | "requested" | "ready" | "failed";
  error_message: string; result_json: CatalogResult | string | null;
  updated_at: string;
}
export async function readCatalog(pid: string) {
  const pool = await getPool();
  const [rows] = await pool.execute<CatalogRow[]>("SELECT * FROM product_catalog_cache WHERE pid=?", [pid]);
  return rows[0] || null;
}
export async function claimCatalog(pid: string) {
  const pool = await getPool();
  const now = new Date().toISOString();
  const [result] = await pool.execute<ResultSetHeader>(
    "INSERT IGNORE INTO product_catalog_cache(pid,fetch_state,analysis_state,created_at,updated_at) VALUES (?,'requested','waiting',?,?)", [pid, now, now],
  );
  return result.affectedRows === 1;
}
/** A caller must first verify the durable INSUFFICIENT_CREDITS receipt. */
export async function claimCatalogCreditRetry(pid: string, updatedAt: string) {
  const pool = await getPool();
  const [result] = await pool.execute<ResultSetHeader>(
    "UPDATE product_catalog_cache SET fetch_state='requested',error_message='',updated_at=? WHERE pid=? AND fetch_state='failed' AND analysis_state='waiting' AND result_json IS NULL AND updated_at=?",
    [new Date().toISOString(), pid, updatedAt],
  );
  return result.affectedRows === 1;
}
/** Recover a legacy failed supplier row through the free public source. */
export async function claimCatalogPublicRecovery(pid: string, updatedAt: string) {
  const pool = await getPool();
  const [result] = await pool.execute<ResultSetHeader>(
    "UPDATE product_catalog_cache SET fetch_state='requested',error_message='',updated_at=? WHERE pid=? AND fetch_state='failed' AND analysis_state='waiting' AND result_json IS NULL AND updated_at=?",
    [new Date().toISOString(), pid, updatedAt],
  );
  return result.affectedRows === 1;
}
export async function markCatalogFetched(pid: string) {
  const pool = await getPool();
  await pool.execute("UPDATE product_catalog_cache SET fetch_state='ready',error_message='',updated_at=? WHERE pid=? AND fetch_state='requested'", [new Date().toISOString(), pid]);
}
export async function claimCatalogAnalysis(pid: string) {
  const pool = await getPool();
  const [result] = await pool.execute<ResultSetHeader>(
    "UPDATE product_catalog_cache SET analysis_state='requested',updated_at=? WHERE pid=? AND fetch_state='ready' AND analysis_state='waiting'", [new Date().toISOString(), pid],
  );
  return result.affectedRows === 1;
}
export async function finishCatalogAnalysis(pid: string, result: CatalogResult) {
  const pool = await getPool();
  await pool.execute("UPDATE product_catalog_cache SET analysis_state='ready',result_json=?,error_message='',updated_at=? WHERE pid=? AND analysis_state='requested'", [JSON.stringify(result), new Date().toISOString(), pid]);
}
export async function failCatalog(pid: string, stage: "fetch" | "analysis", message: string) {
  const pool = await getPool();
  const column = stage === "fetch" ? "fetch_state" : "analysis_state";
  await pool.execute(`UPDATE product_catalog_cache SET ${column}='failed',error_message=?,updated_at=? WHERE pid=? AND ${column}='requested'`, [message.slice(0, 500), new Date().toISOString(), pid]);
}

export async function saveCatalogMetadata(value: CatalogSourceMetadata) {
  const pool = await getPool();
  await pool.execute(
    `INSERT INTO product_catalog_metadata
      (pid,source,title,shop_name,description,main_image_urls_json,source_url,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE source=VALUES(source),title=VALUES(title),shop_name=VALUES(shop_name),
        description=VALUES(description),main_image_urls_json=VALUES(main_image_urls_json),
        source_url=VALUES(source_url),updated_at=VALUES(updated_at)`,
    [value.pid, value.source, value.title, value.shopName, value.description,
      JSON.stringify(value.mainImageUrls), value.sourceUrl, value.updatedAt],
  );
}

interface CatalogMetadataRow extends RowDataPacket {
  pid: string; source: string; title: string; shop_name: string; description: string;
  main_image_urls_json: string[] | string; source_url: string; updated_at: string;
}

export async function readCatalogMetadata(pid: string): Promise<CatalogSourceMetadata | null> {
  const pool = await getPool();
  const [rows] = await pool.execute<CatalogMetadataRow[]>("SELECT * FROM product_catalog_metadata WHERE pid=?", [pid]);
  const row = rows[0];
  if (!row) return null;
  const images = typeof row.main_image_urls_json === "string"
    ? JSON.parse(row.main_image_urls_json) as unknown
    : row.main_image_urls_json;
  return {
    pid: row.pid,
    source: row.source === "tiktok-public" ? "tiktok-public" : "chuhaijiang",
    title: row.title,
    shopName: row.shop_name,
    description: row.description,
    mainImageUrls: Array.isArray(images) ? images.filter(value => typeof value === "string") : [],
    sourceUrl: row.source_url,
    updatedAt: row.updated_at,
  };
}

export type CatalogStatus = {
  pid: string; source: "tiktok-public" | "chuhaijiang" | null;
  fetchState: CatalogRow["fetch_state"] | null;
  analysisState: CatalogRow["analysis_state"] | null;
  model: string; errorMessage: string; updatedAt: string;
};

/** Batch status read for the admin page; never invokes a provider or model. */
export async function readCatalogStatuses(pids: string[]): Promise<Map<string, CatalogStatus>> {
  const unique = [...new Set(pids.map(value => value.trim()).filter(Boolean))];
  if (!unique.length) return new Map();
  const pool = await getPool();
  const placeholders = unique.map(() => "?").join(",");
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT c.pid,c.fetch_state,c.analysis_state,c.error_message,c.result_json,c.updated_at,m.source
       FROM product_catalog_cache c LEFT JOIN product_catalog_metadata m ON m.pid=c.pid
      WHERE c.pid IN (${placeholders})`, unique,
  );
  return new Map(rows.map(row => {
    let result: unknown = row.result_json;
    if (typeof result === "string") { try { result = JSON.parse(result); } catch { result = null; } }
    const model = result && typeof result === "object" && typeof (result as { model?: unknown }).model === "string"
      ? String((result as { model: string }).model) : "";
    const source = row.source === "tiktok-public" || row.source === "chuhaijiang" ? row.source : null;
    return [String(row.pid), {
      pid: String(row.pid), source, fetchState: row.fetch_state as CatalogRow["fetch_state"],
      analysisState: row.analysis_state as CatalogRow["analysis_state"], model,
      errorMessage: String(row.error_message || ""), updatedAt: String(row.updated_at || ""),
    }];
  }));
}
