import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db/pool";
import { decryptSecret } from "@/lib/crypto";
import { createVideo, saveFeishuAutomationJob } from "@/lib/database";
import { getChatgptFeishuClient } from "@/lib/feishu/chatgpt-app";
import { getConnectedFeishuChannel, ensureFeishuConnection } from "@/lib/feishu/runtime";
import { getBaseRecordFields, handleFeishuAutomation, hydrateAutomationProductFields, resolveAutomationFields } from "@/lib/feishu/automation";
import { assertDeliverySource } from "@/lib/feishu/delivery-guard";
import { findOrCreateProduct } from "@/lib/feishu/product-lookup";
import { safeBackgroundError } from "@/lib/feishu/webhook-shared";
import { enqueueVideos } from "@/lib/queue";
import type { FeishuInboxInput } from "@/lib/feishu/inbox-types";

type InboxState = "pending" | "running" | "completed" | "partial" | "failed" | "paused";
interface InboxRow extends RowDataPacket {
  id: string; kind: FeishuInboxInput["kind"]; input_cipher: string; state: InboxState;
}

async function finish(connection: PoolConnection, id: string, state: Exclude<InboxState, "pending" | "running">, message = "") {
  const now = new Date().toISOString();
  await connection.beginTransaction();
  try {
    const [result] = await connection.execute<ResultSetHeader>(
      "UPDATE feishu_inbox_tasks SET state=?,error_message=?,updated_at=? WHERE id=? AND state IN ('pending','running')",
      [state, message.slice(0, 500), now, id]);
    // COMMIT can succeed while its acknowledgement is lost. Do not turn an
    // already committed video or a paused task back into a failed operation.
    if (result.affectedRows) await connection.execute(
      "UPDATE feishu_request_receipts SET state=?,updated_at=? WHERE id=? AND state='accepted'",
      [state === "paused" ? "failed" : state, now, id]);
    await connection.commit();
  } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
}

async function clientFor(input: FeishuInboxInput) {
  if (input.credentialSource === "chatgpt") return getChatgptFeishuClient();
  const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
  if (!channel) throw new Error("飞书应用尚未连接");
  return channel.rawClient;
}

/** A video, its target row and the completed receipt are one database commit. */
export async function materializeInboxVideo(connection: PoolConnection, id: string, input: FeishuInboxInput) {
  const resolved = resolveAutomationFields(input.fields, input.fieldMap);
  const client = await clientFor(input);
  const current = await getBaseRecordFields(client, input);
  assertDeliverySource(resolved.videoUrl, current[resolved.map.videoUrl]);
  if (resolveAutomationFields(current, input.fieldMap).pid !== resolved.pid) {
    throw new Error("该行 PID 已变化，已停止旧任务");
  }
  const product = await findOrCreateProduct(resolved.productName || "飞书任务表待命名", resolved.pid);
  const videoId = randomUUID();
  const now = new Date().toISOString();
  await connection.beginTransaction();
  try {
    const [tasks] = await connection.execute<RowDataPacket[]>(
      "SELECT state,video_id FROM feishu_inbox_tasks WHERE id=? FOR UPDATE", [id]);
    if (tasks[0]?.state === "completed" && tasks[0].video_id) {
      await connection.commit();
      return String(tasks[0].video_id);
    }
    if (tasks[0]?.state !== "pending") throw new Error("任务已处理或已暂停，未重复创建视频");
    await createVideo({ productId: product.id, sourceType: "tiktok", sourceUrl: resolved.videoUrl,
      title: resolved.productName || "任务表视频", analysisMode: "transcript_only" }, { connection, id: videoId });
    await saveFeishuAutomationJob({ videoId, appToken: input.appToken, tableId: input.tableId,
      recordId: input.recordId, fieldMap: resolved.map, credentialSource: input.credentialSource }, connection);
    await connection.execute("UPDATE feishu_inbox_tasks SET state='completed',video_id=?,updated_at=? WHERE id=?", [videoId, now, id]);
    await connection.execute("UPDATE feishu_request_receipts SET state='completed',updated_at=? WHERE id=? AND state='accepted'", [now, id]);
    await connection.commit();
  } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
  // Queued videos are recovered independently from the durable videos table.
  // A wake-up failure must not turn a committed receipt into a failed operation.
  await enqueueVideos([videoId]).catch(() => undefined);
  return videoId;
}

