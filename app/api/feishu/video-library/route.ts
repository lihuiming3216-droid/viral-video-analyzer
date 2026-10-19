import { after, NextRequest, NextResponse } from "next/server";
import { automationAuth, safeBackgroundError } from "@/lib/feishu/webhook-shared";
import { acceptVideoLibraryEvent, runVideoLibraryTask } from "@/lib/feishu/video-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    // This new endpoint accepts the header credential only, before reading a
    // bounded body. Other existing webhook authentication contracts are intact.
    const auth = automationAuth(request, {});
    if (auth === null) return NextResponse.json({ code: 503, msg: "自动化接口尚未配置" }, { status: 503 });
    if (!auth) return NextResponse.json({ code: 401, msg: "自动化接口鉴权失败" }, { status: 401 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = request.body?.getReader();
    if (reader) try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024) return NextResponse.json({ code: 413, msg: "请求内容过大" }, { status: 413 });
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const content = Buffer.concat(chunks).toString("utf8");
    const body = request.headers.get("content-type")?.includes("application/json")
      ? JSON.parse(content) as Record<string, unknown> : Object.fromEntries(new URLSearchParams(content)) as Record<string, unknown>;
    const receipt = await acceptVideoLibraryEvent(body);
    if ((receipt.accepted || "duplicate" in receipt && receipt.duplicate) && "jobId" in receipt && receipt.jobId) after(() => runVideoLibraryTask(receipt.jobId!));
    return NextResponse.json({ code: 0, msg: receipt.accepted ? "已接收，正在处理" : "未重复处理", data: receipt });
  } catch (error) {
    return NextResponse.json({ code: 400, msg: safeBackgroundError(error) }, { status: 400 });
  }
}
