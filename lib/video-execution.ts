import "server-only";

import { createHash } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { getPool } from "@/lib/db/pool";

export interface VideoExecutionLease {
  valid(): boolean;
  release(): Promise<void>;
}

/** Shared MySQL session locks: two slots for the database, one owner per task.
 * A disconnected owner is aborted; its persisted attempt is NOT auto-replayed.
 * See MySQL 8.0 Locking Functions: locks survive COMMIT, not session termination.
 */
export async function tryAcquireVideoExecution(videoId: string, controller: AbortController): Promise<VideoExecutionLease | null> {
  const connection: PoolConnection = await (await getPool()).getConnection();
  const held: string[] = [];
  let alive = true;
  let released = false;
  let checking = false;
  let heartbeat: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const lost = () => {
    alive = false;
    const error = new Error("任务执行锁连接中断，已停止；请核查结果后再主动重试");
    error.name = "VideoExecutionLostError";
    if (!released && !controller.signal.aborted) controller.abort(error);
    connection.destroy();
  };
  connection.on("error", lost);
  const release = async () => {
    if (released) return;
    released = true;
    if (timer) clearInterval(timer);
    try {
      await heartbeat;
      if (!alive) return;
      for (const name of [...held].reverse()) {
        const [rows] = await connection.query<RowDataPacket[]>({ sql: "SELECT RELEASE_LOCK(?) AS released", timeout: 5_000 }, [name]);
        if (Number(rows[0]?.released) !== 1) throw new Error("执行锁释放未确认");
      }
      connection.release();
    } catch {
      alive = false;
      connection.destroy();
    } finally {
      connection.removeListener("error", lost);
    }
  };
  try {
    const [database] = await connection.query<RowDataPacket[]>({ sql: "SELECT DATABASE() AS name", timeout: 5_000 });
    const namespace = createHash("sha256").update(String(database[0]?.name)).digest("hex").slice(0, 16);
    const taskLock = `video:${namespace}:${createHash("sha256").update(videoId).digest("hex").slice(0, 32)}`;
    const acquire = async (name: string) => {
      const [rows] = await connection.query<RowDataPacket[]>({ sql: "SELECT GET_LOCK(?,0) AS acquired", timeout: 5_000 }, [name]);
      if (Number(rows[0]?.acquired) !== 1) return false;
      held.push(name);
      return true;
    };
    if (!await acquire(taskLock)) { await release(); return null; }
    const [tasks] = await connection.query<RowDataPacket[]>({ sql: "SELECT status,processing_started_at FROM videos WHERE id=?", timeout: 5_000 }, [videoId]);
    const needsSlot = tasks[0]?.status === "queued" && !tasks[0].processing_started_at;
    // Orphan/terminal cleanup owns only its task, so busy video slots cannot
    // postpone cleanup of a historical task beyond its 30-minute limit.
    if (needsSlot && !await acquire(`video-slot:${namespace}:1`) && !await acquire(`video-slot:${namespace}:2`)) {
      await release();
      return null;
    }
    timer = setInterval(() => {
      if (released || checking || !alive) return;
      checking = true;
      heartbeat = (async () => {
        const [locks] = await connection.query<RowDataPacket[]>({
          sql: "SELECT IS_USED_LOCK(?)=CONNECTION_ID() AS task_owned, IS_USED_LOCK(?)=CONNECTION_ID() AS slot_owned", timeout: 5_000,
        }, [held[0], held[1] || held[0]]);
        if (Number(locks[0]?.task_owned) !== 1 || Number(locks[0]?.slot_owned) !== 1) throw new Error("执行锁已失效");
        if (released) return;
        const [videos] = await connection.query<RowDataPacket[]>({ sql: "SELECT status FROM videos WHERE id=?", timeout: 5_000 }, [videoId]);
        if ((!videos[0] || videos[0].status === "stopped") && !controller.signal.aborted) controller.abort(new Error("用户停止分析"));
      })().catch(lost).finally(() => { checking = false; });
    }, 5_000);
    timer.unref?.();
    return { valid: () => alive && !released, release };
  } catch (error) {
    // GET_LOCK may have succeeded even if its response was lost. A failed
    // acquisition session must never go back into the shared pool.
    alive = false;
    connection.destroy();
    await release();
    throw error;
  }
}
