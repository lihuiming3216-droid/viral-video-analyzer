import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db/pool";
import { librarySourceKey } from "@/lib/providers/tokscript-library";
import { libraryDigest, libraryOutputSnapshot, VIDEO_LIBRARY_SCOPE } from "@/lib/feishu/video-library-policy";

export type LibraryTask = {
  id: string; rowKey: string; appToken: string; tableId: string; recordId: string;
  eventMs: number; sourceUrl: string; state: string; resetOutputs: boolean;
  baseline: Record<string, unknown>; owned: Record<string, unknown>; errors: Record<string, string>;
  original: string; translated: string; mediaPath: string; fileToken: string;
};

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function task(row: RowDataPacket): LibraryTask {
  return { id: String(row.id), rowKey: String(row.row_key), appToken: String(row.app_token), tableId: String(row.table_id),
    recordId: String(row.record_id), eventMs: Number(row.event_ms), sourceUrl: String(row.source_url), state: String(row.state),
    resetOutputs: Boolean(row.reset_outputs), baseline: object(row.baseline_json), owned: object(row.owned_json),
    errors: object(row.errors_json) as Record<string, string>, original: String(row.original_text || ""),
    translated: String(row.translated_text || ""), mediaPath: String(row.media_path || ""), fileToken: String(row.file_token || "") };
}

export async function libraryActivation() {
  const value = JSON.parse(await readFile(path.join(process.cwd(), ".data", "feishu-video-library.json"), "utf8")) as Record<string, unknown>;
  const enabledAfter = Date.parse(String(value.enabledAfter || ""));
  if (value.version !== 1 || value.appToken !== VIDEO_LIBRARY_SCOPE.appToken || value.tableId !== VIDEO_LIBRARY_SCOPE.tableId
    || !Number.isFinite(enabledAfter) || value.enabled !== true) throw new Error("优质视频库尚未启用");
  return { enabledAfter };
}

export async function getLibraryTask(id: string) {
  const [rows] = await (await getPool()).execute<RowDataPacket[]>(
    "SELECT t.*,r.app_token,r.table_id,r.record_id,r.latest_task_id FROM feishu_video_library_tasks t JOIN feishu_video_library_rows r ON r.row_key=t.row_key WHERE t.id=?", [id]);
  if (!rows[0]) return null;
  return { ...task(rows[0]), current: rows[0].latest_task_id === id };
}

type LibraryEvent = {
  appToken: string; tableId: string; recordId: string; eventMs: number; sourceUrl: string; fields: Record<string, unknown>;
  eventFields?: Record<string, unknown>;
};

/** Retry only a rolled-back database conflict, never a provider submission. */
export async function claimLibraryTask(input: LibraryEvent) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await claimLibraryTaskOnce(input); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (attempt === 1 || !["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(code)) throw error;
    }
  }
  throw new Error("未能确认本次视频事件的认领结果");
}