async function processTask(connection: PoolConnection, row: InboxRow) {
  if (row.kind === "handcard" && row.state === "running") {
    // Copy/paid requests could already have succeeded. Retain the exact input
    // and explain the interruption rather than blindly running them again.
    await finish(connection, row.id, "paused", "服务中断，手卡创建或资料请求结果可能已产生；请核查已有手卡和缓存后再主动提交");
    return;
  }
  try {
    const input = JSON.parse(decryptSecret(row.input_cipher)) as FeishuInboxInput;
    if (!input || input.kind !== row.kind || !input.appToken || !input.tableId || !input.recordId
      || !["primary", "chatgpt"].includes(input.credentialSource)) throw new Error("任务保存的输入无效，请核查");
    if (input.kind === "video") {
      // No external paid call occurs before this atomic materialization.
      await materializeInboxVideo(connection, row.id, input);
      return;
    }
    const client = await clientFor(input);
    const current = resolveAutomationFields(input.fields, input.fieldMap);
    const fields = current.productName && current.pid ? input.fields : hydrateAutomationProductFields(
      input.fields, await getBaseRecordFields(client, input), input.fieldMap,
    );
    const [claimed] = await connection.execute<ResultSetHeader>("UPDATE feishu_inbox_tasks SET state='running',updated_at=? WHERE id=? AND state='pending'",
      [new Date().toISOString(), row.id]);
    if (!claimed.affectedRows) return;
    const result = await handleFeishuAutomation({ client, ...input, fields, writeBack: true });
    const error = result.productRefreshError || result.writeBackError || "";
    await finish(connection, row.id, error ? "partial" : "completed", error ? safeBackgroundError(error) : "");
  } catch (error) {
    await finish(connection, row.id, "failed", safeBackgroundError(error));
  }
}

const worker = globalThis as typeof globalThis & {
  __feishuInboxRunning?: Set<string>; __feishuInboxTimer?: ReturnType<typeof setInterval>;
};
worker.__feishuInboxRunning ||= new Set();

export async function runFeishuInboxKind(kind: FeishuInboxInput["kind"]) {
  if (worker.__feishuInboxRunning!.has(kind)) return;
  worker.__feishuInboxRunning!.add(kind);
  let connection: PoolConnection | undefined;
  let lock = "";
  let acquired = false;
  let reusable = true;
  const disconnected = () => { reusable = false; };
  try {
    connection = await (await getPool()).getConnection();
    connection.on("error", disconnected);
    const [database] = await connection.query<RowDataPacket[]>("SELECT DATABASE() AS name");
    lock = `feishu-inbox:${createHash("sha256").update(String(database[0].name)).digest("hex").slice(0, 24)}:${kind}`;
    const [locks] = await connection.execute<RowDataPacket[]>("SELECT GET_LOCK(?,0) AS acquired", [lock]);
    acquired = Number(locks[0].acquired) === 1;
    if (!acquired) return;
    const [rows] = await connection.execute<InboxRow[]>(
      "SELECT id,kind,input_cipher,state FROM feishu_inbox_tasks WHERE kind=? AND state IN ('pending','running') ORDER BY created_at,id LIMIT 10", [kind],
    );
    for (const row of rows) await processTask(connection, row);
  } catch (error) {
    // An unacknowledged GET_LOCK/COMMIT may have succeeded. Do not reuse an
    // uncertain session or leave its named lock attached to the pooled socket.
    reusable = false;
    throw error;
  } finally {
    // Never return a session with an unconfirmed held named lock to the pool.
    if (connection) {
      try {
        if (!reusable) connection.destroy();
        else {
          if (acquired) {
            const [released] = await connection.execute<RowDataPacket[]>("SELECT RELEASE_LOCK(?) AS released", [lock]);
            if (Number(released[0]?.released) !== 1) throw new Error("接收队列执行锁释放未确认");
          }
          connection.release();
        }
      } catch { connection.destroy(); }
      finally { connection.removeListener("error", disconnected); }
    }
    worker.__feishuInboxRunning!.delete(kind);
  }
}

export async function runFeishuInboxPass() {
  await Promise.all((["handcard", "video"] as const).map(async kind => {
    try { await runFeishuInboxKind(kind); }
    catch (error) { console.warn("[feishu-inbox] retained pending tasks", { kind, error: safeBackgroundError(error) }); }
  }));
}

export function startFeishuInboxWorker() {
  if (worker.__feishuInboxTimer) return;
  void runFeishuInboxPass();
  worker.__feishuInboxTimer = setInterval(() => void runFeishuInboxPass(), 10_000);
  worker.__feishuInboxTimer.unref?.();
}

/** Admin-only caller: no encrypted input, signed URL or credential is returned. */
export async function listFeishuInboxStatuses() {
  const [rows] = await (await getPool()).execute<RowDataPacket[]>(
    "SELECT id,kind,state,error_message,updated_at,input_cipher FROM feishu_inbox_tasks WHERE state<>'completed' ORDER BY updated_at DESC LIMIT 20",
  );
  return rows.map(row => {
    let recordId = "无法读取目标行";
    try { recordId = String((JSON.parse(decryptSecret(row.input_cipher)) as FeishuInboxInput).recordId); } catch { /* Retain the visible task and safe diagnostics. */ }
    return { id: String(row.id), kind: String(row.kind), state: String(row.state), error: String(row.error_message || ""), recordId };
  });
}
