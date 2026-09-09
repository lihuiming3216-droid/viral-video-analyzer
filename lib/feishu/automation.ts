import "server-only";

import type { Client } from "@larksuiteoapi/node-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProduct, createVideo,
  deleteFeishuAutomationJob, getFeishuAutomationJobs,
  getFeishuFieldMapping, getFeishuProductCardMapping, getProduct, getProductByPid, getVideo,
  incrementFeishuAutomationJobAttempts,
  listFeishuAutomationJobVideoIds, saveFeishuAutomationJob, updateProduct,
  upsertFeishuProductCardMapping,
} from "@/lib/database";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { ensureProductCardByPid, syncProductCardManagedFields } from "@/lib/feishu/document";
import { uploadBaseAttachment } from "@/lib/feishu/media-upload";
import { enqueueVideos } from "@/lib/queue";
import { conciseProductDocAnalysis } from "@/lib/product-doc-analysis";
import { transcribeMediaWithQwen, translateSegmentsWithQwen } from "@/lib/providers/qwen";
import { fetchTikTok } from "@/lib/providers/tokscript";
import { buildBilingualSrt, buildTimestampedText, generateBilingualSubtitleFile, type TranscriptSegment } from "@/lib/subtitle";
import { resolveMediaPath } from "@/lib/video-processing";

export interface FeishuAutomationFieldMap {
  productUrl: string;
  pid: string;
  productName: string;
  productDocument: string;
  productCardStatus: string;
  videoUrl: string;
  analysis: string;
  translation: string;
  status: string;
  transcript: string;
  videoFile: string;
  subtitle: string;
  timestampedTranscript: string;
  timestampedTranslation: string;
  linkedSubtitle: string;
}

export const defaultFeishuAutomationFieldMap: FeishuAutomationFieldMap = {
  productUrl: "产品链接",
  pid: "商品ID",
  productName: "产品名称",
  productDocument: "产品手卡",
  productCardStatus: "手卡状态",
  videoUrl: "视频链接",
  analysis: "视频分析",
  translation: "中文翻译",
  status: "分析状态",
  transcript: "原口播",
  videoFile: "视频文件",
  subtitle: "音频字幕",
  timestampedTranscript: "时间戳原口播",
  timestampedTranslation: "时间戳中文",
  linkedSubtitle: "链接字幕",
};

const productIdentityLockState = globalThis as typeof globalThis & {
  __viralProductIdentityLocks?: Map<string, Promise<void>>;
};
const productIdentityLocks = productIdentityLockState.__viralProductIdentityLocks
  ||= new Map<string, Promise<void>>();

async function withAutomationLock<T>(key: string, operation: () => Promise<T> | T) {
  const previous = productIdentityLocks.get(key) || Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  productIdentityLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (productIdentityLocks.get(key) === tail) productIdentityLocks.delete(key);
  }
}

function withProductIdentityLock<T>(pid: string, operation: () => Promise<T> | T) {
  return withAutomationLock(`product:${pid}`, operation);
}

function withProductCardRecordLock<T>(
  input: { appToken: string; tableId: string; recordId: string },
  operation: () => Promise<T> | T,
) {
  // Serialize repeated clicks for one Base row. Document creation itself also
  // holds a PID lock so different rows with the same PID share one card.
  const stableKey = JSON.stringify([
    input.appToken.trim(),
    input.tableId.trim(),
    input.recordId.trim(),
  ]);
  return withAutomationLock(`product-card-record:${stableKey}`, operation);
}

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    return text(item.text ?? item.link ?? item.url ?? item.value ?? item.name ?? item.id);
  }
  return "";
}

function urlText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return cleanUrl(value.trim());
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = urlText(item);
      if (candidate) return candidate;
    }
    return "";
  }
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    return urlText(item.link ?? item.url ?? item.value ?? item.text);
  }
  return "";
}

function field(fields: Record<string, unknown>, name: string, aliases: string[] = []) {
  for (const key of [name, ...aliases]) {
    if (key in fields) return text(fields[key]);
  }
  return "";
}

function urlField(fields: Record<string, unknown>, name: string, aliases: string[] = []) {
  for (const key of [name, ...aliases]) {
    if (key in fields) return urlText(fields[key]);
  }
  return "";
}

function cleanUrl(value: string) {
  return value.replace(/[，。；;、!！?？)）\]】}]+$/g, "");
}

function apiError(response: { code?: number; msg?: string } | null | undefined, fallback: string) {
  if (response?.code && response.code !== 0) throw new Error(response.msg || fallback);
}

function isBaseRolePermissionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /RolePermNotAllow|role has no permissions|1254302|没有权限|无权限/i.test(message);
}

export type FeishuAutomationFieldAliases = Partial<Record<keyof FeishuAutomationFieldMap, string[]>>;