/** Event, row ownership and baseline commit atomically. No external requests. */
async function claimLibraryTaskOnce(input: LibraryEvent) {
  const rowKey = libraryDigest([input.appToken, input.tableId, input.recordId]);
  const id = libraryDigest([rowKey, input.eventMs, librarySourceKey(input.sourceUrl)]);
  const db = await (await getPool()).getConnection();
  let reusable = true;
  try {
    await db.beginTransaction();
    const now = new Date().toISOString();
    // ON DUPLICATE KEY UPDATE acquires an exclusive row lock immediately;
    // INSERT IGNORE's shared duplicate lock can deadlock when five replays all
    // subsequently try upgrading to SELECT FOR UPDATE (real MySQL regression).
    await db.execute("INSERT INTO feishu_video_library_rows(row_key,app_token,table_id,record_id,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE row_key=feishu_video_library_rows.row_key",
      [rowKey, input.appToken, input.tableId, input.recordId, now]);
    const [rows] = await db.execute<RowDataPacket[]>("SELECT event_ms,latest_task_id FROM feishu_video_library_rows WHERE row_key=? FOR UPDATE", [rowKey]);
    const previousId = rows[0].latest_task_id ? String(rows[0].latest_task_id) : "";
    if (Number(rows[0].event_ms) >= input.eventMs) {
      await db.commit();
      return { id, accepted: false, duplicate: previousId === id, previousId };
    }
    const [previous] = previousId ? await db.execute<RowDataPacket[]>("SELECT source_url,owned_json FROM feishu_video_library_tasks WHERE id=?", [previousId]) : [[]];
    const reset = !previous[0] || librarySourceKey(String(previous[0].source_url)) !== librarySourceKey(input.sourceUrl);
    const baseline = libraryOutputSnapshot(input.fields);
    const owned = reset ? input.eventFields || baseline : object(previous[0].owned_json);
    if (previousId) await db.execute("UPDATE feishu_video_library_tasks SET state='superseded',finished_at=?,updated_at=? WHERE id=? AND state IN ('accepted','running')", [now, now, previousId]);
    await db.execute("INSERT INTO feishu_video_library_tasks(id,row_key,event_ms,source_url,reset_outputs,baseline_json,owned_json,original_text,translated_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [id, rowKey, input.eventMs, input.sourceUrl, reset ? 1 : 0, JSON.stringify(baseline), JSON.stringify(owned), "", "", now, now]);
    await db.execute("UPDATE feishu_video_library_rows SET latest_task_id=?,event_ms=?,updated_at=? WHERE row_key=?", [id, input.eventMs, now, rowKey]);
    await db.commit();
    return { id, accepted: true, duplicate: false, previousId };
  } catch (error) {
    try { await db.rollback(); } catch { reusable = false; db.destroy(); }
    throw error;
  } finally { if (reusable) db.release(); }
}

export async function startLibraryTask(id: string) {
  const [result] = await (await getPool()).execute<import("mysql2").ResultSetHeader>(
    // A newer row generation transaction already supersedes accepted tasks.
    // Do not lock the row head in reverse order here (task -> head).
    "UPDATE feishu_video_library_tasks SET state='running',started_at=?,updated_at=? WHERE id=? AND state='accepted'",
    [new Date().toISOString(), new Date().toISOString(), id]);
  return result.affectedRows === 1;
}

type LibraryTaskUpdate = Partial<{
  state: string; owned_json: Record<string, unknown>; errors_json: Record<string, string>;
  original_text: string; translated_text: string; media_path: string; file_token: string; provider_job_id: string; finished_at: string;
}>;
export async function updateLibraryTask(id: string, values: LibraryTaskUpdate) {
  const entries = Object.entries({ ...values, updated_at: new Date().toISOString() });
  await (await getPool()).execute(
    `UPDATE feishu_video_library_tasks SET ${entries.map(([name]) => `\`${name}\`=?`).join(",")} WHERE id=? AND state<>'superseded'`,
    [...entries.map(([name, value]) => name.endsWith("_json") ? JSON.stringify(value) : String(value)), id]);
}

/** Five independent lightweight slots, separate from the two full-video slots.
 * There is deliberately no waiting queue and no restart/interval recovery.
 */
export async function acquireLibraryExecution(id: string, controller: AbortController) {
  const db: PoolConnection = await (await getPool()).getConnection();
  const held: string[] = [];
  let healthy = true, released = false, checking = false;
  let heartbeat: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const lost = () => { healthy = false; controller.abort(new Error("执行连接已中断，已停止；请重新修改链接后提交")); db.destroy(); };
  db.on("error", lost);
  const release = async () => {
    if (released) return;
    released = true;
    if (timer) clearInterval(timer);
    await heartbeat;
    try {
      if (!healthy) return;
      for (const name of [...held].reverse()) {
        const [rows] = await db.query<RowDataPacket[]>({ sql: "SELECT RELEASE_LOCK(?) AS released", timeout: 5_000 }, [name]);
        if (Number(rows[0]?.released) !== 1) throw new Error("轻量任务锁释放未确认");
      }
      db.release();
    } catch { healthy = false; db.destroy(); }
    finally { db.removeListener("error", lost); }
  };
  try {
    const [database] = await db.query<RowDataPacket[]>({ sql: "SELECT DATABASE() AS name", timeout: 5_000 });
    const namespace = libraryDigest(database[0]?.name).slice(0, 16);
    const acquire = async (name: string) => {
      const [rows] = await db.query<RowDataPacket[]>({ sql: "SELECT GET_LOCK(?,0) AS acquired", timeout: 5_000 }, [name]);
      if (Number(rows[0]?.acquired) !== 1) return false;
      held.push(name); return true;
    };
    if (!await acquire(`library-task:${namespace}:${id.slice(0, 24)}`)) { await release(); return { acquired: false as const, reason: "running" as const }; }
    let slot = false;
    for (let index = 1; index <= 5; index++) if (await acquire(`library-slot:${namespace}:${index}`)) { slot = true; break; }
    if (!slot) { await release(); return { acquired: false as const, reason: "busy" as const }; }
    timer = setInterval(() => {
      if (checking || released || !healthy) return;
      checking = true;
      heartbeat = (async () => {
        const [rows] = await db.query<RowDataPacket[]>({ sql: "SELECT t.state,r.latest_task_id FROM feishu_video_library_tasks t JOIN feishu_video_library_rows r ON r.row_key=t.row_key WHERE t.id=?", timeout: 5_000 }, [id]);
        if (!rows[0] || rows[0].latest_task_id !== id || rows[0].state === "superseded") controller.abort(new Error("该行已提交新链接，旧任务已停止"));
      })().catch(lost).finally(() => { checking = false; });
    }, 5_000);
    timer.unref?.();
    return { acquired: true as const, release, valid: () => healthy && !released };
  } catch (error) { healthy = false; db.destroy(); await release(); throw error; }
}
