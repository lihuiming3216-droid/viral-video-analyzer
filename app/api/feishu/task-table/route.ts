import { after, NextRequest, NextResponse } from "next/server";
import { createVideo, getFeishuFieldMapping, saveFeishuAutomationJob } from "@/lib/database";
import { resolveAutomationFields } from "@/lib/feishu/automation";
import { findOrCreateProduct } from "@/lib/feishu/product-lookup";
import { automationAuth, payloadFieldMap, payloadFields, safeBackgroundError } from "@/lib/feishu/webhook-shared";
import { enqueueVideos } from "@/lib/queue";
import { isTikTokUrl } from "@/lib/tiktok-product";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Entry point for "任务安排表"-style Base automations: a row carries a
 * product name/PID and a video link, and wants the same TokScript→Qwen
 * pipeline the bot and product-card entry points already use, with the
 * result written back to that row's own fields — not a product-card Docx.
 * All of the actual work after this function reuses existing machinery:
 * enqueueVideos()/analyzeVideo() for the pipeline, saveFeishuAutomationJob()
 * + the already-running delivery worker for the write-back.
 */
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await request.json() as Record<string, unknown>
      : Object.fromEntries((await request.formData()).entries()) as Record<string, unknown>;
    const auth = automationAuth(request, body);
    if (auth === null) return NextResponse.json({ error: "云端尚未配置自动化接口密钥" }, { status: 503 });
    if (!auth) return NextResponse.json({ error: "自动化接口密钥不正确" }, { status: 401 });

    const appToken = String(body.appToken || body.app_token || "").trim();
    const tableId = String(body.tableId || body.table_id || "").trim();
    const recordId = String(body.recordId || body.record_id || "").trim();
    const fields = payloadFields(body);
    if (!appToken || !tableId || !recordId) return NextResponse.json({ error: "缺少 appToken、tableId 或 recordId" }, { status: 400 });

    const storedMapping = await getFeishuFieldMapping(`${appToken}:${tableId}`).catch(() => null);
    const inputFieldMap = payloadFieldMap(body.fieldMap || body.field_map);
    const mergedFieldMap = { ...storedMapping?.fieldMap, ...inputFieldMap };
    const resolved = resolveAutomationFields(fields, mergedFieldMap, storedMapping?.aliases);

    if (!resolved.videoUrl || !isTikTokUrl(resolved.videoUrl)) {
      return NextResponse.json({ error: "这一行没有有效的 TikTok 视频链接" }, { status: 400 });
    }

    after(async () => {
      try {
        const product = await findOrCreateProduct(resolved.productName || "飞书任务表待命名", resolved.pid);
        const video = await createVideo({
          productId: product.id,
          sourceType: "tiktok",
          sourceUrl: resolved.videoUrl,
          title: resolved.productName || "任务表视频",
          // This flow only ever delivers 文件/原口播/中文翻译/链接字幕/时间戳原口播/
          // 时间戳中文 — none of which need scene extraction or a full multimodal
          // Qwen video analysis. transcript_only skips straight from TokScript +
          // download to completion (see lib/analysis.ts's analyzeVideo).
          analysisMode: "transcript_only",
        });
        await enqueueVideos([video.id]);
        await saveFeishuAutomationJob({
          videoId: video.id,
          appToken,
          tableId,
          recordId,
          fieldMap: resolved.map,
        });
        console.info("[feishu-task-table] queued", { recordId, videoId: video.id, pid: product.pid });
      } catch (error) {
        console.error("[feishu-task-table] failed", { recordId, error: safeBackgroundError(error) });
      }
    });

    return NextResponse.json({ code: 0, msg: "success", data: { accepted: true, status: "后台处理中" } });
  } catch (error) {
    return NextResponse.json({ error: safeBackgroundError(error) }, { status: 500 });
  }
}
