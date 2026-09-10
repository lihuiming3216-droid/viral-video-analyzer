import "server-only";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db/pool";
import type { CatalogResult } from "@/lib/products/catalog-types";

export interface CatalogRow extends RowDataPacket {
  pid: string; fetch_state: "requested" | "ready" | "failed";
  analysis_state: "waiting" | "requested" | "ready" | "failed";
  error_message: string; result_json: CatalogResult | string | null;
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