export function resolveAutomationFields(
  fields: Record<string, unknown>,
  inputMap: Partial<FeishuAutomationFieldMap> = {},
  extraAliases: FeishuAutomationFieldAliases = {},
) {
  const map = { ...defaultFeishuAutomationFieldMap, ...inputMap };
  const productUrl = urlField(fields, map.productUrl, ["商品链接", "产品链接", ...(extraAliases.productUrl || [])]);
  // 新人组任务安排表用的字段名是"产品id"（小写 id，不带空格）——审计报告技术债第4条确认的缺口，直接补齐。
  const suppliedPid = field(fields, map.pid, ["PID", "pid", "商品ID/PID", "产品id", "产品ID", ...(extraAliases.pid || [])]);
  const documentField = inputMap.productDocument
    || ("产品手卡" in fields ? "产品手卡" : "产品文档" in fields ? "产品文档" : map.productDocument);
  return {
    map: { ...map, productDocument: documentField },
    // Product-link analysis is disabled. The explicit Base PID is the only
    // document identity; a number found inside an unrelated URL is never used.
    productUrl,
    pid: suppliedPid,
    suppliedPid,
    productName: field(fields, map.productName, ["商品名称", "产品名", "productName", "product_name", ...(extraAliases.productName || [])]),
    productDocument: urlField(fields, documentField, [map.productDocument, "产品手卡", "产品文档", ...(extraAliases.productDocument || [])]),
    videoUrl: cleanUrl(field(fields, map.videoUrl, ["样片链接", "视频链接", ...(extraAliases.videoUrl || [])])),
    analysis: field(fields, map.analysis),
    translation: field(fields, map.translation),
    status: field(fields, map.status),
  };
}

/**
 * Fill only the product-card inputs that an older Feishu button payload may
 * omit. Never merge the whole live Base row: doing so could accidentally send
 * an unrelated sample-video field through the video-analysis branch.
 */
export function hydrateAutomationProductFields(
  fields: Record<string, unknown>,
  latestFields: Record<string, unknown>,
  inputMap: Partial<FeishuAutomationFieldMap> = {},
) {
  const current = resolveAutomationFields(fields, inputMap);
  const latest = resolveAutomationFields(latestFields, inputMap);
  const hydrated = { ...fields };
  if (!current.productName && latest.productName) hydrated[current.map.productName] = latest.productName;
  if (!current.pid && latest.pid) hydrated[current.map.pid] = latest.pid;
  if (!current.productDocument && latest.productDocument) {
    hydrated[current.map.productDocument] = latest.productDocument;
  }
  return hydrated;
}

/**
 * A field-map value of "" means a saved mapping has explicitly marked that
 * field as not applicable to this table (see /admin/field-mapping, which
 * fills in "" for every system field nobody assigned a real column to) —
 * distinct from an unset override, which still falls back to the code
 * default. Every write site must skip these instead of sending an empty
 * field name: Feishu's Base PUT validates every key in `fields` against the
 * table's real columns and rejects the WHOLE request over a single bad name,
 * so one inapplicable field would otherwise block every other field on the
 * same row from ever being written.
 */
function setMappedField(fields: Record<string, unknown>, fieldName: string, value: unknown) {
  if (fieldName) fields[fieldName] = value;
}

/**
 * Pull {appToken, tableId} out of a pasted Feishu Base web URL, e.g.
 * https://xxx.feishu.cn/base/{appToken}?table={tableId}&view=... — lets
 * /admin/field-mapping derive the scope key straight from a link instead of
 * making someone find and type the two ids by hand.
 */
export function parseFeishuBaseUrl(input: string): { appToken: string; tableId: string } | null {
  try {
    const url = new URL(input.trim());
    const appToken = url.pathname.match(/\/base\/([A-Za-z0-9]+)/)?.[1];
    const tableId = url.searchParams.get("table")
      || url.pathname.match(/\/table\/(tbl[A-Za-z0-9]+)/)?.[1];
    if (!appToken || !tableId) return null;
    return { appToken, tableId };
  } catch {
    return null;
  }
}

