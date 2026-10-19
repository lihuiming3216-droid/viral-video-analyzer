import "server-only";

import { downloadMedia, resolveMediaPath, validateDownloadedVideoFile } from "@/lib/video-processing";
import { fetchLibraryVideo, librarySourceKey } from "@/lib/providers/tokscript-library";
import { getChatgptFeishuClient } from "@/lib/feishu/chatgpt-app";
import { getBaseRecordFields, listBitableTableFieldNames, patchBaseRecord, withProductCardRecordLock } from "@/lib/feishu/automation";
import { safeBackgroundError } from "@/lib/feishu/webhook-shared";
import { uploadBaseAttachment } from "@/lib/feishu/media-upload";
import {
  acquireLibraryExecution, claimLibraryTask, getLibraryTask, libraryActivation, startLibraryTask, updateLibraryTask,
  type LibraryTask,
} from "@/lib/feishu/video-library-store";
import {
  libraryEventTime, libraryLink, libraryOwnedPatch, librarySameValue, libraryTriggerSnapshot, VIDEO_LIBRARY_FIELDS as F, VIDEO_LIBRARY_OUTPUTS, VIDEO_LIBRARY_SCOPE,
} from "@/lib/feishu/video-library-policy";

const global = globalThis as typeof globalThis & { __feishuVideoLibraryControllers?: Map<string, AbortController> };
const controllers = global.__feishuVideoLibraryControllers ||= new Map<string, AbortController>();

export class LibrarySourceChangedError extends Error {
  constructor() { super("该行已换成新视频，旧任务停止写回"); }
}
function sourceMatches(expected: string, value: unknown) {
  try { return librarySourceKey(expected) === librarySourceKey(libraryLink(value)); } catch { return false; }
}

/** No table scan. The trigger's event time is the stable invocation identity. */
export async function acceptVideoLibraryEvent(body: Record<string, unknown>) {
  const appToken = String(body.appToken || body.app_token || "").trim();
  const tableId = String(body.tableId || body.table_id || "").trim();
  const recordId = String(body.recordId || body.record_id || "").trim();
  if (appToken !== VIDEO_LIBRARY_SCOPE.appToken || tableId !== VIDEO_LIBRARY_SCOPE.tableId || !/^rec[A-Za-z0-9]{5,100}$/.test(recordId)) {
    throw new Error("这项视频库处理尚未授权给该表或该行");
  }
  const sourceUrl = libraryLink(body.sourceUrl || body.videoUrl || body["视频链接"]);
  librarySourceKey(sourceUrl);
  const eventMs = libraryEventTime(body.eventTime);
  const { enabledAfter } = await libraryActivation();
  if (eventMs < enabledAfter) return { accepted: false, ignored: "上线前的旧事件不补跑" };
  const eventFields = libraryTriggerSnapshot(body);
  const scope = { appToken, tableId, recordId };
  return withProductCardRecordLock(scope, async () => {
    const client = getChatgptFeishuClient();
    const fields = await getBaseRecordFields(client, scope);
    if (!sourceMatches(sourceUrl, fields[F.source])) return { accepted: false, ignored: "视频链接已变化，忽略旧事件" };
    const columns = new Set(await listBitableTableFieldNames(scope, client));
    if (Object.values(F).some(name => !columns.has(name))) throw new Error("优质视频库缺少原口播、中文翻译、文件、处理状态或失败原因字段");
    const receipt = await claimLibraryTask({ ...scope, eventMs, sourceUrl, fields, eventFields });
    if (receipt.accepted && receipt.previousId) controllers.get(receipt.previousId)?.abort(new LibrarySourceChangedError());
    return { accepted: receipt.accepted, duplicate: receipt.duplicate, jobId: receipt.id };
  });
}

async function current(id: string) {
  const task = await getLibraryTask(id);
  if (!task || !task.current || task.state === "superseded") throw new LibrarySourceChangedError();
  return task;
}

/** A source/generation check guards every attempt, including after uploads.
 * External Base GET/PUT is not transactional: the post-write check additionally
 * removes only our just-written values if a user changed the source mid-call.
 */
