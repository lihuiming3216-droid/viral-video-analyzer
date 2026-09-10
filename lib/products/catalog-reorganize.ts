import "server-only";
import path from "node:path";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db/pool";
import { requireAiRuntime } from "@/lib/ai/settings";
import { analyzeCatalog } from "@/lib/products/catalog-analyzer";
import { cachedProduct, prepareCatalogEvidence, catalogDirectory, readPrivateJson, savePrivate } from "@/lib/products/catalog-source";
import { CatalogError, catalogError, validatePid, cachedCatalogResult } from "@/lib/products/catalog-types";

let queue: Promise<unknown> = Promise.resolve();
/** Explicit admin action only. Bound image memory; no supplier calls or recycled charge markers. */
export function reorganizeCatalogFromCache(pid: string, id: string) {
  const task = queue.then(() => runReorganization(pid, id));
  queue = task.catch(() => undefined);
  return task;
}

async function runReorganization(pid: string, id: string) {
  validatePid(pid);
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new CatalogError("重新整理任务标识无效");
  const pool = await getPool();
  const connection = await pool.getConnection();
  const lock = "catalog-reorganize:" + pid;
  let locked = false;
  let claimed = false;
  let saved = false;
  try {
    const [locks] = await connection.execute<RowDataPacket[]>("SELECT GET_LOCK(?,0) AS acquired", [lock]);
    locked = Number(locks[0].acquired) === 1;
    if (!locked) throw new CatalogError("该PID已有重新整理任务，请勿重复点击");
    const [existing] = await connection.execute<RowDataPacket[]>("SELECT * FROM product_catalog_reorganizations WHERE id=?", [id]);
    if (existing[0] && existing[0].pid !== pid) throw new CatalogError("任务与PID不一致");
    const resultFile = path.join(catalogDirectory(pid), "reorganizations", id, "organized.json");
    let result = existing[0] ? cachedCatalogResult(await readPrivateJson(resultFile), pid) : null;
    if (existing[0]?.state === "ready") {
      if (!result) throw new CatalogError("重新整理结果文件缺失，需管理员核查，不重复收费");
      return result;
    }
    if (existing[0] && !result) throw new CatalogError("该次重新整理已提交但尚无完整结果；不会重复请求模型");
    if (!result) {
      const [active] = await connection.execute<RowDataPacket[]>("SELECT id FROM product_catalog_reorganizations WHERE pid=? AND state='requested' LIMIT 1", [pid]);
      if (active.length) throw new CatalogError("该PID有未确认完成的重新整理任务，请管理员先核查，不重复收费");
      const [rows] = await connection.execute<RowDataPacket[]>("SELECT fetch_state,analysis_state FROM product_catalog_cache WHERE pid=?", [pid]);
      if (!rows[0] || rows[0].fetch_state !== "ready" || rows[0].analysis_state === "requested") throw new CatalogError("该PID尚无完整缓存或原整理仍在进行，不能重新整理");
      const item = await cachedProduct(pid);
      if (!item) throw new CatalogError("没有完整商品缓存，不会调用出海匠补取");
      const runtime = await requireAiRuntime("product");
      const evidence = await prepareCatalogEvidence(pid, item, { cacheOnly: true });
      const time = new Date().toISOString();
      await connection.execute("INSERT INTO product_catalog_reorganizations(id,pid,state,created_at,updated_at) VALUES (?,?,'requested',?,?)", [id, pid, time, time]);
      claimed = true;
      result = await analyzeCatalog(evidence, runtime, id);
      await savePrivate(resultFile, JSON.stringify(result));
      saved = true;
    }
    // Publish the successful result atomically; preserve original organized.json and all prior evidence.
    await connection.beginTransaction();
    const [updated] = await connection.execute<ResultSetHeader>(
      "UPDATE product_catalog_cache SET analysis_state='ready',result_json=?,error_message='',updated_at=? WHERE pid=? AND fetch_state='ready' AND analysis_state<>'requested'",
      [JSON.stringify(result), new Date().toISOString(), pid],
    );
    if (updated.affectedRows !== 1) throw new CatalogError("商品缓存状态已变化，结果已保留，未覆盖资料");
    await connection.execute("UPDATE product_catalog_reorganizations SET state='ready',error_message='',updated_at=? WHERE id=?", [new Date().toISOString(), id]);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    if (claimed && !saved) await connection.execute("UPDATE product_catalog_reorganizations SET state='failed',error_message=?,updated_at=? WHERE id=? AND state='requested'", [catalogError(error).slice(0, 500), new Date().toISOString(), id]).catch(() => undefined);
    throw error;
  } finally {
    if (locked) await connection.execute("SELECT RELEASE_LOCK(?)", [lock]).catch(() => undefined);
    connection.release();
  }
}
