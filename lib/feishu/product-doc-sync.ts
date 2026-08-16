import "server-only";

import path from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import {
  createVideo,
  deleteProductDocumentVideoRow,
  getProduct,
  getProductDocumentVideoRow,
  getProductDocumentVideoRowByVideoId,
  getVideo,
  getVideoBySourceUrl,
  isProductDocumentVideoRowsInitialized,
  listFeishuProductCardMappingsByProductId,
  listProducts,
  markProductDocumentVideoRowsInitialized,
  saveProductDocumentVideoRow,
  updateVideo,
} from "@/lib/database";
import { listFeishuDocumentBlocks, updateFeishuTextBlock } from "@/lib/feishu/document";
import { ensureFeishuVideoPreview } from "@/lib/feishu/docx-file";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { conciseProductDocAnalysis } from "@/lib/product-doc-analysis";
import { enqueueVideos } from "@/lib/queue";
import type { Product, VideoRecord } from "@/lib/types";
import { resolveMediaPath } from "@/lib/video-processing";

interface DocBlock extends Record<string, unknown> {
  block_id?: string;
  block_type?: number;
  children?: string[];
  text?: { elements?: Array<{ text_run?: { content?: string } }> };
  table?: { property?: { column_size?: number }; cells?: string[] };
}

type SyncResult = {
  found: number;
  queued: number;
  completed: number;
  failed: number;
};

type WorkerGlobal = typeof globalThis & {
  __productDocSyncTimer?: NodeJS.Timeout;
  __productDocSyncRunning?: boolean;
  __productDocSyncCursor?: number;
  __productDocSyncLastError?: string;
  __productDocSyncLocks?: Map<string, Promise<unknown>>;
};

const workerState = globalThis as WorkerGlobal;
workerState.__productDocSyncRunning ||= false;
workerState.__productDocSyncCursor ||= 0;
workerState.__productDocSyncLastError ||= "";
workerState.__productDocSyncLocks ||= new Map<string, Promise<unknown>>();
const attachmentErrors = new Set<string>();
const rowErrors = new Set<string>();
const deliveredFailureCells = new Set<string>();

function productDocumentTargets(product: Product) {
  const seen = new Set<string>();
  const targets: Product[] = [];
  const add = (documentId: string | null | undefined, documentUrl: string | null | undefined) => {
    const normalizedId = documentId?.trim() || "";
    if (!normalizedId || seen.has(normalizedId)) return;
    seen.add(normalizedId);
    targets.push({
      ...product,
      documentId: normalizedId,
      documentUrl: documentUrl?.trim() || null,
    });
  };
  add(product.documentId, product.documentUrl);
  for (const mapping of listFeishuProductCardMappingsByProductId(product.id)) {
    add(mapping.documentId, mapping.documentUrl);
  }
  return targets;
}

function textFrom(block: DocBlock | undefined) {
  return (block?.text?.elements || []).map((element) => element.text_run?.content || "").join("").trim();
}

function tokScriptVideoFileName(video: VideoRecord) {
  return `TokScript视频-${video.id.slice(0, 8)}${path.extname(video.originalPath || "") || ".mp4"}`;
}

function normalizeTikTokUrl(value: string) {
  const candidate = value.trim().replace(/[，。；;、!！?？)）\]】}]+$/g, "");
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && (host === "tiktok.com" || host.endsWith(".tiktok.com"))
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

