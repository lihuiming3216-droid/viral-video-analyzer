import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db/pool";
import { encryptSecret } from "@/lib/crypto";
import type { FeishuInboxInput } from "@/lib/feishu/inbox-types";

type ReceiptState = "accepted" | "completed" | "partial" | "failed";
export type FeishuRequestReceipt = { id: string; duplicate: boolean; state: ReceiptState; identified?: boolean };
export class FeishuRequestIdentityError extends Error {
  constructor(message: string, public status: 400 | 409) { super(message); }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

/** Stable invocation ID, never a URL or a time-window guess. Old callers stay compatible. */
export async function claimFeishuRequest(headers: Headers, body: Record<string, unknown>, scope: string[], payload: unknown,
  input?: FeishuInboxInput): Promise<FeishuRequestReceipt | null> {
  const candidates = [headers.get("x-idempotency-key"), body.requestId, body.request_id].filter(value => value !== undefined && value !== null && value !== "");
  if (!candidates.length && !input) return null;
  if (candidates.some(value => typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value))) {
    throw new FeishuRequestIdentityError("操作编号格式无效，请传入本次操作固定的 requestId", 400);
  }
  if (new Set(candidates).size > 1) throw new FeishuRequestIdentityError("请求头和请求体的操作编号不一致", 400);
  const identified = candidates.length > 0;
  const id = digest([scope, candidates[0] || randomUUID()]);
  const payloadHash = digest(payload);
  const pool = await getPool();
  const now = new Date().toISOString();
  const serialized = input ? JSON.stringify(input) : "";
  if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) throw new FeishuRequestIdentityError("任务输入过大，请缩小提交范围", 400);
  const connection = input ? await pool.getConnection() : null;
  const db = connection || pool;
  try {
    if (connection) await connection.beginTransaction();
    const [inserted] = await db.execute<ResultSetHeader>(
      "INSERT IGNORE INTO feishu_request_receipts(id,payload_sha256,state,created_at,updated_at) VALUES (?,?,'accepted',?,?)", [id, payloadHash, now, now],
    );
    if (inserted.affectedRows === 1) {
      if (input) await db.execute(
        "INSERT INTO feishu_inbox_tasks(id,kind,input_cipher,state,created_at,updated_at) VALUES (?,?,?,'pending',?,?)",
        [id, input.kind, encryptSecret(serialized), now, now],
      );
      if (connection) await connection.commit();
      return { id, duplicate: false, state: "accepted", identified };
    }
    const [rows] = await db.execute<RowDataPacket[]>("SELECT payload_sha256,state FROM feishu_request_receipts WHERE id=?", [id]);
    if (!rows[0] || rows[0].payload_sha256 !== payloadHash) throw new FeishuRequestIdentityError("同一操作编号对应了不同内容；主动重新提交请使用新的编号", 409);
    if (connection) await connection.commit();
    return { id, duplicate: true, state: rows[0].state as ReceiptState, identified };
  } catch (error) {
    await connection?.rollback().catch(() => undefined);
    throw error;
  } finally { connection?.release(); }
}

export async function finishFeishuRequest(receipt: FeishuRequestReceipt | null, state: Exclude<ReceiptState, "accepted">) {
  if (!receipt || receipt.duplicate) return;
  const pool = await getPool();
  await pool.execute("UPDATE feishu_request_receipts SET state=?,updated_at=? WHERE id=? AND state='accepted'", [state, new Date().toISOString(), receipt.id]);
}

export function feishuRequestReplay(receipt: FeishuRequestReceipt) {
  return { code: 0, duplicate: true, state: receipt.state,
    msg: receipt.state === "accepted" ? "已接收过本次操作，不重复执行；如长时间无结果请在后台核查"
      : receipt.state === "failed" || receipt.state === "partial" ? "本次操作此前未完全成功；不重复执行，主动重试请使用新操作编号"
        : "本次操作已处理，不重复执行" };
}
