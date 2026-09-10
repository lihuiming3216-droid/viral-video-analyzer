import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader } from "mysql2/promise";
import { getPool } from "@/lib/db/pool";
import { QWEN_TRANSPORT_ERROR_CODES } from "@/lib/types";
import type {
  AnalysisResult,
  DashboardPayload,
  FeishuProductCardMapping,
  FeishuProductCardMappingKey,
  ManualLabel,
  Product,
  ProductFactBasis,
  ProductFactField,
  ProductFactProvenance,
  ProviderName,
  ProviderSetting,
  SceneRecord,
  VerifiedProductFactsMergeInput,
  VideoAttemptCallDiagnostic,
  VideoAttemptDiagnostics,
  VideoRecord,
  VideoStatus,
} from "@/lib/types";

type Row = Record<string, unknown>;
/** Anything that can run a parameterized query: the pool itself, or one connection held for a transaction. */
type Queryable = { query(sql: string, params?: unknown[]): Promise<[unknown, unknown]> };

function now() {
  return new Date().toISOString();
}

/** mysql2 auto-parses JSON columns into JS values already; a string only shows up for legacy/edge input. */
function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" ? value : value == null ? null : Number(value);
}

function sqlValue(value: unknown): string | number | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

async function rows(db: Queryable, sql: string, params: unknown[] = []) {
  const [result] = await db.query(sql, params);
  return result as Row[];
}

async function row(db: Queryable, sql: string, params: unknown[] = []) {
  return (await rows(db, sql, params))[0] as Row | undefined;
}

async function run(db: Queryable, sql: string, params: unknown[] = []) {
  const [result] = await db.query(sql, params);
  return result as ResultSetHeader;
}

let seeded: Promise<void> | undefined;

async function ensureSeeded(db: Queryable) {
  const timestamp = now();
  const providers: Array<[ProviderName, string, string]> = [
    ["tokscript", "https://api.tokscript.com/mcp", ""],
    ["qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3.7-plus"],
  ];
  for (const [provider, baseUrl, model] of providers) {
    await run(
      db,
      "INSERT IGNORE INTO provider_settings(provider, base_url, model, enabled, updated_at) VALUES (?, ?, ?, 1, ?)",
      [provider, baseUrl, model, timestamp],
    );
  }
  await run(db, "DELETE FROM provider_settings WHERE provider='openai'");
  await run(
    db,
    `INSERT IGNORE INTO feishu_settings(id, public_base_url, connection_status, updated_at)
     VALUES (1, 'http://localhost:3000', 'disconnected', ?)`,
    [timestamp],
  );
  await run(
    db,
    `INSERT IGNORE INTO products(id, name, category, market, notes, is_system, created_at, updated_at)
     VALUES ('system-unclassified', '未归类样片', '待整理', '美国', '用于暂存还没有建立产品档案的视频', 1, ?, ?)`,
    [timestamp, timestamp],
  );
}

/** The shared MySQL pool, schema-applied and seed-data-populated exactly once per process. */
export async function getDb() {
  const pool = await getPool();
  if (!seeded) seeded = ensureSeeded(pool);
  await seeded;
  return pool;
}

async function withTransaction<T>(fn: (db: PoolConnection) => Promise<T>): Promise<T> {
  const pool = await getDb();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      /* transaction already closed */
    }
    throw error;
  } finally {
    connection.release();
  }
}

function requiredMappingKey(value: unknown, label: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`缺少飞书产品手卡映射${label}`);
  return normalized;
}

function nullableMappingValue(value: string | null | undefined) {
  if (value == null) return null;
  return value.trim() || null;
}

function productCardMappingFromRow(source: Row): FeishuProductCardMapping {
  return {
    appToken: String(source.app_token),
    tableId: String(source.table_id),
    recordId: String(source.record_id),
    productId: source.product_id ? String(source.product_id) : null,
    documentId: source.document_id ? String(source.document_id) : null,
    documentUrl: source.document_url ? String(source.document_url) : null,
    lastProductPid: String(source.last_product_pid || ""),
    lastProductUrl: String(source.last_product_url || ""),
    lastProductName: String(source.last_product_name || ""),
    managedProductPid: String(source.managed_product_pid || ""),
    createdAt: String(source.created_at),
    updatedAt: String(source.updated_at),
  };
}

export async function getFeishuProductCardMapping(key: FeishuProductCardMappingKey) {
  const appToken = requiredMappingKey(key.appToken, " App Token");
  const tableId = requiredMappingKey(key.tableId, " Table ID");
  const recordId = requiredMappingKey(key.recordId, " Record ID");
  const db = await getDb();
  const found = await row(
    db,
    `SELECT * FROM feishu_product_card_mappings WHERE app_token=? AND table_id=? AND record_id=?`,
    [appToken, tableId, recordId],
  );
  return found ? productCardMappingFromRow(found) : null;
}

/** All row-owned product-card documents currently bound to one internal product. */
export async function listFeishuProductCardMappingsByProductId(productId: string) {
  const normalized = productId.trim();
  if (!normalized) return [];
  const db = await getDb();
  const found = await rows(
    db,
    `SELECT * FROM feishu_product_card_mappings
      WHERE product_id=? AND document_id IS NOT NULL AND TRIM(document_id)<>''
      ORDER BY created_at, app_token, table_id, record_id`,
    [normalized],
  );
  return found.map(productCardMappingFromRow);
}

export async function upsertFeishuProductCardMapping(
  input: FeishuProductCardMappingKey & Partial<Pick<
    FeishuProductCardMapping,
    "productId" | "documentId" | "documentUrl" | "lastProductPid" | "lastProductUrl" | "lastProductName" | "managedProductPid"
  >>,
) {
  const appToken = requiredMappingKey(input.appToken, " App Token");
  const tableId = requiredMappingKey(input.tableId, " Table ID");
  const recordId = requiredMappingKey(input.recordId, " Record ID");
  const timestamp = now();
  const productId = nullableMappingValue(input.productId);
  const documentId = nullableMappingValue(input.documentId);
  const documentUrl = nullableMappingValue(input.documentUrl);
  const lastProductPid = input.lastProductPid?.trim() || "";
  const lastProductUrl = input.lastProductUrl?.trim() || "";
  const lastProductName = input.lastProductName?.trim() || "";
  const managedProductPid = input.managedProductPid?.trim() || "";
  const db = await getDb();
  await run(
    db,
    `INSERT INTO feishu_product_card_mappings(
      app_token, table_id, record_id, product_id, document_id, document_url,
      last_product_pid, last_product_url, last_product_name, managed_product_pid, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      product_id=IF(?=1, VALUES(product_id), product_id),
      document_id=IF(?=1, VALUES(document_id), document_id),
      document_url=IF(?=1, VALUES(document_url), document_url),
      last_product_pid=IF(?=1, VALUES(last_product_pid), last_product_pid),
      last_product_url=IF(?=1, VALUES(last_product_url), last_product_url),
      last_product_name=IF(?=1, VALUES(last_product_name), last_product_name),
      managed_product_pid=IF(?=1, VALUES(managed_product_pid), managed_product_pid),
      updated_at=VALUES(updated_at)`,
    [
      appToken, tableId, recordId, productId, documentId, documentUrl,
      lastProductPid, lastProductUrl, lastProductName, managedProductPid, timestamp, timestamp,
      input.productId !== undefined ? 1 : 0,
      input.documentId !== undefined ? 1 : 0,
      input.documentUrl !== undefined ? 1 : 0,
      input.lastProductPid !== undefined ? 1 : 0,
      input.lastProductUrl !== undefined ? 1 : 0,
      input.lastProductName !== undefined ? 1 : 0,
      input.managedProductPid !== undefined ? 1 : 0,
    ],
  );
  return (await getFeishuProductCardMapping({ appToken, tableId, recordId }))!;
}