export async function publishVideoLibraryTask(
  id: string, proposed: Record<string, unknown>, status: string,
) {
  const initial = await current(id);
  return withProductCardRecordLock(initial, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const task = await current(id);
      const client = getChatgptFeishuClient();
      const fields = await getBaseRecordFields(client, task);
      if (!sourceMatches(task.sourceUrl, fields[F.source])) {
        await updateLibraryTask(id, { state: "superseded", finished_at: new Date().toISOString() });
        controllers.get(id)?.abort(new LibrarySourceChangedError());
        throw new LibrarySourceChangedError();
      }
      const patch = libraryOwnedPatch(fields, task.owned, proposed);
      const errors = { ...task.errors };
      for (const name of patch.conflicts) errors[`manual:${name}`] = `${name}已人工修改，已保留且未覆盖`;
      const changes: Record<string, unknown> = { ...patch.fields, [F.status]: status, [F.error]: Object.values(errors).join("；").slice(0, 1500) };
      try {
        await patchBaseRecord(client, { ...task, fields: changes });
      } catch (error) {
        if (attempt === 1) throw error;
        continue;
      }
      const after = await getBaseRecordFields(client, task);
      if (!sourceMatches(task.sourceUrl, after[F.source])) {
        // Ownership is rechecked within the same row lock. Never erase manual
        // edits or results written by a newer task while repairing this window.
        const owner = await getLibraryTask(id);
        if (owner?.current) {
          const clear = Object.fromEntries(Object.entries(patch.fields)
            .filter(([name, value]) => librarySameValue(after[name], value))
            .map(([name]) => [name, name === F.file ? [] : ""]));
          if (Object.keys(clear).length) await patchBaseRecord(client, { ...task, fields: clear });
          await updateLibraryTask(id, { state: "superseded", finished_at: new Date().toISOString() });
          controllers.get(id)?.abort(new LibrarySourceChangedError());
        }
        throw new LibrarySourceChangedError();
      }
      const unverified = Object.entries(patch.fields).filter(([name, value]) => !librarySameValue(after[name], value));
      if (unverified.length) throw new Error(`飞书回读未确认已保存：${unverified.map(([name]) => name).join("、")}`);
      const owned = { ...task.owned };
      for (const [name, value] of Object.entries(proposed)) {
        if (VIDEO_LIBRARY_OUTPUTS.includes(name as typeof VIDEO_LIBRARY_OUTPUTS[number])
          && !patch.conflicts.includes(name) && librarySameValue(after[name], value)) owned[name] = value;
      }
      await updateLibraryTask(id, { owned_json: owned, errors_json: errors });
      return { conflicts: patch.conflicts };
    }
    throw new Error("飞书回填未完成");
  });
}

async function addError(id: string, key: string, message: string) {
  const initial = await current(id);
  await withProductCardRecordLock(initial, async () => {
    const task = await current(id);
    await updateLibraryTask(id, { errors_json: { ...task.errors, [key]: message } });
  });
}

async function prepare(task: LibraryTask) {
  await publishVideoLibraryTask(task.id, task.resetOutputs ? { [F.transcript]: "", [F.translation]: "", [F.file]: [] } : {}, "处理中");
}

