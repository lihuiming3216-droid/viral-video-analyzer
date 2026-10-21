import "server-only";

import path from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import {
  createVideo,
  deleteProductDocumentVideoRow,
  getCachedDocumentRevision,
  getProduct,
  getProductDocumentVideoRow,
  getProductDocumentVideoRowByVideoId,
  getVideo,
  getVideoBySourceUrl,
  isProductDocumentVideoRowsInitialized,
  listFeishuProductCardMappingsByProductId,
  listProductDocumentSyncTargets,
  markProductDocumentVideoRowsInitialized,
  saveProductDocumentVideoRow,
  setCachedDocumentRevision,
  type ProductDocumentSyncTarget,
} from "@/lib/database";
import { listFeishuDocumentBlocks, updateFeishuTextBlock } from "@/lib/feishu/document";
import { ensureFeishuVideoPreview, hasFeishuVideoPreview } from "@/lib/feishu/docx-file";
import { ProductDocumentDiscovery } from "@/lib/feishu/product-doc-discovery";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { enqueueVideos } from "@/lib/queue";
import { NO_PRODUCT_VOICEOVER_TRANSCRIPT } from "@/lib/transcript-validation";
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
  __productDocDiscovery?: ProductDocumentDiscovery;
  __productDocDeliveries?: Map<string, { promise: Promise<boolean>; dirty: boolean }>;
  __productDocDeliveryEpochs?: Map<string, number>;
  __productDocSyncLastError?: string;
  __productDocSyncLocks?: Map<string, Promise<unknown>>;
};

const workerState = globalThis as WorkerGlobal;
workerState.__productDocSyncRunning ||= false;
workerState.__productDocSyncLastError ||= "";
workerState.__productDocSyncLocks ||= new Map<string, Promise<unknown>>();
workerState.__productDocDeliveries ||= new Map();
workerState.__productDocDeliveryEpochs ||= new Map();
const attachmentErrors = new Set<string>();
const rowErrors = new Set<string>();