export async function claimFeishuProductCardDocument(
  key: FeishuProductCardMappingKey,
  document: { documentId: string; documentUrl: string },
) {
  const appToken = requiredMappingKey(key.appToken, " App Token");
  const tableId = requiredMappingKey(key.tableId, " Table ID");
  const recordId = requiredMappingKey(key.recordId, " Record ID");
  const documentId = document.documentId?.trim();
  const documentUrl = document.documentUrl?.trim();
  if (!documentId) throw new Error("缺少待认领的飞书产品手卡文档 ID");
  if (!documentUrl) throw new Error("缺少待认领的飞书产品手卡文档链接");
  return withTransaction(async (db) => {
    const current = await row(
      db,
      `SELECT document_id FROM feishu_product_card_mappings WHERE app_token=? AND table_id=? AND record_id=?`,
      [appToken, tableId, recordId],
    );
    const timestamp = now();
    if (current) {
      await run(
        db,
        `UPDATE feishu_product_card_mappings SET document_id=?, document_url=?, updated_at=?
         WHERE app_token=? AND table_id=? AND record_id=?`,
        [documentId, documentUrl, timestamp, appToken, tableId, recordId],
      );
    } else {
      await run(
        db,
        `INSERT INTO feishu_product_card_mappings(
          app_token, table_id, record_id, document_id, document_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [appToken, tableId, recordId, documentId, documentUrl, timestamp, timestamp],
      );
    }
    return true;
  });
}

export interface FeishuAutomationJobKey {
  videoId: string;
  appToken: string;
  tableId: string;
  recordId: string;
}

export interface FeishuAutomationJob extends FeishuAutomationJobKey {
  fieldMap: Record<string, string>;
  attempts: number;
  blockedReason: string;
  createdAt: string;
  updatedAt: string;
}

const feishuAutomationFieldMapKeys = new Set([
  "productUrl", "pid", "productName", "productDocument", "productCardStatus",
  "videoUrl", "analysis", "translation", "status",
  "transcript", "videoFile", "subtitle",
  "timestampedTranscript", "timestampedTranslation", "linkedSubtitle",
]);

function safeFeishuAutomationFieldMap(value: Record<string, string> | undefined) {
  // An empty string is a deliberate "this table has no such column, never
  // write it" marker (set via /admin/field-mapping's "跳过" checkbox) and
  // must survive this filter — only a missing/non-string entry gets dropped,
  // which lets the caller fall back to the code default for that key.
  return Object.fromEntries(Object.entries(value || {}).filter(([key, fieldName]) => (
    feishuAutomationFieldMapKeys.has(key) && typeof fieldName === "string"
  )).map(([key, fieldName]) => [key, fieldName.trim()]));
}

function feishuAutomationJobFromRow(source: Row): FeishuAutomationJob {
  return {
    videoId: String(source.video_id),
    appToken: String(source.app_token),
    tableId: String(source.table_id),
    recordId: String(source.record_id),
    fieldMap: json<Record<string, string>>(source.field_map_json, {}),
    attempts: Number(source.attempts ?? 0),
    blockedReason: String(source.blocked_reason || ""),
    createdAt: String(source.created_at),
    updatedAt: String(source.updated_at),
  };
}

export async function saveFeishuAutomationJob(input: {
  videoId: string;
  appToken: string;
  tableId: string;
  recordId: string;
  fieldMap?: Record<string, string>;
}) {
  const timestamp = now();
  const videoId = input.videoId.trim();
  const appToken = input.appToken.trim();
  const tableId = input.tableId.trim();
  const recordId = input.recordId.trim();
  await withTransaction(async (db) => {
    // A Base row has exactly one current delivery generation. A later click
    // supersedes every older task for that row, while the same video may still
    // deliver independently to other Base rows.
    await run(
      db,
      `DELETE FROM feishu_automation_jobs WHERE app_token=? AND table_id=? AND record_id=? AND video_id<>?`,
      [appToken, tableId, recordId, videoId],
    );
    await run(
      db,
      `INSERT INTO feishu_automation_jobs(
        video_id, app_token, table_id, record_id, field_map_json, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      ON DUPLICATE KEY UPDATE field_map_json=VALUES(field_map_json), attempts=0, updated_at=VALUES(updated_at)`,
      [videoId, appToken, tableId, recordId, JSON.stringify(safeFeishuAutomationFieldMap(input.fieldMap)), timestamp, timestamp],
    );
    await run(db, `DELETE FROM feishu_automation_delivery_blocks
      WHERE video_id=? AND app_token=? AND table_id=? AND record_id=?`, [videoId, appToken, tableId, recordId]);
  });
}

export async function getFeishuAutomationJob(videoId: string) {
  return (await getFeishuAutomationJobs(videoId))[0] || null;
}

export async function getFeishuAutomationJobs(videoId: string) {
  const db = await getDb();
  const found = await rows(
    db,
    `SELECT j.*, b.reason AS blocked_reason FROM feishu_automation_jobs j
      LEFT JOIN feishu_automation_delivery_blocks b USING (video_id, app_token, table_id, record_id)
      WHERE j.video_id=? ORDER BY j.created_at, j.app_token, j.table_id, j.record_id`,
    [videoId],
  );
  return found.map(feishuAutomationJobFromRow);
}

export async function listFeishuAutomationJobVideoIds() {
  const db = await getDb();
  const found = await rows(
    db,
    `SELECT j.video_id, MIN(j.created_at) AS first_created_at FROM feishu_automation_jobs j
      LEFT JOIN feishu_automation_delivery_blocks b USING (video_id, app_token, table_id, record_id)
      WHERE b.video_id IS NULL GROUP BY j.video_id ORDER BY first_created_at, j.video_id`,
  );
  return found.map((item) => String(item.video_id));
}

export async function incrementFeishuAutomationJobAttempts(key: FeishuAutomationJobKey) {
  const db = await getDb();
  await run(
    db,
    `UPDATE feishu_automation_jobs SET attempts=attempts+1, updated_at=?
     WHERE video_id=? AND app_token=? AND table_id=? AND record_id=?`,
    [now(), key.videoId, key.appToken, key.tableId, key.recordId],
  );
}

export async function blockFeishuAutomationJob(key: FeishuAutomationJobKey, reason: string, message: string) {
  const db = await getDb();
  const timestamp = now();
  // INSERT ... SELECT cannot create a block for a superseded/deleted row job.
  await run(db, `INSERT INTO feishu_automation_delivery_blocks
    (video_id, app_token, table_id, record_id, reason, message, created_at, updated_at)
    SELECT video_id, app_token, table_id, record_id, ?, ?, ?, ? FROM feishu_automation_jobs
      WHERE video_id=? AND app_token=? AND table_id=? AND record_id=?
    ON DUPLICATE KEY UPDATE reason=VALUES(reason), message=VALUES(message), updated_at=VALUES(updated_at)`,
  [reason, Array.from(message).slice(0, 512).join(""), timestamp, timestamp,
    key.videoId, key.appToken, key.tableId, key.recordId]);
}

export async function deleteFeishuAutomationJob(key: FeishuAutomationJobKey | string) {
  const db = await getDb();
  if (typeof key === "string") {
    // Kept for callers from older builds. New completion code always passes a
    // composite key so one successful row cannot delete another pending row.
    return run(db, "DELETE FROM feishu_automation_jobs WHERE video_id=?", [key]);
  }
  return run(
    db,
    `DELETE FROM feishu_automation_jobs WHERE video_id=? AND app_token=? AND table_id=? AND record_id=?`,
    [key.videoId, key.appToken, key.tableId, key.recordId],
  );
}

function productFromRow(source: Row): Product {
  return {
    id: String(source.id),
    name: String(source.name),
    pid: String(source.pid ?? ""),
    sku: String(source.sku ?? ""),
    documentId: source.document_id ? String(source.document_id) : null,
    documentUrl: source.document_url ? String(source.document_url) : null,
    imagePath: source.image_path ? String(source.image_path) : null,
    propImages: json<string[]>(source.prop_images_json, []),
    category: String(source.category ?? ""),
    market: String(source.market ?? ""),
    price: String(source.price ?? ""),
    sellingPoints: String(source.selling_points ?? ""),
    targetAudience: String(source.target_audience ?? ""),
    painPoints: String(source.pain_points ?? ""),
    competitors: String(source.competitors ?? ""),
    productUrl: String(source.product_url ?? ""),
    coreFunctions: json<string[]>(source.core_functions_json, []),
    productParameters: String(source.product_parameters ?? ""),
    usageMethod: String(source.usage_method ?? ""),
    usageScenes: String(source.usage_scenes ?? ""),
    sourceTitle: String(source.source_title ?? ""),
    sourceDescription: String(source.source_description ?? ""),
    sourceImageUrls: json<string[]>(source.source_image_urls_json, []),
    visualEvidence: String(source.visual_evidence ?? ""),
    visualAnalysisStatus: (["completed", "unavailable"].includes(String(source.visual_analysis_status))
      ? String(source.visual_analysis_status)
      : "") as Product["visualAnalysisStatus"],
    visualAnalyzedAt: source.visual_analyzed_at ? String(source.visual_analyzed_at) : null,
    verifiedPid: String(source.verified_pid ?? ""),
    verifiedSourceUrl: String(source.verified_source_url ?? ""),
    evidenceVersion: String(source.evidence_version ?? ""),
    factsVerifiedAt: String(source.facts_verified_at ?? ""),
    factProvenance: json<ProductFactProvenance>(source.fact_provenance_json, {}),
    bannedTerms: String(source.banned_terms ?? ""),
    notes: String(source.notes ?? ""),
    isSystem: Boolean(source.is_system),
    videoCount: Number(source.video_count ?? 0),
    createdAt: String(source.created_at),
    updatedAt: String(source.updated_at),
  };
}

function videoFromRow(source: Row): VideoRecord {
  return {
    id: String(source.id),
    productId: String(source.product_id),
    productName: String(source.product_name ?? ""),
    sourceType: source.source_type === "upload" ? "upload" : "tiktok",
    sourceUrl: source.source_url ? String(source.source_url) : null,
    sourceFileName: source.source_file_name ? String(source.source_file_name) : null,
    title: String(source.title ?? ""),
    accountName: String(source.account_name ?? ""),
    platformVideoId: source.platform_video_id ? String(source.platform_video_id) : null,
    language: source.language ? String(source.language) : null,
    publishedAt: source.published_at ? String(source.published_at) : null,
    durationSeconds: numberOrNull(source.duration_seconds),
    originalPath: source.original_path ? String(source.original_path) : null,
    coverPath: source.cover_path ? String(source.cover_path) : null,
    remoteVideoUrl: source.remote_video_url ? String(source.remote_video_url) : null,
    status: String(source.status) as VideoStatus,
    stage: String(source.stage ?? ""),
    progress: Number(source.progress ?? 0),
    errorMessage: source.error_message ? String(source.error_message) : null,
    scores: {
      traffic: Number(source.score_traffic ?? 0),
      conversion: Number(source.score_conversion ?? 0),
      visual: Number(source.score_visual ?? 0),
      product: Number(source.score_product ?? 0),
      audio: Number(source.score_audio ?? 0),
      rhythm: Number(source.score_rhythm ?? 0),
    },
    summary: String(source.summary ?? ""),
    hookSummary: String(source.hook_summary ?? ""),
    manualLabel: (source.manual_label ? String(source.manual_label) : null) as ManualLabel,
    manualNotes: String(source.manual_notes ?? ""),
    viewCount: numberOrNull(source.view_count),
    likeCount: numberOrNull(source.like_count),
    commentCount: numberOrNull(source.comment_count),
    shareCount: numberOrNull(source.share_count),
    favoriteCount: numberOrNull(source.favorite_count),
    followerCount: numberOrNull(source.follower_count),
    statsCapturedAt: source.stats_captured_at ? String(source.stats_captured_at) : null,
    transcriptOriginal: String(source.transcript_original ?? ""),
    transcriptZh: String(source.transcript_zh ?? ""),
    transcriptSegments: json<Array<{ start: number; end: number; text: string }>>(source.transcript_segments_json, []),
    analysis: json<AnalysisResult | null>(source.analysis_json, null),
    analysisMode: source.analysis_mode === "product_doc" ? "product_doc"
      : source.analysis_mode === "transcript_only" ? "transcript_only" : "full",
    productDocRetryCount: Number(source.product_doc_retry_count ?? 0),
    productDocFailureDelivered: Boolean(Number(source.product_doc_failure_delivered ?? 0)),
    processingStartedAt: source.processing_started_at ? String(source.processing_started_at) : null,
    attemptCount: Number(source.attempt_count ?? 0),
    createdAt: String(source.created_at),
    updatedAt: String(source.updated_at),
  };
}

function sceneFromRow(source: Row): SceneRecord {
  return {
    id: String(source.id),
    videoId: String(source.video_id),
    shotIndex: Number(source.shot_index),
    startSeconds: Number(source.start_seconds),
    endSeconds: Number(source.end_seconds),
    screenshotPath: source.screenshot_path ? String(source.screenshot_path) : null,
    clipPath: source.clip_path ? String(source.clip_path) : null,
    role: String(source.role ?? ""),
    visualDescription: String(source.visual_description ?? ""),
    audioDescription: String(source.audio_description ?? ""),
    transcriptOriginal: String(source.transcript_original ?? ""),
    translationZh: String(source.translation_zh ?? ""),
    strengths: String(source.strengths ?? ""),
    weaknesses: String(source.weaknesses ?? ""),
    importance: Number(source.importance ?? 0),
    scoreTraffic: Number(source.score_traffic ?? 0),
    scoreConversion: Number(source.score_conversion ?? 0),
    scoreClarity: Number(source.score_clarity ?? 0),
    scoreAesthetic: Number(source.score_aesthetic ?? 0),
    scoreLighting: Number(source.score_lighting ?? 0),
    scoreProduct: Number(source.score_product ?? 0),
    tags: json<string[]>(source.tags_json, []),
  };
}

export async function listProducts(options: { search?: string; excludeSystem?: boolean; limit?: number; offset?: number } = {}) {
  const { search, excludeSystem, limit, offset = 0 } = options;
  const db = await getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (excludeSystem) conditions.push("p.is_system = 0");
  if (search?.trim()) {
    conditions.push("(p.name LIKE ? OR p.pid LIKE ?)");
    params.push(`%${search.trim()}%`, `%${search.trim()}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limitSql = limit != null ? "LIMIT ? OFFSET ?" : "";
  if (limit != null) params.push(limit, offset);
  const found = await rows(
    db,
    `SELECT p.*, COUNT(v.id) AS video_count FROM products p
     LEFT JOIN videos v ON v.product_id = p.id
     ${where}
     GROUP BY p.id ORDER BY p.is_system ASC, p.updated_at DESC ${limitSql}`,
    params,
  );
  return found.map(productFromRow);
}

/** Row count for {@link listProducts}'s filters — used by the ops console's pagination. */
export async function countProducts(options: { search?: string; excludeSystem?: boolean } = {}) {
  const { search, excludeSystem } = options;
  const db = await getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (excludeSystem) conditions.push("is_system = 0");
  if (search?.trim()) {
    conditions.push("(name LIKE ? OR pid LIKE ?)");
    params.push(`%${search.trim()}%`, `%${search.trim()}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const found = await row(db, `SELECT COUNT(*) AS total FROM products ${where}`, params);
  return Number(found?.total || 0);
}

export async function createProduct(input: Partial<Product>) {
  const id = randomUUID();
  const timestamp = now();
  const db = await getDb();
  await run(
    db,
    `INSERT INTO products(
      id, name, pid, sku, document_id, document_url, image_path, prop_images_json, category, market, price, selling_points, target_audience,
      pain_points, competitors, product_url, source_image_urls_json, visual_evidence, visual_analysis_status, visual_analyzed_at,
      banned_terms, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name?.trim() || "未命名产品",
      input.pid?.trim() || "",
      input.sku || "",
      input.documentId || null,
      input.documentUrl || null,
      input.imagePath || null,
      JSON.stringify(input.propImages || []),
      input.category || "",
      input.market || "",
      input.price || "",
      input.sellingPoints || "",
      input.targetAudience || "",
      input.painPoints || "",
      input.competitors || "",
      input.productUrl || "",
      JSON.stringify(input.sourceImageUrls || []),
      input.visualEvidence || "",
      input.visualAnalysisStatus || "",
      input.visualAnalyzedAt || null,
      input.bannedTerms || "",
      input.notes || "",
      timestamp,
      timestamp,
    ],
  );
  return (await getProduct(id))!;
}

export async function getProduct(id: string) {
  const db = await getDb();
  const found = await row(
    db,
    `SELECT p.*, COUNT(v.id) AS video_count FROM products p
     LEFT JOIN videos v ON v.product_id = p.id WHERE p.id = ? GROUP BY p.id`,
    [id],
  );
  return found ? productFromRow(found) : null;
}

export async function getProductByPid(pid: string) {
  const normalized = pid.trim();
  if (!normalized) return null;
  const db = await getDb();
  const found = await row(
    db,
    `SELECT p.*, COUNT(v.id) AS video_count FROM products p
     LEFT JOIN videos v ON v.product_id = p.id WHERE LOWER(p.pid) = LOWER(?) GROUP BY p.id LIMIT 1`,
    [normalized],
  );
  return found ? productFromRow(found) : null;
}

export async function updateProduct(id: string, input: Partial<Product>) {
  const current = await getProduct(id);
  if (!current) return null;
  const nextPid = input.pid?.trim() ?? current.pid;
  const pidChanged = nextPid !== current.pid;
  const verifiedFactWasWritten = [
    "sku", "coreFunctions", "productParameters", "usageMethod", "targetAudience",
    "usageScenes", "sourceTitle", "sourceDescription", "sourceImageUrls",
    "visualEvidence", "visualAnalysisStatus", "visualAnalyzedAt", "factProvenance",
  ].some((key) => input[key as keyof Product] !== undefined);
  const keepVerifiedState = !pidChanged && !verifiedFactWasWritten;
  const db = await getDb();
  await run(
    db,
    `UPDATE products SET name=?, pid=?, sku=?, document_id=?, document_url=?, image_path=?, prop_images_json=?, category=?, market=?, price=?, selling_points=?,
      target_audience=?, pain_points=?, competitors=?, product_url=?, banned_terms=?, notes=?,
      core_functions_json=?, product_parameters=?, usage_method=?, usage_scenes=?, source_title=?, source_description=?,
      source_image_urls_json=?, visual_evidence=?, visual_analysis_status=?, visual_analyzed_at=?,
      verified_pid=?, verified_source_url=?, evidence_version=?, facts_verified_at=?, fact_provenance_json=?, updated_at=? WHERE id=?`,
    [
      input.name ?? current.name,
      nextPid,
      input.sku ?? (pidChanged ? "" : current.sku),
      input.documentId ?? current.documentId,
      input.documentUrl ?? current.documentUrl,
      input.imagePath ?? current.imagePath,
      JSON.stringify(input.propImages ?? current.propImages),
      input.category ?? current.category,
      input.market ?? current.market,
      input.price ?? current.price,
      input.sellingPoints ?? current.sellingPoints,
      input.targetAudience ?? (pidChanged ? "" : current.targetAudience),
      input.painPoints ?? current.painPoints,
      input.competitors ?? current.competitors,
      input.productUrl ?? current.productUrl,
      input.bannedTerms ?? current.bannedTerms,
      input.notes ?? current.notes,
      JSON.stringify(input.coreFunctions ?? (pidChanged ? [] : current.coreFunctions)),
      input.productParameters ?? (pidChanged ? "" : current.productParameters),
      input.usageMethod ?? (pidChanged ? "" : current.usageMethod),
      input.usageScenes ?? (pidChanged ? "" : current.usageScenes),
      input.sourceTitle ?? (pidChanged ? "" : current.sourceTitle),
      input.sourceDescription ?? (pidChanged ? "" : current.sourceDescription),
      JSON.stringify(input.sourceImageUrls ?? (pidChanged ? [] : current.sourceImageUrls)),
      input.visualEvidence ?? (pidChanged ? "" : current.visualEvidence),
      input.visualAnalysisStatus ?? (pidChanged ? "" : current.visualAnalysisStatus),
      input.visualAnalyzedAt === undefined ? (pidChanged ? null : current.visualAnalyzedAt) : input.visualAnalyzedAt,
      keepVerifiedState ? current.verifiedPid : "",
      keepVerifiedState ? current.verifiedSourceUrl : "",
      keepVerifiedState ? current.evidenceVersion : "",
      keepVerifiedState ? current.factsVerifiedAt : "",
      keepVerifiedState ? JSON.stringify(current.factProvenance) : "{}",
      now(),
      id,
    ],
  );
  return getProduct(id);
}

function requiredVerifiedText(value: unknown, label: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`缺少已验证商品资料${label}`);
  return normalized;
}

function verifiedString(value: string | undefined, current: string, sameEvidence: boolean) {
  return value === undefined ? (sameEvidence ? current : "") : value.trim();
}

function verifiedList(value: string[] | undefined, current: string[], sameEvidence: boolean) {
  if (value === undefined) return sameEvidence ? current : [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

const provenanceFields = ["coreFunctions", "usageMethod", "audience", "scenes"] as const satisfies readonly ProductFactField[];

function factItems(value: string | string[]) {
  const values = Array.isArray(value) ? value : value.split(/[；;]/);
  return values.map((item) => String(item).trim()).filter(Boolean);
}

function factProvenanceForMerge(
  input: VerifiedProductFactsMergeInput,
  current: Product,
  next: Pick<Product, "coreFunctions" | "usageMethod" | "targetAudience" | "usageScenes">,
  sameEvidence: boolean,
): ProductFactProvenance {
  const submitted = input.factProvenance || {};
  const result: ProductFactProvenance = {};
  const nextValues: Record<ProductFactField, string[]> = {
    coreFunctions: factItems(next.coreFunctions),
    usageMethod: factItems(next.usageMethod),
    audience: factItems(next.targetAudience),
    scenes: factItems(next.usageScenes),
  };
  for (const field of provenanceFields) {
    // Provenance is reusable only inside the same evidence policy. A new
    // version must submit a fresh basis for every accepted fact; otherwise an
    // earlier validator's classification could be silently promoted.
    const currentByValue = new Map((sameEvidence ? current.factProvenance[field] || [] : [])
      .map((fact) => [fact.value.trim(), fact.basis]));
    const submittedByValue = new Map((submitted[field] || [])
      .map((fact) => [String(fact.value || "").trim(), fact.basis] as const));
    const facts = nextValues[field].map((value) => {
      const basis = submittedByValue.get(value) || currentByValue.get(value) || "verified_text";
      return {
        value,
        basis: (["verified_text", "verified_image_ocr", "ai_inference"].includes(basis)
          ? basis
          : "verified_text") as ProductFactBasis,
      };
    });
    if (facts.length) result[field] = facts;
  }
  return result;
}

function hasIncomingVerifiedFacts(input: VerifiedProductFactsMergeInput) {
  return Boolean(
    input.sku?.trim()
    || input.coreFunctions?.some((item) => String(item).trim())
    || input.productParameters?.trim()
    || input.usageMethod?.trim()
    || input.targetAudience?.trim()
    || input.usageScenes?.trim()
    || input.visualEvidence?.trim(),
  );
}

/**
 * Atomically merge parser-certified facts into one evidence snapshot.
 *
 * Omitted fields are preserved only for the same PID/evidence version. A new
 * exact source URL for that same validation policy advances provenance without
 * dropping previously certified partial facts. A new version resets omissions,
 * and an unverified legacy row can never be silently re-certified.
 */
export async function mergeVerifiedProductFacts(id: string, input: VerifiedProductFactsMergeInput) {
  const productId = id.trim();
  if (!productId) throw new Error("缺少待合并的产品 ID");
  const pid = requiredVerifiedText(input.pid, " PID");
  const sourceUrl = requiredVerifiedText(input.sourceUrl, "来源链接");
  try {
    if (new URL(sourceUrl).protocol !== "https:") throw new Error("invalid protocol");
  } catch {
    throw new Error("已验证商品资料来源链接必须是 HTTPS 绝对链接");
  }
  const evidenceVersion = requiredVerifiedText(input.evidenceVersion, "证据版本");
  const verifiedAt = requiredVerifiedText(input.verifiedAt, "验证时间");
  if (!Number.isFinite(Date.parse(verifiedAt))) throw new Error("已验证商品资料验证时间无效");
  if (input.visualAnalysisStatus !== undefined
    && !["", "completed", "unavailable"].includes(input.visualAnalysisStatus)) {
    throw new Error("已验证商品资料视觉状态无效");
  }
  if (!hasIncomingVerifiedFacts(input)) {
    throw new Error("已验证商品资料本次至少需要一项非空事实");
  }

  await withTransaction(async (db) => {
    const found = await row(db, "SELECT * FROM products WHERE id=?", [productId]);
    if (!found) throw new Error("产品不存在");
    const current = productFromRow({ ...found, video_count: 0 });
    if (pid !== current.pid) throw new Error("已验证商品资料 PID 与产品 PID 不一致");
    const sameEvidence = current.verifiedPid === pid
      && current.evidenceVersion === evidenceVersion;
    const next = {
      sku: verifiedString(input.sku, current.sku, sameEvidence),
      coreFunctions: verifiedList(input.coreFunctions, current.coreFunctions, sameEvidence),
      productParameters: verifiedString(input.productParameters, current.productParameters, sameEvidence),
      usageMethod: verifiedString(input.usageMethod, current.usageMethod, sameEvidence),
      targetAudience: verifiedString(input.targetAudience, current.targetAudience, sameEvidence),
      usageScenes: verifiedString(input.usageScenes, current.usageScenes, sameEvidence),
      sourceTitle: verifiedString(input.sourceTitle, current.sourceTitle, sameEvidence),
      sourceDescription: verifiedString(input.sourceDescription, current.sourceDescription, sameEvidence),
      sourceImageUrls: verifiedList(input.sourceImageUrls, current.sourceImageUrls, sameEvidence),
      visualEvidence: verifiedString(input.visualEvidence, current.visualEvidence, sameEvidence),
      visualAnalysisStatus: input.visualAnalysisStatus === undefined
        ? (sameEvidence ? current.visualAnalysisStatus : "")
        : input.visualAnalysisStatus,
    } satisfies Pick<Product,
      "sku" | "coreFunctions" | "productParameters" | "usageMethod" | "targetAudience"
      | "usageScenes" | "sourceTitle" | "sourceDescription" | "sourceImageUrls"
      | "visualEvidence" | "visualAnalysisStatus">;
    const visualAnalyzedAt = next.visualAnalysisStatus === "completed"
      ? verifiedAt
      : next.visualAnalysisStatus === "unavailable"
        ? null
        : sameEvidence ? current.visualAnalyzedAt : null;
    const factProvenance = factProvenanceForMerge(input, current, next, sameEvidence);
    await run(
      db,
      `UPDATE products SET
        sku=?, core_functions_json=?, product_parameters=?, usage_method=?, target_audience=?, usage_scenes=?,
        source_title=?, source_description=?, source_image_urls_json=?, visual_evidence=?,
        visual_analysis_status=?, visual_analyzed_at=?, verified_pid=?, verified_source_url=?,
        evidence_version=?, facts_verified_at=?, fact_provenance_json=?, updated_at=?
        WHERE id=? AND pid=?`,
      [
        next.sku,
        JSON.stringify(next.coreFunctions),
        next.productParameters,
        next.usageMethod,
        next.targetAudience,
        next.usageScenes,
        next.sourceTitle,
        next.sourceDescription,
        JSON.stringify(next.sourceImageUrls),
        next.visualEvidence,
        next.visualAnalysisStatus,
        visualAnalyzedAt,
        pid,
        sourceUrl,
        evidenceVersion,
        verifiedAt,
        JSON.stringify(factProvenance),
        now(),
        productId,
        pid,
      ],
    );
  });
  return (await getProduct(productId))!;
}

/** Explicitly clear a stale Feishu document link; updateProduct's ?? semantics intentionally cannot do this. */
export async function clearProductDocumentLink(id: string) {
  const db = await getDb();
  await run(db, "UPDATE products SET document_id=NULL, document_url=NULL, updated_at=? WHERE id=?", [now(), id]);
  return getProduct(id);
}

export async function listVideos(filters: { search?: string; productId?: string; account?: string; date?: string } = {}) {
  const clauses = ["1=1"];
  const params: string[] = [];
  if (filters.productId) {
    clauses.push("v.product_id = ?");
    params.push(filters.productId);
  }
  if (filters.account) {
    clauses.push("v.account_name = ?");
    params.push(filters.account);
  }
  if (filters.date) {
    clauses.push("SUBSTR(COALESCE(v.published_at, v.created_at), 1, 10) = ?");
    params.push(filters.date);
  }
  if (filters.search) {
    clauses.push("(v.title LIKE ? OR v.account_name LIKE ? OR p.name LIKE ? OR p.pid LIKE ? OR v.transcript_original LIKE ? OR v.transcript_zh LIKE ?)");
    const term = `%${filters.search}%`;
    params.push(term, term, term, term, term, term);
  }
  const db = await getDb();
  const found = await rows(
    db,
    `SELECT v.*, p.name AS product_name FROM videos v
     JOIN products p ON p.id = v.product_id
     WHERE ${clauses.join(" AND ")} ORDER BY v.created_at DESC`,
    params,
  );
  return found.map(videoFromRow);
}

export interface ProductDocumentVideoRow {
  documentId: string;
  linkBlockId: string;
  productId: string;
  sourceUrl: string;
  videoId: string;
  createdAt: string;
  updatedAt: string;
}

function productDocumentVideoRowFromDb(source: Row): ProductDocumentVideoRow {
  return {
    documentId: String(source.document_id),
    linkBlockId: String(source.link_block_id),
    productId: String(source.product_id),
    sourceUrl: String(source.source_url),
    videoId: String(source.video_id),
    createdAt: String(source.created_at),
    updatedAt: String(source.updated_at),
  };
}

export async function getProductDocumentVideoRow(documentId: string, linkBlockId: string) {
  const db = await getDb();
  const found = await row(
    db,
    `SELECT * FROM product_document_video_rows WHERE document_id=? AND link_block_id=?`,
    [documentId.trim(), linkBlockId.trim()],
  );
  return found ? productDocumentVideoRowFromDb(found) : null;
}

export async function getProductDocumentVideoRowByVideoId(videoId: string) {
  const db = await getDb();
  const found = await row(db, "SELECT * FROM product_document_video_rows WHERE video_id=?", [videoId.trim()]);
  return found ? productDocumentVideoRowFromDb(found) : null;
}

export async function saveProductDocumentVideoRow(input: {
  documentId: string;
  linkBlockId: string;
  productId: string;
  sourceUrl: string;
  videoId: string;
}) {
  const timestamp = now();
  const db = await getDb();
  await run(
    db,
    `INSERT INTO product_document_video_rows(
      document_id, link_block_id, product_id, source_url, video_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      product_id=VALUES(product_id),
      source_url=VALUES(source_url),
      video_id=VALUES(video_id),
      updated_at=VALUES(updated_at)`,
    [input.documentId.trim(), input.linkBlockId.trim(), input.productId.trim(), input.sourceUrl.trim(), input.videoId.trim(), timestamp, timestamp],
  );
  return (await getProductDocumentVideoRow(input.documentId, input.linkBlockId))!;
}

export async function deleteProductDocumentVideoRow(documentId: string, linkBlockId: string) {
  const db = await getDb();
  return run(db, `DELETE FROM product_document_video_rows WHERE document_id=? AND link_block_id=?`, [documentId.trim(), linkBlockId.trim()]);
}

export async function isProductDocumentVideoRowsInitialized(documentId: string) {
  const db = await getDb();
  return Boolean(await row(db, "SELECT 1 FROM product_document_video_scan_state WHERE document_id=?", [documentId.trim()]));
}

/** Last document revision this document was fully deep-scanned at (20秒SLA优化的修改检测)。 */
export async function getCachedDocumentRevision(documentId: string) {
  const db = await getDb();
  const found = await row(db, "SELECT last_revision_id FROM product_document_video_scan_state WHERE document_id=?", [documentId.trim()]);
  return found?.last_revision_id == null ? null : Number(found.last_revision_id);
}

export async function setCachedDocumentRevision(documentId: string, revisionId: number) {
  const db = await getDb();
  await run(
    db,
    `INSERT INTO product_document_video_scan_state(document_id, initialized_at, last_revision_id) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE last_revision_id=VALUES(last_revision_id)`,
    [documentId.trim(), now(), revisionId],
  );
}

export async function markProductDocumentVideoRowsInitialized(documentId: string) {
  const db = await getDb();
  await run(
    db,
    `INSERT IGNORE INTO product_document_video_scan_state(document_id, initialized_at) VALUES (?, ?)`,
    [documentId.trim(), now()],
  );
}

export async function getVideoBySourceUrl(sourceUrl: string, productId?: string) {
  const normalized = sourceUrl.trim();
  if (!normalized) return null;
  const db = await getDb();
  const found = productId
    ? await row(
      db,
      `SELECT v.*, p.name AS product_name FROM videos v JOIN products p ON p.id=v.product_id
       WHERE v.source_url=? AND v.product_id=? ORDER BY v.created_at DESC LIMIT 1`,
      [normalized, productId],
    )
    : await row(
      db,
      `SELECT v.*, p.name AS product_name FROM videos v JOIN products p ON p.id=v.product_id
       WHERE v.source_url=? ORDER BY v.created_at DESC LIMIT 1`,
      [normalized],
    );
  return found ? videoFromRow(found) : null;
}

export async function getVideo(id: string, withScenes = true) {
  const db = await getDb();
  const found = await row(
    db,
    "SELECT v.*, p.name AS product_name FROM videos v JOIN products p ON p.id=v.product_id WHERE v.id=?",
    [id],
  );
  if (!found) return null;
  const video = videoFromRow(found);
  if (withScenes) {
    const scenes = await rows(db, "SELECT * FROM scenes WHERE video_id=? ORDER BY shot_index", [id]);
    video.scenes = scenes.map(sceneFromRow);
  }
  return video;
}

export async function createVideo(input: {
  productId: string;
  sourceType: "tiktok" | "upload";
  sourceUrl?: string | null;
  sourceFileName?: string | null;
  analysisMode?: "full" | "product_doc" | "transcript_only";
  originalPath?: string | null;
  title?: string;
}) {
  const id = randomUUID();
  const timestamp = now();
  const db = await getDb();
  await run(
    db,
    `INSERT INTO videos(
      id, product_id, source_type, source_url, source_file_name, analysis_mode, original_path, title,
      status, stage, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', '已加入队列', ?, ?)`,
    [
      id,
      input.productId,
      input.sourceType,
      input.sourceUrl || null,
      input.sourceFileName || null,
      input.analysisMode || "full",
      input.originalPath || null,
      input.title || "待分析视频",
      timestamp,
      timestamp,
    ],
  );
  return (await getVideo(id))!;
}

export async function updateVideo(id: string, values: Record<string, unknown>) {
  const allowed = new Set([
    "product_id", "title", "account_name", "platform_video_id", "language", "published_at",
    "analysis_mode", "product_doc_retry_count", "product_doc_failure_delivered", "processing_started_at", "attempt_count",
    "duration_seconds", "original_path", "cover_path", "remote_video_url", "status", "stage", "progress",
    "error_message", "score_traffic", "score_conversion", "score_visual", "score_product", "score_audio",
    "score_rhythm", "summary", "hook_summary", "manual_label", "manual_notes", "view_count", "like_count",
    "comment_count", "share_count", "favorite_count", "follower_count", "stats_captured_at",
    "transcript_original", "transcript_zh", "transcript_segments_json", "analysis_json", "provider_payload_json",
  ]);
  const entries = Object.entries(values).filter(([key]) => allowed.has(key));
  if (!entries.length) return getVideo(id);
  entries.push(["updated_at", now()]);
  const db = await getDb();
  await run(
    db,
    `UPDATE videos SET ${entries.map(([key]) => `${key}=?`).join(", ")} WHERE id=?`,
    [...entries.map(([, value]) => sqlValue(value)), id],
  );
  return getVideo(id);
}

export async function deleteVideoRecord(id: string) {
  const db = await getDb();
  const result = await run(db, "DELETE FROM videos WHERE id=?", [id]);
  return result.affectedRows > 0;
}

export async function replaceScenes(videoId: string, scenes: Array<Omit<SceneRecord, "id" | "videoId">>) {
  const db = await getDb();
  await run(db, "DELETE FROM scenes WHERE video_id=?", [videoId]);
  for (const scene of scenes) {
    await run(
      db,
      `INSERT INTO scenes(
        id, video_id, shot_index, start_seconds, end_seconds, screenshot_path, clip_path, role,
        visual_description, audio_description, transcript_original, translation_zh, strengths, weaknesses,
        importance, score_traffic, score_conversion, score_clarity, score_aesthetic, score_lighting,
        score_product, tags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), videoId, scene.shotIndex, scene.startSeconds, scene.endSeconds,
        scene.screenshotPath, scene.clipPath, scene.role, scene.visualDescription, scene.audioDescription,
        scene.transcriptOriginal, scene.translationZh, scene.strengths, scene.weaknesses, scene.importance,
        scene.scoreTraffic, scene.scoreConversion, scene.scoreClarity, scene.scoreAesthetic,
        scene.scoreLighting, scene.scoreProduct, JSON.stringify(scene.tags),
      ],
    );
  }
  return getVideo(videoId);
}

export async function getRawProviderSetting(provider: ProviderName) {
  const db = await getDb();
  return row(db, "SELECT * FROM provider_settings WHERE provider=?", [provider]);
}

export async function listProviderSettings(): Promise<ProviderSetting[]> {
  const db = await getDb();
  const found = await rows(db, "SELECT * FROM provider_settings ORDER BY provider");
  return found.map((item) => ({
    provider: String(item.provider) as ProviderName,
    hasKey: Boolean(item.encrypted_api_key),
    baseUrl: String(item.base_url),
    model: String(item.model ?? ""),
    enabled: Boolean(item.enabled),
    updatedAt: String(item.updated_at),
  }));
}

export async function saveProviderSetting(input: {
  provider: ProviderName;
  encryptedApiKey?: string | null;
  baseUrl: string;
  model?: string;
  enabled: boolean;
}) {
  const current = await getRawProviderSetting(input.provider);
  const encrypted = input.encryptedApiKey === undefined
    ? current?.encrypted_api_key ? String(current.encrypted_api_key) : null
    : input.encryptedApiKey;
  const db = await getDb();
  await run(
    db,
    `UPDATE provider_settings SET encrypted_api_key=?, base_url=?, model=?, enabled=?, updated_at=? WHERE provider=?`,
    [encrypted, input.baseUrl, input.model || "", input.enabled ? 1 : 0, now(), input.provider],
  );
  return (await listProviderSettings()).find((item) => item.provider === input.provider)!;
}

export async function getDashboard(filters: Parameters<typeof listVideos>[0] = {}): Promise<DashboardPayload> {
  const [products, videos, providers] = await Promise.all([
    listProducts(),
    listVideos(filters),
    listProviderSettings(),
  ]);
  const completed = videos.filter((video) => video.status === "completed");
  const processing = videos.filter((video) => !["completed", "failed", "waiting"].includes(video.status));
  const average = (key: "traffic" | "conversion") =>
    completed.length ? Math.round(completed.reduce((sum, video) => sum + video.scores[key], 0) / completed.length) : 0;
  return {
    products,
    videos,
    providers,
    totals: {
      products: products.filter((product) => !product.isSystem).length,
      videos: videos.length,
      completed: completed.length,
      processing: processing.length,
      averageTraffic: average("traffic"),
      averageConversion: average("conversion"),
    },
  };
}

export async function getPendingVideoIds() {
  const db = await getDb();
  const found = await rows(
    db,
    `SELECT id FROM videos WHERE status IN ('queued','downloading','transcribing','extracting','analyzing') ORDER BY created_at`,
  );
  return found.map((item) => String(item.id));
}

export const VIDEO_ATTEMPT_DIAGNOSTICS_MAX_BYTES = 16 * 1024;

const videoAttemptDiagnosticKeys = new Set([
  "schemaVersion", "provider", "model", "inputMode", "fileBytes", "inputSha256", "encodedBytes", "durationMs",
  "hasAudio", "videoCodec", "audioCodec", "calls",
]);
const videoAttemptCallDiagnosticKeys = new Set([
  "requestIndex", "clientRequestId", "providerRequestId", "phase", "outcome", "startedAt",
  "headersMs", "firstTokenMs", "totalMs", "httpStatus", "responseSha256", "errorCode",
]);
const videoAttemptCallPhases = new Set([
  "awaiting_headers", "awaiting_first_token", "streaming", "parsing", "completed",
]);
const videoAttemptCallOutcomes = new Set([
  "success", "timeout", "aborted", "http_error", "network_error", "invalid_response",
]);

function plainDiagnosticObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDiagnosticKeys(value: Record<string, unknown>, allowed: Set<string>, label: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}包含不允许的字段 ${key}`);
  }
}

function diagnosticNumber(value: unknown, label: string, options: { integer?: boolean; positive?: boolean } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label}必须是安全的非负数`);
  }
  if (options.integer && !Number.isInteger(value)) throw new Error(`${label}必须是整数`);
  if (options.positive && value === 0) throw new Error(`${label}必须大于0`);
  return value;
}

function diagnosticIdentifier(value: unknown, label: string, maxLength = 160) {
  if (typeof value !== "string"
    || !value
    || value.length > maxLength
    || /(?:https?|ftp):\/\/|^data:|bearer\s|sk-[A-Za-z0-9_-]{8,}/i.test(value)
    || !/^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/.test(value)) {
    throw new Error(`${label}必须是安全标识符`);
  }
  return value;
}

function optionalDiagnosticNumber(value: Record<string, unknown>, key: string, options: { integer?: boolean } = {}) {
  if (key in value) diagnosticNumber(value[key], `诊断字段 ${key}`, options);
}

function validateVideoAttemptCallDiagnostic(value: unknown): asserts value is VideoAttemptCallDiagnostic {
  if (!plainDiagnosticObject(value)) throw new Error("Qwen请求诊断必须是普通对象");
  assertDiagnosticKeys(value, videoAttemptCallDiagnosticKeys, "Qwen请求诊断");
  const requestIndex = diagnosticNumber(value.requestIndex, "requestIndex", { integer: true, positive: true });
  if (requestIndex !== 1 && requestIndex !== 2) throw new Error("requestIndex只能是1或2");
  diagnosticIdentifier(value.clientRequestId, "clientRequestId");
  if ("providerRequestId" in value) diagnosticIdentifier(value.providerRequestId, "providerRequestId");
  if ("errorCode" in value && !QWEN_TRANSPORT_ERROR_CODES.some((code) => code === value.errorCode)) {
    throw new Error("Qwen网络错误码无效");
  }
  if ("responseSha256" in value
    && (typeof value.responseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.responseSha256))) {
    throw new Error("responseSha256必须是64位小写十六进制");
  }
  if (typeof value.phase !== "string" || !videoAttemptCallPhases.has(value.phase)) throw new Error("Qwen请求诊断阶段无效");
  if (typeof value.outcome !== "string" || !videoAttemptCallOutcomes.has(value.outcome)) throw new Error("Qwen请求诊断结果无效");
  if (typeof value.startedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.startedAt)
    || !Number.isFinite(Date.parse(value.startedAt))) {
    throw new Error("startedAt必须是UTC ISO时间");
  }
  for (const key of ["headersMs", "firstTokenMs"]) {
    optionalDiagnosticNumber(value, key);
  }
  diagnosticNumber(value.totalMs, "totalMs");
  optionalDiagnosticNumber(value, "httpStatus", { integer: true });
  if ("httpStatus" in value && (Number(value.httpStatus) < 100 || Number(value.httpStatus) > 599)) {
    throw new Error("httpStatus超出有效范围");
  }
}

function serializeVideoAttemptDiagnostics(value: VideoAttemptDiagnostics) {
  if (!plainDiagnosticObject(value)) throw new Error("执行诊断必须是普通对象");
  let serialized = "";
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("执行诊断必须是可序列化JSON");
  }
  if (Buffer.byteLength(serialized, "utf8") > VIDEO_ATTEMPT_DIAGNOSTICS_MAX_BYTES) {
    throw new Error(`执行诊断不能超过${VIDEO_ATTEMPT_DIAGNOSTICS_MAX_BYTES}字节`);
  }
  assertDiagnosticKeys(value, videoAttemptDiagnosticKeys, "执行诊断");
  if (value.schemaVersion !== 1) throw new Error("执行诊断版本无效");
  if (value.provider !== "qwen") throw new Error("执行诊断provider必须是qwen");
  diagnosticIdentifier(value.model, "model", 100);
  if (value.inputMode !== "local_base64") throw new Error("inputMode无效");
  diagnosticNumber(value.fileBytes, "fileBytes", { integer: true, positive: true });
  if (typeof value.inputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.inputSha256)) {
    throw new Error("inputSha256必须是64位小写十六进制");
  }
  diagnosticNumber(value.encodedBytes, "encodedBytes", { integer: true, positive: true });
  diagnosticNumber(value.durationMs, "durationMs", { positive: true });
  if (value.hasAudio !== true) throw new Error("hasAudio必须为true");
  diagnosticIdentifier(value.videoCodec, "videoCodec", 80);
  diagnosticIdentifier(value.audioCodec, "audioCodec", 80);
  if (!Array.isArray(value.calls) || value.calls.length > 2) throw new Error("每次执行最多记录2个Qwen请求");
  const requestIndexes = new Set<number>();
  for (const call of value.calls) {
    validateVideoAttemptCallDiagnostic(call);
    if (requestIndexes.has(call.requestIndex)) throw new Error("Qwen请求序号不能重复");
    requestIndexes.add(call.requestIndex);
  }
  return serialized;
}

/** Replace the sanitized diagnostic snapshot for the exact active attempt.
 * A stale or already-finished attempt can never mutate durable history. */
export async function updateVideoAttemptDiagnostics(
  videoId: string,
  attemptNumber: number,
  diagnostics: VideoAttemptDiagnostics,
) {
  const normalizedVideoId = videoId.trim();
  if (!normalizedVideoId) throw new Error("videoId不能为空");
  if (!Number.isInteger(attemptNumber) || attemptNumber <= 0) throw new Error("attemptNumber必须是正整数");
  const serialized = serializeVideoAttemptDiagnostics(diagnostics);
  const db = await getDb();
  const result = await run(
    db,
    `UPDATE video_attempts SET diagnostics_json=?
     WHERE video_id=? AND attempt_number=? AND status='running' AND finished_at IS NULL`,
    [serialized, normalizedVideoId, attemptNumber],
  );
  return result.affectedRows > 0;
}

export async function startVideoAttempt(videoId: string) {
  const timestamp = now();
  const attemptId = randomUUID();
  return withTransaction(async (db) => {
    const found = await row(db, "SELECT attempt_count FROM videos WHERE id=?", [videoId]);
    if (!found) throw new Error("视频不存在");
    const attemptNumber = Number(found.attempt_count || 0) + 1;
    await run(
      db,
      `UPDATE video_attempts SET status='stopped', error_message='新一轮处理启动，上一轮已中断', finished_at=?
       WHERE video_id=? AND status='running' AND finished_at IS NULL`,
      [timestamp, videoId],
    );
    await run(
      db,
      `UPDATE videos SET attempt_count=?, processing_started_at=?, product_doc_failure_delivered=0, updated_at=? WHERE id=?`,
      [attemptNumber, timestamp, timestamp, videoId],
    );
    await run(
      db,
      `INSERT INTO video_attempts(id, video_id, attempt_number, status, error_message, started_at, finished_at)
       VALUES (?, ?, ?, 'running', '', ?, NULL)`,
      [attemptId, videoId, attemptNumber, timestamp],
    );
    return { attemptId, attemptNumber, startedAt: timestamp };
  });
}

export async function finishVideoAttempt(
  attemptId: string,
  videoId: string,
  status: "completed" | "failed" | "stopped",
  errorMessage = "",
) {
  const timestamp = now();
  await withTransaction(async (db) => {
    const attempt = await row(
      db,
      `SELECT started_at FROM video_attempts WHERE id=? AND video_id=? AND status='running' AND finished_at IS NULL`,
      [attemptId, videoId],
    );
    if (attempt) {
      const result = await run(
        db,
        `UPDATE video_attempts SET status=?, error_message=?, finished_at=?
         WHERE id=? AND video_id=? AND status='running' AND finished_at IS NULL`,
        [status, errorMessage, timestamp, attemptId, videoId],
      );
      if (result.affectedRows > 0) {
        await run(
          db,
          `UPDATE videos SET processing_started_at=NULL, updated_at=? WHERE id=? AND processing_started_at=?`,
          [timestamp, videoId, String(attempt.started_at)],
        );
      }
    }
  });
}

export async function finishOpenVideoAttempts(videoId: string, status: "failed" | "stopped", errorMessage: string) {
  const timestamp = now();
  const db = await getDb();
  await run(
    db,
    `UPDATE video_attempts SET status=?, error_message=?, finished_at=?
     WHERE video_id=? AND status='running' AND finished_at IS NULL`,
    [status, errorMessage, timestamp, videoId],
  );
}

export async function getStaleProcessingVideoIds(cutoffIso: string) {
  const db = await getDb();
  const found = await rows(
    db,
    `SELECT id FROM videos
     WHERE status IN ('downloading','transcribing','extracting','analyzing')
       AND COALESCE(NULLIF(processing_started_at, ''), updated_at) < ?
     ORDER BY COALESCE(NULLIF(processing_started_at, ''), updated_at)`,
    [cutoffIso],
  );
  return found.map((item) => String(item.id));
}

// ---- 运维后台专用查询（只读，供 app/admin/* 页面使用） ----

const PROCESSING_STATUSES = ["downloading", "transcribing", "extracting", "analyzing"] as const;

/** Videos currently occupying a queue worker slot, oldest-started first. */
export async function getActiveVideos(limit: number) {
  const db = await getDb();
  const found = await rows(
    db,
    `SELECT v.*, p.name AS product_name FROM videos v JOIN products p ON p.id = v.product_id
     WHERE v.status IN ('downloading','transcribing','extracting','analyzing')
     ORDER BY COALESCE(NULLIF(v.processing_started_at, ''), v.updated_at) ASC
     LIMIT ?`,
    [limit],
  );
  return found.map(videoFromRow);
}

/** Live snapshot of the queue backlog, independent of which day a task was submitted. */
export async function getLiveQueueCounts() {
  const db = await getDb();
  const found = await rows(
    db,
    `SELECT status, COUNT(*) AS count FROM videos
     WHERE status IN ('queued','downloading','transcribing','extracting','analyzing')
     GROUP BY status`,
  );
  const byStatus = Object.fromEntries(found.map((item) => [String(item.status), Number(item.count)]));
  const processing = PROCESSING_STATUSES.reduce((sum, status) => sum + (byStatus[status] || 0), 0);
  return { queued: byStatus.queued || 0, processing };
}

/** Outcomes of tasks submitted today (UTC), by their current status. */
export async function getTodayTaskCounts() {
  const db = await getDb();
  const found = await rows(
    db,
    `SELECT status, COUNT(*) AS count FROM videos
     WHERE SUBSTR(created_at, 1, 10) = SUBSTR(UTC_TIMESTAMP(3), 1, 10)
     GROUP BY status`,
  );
  const byStatus = Object.fromEntries(found.map((item) => [String(item.status), Number(item.count)]));
  return { completed: byStatus.completed || 0, failed: byStatus.failed || 0 };
}

export interface VideoAttemptSummary {
  id: string;
  videoId: string;
  attemptNumber: number;
  status: string;
  errorMessage: string;
  diagnostics: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
}

function videoAttemptFromRow(source: Row): VideoAttemptSummary {
  return {
    id: String(source.id),
    videoId: String(source.video_id),
    attemptNumber: Number(source.attempt_number),
    status: String(source.status),
    errorMessage: String(source.error_message ?? ""),
    diagnostics: json<Record<string, unknown>>(source.diagnostics_json, {}),
    startedAt: String(source.started_at),
    finishedAt: source.finished_at ? String(source.finished_at) : null,
  };
}

/** Most recent videos across all products, for the ops console's task list (not the consumer search/filter path). */
export async function listRecentVideos(options: { search?: string; status?: string; limit?: number; offset?: number } = {}) {
  const { search, status, limit = 100, offset = 0 } = options;
  const db = await getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (search?.trim()) {
    conditions.push("(p.name LIKE ? OR v.source_url LIKE ?)");
    params.push(`%${search.trim()}%`, `%${search.trim()}%`);
  }
  if (status?.trim()) {
    conditions.push("v.status = ?");
    params.push(status.trim());
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const found = await rows(
    db,
    `SELECT v.*, p.name AS product_name FROM videos v JOIN products p ON p.id = v.product_id
     ${where}
     ORDER BY v.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return found.map(videoFromRow);
}

/** Row count for {@link listRecentVideos}'s filters — used by the ops console's pagination. */
export async function countRecentVideos(options: { search?: string; status?: string } = {}) {
  const { search, status } = options;
  const db = await getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (search?.trim()) {
    conditions.push("(p.name LIKE ? OR v.source_url LIKE ?)");
    params.push(`%${search.trim()}%`, `%${search.trim()}%`);
  }
  if (status?.trim()) {
    conditions.push("v.status = ?");
    params.push(status.trim());
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const found = await row(
    db,
    `SELECT COUNT(*) AS total FROM videos v JOIN products p ON p.id = v.product_id ${where}`,
    params,
  );
  return Number(found?.total || 0);
}

/** Full attempt history for one video, most recent first — used by the ops console's diagnostics panel. */
export async function listVideoAttempts(videoId: string) {
  const db = await getDb();
  const found = await rows(
    db,
    `SELECT * FROM video_attempts WHERE video_id=? ORDER BY started_at DESC`,
    [videoId],
  );
  return found.map(videoAttemptFromRow);
}

// ---- Qwen 按用途分别配置模型（full / product_doc / translation） ----

export type QwenPurpose = "full" | "product_doc" | "translation";

export async function getQwenPurposeModel(purpose: QwenPurpose) {
  const db = await getDb();
  const found = await row(db, "SELECT model FROM qwen_purpose_models WHERE purpose=?", [purpose]);
  const value = found?.model ? String(found.model).trim() : "";
  return value || null;
}

export async function listQwenPurposeModels() {
  const db = await getDb();
  const found = await rows(db, "SELECT * FROM qwen_purpose_models");
  const byPurpose = Object.fromEntries(found.map((item) => [String(item.purpose), String(item.model ?? "")]));
  return {
    full: byPurpose.full || "",
    product_doc: byPurpose.product_doc || "",
    translation: byPurpose.translation || "",
  } satisfies Record<QwenPurpose, string>;
}

export async function saveQwenPurposeModel(purpose: QwenPurpose, model: string) {
  const db = await getDb();
  await run(
    db,
    `INSERT INTO qwen_purpose_models (purpose, model, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE model=VALUES(model), updated_at=VALUES(updated_at)`,
    [purpose, model.trim(), now()],
  );
}

// ---- 飞书字段映射：按 scopeKey（通常是 appToken:tableId）持久化覆盖 ----

export interface FeishuFieldMappingConfig {
  scopeKey: string;
  label: string;
  fieldMap: Record<string, string>;
  aliases: Record<string, string[]>;
  updatedAt: string;
}

function feishuFieldMappingFromRow(source: Row): FeishuFieldMappingConfig {
  return {
    scopeKey: String(source.scope_key),
    label: String(source.label ?? ""),
    fieldMap: json<Record<string, string>>(source.field_map_json, {}),
    aliases: json<Record<string, string[]>>(source.aliases_json, {}),
    updatedAt: String(source.updated_at),
  };
}

export async function getFeishuFieldMapping(scopeKey: string) {
  const db = await getDb();
  const found = await row(db, "SELECT * FROM feishu_field_mappings WHERE scope_key=?", [scopeKey]);
  return found ? feishuFieldMappingFromRow(found) : null;
}

export async function listFeishuFieldMappings() {
  const db = await getDb();
  const found = await rows(db, "SELECT * FROM feishu_field_mappings ORDER BY scope_key");
  return found.map(feishuFieldMappingFromRow);
}

export async function saveFeishuFieldMapping(input: {
  scopeKey: string;
  label: string;
  fieldMap: Record<string, string>;
  aliases: Record<string, string[]>;
}) {
  const db = await getDb();
  const timestamp = now();
  await run(
    db,
    `INSERT INTO feishu_field_mappings (scope_key, label, field_map_json, aliases_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE label=VALUES(label), field_map_json=VALUES(field_map_json),
       aliases_json=VALUES(aliases_json), updated_at=VALUES(updated_at)`,
    [input.scopeKey, input.label, JSON.stringify(input.fieldMap), JSON.stringify(input.aliases), timestamp],
  );
  return (await getFeishuFieldMapping(input.scopeKey))!;
}

export async function deleteFeishuFieldMapping(scopeKey: string) {
  const db = await getDb();
  await run(db, "DELETE FROM feishu_field_mappings WHERE scope_key=?", [scopeKey]);
}

// ---- Prompt 调试台：模板（带版本历史）+ 真实请求输入负载 ----
// 用户已明确确认这两组数据不做脱敏，跟 video_attempts.diagnostics_json 的安全限制是两回事。

export interface PromptTemplate {
  slug: string;
  label: string;
  template: string;
  currentVersion: number;
  updatedAt: string;
}

function promptTemplateFromRow(source: Row): PromptTemplate {
  return {
    slug: String(source.slug),
    label: String(source.label),
    template: String(source.template),
    currentVersion: Number(source.current_version),
    updatedAt: String(source.updated_at),
  };
}

/** Read the live template for one prompt slot, seeding it from the hardcoded default on first use. */
export async function getPromptTemplate(slug: string, label: string, defaultTemplate: string): Promise<PromptTemplate> {
  const db = await getDb();
  const timestamp = now();
  await run(
    db,
    `INSERT IGNORE INTO prompt_templates (slug, label, template, current_version, updated_at) VALUES (?, ?, ?, 1, ?)`,
    [slug, label, defaultTemplate, timestamp],
  );
  const found = (await row(db, "SELECT * FROM prompt_templates WHERE slug=?", [slug]))!;
  return promptTemplateFromRow(found);
}

export async function listPromptTemplates() {
  const db = await getDb();
  const found = await rows(db, "SELECT * FROM prompt_templates ORDER BY slug");
  return found.map(promptTemplateFromRow);
}

/** Save an edited template as a new version; the full history stays in prompt_template_versions. */
export async function savePromptTemplate(slug: string, template: string) {
  return withTransaction(async (db) => {
    const current = await row(db, "SELECT current_version FROM prompt_templates WHERE slug=? FOR UPDATE", [slug]);
    const nextVersion = Number(current?.current_version ?? 0) + 1;
    const timestamp = now();
    await run(
      db,
      `INSERT INTO prompt_template_versions (id, slug, version, template, created_at) VALUES (?, ?, ?, ?, ?)`,
      [randomUUID(), slug, nextVersion, template, timestamp],
    );
    await run(
      db,
      `UPDATE prompt_templates SET template=?, current_version=?, updated_at=? WHERE slug=?`,
      [template, nextVersion, timestamp, slug],
    );
    return (await row(db, "SELECT * FROM prompt_templates WHERE slug=?", [slug]))!;
  }).then(promptTemplateFromRow);
}

export interface PromptTemplateVersion {
  version: number;
  template: string;
  createdAt: string;
}

export async function listPromptTemplateVersions(slug: string) {
  const db = await getDb();
  const found = await rows(
    db,
    "SELECT version, template, created_at FROM prompt_template_versions WHERE slug=? ORDER BY version DESC",
    [slug],
  );
  return found.map((item) => ({ version: Number(item.version), template: String(item.template), createdAt: String(item.created_at) }) satisfies PromptTemplateVersion);
}

export interface PromptDebugCapture {
  id: string;
  videoId: string;
  attemptNumber: number;
  templateSlug: string;
  inputs: Record<string, unknown>;
  qwenVideoPath: string | null;
  createdAt: string;
  productName?: string;
}

function promptDebugCaptureFromRow(source: Row): PromptDebugCapture {
  return {
    id: String(source.id),
    videoId: String(source.video_id),
    attemptNumber: Number(source.attempt_number),
    templateSlug: String(source.template_slug),
    inputs: json<Record<string, unknown>>(source.inputs_json, {}),
    qwenVideoPath: source.qwen_video_path ? String(source.qwen_video_path) : null,
    createdAt: String(source.created_at),
    productName: source.product_name ? String(source.product_name) : undefined,
  };
}

/** Best-effort capture of the exact structured inputs behind one real Qwen prompt — never blocks analysis. */
export async function savePromptDebugCapture(input: {
  videoId: string;
  attemptNumber: number;
  templateSlug: string;
  inputs: Record<string, unknown>;
  qwenVideoPath: string | null;
}) {
  const db = await getDb();
  await run(
    db,
    `INSERT INTO prompt_debug_captures (id, video_id, attempt_number, template_slug, inputs_json, qwen_video_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), input.videoId, input.attemptNumber, input.templateSlug, JSON.stringify(input.inputs), input.qwenVideoPath, now()],
  );
}

export async function listPromptDebugCaptures(templateSlug: string, limit = 30) {
  const db = await getDb();
  const found = await rows(
    db,
    `SELECT c.*, p.name AS product_name FROM prompt_debug_captures c
     JOIN videos v ON v.id = c.video_id
     JOIN products p ON p.id = v.product_id
     WHERE c.template_slug=? ORDER BY c.created_at DESC LIMIT ?`,
    [templateSlug, limit],
  );
  return found.map(promptDebugCaptureFromRow);
}

export async function getPromptDebugCapture(id: string) {
  const db = await getDb();
  const found = await row(
    db,
    `SELECT c.*, p.name AS product_name FROM prompt_debug_captures c
     JOIN videos v ON v.id = c.video_id
     JOIN products p ON p.id = v.product_id
     WHERE c.id=?`,
    [id],
  );
  return found ? promptDebugCaptureFromRow(found) : null;
}