/** Every real column on one Base table, straight from Feishu — not our guess. */
export async function listBitableTableFieldNames(input: { appToken: string; tableId: string }): Promise<string[]> {
  const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
  if (!channel) throw new Error("飞书未连接，请先在“飞书设置”里完成连接");
  const names: string[] = [];
  let pageToken: string | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const response = await channel.rawClient.request<{
      code?: number; msg?: string;
      data?: { items?: { field_name?: string }[]; has_more?: boolean; page_token?: string };
    }>({
      url: `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/fields`,
      method: "GET",
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    apiError(response, "获取多维表格字段失败");
    for (const item of response.data?.items || []) {
      if (item.field_name) names.push(item.field_name);
    }
    if (!response.data?.has_more || !response.data.page_token) break;
    pageToken = response.data.page_token;
  }
  return names;
}

// ~5 delivery passes (default 30s interval) before giving up on the
// subtitle fields for one row. Generous enough to ride out a couple of bad
// Qwen segmentations without letting a persistently-misaligned video burn a
// fresh Qwen call every single pass forever.
const SUBTITLE_RETRY_GIVE_UP_AFTER = 5;

export async function patchBaseRecord(
  client: Client,
  input: { appToken: string; tableId: string; recordId: string; fields: Record<string, unknown> },
) {
  const response = await client.request<{ code?: number; msg?: string }>({
    url: `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/records/${encodeURIComponent(input.recordId)}`,
    method: "PUT",
    data: { fields: input.fields },
  });
  apiError(response, "回写飞书多维表格失败");
}

/** Read one Base record's current field values — the read half of patchBaseRecord. */
export async function getBaseRecordFields(
  client: Client,
  input: { appToken: string; tableId: string; recordId: string },
): Promise<Record<string, unknown>> {
  const response = await client.request<{ code?: number; msg?: string; data?: { record?: { fields?: Record<string, unknown> } } }>({
    url: `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/records/${encodeURIComponent(input.recordId)}`,
    method: "GET",
  });
  apiError(response, "读取飞书多维表格记录失败");
  return response.data?.record?.fields || {};
}

function firstAttachment(value: unknown): { fileToken: string; name: string } | null {
  if (!Array.isArray(value) || !value.length) return null;
  const item = value[0] as Record<string, unknown>;
  const fileToken = String(item?.file_token || "");
  if (!fileToken) return null;
  return { fileToken, name: String(item?.name || "attachment") };
}

async function requireConnectedFeishuClient() {
  const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
  if (!channel) throw new Error("飞书未连接");
  return channel.rawClient;
}

/**
 * A pared-down alternative to Feishu's own "任务安排表" automations that used
 * to call out to an Aliyun subtitle service (see http://47.97.47.205 in
 * project notes) — these three functions replicate that service's exact
 * request/response contract so a Feishu-side edit can be just the target
 * host, nothing else. transcript/timestamp text uses the same
 * buildTimestampedText()/"[MM:SS–MM:SS] text" convention the rest of this
 * project already writes, so a subsequent call re-parses its own format.
 */
const TIMESTAMPED_LINE = /^\[(\d{2}):(\d{2})[–-](\d{2}):(\d{2})\]\s?(.*)$/;

function parseTimestampedText(value: string): TranscriptSegment[] {
  return value.split("\n").map((line) => {
    const match = TIMESTAMPED_LINE.exec(line.trim());
    if (!match) return null;
    const [, sm, ss, em, es, text] = match;
    return {
      start: Number(sm) * 60 + Number(ss),
      end: Number(em) * 60 + Number(es),
      text: text.trim(),
    };
  }).filter((segment): segment is TranscriptSegment => Boolean(segment));
}

/** Mirrors the Aliyun "生成音频字幕" action: transcribe an uploaded audio/video attachment and write a subtitle attachment back. */
export async function runSubtitleBridgeAudioSubtitle(input: {
  appToken: string; tableId: string; recordId: string;
  audioField: string; subtitleField: string; targetLanguage?: string;
}) {
  const client = await requireConnectedFeishuClient();
  const fields = await getBaseRecordFields(client, input);
  const attachment = firstAttachment(fields[input.audioField]);
  if (!attachment) throw new Error(`记录里字段“${input.audioField}”没有可用的附件`);
  const dir = await mkdtemp(path.join(tmpdir(), "viral-subtitle-bridge-"));
  try {
    const ext = path.extname(attachment.name) || ".mp4";
    const localPath = path.join(dir, `input${ext}`);
    // A Base attachment's underlying media is scoped to the record/field it
    // was uploaded through — drive.v1.media.download rejects the plain
    // file_token with 400 unless the request also proves that Bitable
    // context via `extra` (same shape Feishu itself puts in the attachment's
    // own tmp_url: {"bitablePerm":{"tableId":...}}).
    const download = await client.drive.v1.media.download({
      path: { file_token: attachment.fileToken },
      params: { extra: JSON.stringify({ bitablePerm: { tableId: input.tableId } }) },
    });
    await download.writeFile(localPath);
    const segments = await transcribeMediaWithQwen({ localMediaPath: localPath, targetLanguage: input.targetLanguage || "简体中文" });
    if (!segments.length) throw new Error("没有识别到可用的语音内容");
    const srt = buildBilingualSrt(segments, segments.map((segment) => segment.translated));
    const srtPath = path.join(dir, "subtitle.srt");
    await writeFile(srtPath, srt, "utf8");
    const uploaded = await uploadBaseAttachment(client, { appToken: input.appToken, absolutePath: srtPath, fileName: `${attachment.name.replace(/\.[^.]+$/, "") || "subtitle"}.srt` });
    await patchBaseRecord(client, { appToken: input.appToken, tableId: input.tableId, recordId: input.recordId, fields: { [input.subtitleField]: uploaded } });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Mirrors the Aliyun "调用TokScript提取时间戳" action: fetch TokScript segments for a video link and write the two timestamped-text fields. */
export async function runSubtitleBridgeTokScriptTimestamps(input: {
  appToken: string; tableId: string; recordId: string;
  videoField: string; transcriptField: string; translatedTranscriptField: string;
}) {
  const client = await requireConnectedFeishuClient();
  const fields = await getBaseRecordFields(client, input);
  const videoUrl = urlText(fields[input.videoField]);
  if (!videoUrl) throw new Error(`记录里字段“${input.videoField}”没有有效的视频链接`);
  const tok = await fetchTikTok(videoUrl, undefined, { includeCover: false });
  const segments = tok.segments.filter((segment) => segment.text.trim());
  if (!segments.length) throw new Error("TokScript 没有返回可用的分段时间戳");
  const translations = await translateSegmentsWithQwen({ segments });
  await patchBaseRecord(client, {
    appToken: input.appToken, tableId: input.tableId, recordId: input.recordId,
    fields: {
      [input.transcriptField]: buildTimestampedText(segments, segments.map((segment) => segment.text)),
      [input.translatedTranscriptField]: buildTimestampedText(segments, translations),
    },
  });
}

/** Mirrors the Aliyun "调用字幕服务生成链接字幕" action: combine the two timestamped-text fields into a bilingual SRT attachment. */
export async function runSubtitleBridgeLinkSubtitle(input: {
  appToken: string; tableId: string; recordId: string;
  transcriptField: string; translatedTranscriptField: string; subtitleField: string;
}) {
  const client = await requireConnectedFeishuClient();
  const fields = await getBaseRecordFields(client, input);
  const segments = parseTimestampedText(text(fields[input.transcriptField]));
  const translatedSegments = parseTimestampedText(text(fields[input.translatedTranscriptField]));
  if (!segments.length || segments.length !== translatedSegments.length) {
    throw new Error(`“${input.transcriptField}”和“${input.translatedTranscriptField}”里的时间戳内容为空或行数对不上`);
  }
  const dir = await mkdtemp(path.join(tmpdir(), "viral-subtitle-bridge-"));
  try {
    const srt = buildBilingualSrt(segments, translatedSegments.map((segment) => segment.text));
    const srtPath = path.join(dir, "subtitle.srt");
    await writeFile(srtPath, srt, "utf8");
    const uploaded = await uploadBaseAttachment(client, { appToken: input.appToken, absolutePath: srtPath, fileName: "link-subtitle.srt" });
    await patchBaseRecord(client, { appToken: input.appToken, tableId: input.tableId, recordId: input.recordId, fields: { [input.subtitleField]: uploaded } });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function updateProductCardStatus(input: {
  client: Client;
  appToken: string;
  tableId: string;
  recordId: string;
  status: string;
  fieldName?: string;
}) {
  await patchBaseRecord(input.client, {
    appToken: input.appToken,
    tableId: input.tableId,
    recordId: input.recordId,
    fields: { [input.fieldName?.trim() || "手卡状态"]: input.status.slice(0, 500) },
  });
}

/** Pull Feishu's own {code,msg} validation body out of an Axios error, when present. */
function feishuApiErrorDetail(error: unknown): unknown {
  if (error && typeof error === "object" && "response" in error) {
    const response = (error as { response?: { data?: unknown; status?: number } }).response;
    if (response?.data !== undefined) return `HTTP ${response.status}: ${JSON.stringify(response.data)}`;
  }
  return error;
}

function safeAutomationFailure(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "资料刷新失败");
  return raw
    .replace(/\bauthorization\s*:\s*(?:bearer|basic)?\s*\S+/gi, "[已隐藏]")
    .replace(/\bbearer\s+\S+/gi, "[已隐藏]")
    .replace(/(?:api[_ -]?key|app[_ -]?secret|webhook[_ -]?secret)\s*[:=]?\s*\S+/gi, "[已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360) || "资料刷新失败";
}

/**
 * Push just 原口播/中文翻译 back to Feishu as soon as TokScript's transcript is
 * ready — long before the multi-minute Qwen video analysis (and everything
 * after it: attachments, 分析状态, the final report) finishes. Deliberately
 * never touches those other fields and never deletes the automation job —
 * completeFeishuAutomation() still owns the one durable, terminal delivery
 * once the task actually finishes. Best-effort: a failure here just means the
 * row shows up-to-date content a little later than it could have.
 */
export async function deliverEarlyTranscript(videoId: string) {
  const jobs = await getFeishuAutomationJobs(videoId);
  if (!jobs.length) return;
  const video = await getVideo(videoId);
  if (!video?.transcriptOriginal?.trim()) return;
  try {
    const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
    if (!channel) return;
    for (const job of jobs) {
      const map = { ...defaultFeishuAutomationFieldMap, ...job.fieldMap };
      const fields: Record<string, unknown> = {};
      setMappedField(fields, map.transcript, video.transcriptOriginal);
      if (video.transcriptZh?.trim()) setMappedField(fields, map.translation, video.transcriptZh);
      if (!Object.keys(fields).length) continue;
      try {
        await patchBaseRecord(channel.rawClient, { ...job, fields });
      } catch (error) {
        console.warn(`[feishu-automation] 提前写回口播失败 video=${videoId} record=${job.recordId}: ${safeAutomationFailure(feishuApiErrorDetail(error))}`);
      }
    }
  } catch {
    // Connection failures are fine to swallow here too — the terminal
    // delivery path retries independently.
  }
}

export async function completeFeishuAutomation(videoId: string) {
  const jobs = await getFeishuAutomationJobs(videoId);
  const video = await getVideo(videoId);
  if (!jobs.length || !video || !["completed", "failed", "stopped"].includes(video.status)) return false;
  const product = await getProduct(video.productId);
  try {
    const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
    if (!channel) return false;
    let allDelivered = true;
    for (const job of jobs) {
      try {
        const delivered = await withProductCardRecordLock(job, async () => {
          // Re-read after acquiring the row lock. A newer click transactionally
          // removes this job, so an older completion can never overwrite it.
          const currentJobs = await getFeishuAutomationJobs(videoId);
          const current = currentJobs.find((candidate) => (
            candidate.appToken === job.appToken
            && candidate.tableId === job.tableId
            && candidate.recordId === job.recordId
          ));
          if (!current) return true;
          const productCardMapping = await getFeishuProductCardMapping({
            appToken: current.appToken,
            tableId: current.tableId,
            recordId: current.recordId,
          });
          const map = { ...defaultFeishuAutomationFieldMap, ...current.fieldMap };
          const fields: Record<string, unknown> = {};
          setMappedField(fields, map.status, video.status === "completed" ? "已完成" : video.status === "failed" ? "失败" : "已停止");
          if (video.status === "completed") {
            // conciseProductDocAnalysis()'s compact "核心/爆点/借鉴" format was
            // designed for 手卡 (product_doc mode)'s narrow table cell — it costs
            // nothing extra to generate (pure local reformatting of the analysis
            // already in hand, no additional AI call), but writing it for the
            // unrelated 任务安排表 (full mode) flow was just an accidental side
            // effect of sharing this delivery function, not an intentional field.
            if (video.analysisMode === "product_doc") {
              setMappedField(fields, map.analysis, conciseProductDocAnalysis(video));
            }
            setMappedField(fields, map.translation, video.transcriptZh || "暂无中文翻译");
            setMappedField(fields, map.transcript, video.transcriptOriginal || "");
            const mappedDocumentUrl = productCardMapping?.documentUrl || product?.documentUrl;
            if (mappedDocumentUrl) setMappedField(fields, map.productDocument, mappedDocumentUrl);
            // Attachments are best-effort: an upload/translation failure here
            // must never block the text fields above from being written back.
            // Also skip the upload entirely when the target table has no
            // matching column — no point paying for it if it can't be written.
            if (video.originalPath && map.videoFile) {
              try {
                fields[map.videoFile] = await uploadBaseAttachment(channel.rawClient, {
                  appToken: current.appToken,
                  absolutePath: resolveMediaPath(video.originalPath),
                  fileName: `${video.title || video.id}.mp4`,
                });
              } catch (error) {
                console.warn(`[feishu-automation] 视频文件上传失败 video=${videoId}: ${safeAutomationFailure(feishuApiErrorDetail(error))}`);
              }
            }
            const wantsSubtitleFields = map.linkedSubtitle || map.timestampedTranscript || map.timestampedTranslation;
            // Every failed delivery pass calls this again — without a cap, a
            // video whose segment translation never lines up (see the
            // "双语字幕生成失败" warning below) would re-run a real Qwen call
            // forever every ~30s. Give up on the subtitle fields specifically
            // after a few tries; the cheap text/status fields below still
            // retry on every pass, uncapped, since they cost nothing to redo.
            if (current.attempts === SUBTITLE_RETRY_GIVE_UP_AFTER && wantsSubtitleFields) {
              console.warn(`[feishu-automation] 双语字幕已重试 ${current.attempts} 次仍失败，放弃生成 video=${videoId}（其余字段仍会继续重试写回）`);
            }
            if (video.transcriptSegments.length && wantsSubtitleFields
              && current.attempts < SUBTITLE_RETRY_GIVE_UP_AFTER) {
              let subtitleFile: Awaited<ReturnType<typeof generateBilingualSubtitleFile>> = null;
              try {
                subtitleFile = await generateBilingualSubtitleFile(video.transcriptSegments as TranscriptSegment[]);
                if (subtitleFile) {
                  // 用户最终确认：只写"链接字幕"（视频链接提取 TokScript 时间戳这条
                  // 原生流程对应的字段），不再写"音频字幕"。
                  if (map.linkedSubtitle) {
                    const attachment = await uploadBaseAttachment(channel.rawClient, {
                      appToken: current.appToken,
                      absolutePath: subtitleFile.filePath,
                      fileName: `${video.title || video.id}.srt`,
                    });
                    fields[map.linkedSubtitle] = attachment;
                  }
                  setMappedField(fields, map.timestampedTranscript, buildTimestampedText(subtitleFile.segments, subtitleFile.segments.map((s) => s.text)));
                  setMappedField(fields, map.timestampedTranslation, buildTimestampedText(subtitleFile.segments, subtitleFile.translations));
                }
              } catch (error) {
                console.warn(`[feishu-automation] 双语字幕生成失败 video=${videoId}: ${safeAutomationFailure(feishuApiErrorDetail(error))}`);
              } finally {
                await subtitleFile?.cleanup();
              }
            }
          } else if (video.errorMessage) {
            setMappedField(fields, map.analysis, `处理失败：${safeAutomationFailure(video.errorMessage)}`);
          }
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              await patchBaseRecord(channel.rawClient, { ...current, fields });
              await deleteFeishuAutomationJob(current);
              return true;
            } catch (error) {
              if (isBaseRolePermissionError(error) || attempt === 3) {
                // Feishu's own {code,msg} validation body is not a secret — it
                // describes what our request got wrong, not a credential — and
                // is the only way to diagnose a real write-back failure without
                // just retrying forever. safeAutomationFailure still redacts
                // anything that looks like an auth header as a backstop.
                console.warn(`[feishu-automation] 写回失败 video=${videoId} record=${current.recordId}: ${safeAutomationFailure(feishuApiErrorDetail(error))}`);
                await incrementFeishuAutomationJobAttempts(current);
                return false;
              }
              await new Promise((resolve) => setTimeout(resolve, attempt * 100));
            }
          }
          return false;
        });
        if (!delivered) {
          allDelivered = false;
          continue;
        }
      } catch {
        // A single Base row must never prevent the remaining deliveries. The
        // untouched job is the durable retry marker for a later completion run.
        allDelivered = false;
      }
    }
    return allDelivered;
  } catch {
    // Connection failures are retryable too; retain every delivery without
    // propagating provider messages that might contain credentials.
    return false;
  }
}

const automationDeliveryWorkerState = globalThis as typeof globalThis & {
  __feishuAutomationDeliveryInitialTimer?: ReturnType<typeof setTimeout>;
  __feishuAutomationDeliveryTimer?: ReturnType<typeof setInterval>;
  __feishuAutomationDeliveryRunning?: boolean;
};

export async function runFeishuAutomationDeliveryPass() {
  const pendingVideoIds = await listFeishuAutomationJobVideoIds();
  let terminalVideos = 0;
  let deliveredVideos = 0;
  for (const videoId of pendingVideoIds) {
    const video = await getVideo(videoId);
    if (!video || !["completed", "failed", "stopped"].includes(video.status)) continue;
    terminalVideos += 1;
    try {
      if (await completeFeishuAutomation(videoId)) deliveredVideos += 1;
    } catch {
      // The database job is the durable retry marker. Never log provider/Base
      // errors here because they can contain authorization material.
    }
  }
  return { pendingVideos: pendingVideoIds.length, terminalVideos, deliveredVideos };
}

function automationDeliveryWorkerInterval() {
  const configured = Number(process.env.FEISHU_AUTOMATION_DELIVERY_INTERVAL_MS || 30_000);
  return Number.isFinite(configured) ? Math.max(5_000, configured) : 30_000;
}

export function startFeishuAutomationDeliveryWorker() {
  if (automationDeliveryWorkerState.__feishuAutomationDeliveryTimer) return;
  const run = async () => {
    if (automationDeliveryWorkerState.__feishuAutomationDeliveryRunning) return;
    automationDeliveryWorkerState.__feishuAutomationDeliveryRunning = true;
    try {
      await runFeishuAutomationDeliveryPass();
    } catch {
      // A later fixed-interval pass will retry; do not emit sensitive errors.
    } finally {
      automationDeliveryWorkerState.__feishuAutomationDeliveryRunning = false;
    }
  };
  automationDeliveryWorkerState.__feishuAutomationDeliveryInitialTimer = setTimeout(run, 2_500);
  automationDeliveryWorkerState.__feishuAutomationDeliveryInitialTimer.unref();
  automationDeliveryWorkerState.__feishuAutomationDeliveryTimer = setInterval(
    run,
    automationDeliveryWorkerInterval(),
  );
  automationDeliveryWorkerState.__feishuAutomationDeliveryTimer.unref();
}

type FeishuAutomationInput = {
  client: Client;
  appToken: string;
  tableId: string;
  recordId: string;
  fields: Record<string, unknown>;
  fieldMap?: Partial<FeishuAutomationFieldMap>;
  writeBack?: boolean;
};

export async function handleFeishuAutomation(input: FeishuAutomationInput) {
  return withProductCardRecordLock(input, () => handleFeishuAutomationUnlocked(input));
}

async function handleFeishuAutomationUnlocked(input: FeishuAutomationInput) {
  // 运维后台"字段映射"页面按 appToken:tableId 存的覆盖配置——不存在时完全不影响现有硬编码默认值。
  const scopeKey = `${input.appToken}:${input.tableId}`;
  const storedMapping = await getFeishuFieldMapping(scopeKey).catch(() => null);
  const mergedFieldMap = { ...storedMapping?.fieldMap, ...input.fieldMap };
  const resolved = resolveAutomationFields(input.fields, mergedFieldMap, storedMapping?.aliases);
  const patch: Record<string, unknown> = {};
  const pendingPatch: Record<string, unknown> = {};
  const writeBack = input.writeBack === true;
  let documentUrl = "";
  let writeBackError = "";
  const writeBackFailures = new Map<string, string>();
  let productRefreshError = "";
  let productCardWarning = "";
  let productCardStatus = "";
  let product = null as Awaited<ReturnType<typeof getProductByPid>>;

  const queuePatch = (fields: Record<string, unknown>) => {
    Object.assign(patch, fields);
    Object.assign(pendingPatch, fields);
  };
  const flushPatch = async () => {
    if (!writeBack || !Object.keys(pendingPatch).length) return;
    const snapshot = Object.entries(pendingPatch);
    for (const [key, value] of snapshot) {
      try {
        await patchBaseRecord(input.client, {
          appToken: input.appToken,
          tableId: input.tableId,
          recordId: input.recordId,
          fields: { [key]: value },
        });
        if (pendingPatch[key] === value) delete pendingPatch[key];
        writeBackFailures.delete(key);
      } catch (error) {
        writeBackFailures.set(key, safeAutomationFailure(error));
      }
    }
    writeBackError = [...writeBackFailures.entries()]
      .map(([fieldName, message]) => `${fieldName}：${message}`)
      .join("；")
      .slice(0, 500);
  };

  const mappingKey = {
    appToken: input.appToken,
    tableId: input.tableId,
    recordId: input.recordId,
  };
  const effectivePid = resolved.pid.trim();
  const effectiveName = resolved.productName.trim();
  if (!effectiveName) throw new Error("缺少产品名称，无法按“产品名称_PID”命名手卡");
  if (!effectivePid) throw new Error("缺少商品 PID，无法按“产品名称_PID”命名手卡");
  if (!/^\d+$/.test(effectivePid)) throw new Error("商品 PID 格式不正确，必须只包含数字");
  // Most rows only carry a PID, not a full 商品链接/产品链接 — but a TikTok Shop
  // product URL is just this exact template with the PID slotted in (a
  // slug-less /pdp/{pid} path is a recognized, valid TikTok Shop product
  // source — see lib/product-parser.ts's officialTikTokProductPath). Build
  // one from the PID whenever the request didn't supply its own link, so
  // "产品链接" and the product-page analysis below aren't gated on a field
  // most rows never fill in.
  const effectiveProductUrl = resolved.productUrl || `https://shop.tiktok.com/us/pdp/${effectivePid}?source=anchor`;
  // Testing convenience: a product name containing "测试" always gets a fresh
  // card, bypassing the existing-by-PID reuse — lets a real PID be reused
  // across repeated test clicks to check the field-fill behavior without
  // "已有手卡不碰" silently skipping every run after the first.
  const isTestRequest = effectiveName.includes("测试");

  // Only an explicit Feishu button click reaches this handler. The product
  // folder and exact `_PID` title suffix are authoritative; row fields and
  // cached mappings never select or create a document.
  const shell = await ensureProductCardByPid(input.client, {
    name: effectiveName,
    pid: effectivePid,
    forceNew: isTestRequest,
  });
  documentUrl = shell.documentUrl;

  productCardWarning = [shell.permissionWarning, shell.ownershipWarning]
    .filter(Boolean)
    .map((warning) => safeAutomationFailure(warning))
    .join("；");

  // A reused card that staff already filled in is returned as-is — a button
  // click must never rewrite fields someone is actively editing. But a reused
  // card that was only ever created as an empty shell (all three identity
  // fields still blank, e.g. an old pre-session template nobody finished) is
  // safe, and worth, filling in exactly like a brand-new one. AI-derived
  // fields like 产品主要功能 are never touched here either way — that belongs to
  // a separate parsing step.
  let shouldSyncIdentity = !shell.reused;
  if (shell.reused) {
    try {
      const preflight = await syncProductCardManagedFields(input.client, {
        documentId: shell.documentId,
        mode: "identity",
        name: effectiveName,
        productUrl: effectiveProductUrl,
        pid: effectivePid,
        preflightOnly: true,
      });
      shouldSyncIdentity = (["商品名称", "产品链接", "商品ID"] as const)
        .every((label) => !(preflight.currentValues[label] || "").trim());
    } catch {
      shouldSyncIdentity = false; // 读取失败时保守处理，宁可不填也不误判成空白去覆盖。
    }
  }
  if (shouldSyncIdentity) {
    try {
      const identitySync = await syncProductCardManagedFields(input.client, {
        documentId: shell.documentId,
        mode: "identity",
        name: effectiveName,
        productUrl: effectiveProductUrl,
        pid: effectivePid,
      });
      if (identitySync.missingLabels.length) {
        productCardWarning = [productCardWarning, `产品手卡模板缺少字段：${identitySync.missingLabels.join("、")}`]
          .filter(Boolean)
          .join("；");
      }
    } catch (error) {
      productCardWarning = [productCardWarning, safeAutomationFailure(error)].filter(Boolean).join("；");
    }
  }
  // Same "safe to fill" gate as identity sync (brand-new or still-blank card
  // only) — a product-page parse must never overwrite AI-derived content a
  // human has since edited. effectiveProductUrl is always populated (falls
  // back to a PID-built link above), so this runs for essentially every
  // eligible card now, not just the rare row with its own 商品链接.
  if (shouldSyncIdentity) {
    try {
      const { parsePublicProductPage } = await import("@/lib/product-parser");
      const parsedProduct = await parsePublicProductPage(effectiveProductUrl, {
        productName: effectiveName,
        pid: effectivePid,
      });
      await syncProductCardManagedFields(input.client, {
        documentId: shell.documentId,
        mode: "verified-basic",
        sku: parsedProduct.sku,
        coreFunctions: parsedProduct.coreFunctions,
        productParameters: parsedProduct.productParameters,
        usageMethod: parsedProduct.usageMethod,
        audience: parsedProduct.audience,
        scenes: parsedProduct.scenes,
      });
    } catch (error) {
      // Best-effort only — a bad/expired product link must never block the
      // hand-card shell (already created) or the rest of this automation run.
      console.warn(`[feishu-automation] 商品页解析失败 pid=${effectivePid}: ${safeAutomationFailure(error)}`);
    }
  }
  queuePatch({ [resolved.map.productDocument]: shell.documentUrl });
  await flushPatch();

  product = await withProductIdentityLock(effectivePid, async () => {
    const current = await getProductByPid(effectivePid);
    if (current) {
      return (await updateProduct(current.id, {
        name: effectiveName,
        pid: effectivePid,
        productUrl: effectiveProductUrl,
        documentId: shell.documentId,
        documentUrl: shell.documentUrl,
      })) || current;
    }
    return createProduct({
      name: effectiveName,
      pid: effectivePid,
      productUrl: effectiveProductUrl,
      documentId: shell.documentId,
      documentUrl: shell.documentUrl,
    });
  });
  if (!product) throw new Error("创建产品档案失败");

  await upsertFeishuProductCardMapping({
    ...mappingKey,
    productId: product.id,
    documentId: shell.documentId,
    documentUrl: shell.documentUrl,
    lastProductPid: effectivePid,
    lastProductUrl: effectiveProductUrl,
    lastProductName: effectiveName,
    managedProductPid: "",
  });

  productCardStatus = productCardWarning
    ? "手卡已就绪，请手动填写；文档权限待修复"
    : "手卡已就绪，请手动填写";
  productRefreshError = "";
  // Give the critical document-link field one final independent attempt before
  // publishing the terminal status. Never tell the user "已完成" while the row
  // still has no hand-card link, even if parsing and document sync succeeded.
  await flushPatch();
  const documentWriteFailure = writeBackFailures.get(resolved.map.productDocument);
  if (writeBack && documentWriteFailure) {
    productCardStatus = `手卡已创建，但表格手卡链接回写待重试：${documentWriteFailure}`.slice(0, 500);
  }
  queuePatch({ [resolved.map.productCardStatus]: productCardStatus });

  if (resolved.videoUrl) {
    const targetProduct = product || await getProductByPid(resolved.pid) || await getProduct("system-unclassified");
    if (!targetProduct) throw new Error("无法找到可归档视频的产品档案");
    const video = await createVideo({
      productId: targetProduct.id,
      sourceType: "tiktok",
      sourceUrl: resolved.videoUrl,
      title: effectiveName ? `${effectiveName}样片` : "飞书自动化样片",
      analysisMode: "product_doc",
    });
    if (writeBack) {
      await saveFeishuAutomationJob({
        videoId: video.id,
        appToken: input.appToken,
        tableId: input.tableId,
        recordId: input.recordId,
        fieldMap: resolved.map,
      });
    }
    await enqueueVideos([video.id]);
    queuePatch({ [resolved.map.status]: "排队中" });
  }

  await flushPatch();
  return {
    ...resolved,
    productName: effectiveName,
    pid: effectivePid,
    patch,
    documentUrl,
    documentReady: true,
    productCardStatus,
    productCardWarning,
    productRefreshError,
    writeBackError,
  };
}
