import { NextRequest, NextResponse } from "next/server";
import { createProduct, getProductByPid, listVideos } from "@/lib/database";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { listFeishuDocumentBlocks, updateFeishuTextBlock } from "@/lib/feishu/document";
import { createVideo, enqueueVideos } from "@/lib/feishu/product-doc-sync";

export const runtime = "nodejs";

function textFrom(block: Record<string, any>) {
  return (block.text?.elements || []).map((element: any) => element.text_run?.content || "").join("").trim();
}

function statusText(status: string) {
  return ({ queued: "排队中", downloading: "获取视频", transcribing: "识别文案", extracting: "拆分镜头", analyzing: "AI分析", completed: "已完成", failed: "失败", stopped: "已停止" } as Record<string, string>)[status] || "待处理";
}

function conciseAnalysis(video: any) {
  const analysis = video.analysis || {};
  const hook = analysis.hook;
  const points = Array.isArray(analysis.viralPoints) ? analysis.viralPoints : [];
  const strengths = Array.isArray(analysis.strengths) ? analysis.strengths : [];
  const summary = String(video.summary || "通过痛点切入、产品演示和场景证明推动转化。")
    .split(/(?<=[。！？])/)
    .filter((sentence) => !/(评分|分数|潜力\s*[高低]|\d+\s*分|转化率)/.test(sentence))
    .join("")
    .trim();
  const lines = [
    `核心判断：${summary || "通过痛点切入、产品演示和场景证明推动转化。"}`,
    "",
    "分析爆点：",
    hook?.description ? `- 开头钩子：${hook.description}` : "",
    ...points.slice(0, 3).map((point: any) => `- ${point.description || point.reason || "突出产品价值并推动用户继续观看"}`),
    strengths[0] ? `- 内容优势：${strengths[0]}` : "",
    "",
    "可借鉴：",
    ...strengths.slice(0, 2).map((item: string) => `- ${item}`),
    analysis.structureFormula ? `- 内容结构：${analysis.structureFormula}` : "",
  ];
  return lines.filter((line, index, all) => line || (index > 0 && all[index - 1])).join("\n").trim();
}

async function getBlock(channel: any, documentId: string, blockId: string) {
  const response = await channel.request({
    url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`,
    method: "GET",
    params: { document_revision_id: "-1" },
  });
  return response.data?.block || {};
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const documentId = String(body.documentId || "").trim();
    const name = String(body.name || "").trim();
    const pid = String(body.pid || "").trim();
    const productUrl = String(body.productUrl || "").trim();
    if (!documentId || !name || !pid || !productUrl) return NextResponse.json({ error: "产品文档同步参数不完整" }, { status: 400 });
    const product = getProductByPid(pid) || createProduct({ name, pid, productUrl });
    const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
    if (!channel) return NextResponse.json({ error: "飞书应用尚未连接" }, { status: 400 });
    let blocks;
    try { blocks = await listFeishuDocumentBlocks(channel.rawClient, documentId); }
    catch (error) { throw new Error(`读取文档块失败：${error instanceof Error ? error.message : "未知错误"}`); }
    const table = blocks.find((block: any) => block.block_type === 31 && block.table?.property?.column_size === 4) as any;
    if (!table) return NextResponse.json({ ok: true, found: 0, queued: 0, completed: 0 });

    let queued = 0;
    let completed = 0;
    const cells = table.table.cells as string[];
    for (let rowStart = 4; rowStart + 3 < cells.length; rowStart += 4) {
      const row = cells.slice(rowStart, rowStart + 4);
      let firstCell;
      try { firstCell = await getBlock(channel.rawClient, documentId, row[0]); }
      catch (error) { throw new Error(`读取表格单元格失败：${error instanceof Error ? error.message : "未知错误"}`); }
      const firstChildId = String((firstCell as any).children?.[0] || "");
      if (!firstChildId) continue;
      let firstChild;
      try { firstChild = await getBlock(channel.rawClient, documentId, firstChildId); }
      catch (error) { throw new Error(`读取视频链接单元格失败：${error instanceof Error ? error.message : "未知错误"}`); }
      const link = textFrom(firstChild);
      if (!/^https?:\/\/(www\.)?tiktok\.com\//i.test(link)) continue;
      let cellBlocks;
      try { cellBlocks = [firstCell, ...await Promise.all(row.slice(1).map((cellId) => getBlock(channel.rawClient, documentId, cellId)))]; }
      catch (error) { throw new Error(`读取表格结果列失败：${error instanceof Error ? error.message : "未知错误"}`); }
      const childIds = [firstChildId, ...cellBlocks.slice(1).map((cell) => String((cell as any).children?.[0] || ""))];
      if (childIds.some((id) => !id)) continue;
      let childBlocks;
      try {
        childBlocks = [];
        for (const childId of childIds) childBlocks.push(await getBlock(channel.rawClient, documentId, childId));
      } catch (error) { throw new Error(`读取单元格文本失败（${childIds.join(",")}）：${error instanceof Error ? error.message : "未知错误"}`); }
      const statusBlock = childBlocks[1];
      const status = textFrom(statusBlock);
      const existing = listVideos({ productId: product.id }).find((video) => video.sourceUrl === link);
      if (!existing) {
        const video = createVideo({ productId: product.id, sourceType: "tiktok", sourceUrl: link, title: `文档样片 ${rowStart / 4}`, analysisMode: "product_doc" });
        enqueueVideos([video.id]);
        await updateFeishuTextBlock(channel.rawClient, documentId, childIds[1], "排队中");
        queued += 1;
        continue;
      }
      const nextStatus = statusText(existing.status);
      if (status !== nextStatus) await updateFeishuTextBlock(channel.rawClient, documentId, childIds[1], nextStatus);
      if (existing.status === "completed") {
        const analysis = conciseAnalysis(existing);
        if (textFrom(childBlocks[2]) !== analysis) await updateFeishuTextBlock(channel.rawClient, documentId, childIds[2], analysis);
        if (textFrom(childBlocks[3]) !== existing.transcriptOriginal) await updateFeishuTextBlock(channel.rawClient, documentId, childIds[3], existing.transcriptOriginal || "暂无原口播文案");
        completed += 1;
      }
    }
    return NextResponse.json({ ok: true, queued, completed });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "产品文档同步失败" }, { status: 500 });
  }
}