/** Invoked with an exact new event only, never by a polling/recovery pass. */
export async function runVideoLibraryTask(id: string) {
  const initial = await getLibraryTask(id);
  if (!initial?.current || initial.state !== "accepted") return;
  const controller = new AbortController();
  if (controllers.has(id)) return;
  controllers.set(id, controller);
  let lease: Awaited<ReturnType<typeof acquireLibraryExecution>> | undefined;
  const timer = setTimeout(() => controller.abort(new Error("本次视频处理超时，其他成功结果保留")), 6 * 60_000);
  timer.unref?.();
  try {
    lease = await acquireLibraryExecution(id, controller);
    if (!lease.acquired) {
      if (lease.reason === "running") return;
      await addError(id, "capacity", "当前已有5条视频在处理，请稍后重新修改链接提交；本次未进入等待队列");
      await updateLibraryTask(id, { state: "failed", finished_at: new Date().toISOString() });
      await publishVideoLibraryTask(id, {}, "未启动：处理繁忙");
      return;
    }
    if (!await startLibraryTask(id)) return;
    await prepare(await current(id));
    const check = async () => {
      controller.signal.throwIfAborted();
      if (!lease?.acquired || !lease.valid()) throw new Error("轻量视频任务已停止");
      return current(id);
    };
    const output = async (kind: "transcript" | "translation", value: string) => {
      await check();
      await updateLibraryTask(id, kind === "transcript" ? { original_text: value } : { translated_text: value });
      try { await publishVideoLibraryTask(id, { [kind === "transcript" ? F.transcript : F.translation]: value }, "处理中：部分结果已返回"); }
      catch (error) {
        if (error instanceof LibrarySourceChangedError) throw error;
        await addError(id, `write:${kind}`, `${kind === "transcript" ? "原口播" : "中文翻译"}回填失败，内容已保存在后台`);
      }
    };
    const provider = await fetchLibraryVideo(initial.sourceUrl, {
      onJob: async jobId => { await check(); await updateLibraryTask(id, { provider_job_id: jobId }); },
      onTranscript: value => output("transcript", value),
      onTranslation: value => output("translation", value),
      onDownload: async url => {
        await check();
        let mediaPath = "";
        for (let attempt = 0; attempt < 2; attempt++) {
          try { mediaPath = await downloadMedia(`video-library/${id}`, url, "video", controller.signal); break; }
          catch (error) { if (attempt === 1 || controller.signal.aborted) throw error; }
        }
        await check();
        const metadata = await validateDownloadedVideoFile(resolveMediaPath(mediaPath), controller.signal, { requireAudio: false, decode: false });
        if (!metadata.audioCodec) await addError(id, "audio", "返回的MP4没有音轨，无法确认原片是否本来无声");
        await updateLibraryTask(id, { media_path: mediaPath });
        const client = getChatgptFeishuClient();
        const attachment = await uploadBaseAttachment(client, { appToken: initial.appToken,
          absolutePath: resolveMediaPath(mediaPath), fileName: `${id.slice(0, 16)}-original.mp4` });
        await check();
        await updateLibraryTask(id, { file_token: attachment[0].file_token });
        await publishVideoLibraryTask(id, { [F.file]: attachment }, "处理中：视频已返回");
      },
    }, controller.signal);
    await check();
    for (const [part, message] of Object.entries(provider.errors)) if (message) await addError(id, part, message);
    const latest = await current(id);
    const missing = [!latest.original ? "原口播" : "", !latest.translated ? "中文翻译" : "", !latest.fileToken ? "视频文件" : ""].filter(Boolean);
    if (missing.length) await addError(id, "missing", `${missing.join("、")}未完成；其他成功结果保留`);
    const final = await current(id);
    const state = Object.keys(final.errors).length || missing.length ? "partial" : "completed";
    await updateLibraryTask(id, { state, finished_at: new Date().toISOString() });
    await publishVideoLibraryTask(id, {}, state === "completed" ? "已完成" : "部分完成");
  } catch (error) {
    if (error instanceof LibrarySourceChangedError || controller.signal.reason instanceof LibrarySourceChangedError) return;
    try {
      const latest = await current(id);
      if (latest.state === "superseded") return;
      const message = controller.signal.aborted ? "本次处理已停止或超时，其他成功结果保留" : "视频处理或回填失败，其他成功结果保留";
      await addError(id, "task", message);
      await updateLibraryTask(id, { state: "partial", finished_at: new Date().toISOString() });
      await publishVideoLibraryTask(id, {}, "部分完成：请查看失败原因");
    } catch {
      console.warn("[video-library] 未能完成本次写回", { taskId: id, message: safeBackgroundError(error) });
    }
  } finally {
    clearTimeout(timer);
    if (lease?.acquired) await lease.release();
    controllers.delete(id);
  }
}