async function fetchBlock(
  client: Client,
  documentId: string,
  blockId: string,
  documentRevisionId = -1,
): Promise<DocBlock> {
  const response = await client.request<{ code?: number; msg?: string; data?: { block?: DocBlock } }>({
    url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`,
    method: "GET",
    params: { document_revision_id: String(documentRevisionId) },
  });
  const block = response.data?.block as DocBlock | undefined;
  if (!block) throw new Error(`飞书没有返回文档块 ${blockId}`);
  return block;
}

function createBlockReader(client: Client, documentId: string, blocks: Array<Record<string, unknown>>) {
  const cache = new Map<string, DocBlock>();
  for (const item of blocks) {
    const block = item as DocBlock;
    if (block.block_id) cache.set(block.block_id, block);
  }
  return async (blockId: string) => {
    const cached = cache.get(blockId);
    if (cached) return cached;
    const block = await fetchBlock(client, documentId, blockId);
    cache.set(blockId, block);
    return block;
  };
}

async function cellText(cellId: string, readBlock: (blockId: string) => Promise<DocBlock>) {
  const cell = await readBlock(cellId);
  let block: DocBlock | undefined;
  let textId = "";
  for (const childId of cell.children || []) {
    const candidate = await readBlock(childId);
    if (candidate.block_type === 2 || candidate.text) {
      textId = childId;
      block = candidate;
      break;
    }
  }
  if (!textId) return { cell, textId: "", block: undefined as DocBlock | undefined, text: "" };
  return { cell, textId, block, text: textFrom(block) };
}

async function findVideoTable(
  blocks: Array<Record<string, unknown>>,
  readBlock: (blockId: string) => Promise<DocBlock>,
) {
  const candidates = blocks.filter((item) => {
    const block = item as DocBlock;
    return block.block_type === 31 && block.table?.property?.column_size === 4;
  }) as DocBlock[];
  for (const table of candidates) {
    const headerCells = table.table?.cells?.slice(0, 4) || [];
    if (headerCells.length !== 4) continue;
    const headers = await Promise.all(headerCells.map(async (cellId) => (await cellText(cellId, readBlock)).text));
    if (/视频链接/.test(headers[0]) && /分析状态/.test(headers[1]) && /视频分析/.test(headers[2]) && /(中文翻译|原口播文案)/.test(headers[3])) {
      return table;
    }
  }
  return null;
}

async function updateIfChanged(
  client: Client,
  documentId: string,
  blockId: string,
  current: string,
  next: string,
  options: { documentRevisionId?: number } = {},
) {
  if (!blockId || current === next) return false;
  await updateFeishuTextBlock(client, documentId, blockId, next, options);
  // Feishu allows only a few document edits per second. Spacing writes keeps
  // multi-column result updates reliable instead of intermittently rate-limited.
  await new Promise((resolve) => setTimeout(resolve, 380));
  return true;
}

/**
 * Result cells become user-owned as soon as they contain text. Always bypass
 * the table-scan cache immediately before an automatic write: the status patch
 * above can be rate-limited for hundreds of milliseconds, during which a user
 * may have entered a correction that must win.
 */
async function updateBlankResultCell(
  client: Client,
  documentId: string,
  blockId: string,
  next: string,
) {
  const normalizedNext = next.trim();
  if (!blockId || !normalizedNext) return false;
  const documentResponse = await client.request<{
    code?: number;
    msg?: string;
    data?: { document?: { revision_id?: number } };
  }>({
    url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`,
    method: "GET",
  });
  const documentRevisionId = documentResponse.data?.document?.revision_id;
  if (!Number.isInteger(documentRevisionId)) throw new Error("飞书没有返回文档版本号");
  const latest = await fetchBlock(client, documentId, blockId, documentRevisionId);
  if (textFrom(latest).trim()) return false;
  // Feishu rejects a patch whose expected revision is no longer current. That
  // closes the last read/write race if a user types after the fresh block GET.
  return updateIfChanged(client, documentId, blockId, "", normalizedNext, { documentRevisionId });
}

async function withProductDocumentLock<T>(documentId: string, task: () => Promise<T>) {
  const previous = workerState.__productDocSyncLocks!.get(documentId) || Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  workerState.__productDocSyncLocks!.set(documentId, current);
  try {
    return await current;
  } finally {
    if (workerState.__productDocSyncLocks!.get(documentId) === current) {
      workerState.__productDocSyncLocks!.delete(documentId);
    }
  }
}