async function productDocumentTargets(product: Product) {
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
  const mappings = await listFeishuProductCardMappingsByProductId(product.id);
  for (const mapping of mappings) {
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

/** Result ownership covers the whole cell, including headings and nested paragraphs. */
async function resultCellText(cellId: string, readBlock: (blockId: string) => Promise<DocBlock>) {
  const cell = await readBlock(cellId);
  const pending = [...(cell.children || [])].reverse();
  const visited = new Set([cellId]);
  const paragraphs: string[] = [];
  let textId = "";
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) throw new Error("飞书结果单元格包含重复文档块，已停止自动写入");
    visited.add(id);
    const block = await readBlock(id);
    // Text, headings, lists and code blocks use the same elements structure.
    for (const value of Object.values(block)) {
      if (!value || typeof value !== "object") continue;
      const content = value as { elements?: Array<Record<string, unknown> & { text_run?: { content?: string } }> };
      if (!Array.isArray(content.elements)) continue;
      textId ||= id;
      paragraphs.push(content.elements.map((element) => {
        const text = element.text_run?.content || "";
        // Mentions/equations/other inline objects also occupy the cell. This
        // sentinel is only used for the blank check, never written to Feishu.
        const hasInlineContent = Object.keys(element).some(key => key !== "text_run" && element[key] != null);
        return text + (hasInlineContent ? "\uFFFC" : "");
      }).join(""));
    }
    pending.push(...[...(block.children || [])].reverse());
  }
  return { textId, text: paragraphs.filter(text => text.trim()).join("\n").trim() };
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
    if (/视频链接/.test(headers[0]) && /(分析状态|视频文件)/.test(headers[1]) && /视频分析/.test(headers[2]) && /(中文翻译|原口播文案)/.test(headers[3])) {
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
  cellId: string,
  next: string,
  rowIdentity: { linkBlockId: string; sourceUrl: string },
) {
  const normalizedNext = next.trim();
  if (!cellId || !normalizedNext) return false;
  const latest = await latestRowText(client, documentId, rowIdentity.linkBlockId, cellId);
  if (!rowMatchesSource(latest.linkText, rowIdentity.sourceUrl) || latest.resultText.trim() || !latest.resultTextId) return false;
  // Keep the revision used for these reads as API context. Live verification
  // showed Feishu can accept a patch against an older revision: this is NOT
  // an atomic compare-and-set, and a manual edit after our read can still race.
  return updateIfChanged(client, documentId, latest.resultTextId, "", normalizedNext, {
    documentRevisionId: latest.documentRevisionId,
  });
}

async function latestRowText(
  client: Client,
  documentId: string,
  linkBlockId: string,
  resultCellId?: string,
) {
  const documentResponse = await client.request<{
    code?: number;
    msg?: string;
    data?: { document?: { revision_id?: number } };
  }>({
    url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`,
    method: "GET",
  });
  const documentRevisionId = documentResponse.data?.document?.revision_id;
  if (typeof documentRevisionId !== "number" || !Number.isInteger(documentRevisionId)) {
    throw new Error("飞书没有返回文档版本号");
  }
  const [linkBlock, resultCell] = await Promise.all([
    fetchBlock(client, documentId, linkBlockId, documentRevisionId),
    resultCellId
      ? resultCellText(resultCellId, id => fetchBlock(client, documentId, id, documentRevisionId))
      : Promise.resolve(undefined),
  ]);
  return {
    documentRevisionId,
    linkText: textFrom(linkBlock),
    resultText: resultCell?.text || "",
    resultTextId: resultCell?.textId || "",
  };
}

function rowMatchesSource(linkText: string, sourceUrl: string | null | undefined) {
  return Boolean(sourceUrl) && normalizeTikTokUrl(linkText) === sourceUrl;
}

/** One cheap metadata call — orders of magnitude cheaper than listing every block in the document. */
async function getDocumentRevisionId(client: Client, documentId: string) {
  const response = await client.request<{ code?: number; msg?: string; data?: { document?: { revision_id?: number } } }>({
    url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`,
    method: "GET",
  });
  const revisionId = response.data?.document?.revision_id;
  if (typeof revisionId !== "number" || !Number.isInteger(revisionId)) throw new Error("飞书没有返回文档版本号");
  return revisionId;
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
  product: ProductDocumentSyncTarget,
  options: { onlyVideoId?: string; discoverOnly?: boolean } = {},
): Promise<SyncResult> {
  const result: SyncResult = { found: 0, queued: 0, completed: 0, failed: 0 };
  if (!product.documentId) return result;
  const deliveryEpoch = workerState.__productDocDeliveryEpochs!.get(product.documentId) || 0;
  if (options.onlyVideoId) workerState.__productDocDeliveryEpochs!.set(product.documentId, deliveryEpoch + 1);
  // A result event changes backend data, not the Feishu revision. Invalidate
  // before external calls so a failed immediate delivery gets a polling retry.
  if (options.onlyVideoId && await isProductDocumentVideoRowsInitialized(product.documentId)) {
    await setCachedDocumentRevision(product.documentId, -1);
  }
  let deliveryFailed = false;

  // 20秒发现目标（审计12.3节）：常规轮询先花一次便宜的元数据调用确认文档真的改过，没变就直接
  // 跳过整份文档的表格深读。onlyVideoId 是"视频结果就绪，立刻回填这一行"的即时投递路径，
  // 不能被这个缓存挡住，所以永远走真实深读。
  let currentRevisionId: number | null = null;
  if (!options.onlyVideoId) {
    try {
      currentRevisionId = await getDocumentRevisionId(client, product.documentId);
      const cachedRevisionId = await getCachedDocumentRevision(product.documentId);
      if (cachedRevisionId !== null && cachedRevisionId === currentRevisionId) return result;
    } catch {
      // 版本号读取失败就退回原来的行为：照常做一次完整深读，不能因为这个优化误跳过真实变更。
      currentRevisionId = null;
    }
  }

  const blocks = await listFeishuDocumentBlocks(client, product.documentId);
  const readBlock = createBlockReader(client, product.documentId, blocks);
  const table = await findVideoTable(blocks, readBlock);
  if (!table) return result;
  const migrationMode = !(await isProductDocumentVideoRowsInitialized(product.documentId));

  const cells = table.table?.cells || [];
  for (let rowStart = 4; rowStart + 3 < cells.length; rowStart += 4) {
    try {
      // The retired analysis column is entirely user-owned. Do not inspect its
      // children, require a text paragraph, write a result/error, or use it as
      // a retry control. Its contents must not affect file/translation delivery.
      const [linkCell, videoCell, translationCell] = await Promise.all([
        cellText(cells[rowStart], readBlock),
        cellText(cells[rowStart + 1], readBlock),
        resultCellText(cells[rowStart + 3], readBlock),
      ]);
      const translationCellId = cells[rowStart + 3];
      const linkBlockId = linkCell.textId;
      if (linkBlockId && !linkCell.text.trim()) {
        if (!options.onlyVideoId) await deleteProductDocumentVideoRow(product.documentId, linkBlockId);
        continue;
      }
      const link = normalizeTikTokUrl(linkCell.text);
      // The second cell is a video-only container and may legitimately have no
      // text block. Only the link and translation need text-backed cells.
      if (!link || !linkBlockId || !translationCell.textId) continue;
      // Discovery is independent of slow uploads, but claiming a row must still
      // be serialized with explicit/legacy delivery paths to avoid duplicate jobs.
      const claimedRow = await withProductDocumentLock(`bind:${product.documentId}:${linkBlockId}`, async () => {
        const binding = await getProductDocumentVideoRow(product.documentId!, linkBlockId);
        let video = binding?.sourceUrl === link ? await getVideo(binding.videoId, false) : null;
        if (binding && !video) {
          const exactLegacy = await getVideoBySourceUrl(link, product.id);
          if (exactLegacy?.id === binding.videoId) video = exactLegacy;
        }
        if (options.onlyVideoId) {
          if (binding && binding.videoId !== options.onlyVideoId) return null;
          if (!video) {
            const exact = await getVideo(options.onlyVideoId, false);
            if (!exact || exact.productId !== product.id || exact.sourceUrl !== link) return null;
            const claimed = await getProductDocumentVideoRowByVideoId(exact.id);
            if (claimed && (claimed.documentId !== product.documentId || claimed.linkBlockId !== linkBlockId)) return null;
            video = exact;
            await saveProductDocumentVideoRow({
              documentId: product.documentId!,
              linkBlockId,
              productId: product.id,
              sourceUrl: link,
              videoId: exact.id,
            });
          }
        }
        let newlyQueued = false;
        if (!video) {
          const legacy = migrationMode && !binding ? await getVideoBySourceUrl(link, product.id) : null;
          const legacyClaim = legacy ? await getProductDocumentVideoRowByVideoId(legacy.id) : null;
          video = legacy && !legacyClaim
            ? legacy
            : await createVideo({
              productId: product.id,
              sourceType: "tiktok",
              sourceUrl: link,
              title: `文档样片 ${rowStart / 4}`,
              analysisMode: "product_doc",
            });
          await saveProductDocumentVideoRow({
            documentId: product.documentId!,
            linkBlockId,
            productId: product.id,
            sourceUrl: link,
            videoId: video.id,
          });
          if (video.status === "queued") {
            await enqueueVideos([video.id]);
            newlyQueued = true;
          }
        }
        return { video, newlyQueued };
      });
      if (!claimedRow) continue;
      let { video } = claimedRow;
      result.found += 1;

      if (options.discoverOnly) {
        // Never let a historical file upload hold up discovery of new rows or
        // other handcards. Immediate delivery has its own serialized write path.
        const needsFile = video.originalPath && !hasFeishuVideoPreview(cells[rowStart + 1], blocks, tokScriptVideoFileName(video));
        const needsTranslation = video.transcriptZh?.trim() && !translationCell.text.trim();
        if (needsFile || needsTranslation || videoCell.text) {
          deliveryFailed = true;
          void syncVideoToProductDocument(video.id).catch(() => undefined);
        }
      } else if (videoCell.textId && videoCell.text) {
        await updateIfChanged(client, product.documentId, videoCell.textId, videoCell.text, "");
      }
      if (claimedRow.newlyQueued) { result.queued += 1; continue; }
      // A restart/temporary queue error may happen after the durable row claim
      // but before enqueue. Recover only queued tasks, never replay failures.
      if (video.status === "queued") {
        await enqueueVideos([video.id]);
        result.queued += 1;
        continue;
      }
      if (options.discoverOnly) {
        if (video.status === "completed") result.completed += 1;
        else if (video.status === "failed" || video.status === "stopped") result.failed += 1;
        continue;
      }

      const attachmentErrorKey = `${product.documentId}:${video.id}`;
      const previewVideoId = video.id;
      const previewSourceUrl = video.sourceUrl;
      const previewAttemptNumber = video.attemptCount;
      const previewOriginalPath = video.originalPath;
      const validatePreviewBinding = async () => {
        const latestRow = await latestRowText(client, product.documentId!, linkBlockId);
        const currentBinding = await getProductDocumentVideoRow(product.documentId!, linkBlockId);
        const currentVideo = await getVideo(previewVideoId, false);
        return {
          documentRevisionId: latestRow.documentRevisionId,
          valid: rowMatchesSource(latestRow.linkText, previewSourceUrl)
            && currentBinding?.videoId === previewVideoId
            && currentBinding.sourceUrl === previewSourceUrl
            && currentVideo?.sourceUrl === previewSourceUrl
            && currentVideo.attemptCount === previewAttemptNumber
            && currentVideo.originalPath === previewOriginalPath,
        };
      };
      const deliverPreview = async () => {
        try {
          if (video.sourceType === "tiktok" && video.originalPath) {
            await ensureFeishuVideoPreview({
              client,
              documentId: product.documentId!,
              parentBlockId: String(cells[rowStart + 1] || ""),
              absolutePath: resolveMediaPath(video.originalPath),
              fileName: tokScriptVideoFileName(video),
              blocks,
              validateBinding: validatePreviewBinding,
            });
          }
          attachmentErrors.delete(attachmentErrorKey);
        } catch (error) {
          // Preview delivery retries independently and must never block translation.
          deliveryFailed = true;
          if (!attachmentErrors.has(attachmentErrorKey)) {
            const message = error instanceof Error ? error.message : "视频附件上传失败";
            console.warn(`[product-doc-sync] TokScript视频附件 ${video.id}: ${message}`);
            if (attachmentErrors.size >= 1_000) attachmentErrors.clear();
            attachmentErrors.add(attachmentErrorKey);
          }
        }
      };

      // Deliver available translation first, then the preview. Network writes
      // remain serial within the document; a slow upload cannot hold this text
      // back. A translation failure must still allow the independent preview.
      try {
        const refreshedVideo = await getVideo(video.id, false);
        if (!refreshedVideo) continue;
        video = refreshedVideo;

        // Translation and the original file are deliverable during processing,
        // after success, failure, or stop. All text writes still check
        // the latest row identity/revision and preserve nonempty user content.
        const transcriptZh = String(video.transcriptZh || "").trim();
        if (!translationCell.text.trim() && transcriptZh) {
          // Shorten only the provider's exact sentinel at display time. Keep
          // stored transcripts, ordinary text and existing user cells unchanged.
          await updateBlankResultCell(
            client, product.documentId, translationCellId,
            transcriptZh === NO_PRODUCT_VOICEOVER_TRANSCRIPT ? "无口播" : transcriptZh,
            { linkBlockId, sourceUrl: video.sourceUrl || "" },
          );
        }
      } finally { await deliverPreview(); }
      const latestStatus = (await getVideo(video.id, false))?.status;
      if (latestStatus === "completed") {
        result.completed += 1;
      } else if (latestStatus === "failed" || latestStatus === "stopped") {
        result.failed += 1;
      }
      rowErrors.delete(`${product.documentId}:${rowStart}`);
    } catch (error) {
      // One malformed row must never prevent later links in this document.
      deliveryFailed = true;
      const key = `${product.documentId}:${rowStart}`;
      if (!rowErrors.has(key)) {
        console.warn(`[product-doc-sync] 第 ${rowStart / 4} 行同步失败: ${error instanceof Error ? error.message : "未知错误"}`);
        if (rowErrors.size >= 1_000) rowErrors.clear();
        rowErrors.add(key);
      }
    }
  }
  if (!options.onlyVideoId) {
    await markProductDocumentVideoRowsInitialized(product.documentId);
    // Keep delivery failures discoverable even when file timestamps stay the
    // same. This is the existing durable invalidation marker, not a new queue.
    const deliveryArrivedDuringScan = (workerState.__productDocDeliveryEpochs!.get(product.documentId) || 0) !== deliveryEpoch;
    await setCachedDocumentRevision(product.documentId, deliveryFailed || deliveryArrivedDuringScan ? -1 : currentRevisionId ?? -1);
  }
  return result;
}

export function syncProductDocument(
  client: Client,
  product: ProductDocumentSyncTarget,
  options: { onlyVideoId?: string; discoverOnly?: boolean } = {},
) {
  if (!product.documentId) return Promise.resolve({ found: 0, queued: 0, completed: 0, failed: 0 });
  const key = options.discoverOnly ? `discover:${product.documentId}` : product.documentId;
  return withProductDocumentLock(key, () => syncProductDocumentUnlocked(client, product, options));
}

/** Deliver currently available file/translation to this exact row; never restart processing. */
async function deliverVideoToProductDocument(videoId: string) {
  const video = await getVideo(videoId);
  if (!video) return false;
  const product = await getProduct(video.productId);
  if (!product) return false;
  const bound = await getProductDocumentVideoRowByVideoId(videoId);
  const documents = bound ? [{ ...product, documentId: bound.documentId }] : await productDocumentTargets(product);
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

export function syncVideoToProductDocument(videoId: string): Promise<boolean> {
  const existing = workerState.__productDocDeliveries!.get(videoId);
  if (existing) { existing.dirty = true; return existing.promise; }
  const entry = { promise: Promise.resolve(false), dirty: false };
  entry.promise = (async () => {
    let delivered = false;
    do {
      entry.dirty = false;
      delivered = await deliverVideoToProductDocument(videoId);
    } while (entry.dirty);
    return delivered;
  })().finally(() => { workerState.__productDocDeliveries!.delete(videoId); });
  workerState.__productDocDeliveries!.set(videoId, entry);
  return entry.promise;
}

export async function syncAllProductDocuments(options: { background?: boolean } = {}) {
  const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
  if (!channel) return { documents: 0, found: 0, queued: 0, completed: 0, failed: 0 };
  const documents = await listProductDocumentSyncTargets();
  if (!documents.length) return { documents: 0, found: 0, queued: 0, completed: 0, failed: 0 };

  workerState.__productDocDiscovery ||= new ProductDocumentDiscovery();
  return workerState.__productDocDiscovery.poll(channel.rawClient, documents,
    product => syncProductDocument(channel.rawClient, product, { discoverOnly: true }), options.background);
}

export function startProductDocumentSyncWorker() {
  if (workerState.__productDocSyncTimer) return;
  const configuredInterval = Number(process.env.PRODUCT_DOC_SYNC_INTERVAL_MS || 20_000);
  const interval = Number.isFinite(configuredInterval) ? Math.max(5_000, configuredInterval) : 20_000;
  const run = async () => {
    if (workerState.__productDocSyncRunning) return;
    workerState.__productDocSyncRunning = true;
    try {
      await syncAllProductDocuments({ background: true });
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