async function syncProductDocumentUnlocked(
  client: Client,
  product: Product,
  options: { onlyVideoId?: string } = {},
): Promise<SyncResult> {
  const result: SyncResult = { found: 0, queued: 0, completed: 0, failed: 0 };
  if (!product.documentId) return result;
  const blocks = await listFeishuDocumentBlocks(client, product.documentId);
  const readBlock = createBlockReader(client, product.documentId, blocks);
  const table = await findVideoTable(blocks, readBlock);
  if (!table) return result;
  const migrationMode = !isProductDocumentVideoRowsInitialized(product.documentId);

  const cells = table.table?.cells || [];
  for (let rowStart = 4; rowStart + 3 < cells.length; rowStart += 4) {
    try {
      const row = await Promise.all(cells.slice(rowStart, rowStart + 4).map((cellId) => cellText(cellId, readBlock)));
      const linkBlockId = row[0].textId;
      if (linkBlockId && !row[0].text.trim()) {
        deleteProductDocumentVideoRow(product.documentId, linkBlockId);
        continue;
      }
      const link = normalizeTikTokUrl(row[0].text);
      // The second cell is a video-only container and may legitimately have no
      // text block. The other three columns remain text-backed.
      if (!link || !linkBlockId || !row[2].textId || !row[3].textId) continue;
      const binding = getProductDocumentVideoRow(product.documentId, linkBlockId);
      let video = binding?.sourceUrl === link ? getVideo(binding.videoId, false) : null;
      if (binding && !video) {
        const exactLegacy = getVideoBySourceUrl(link, product.id);
        if (exactLegacy?.id === binding.videoId) video = exactLegacy;
      }
      if (options.onlyVideoId) {
        if (binding && binding.videoId !== options.onlyVideoId) continue;
        if (!video) {
          const exact = getVideo(options.onlyVideoId, false);
          if (!exact || exact.productId !== product.id || exact.sourceUrl !== link) continue;
          const claimed = getProductDocumentVideoRowByVideoId(exact.id);
          if (claimed && (claimed.documentId !== product.documentId || claimed.linkBlockId !== linkBlockId)) continue;
          video = exact;
          saveProductDocumentVideoRow({
            documentId: product.documentId,
            linkBlockId,
            productId: product.id,
            sourceUrl: link,
            videoId: exact.id,
          });
        }
      }
      // This cell is now reserved for the playable MP4. Remove legacy textual
      // states once, without touching the preview/view children.
      if (row[1].textId && row[1].text) {
        await updateIfChanged(client, product.documentId, row[1].textId, row[1].text, "");
      }
      if (!video) {
        const legacy = migrationMode && !binding ? getVideoBySourceUrl(link, product.id) : null;
        const legacyClaim = legacy ? getProductDocumentVideoRowByVideoId(legacy.id) : null;
        video = legacy && !legacyClaim
          ? legacy
          : createVideo({
            productId: product.id,
            sourceType: "tiktok",
            sourceUrl: link,
            title: `文档样片 ${rowStart / 4}`,
            analysisMode: "product_doc",
          });
        saveProductDocumentVideoRow({
          documentId: product.documentId,
          linkBlockId,
          productId: product.id,
          sourceUrl: link,
          videoId: video.id,
        });
        if (video.status === "queued") {
          enqueueVideos([video.id]);
          result.found += 1;
          result.queued += 1;
          continue;
        }
      }
      result.found += 1;

      const attachmentErrorKey = `${product.documentId}:${video.id}`;
      try {
        if (video.sourceType === "tiktok" && video.originalPath) {
          await ensureFeishuVideoPreview({
            client,
            documentId: product.documentId,
            parentBlockId: String(cells[rowStart + 1] || ""),
            absolutePath: resolveMediaPath(video.originalPath),
            fileName: tokScriptVideoFileName(video),
            blocks,
          });
        }
        attachmentErrors.delete(attachmentErrorKey);
      } catch (error) {
        // Preview delivery is optional and must never block analysis/results.
        if (!attachmentErrors.has(attachmentErrorKey)) {
          const message = error instanceof Error ? error.message : "视频附件上传失败";
          console.warn(`[product-doc-sync] TokScript视频附件 ${video.id}: ${message}`);
          if (attachmentErrors.size >= 1_000) attachmentErrors.clear();
          attachmentErrors.add(attachmentErrorKey);
        }
      }

      const failureCellKey = `${product.documentId}:${row[2].textId}:${video.id}`;
      if (video.status === "stopped") {
        if (!row[2].text.trim()) {
          await updateBlankResultCell(client, product.documentId, row[2].textId, "已停止，请重新粘贴视频链接");
        }
        result.failed += 1;
        continue;
      }
      if (video.status === "failed" && video.analysisMode === "product_doc") {
        const retryCount = Number(video.productDocRetryCount || 0);
        if (retryCount < 2) {
          updateVideo(video.id, { product_doc_retry_count: retryCount + 1 });
          enqueueVideos([video.id]);
          result.queued += 1;
          continue;
        }
        if (/^失败：/.test(row[2].text)) {
          deliveredFailureCells.add(failureCellKey);
        } else if (!row[2].text.trim() && deliveredFailureCells.has(failureCellKey)) {
          updateVideo(video.id, { product_doc_retry_count: 0, error_message: null });
          deliveredFailureCells.delete(failureCellKey);
          enqueueVideos([video.id]);
          result.queued += 1;
          continue;
        } else if (!row[2].text.trim()) {
          const reason = String(video.errorMessage || "分析失败").replace(/\s+/g, " ").slice(0, 70);
          await updateBlankResultCell(client, product.documentId, row[2].textId, `失败：${reason}`);
          deliveredFailureCells.add(failureCellKey);
        }
      }

      if (video.status === "completed") {
        deliveredFailureCells.delete(failureCellKey);
        // Analysis and translation cells are user-owned once they contain text.
        if (!row[2].text.trim()) {
          await updateBlankResultCell(
            client,
            product.documentId,
            row[2].textId,
            conciseProductDocAnalysis(video),
          );
        }
        const transcriptZh = String(video.transcriptZh || "").trim();
        if (!row[3].text.trim() && transcriptZh) {
          await updateBlankResultCell(client, product.documentId, row[3].textId, transcriptZh);
        }
        result.completed += 1;
      } else if (video.status === "failed") {
        result.failed += 1;
      }
      rowErrors.delete(`${product.documentId}:${rowStart}`);
    } catch (error) {
      // One malformed row must never prevent later links in this document.
      const key = `${product.documentId}:${rowStart}`;
      if (!rowErrors.has(key)) {
        console.warn(`[product-doc-sync] 第 ${rowStart / 4} 行同步失败: ${error instanceof Error ? error.message : "未知错误"}`);
        if (rowErrors.size >= 1_000) rowErrors.clear();
        rowErrors.add(key);
      }
    }
  }
  if (!options.onlyVideoId) markProductDocumentVideoRowsInitialized(product.documentId);
  return result;
}

export function syncProductDocument(
  client: Client,
  product: Product,
  options: { onlyVideoId?: string } = {},
) {
  if (!product.documentId) return Promise.resolve({ found: 0, queued: 0, completed: 0, failed: 0 });
  return withProductDocumentLock(product.documentId, () => syncProductDocumentUnlocked(client, product, options));
}

/** Deliver a newly completed video to its exact product-document row now. */
export async function syncCompletedVideoToProductDocument(videoId: string) {
  const video = getVideo(videoId);
  if (!video || video.status !== "completed") return false;
  const product = getProduct(video.productId);
  if (!product) return false;
  const documents = productDocumentTargets(product);
  if (!documents.length) return false;
  const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
  if (!channel) return false;
  let firstError: unknown;
  for (const document of documents) {
    try {
      await syncProductDocument(channel.rawClient, document, { onlyVideoId: video.id });
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
  return true;
}

export async function syncAllProductDocuments() {
  const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
  if (!channel) return { documents: 0, found: 0, queued: 0, completed: 0, failed: 0 };
  const seenDocumentIds = new Set<string>();
  const documents = listProducts()
    .filter((product) => product.pid && !product.isSystem)
    .flatMap(productDocumentTargets)
    .filter((product) => {
      const documentId = product.documentId!;
      if (seenDocumentIds.has(documentId)) return false;
      seenDocumentIds.add(documentId);
      return true;
    });
  if (!documents.length) return { documents: 0, found: 0, queued: 0, completed: 0, failed: 0 };

  const batchSize = Math.max(1, Math.min(20, Number(process.env.PRODUCT_DOC_SYNC_BATCH_SIZE || 12)));
  const start = workerState.__productDocSyncCursor! % documents.length;
  const selected = Array.from({ length: Math.min(batchSize, documents.length) }, (_, index) => documents[(start + index) % documents.length]);
  workerState.__productDocSyncCursor = (start + selected.length) % documents.length;
  const total = { documents: 0, found: 0, queued: 0, completed: 0, failed: 0 };
  for (const product of selected) {
    try {
      const current = await syncProductDocument(channel.rawClient, product);
      total.documents += 1;
      total.found += current.found;
      total.queued += current.queued;
      total.completed += current.completed;
      total.failed += current.failed;
    } catch (error) {
      const message = error instanceof Error ? error.message : "产品文档同步失败";
      if (workerState.__productDocSyncLastError !== message) {
        console.warn(`[product-doc-sync] ${product.name}_${product.pid}: ${message}`);
        workerState.__productDocSyncLastError = message;
      }
    }
  }
  if (total.documents) workerState.__productDocSyncLastError = "";
  return total;
}

export function startProductDocumentSyncWorker() {
  if (workerState.__productDocSyncTimer) return;
  const interval = Math.max(5_000, Number(process.env.PRODUCT_DOC_SYNC_INTERVAL_MS || 20_000));
  const run = async () => {
    if (workerState.__productDocSyncRunning) return;
    workerState.__productDocSyncRunning = true;
    try {
      await syncAllProductDocuments();
    } catch (error) {
      const message = error instanceof Error ? error.message : "产品文档自动同步失败";
      if (workerState.__productDocSyncLastError !== message) {
        console.warn(`[product-doc-sync] ${message}`);
        workerState.__productDocSyncLastError = message;
      }
    } finally {
      workerState.__productDocSyncRunning = false;
    }
  };
  // Do not scan immediately at process startup. Video completion is delivered
  // directly by completeFeishuAutomation; this timer is only a low-frequency
  // safety net for document-table links and missed external edits.
  workerState.__productDocSyncTimer = setInterval(() => void run(), interval);
  workerState.__productDocSyncTimer.unref();
}
