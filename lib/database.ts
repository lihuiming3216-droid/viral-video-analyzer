import "server-only";

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AnalysisResult,
  DashboardPayload,
  ManualLabel,
  Product,
  ProviderName,
  ProviderSetting,
  SceneRecord,
  VideoRecord,
  VideoStatus,
} from "@/lib/types";

const dataRoot = path.join(process.cwd(), ".data");
const dbPath = path.join(dataRoot, "viral-video-analyzer.sqlite");

type DbGlobal = typeof globalThis & { __viralDb?: DatabaseSync };
const dbGlobal = globalThis as DbGlobal;

function now() {
  return new Date().toISOString();
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function numberOrNull(value: unknown) {
  return typeof value === "number" ? value : value == null ? null : Number(value);
}

function sqlValue(value: unknown): string | number | bigint | Uint8Array | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function initialize(db: DatabaseSync) {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pid TEXT NOT NULL DEFAULT '',
      sku TEXT NOT NULL DEFAULT '',
      document_id TEXT,
      document_url TEXT,
      image_path TEXT,
      prop_images_json TEXT NOT NULL DEFAULT '[]',
      category TEXT NOT NULL DEFAULT '',
      market TEXT NOT NULL DEFAULT '',
      price TEXT NOT NULL DEFAULT '',
      selling_points TEXT NOT NULL DEFAULT '',
      target_audience TEXT NOT NULL DEFAULT '',
      pain_points TEXT NOT NULL DEFAULT '',
      competitors TEXT NOT NULL DEFAULT '',
      product_url TEXT NOT NULL DEFAULT '',
      core_functions_json TEXT NOT NULL DEFAULT '[]',
      product_parameters TEXT NOT NULL DEFAULT '',
      usage_method TEXT NOT NULL DEFAULT '',
      usage_scenes TEXT NOT NULL DEFAULT '',
      source_title TEXT NOT NULL DEFAULT '',
      source_description TEXT NOT NULL DEFAULT '',
      source_image_urls_json TEXT NOT NULL DEFAULT '[]',
      visual_evidence TEXT NOT NULL DEFAULT '',
      visual_analysis_status TEXT NOT NULL DEFAULT '',
      visual_analyzed_at TEXT,
      banned_terms TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      source_type TEXT NOT NULL,
      source_url TEXT UNIQUE,
      source_file_name TEXT,
      analysis_mode TEXT NOT NULL DEFAULT 'full',
      title TEXT NOT NULL DEFAULT '',
      account_name TEXT NOT NULL DEFAULT '',
      platform_video_id TEXT,
      language TEXT,
      published_at TEXT,
      duration_seconds REAL,
      original_path TEXT,
      cover_path TEXT,
      remote_video_url TEXT,
      status TEXT NOT NULL DEFAULT 'waiting',
      stage TEXT NOT NULL DEFAULT '等待分析',
      progress INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      score_traffic INTEGER NOT NULL DEFAULT 0,
      score_conversion INTEGER NOT NULL DEFAULT 0,
      score_visual INTEGER NOT NULL DEFAULT 0,
      score_product INTEGER NOT NULL DEFAULT 0,
      score_audio INTEGER NOT NULL DEFAULT 0,
      score_rhythm INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      hook_summary TEXT NOT NULL DEFAULT '',
      manual_label TEXT,
      manual_notes TEXT NOT NULL DEFAULT '',
      view_count INTEGER,
      like_count INTEGER,
      comment_count INTEGER,
      share_count INTEGER,
      favorite_count INTEGER,
      follower_count INTEGER,
      stats_captured_at TEXT,
      transcript_original TEXT NOT NULL DEFAULT '',
      transcript_zh TEXT NOT NULL DEFAULT '',
      transcript_segments_json TEXT NOT NULL DEFAULT '[]',
      analysis_json TEXT,
      provider_payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      shot_index INTEGER NOT NULL,
      start_seconds REAL NOT NULL,
      end_seconds REAL NOT NULL,
      screenshot_path TEXT,
      clip_path TEXT,
      role TEXT NOT NULL DEFAULT '',
      visual_description TEXT NOT NULL DEFAULT '',
      audio_description TEXT NOT NULL DEFAULT '',
      transcript_original TEXT NOT NULL DEFAULT '',
      translation_zh TEXT NOT NULL DEFAULT '',
      strengths TEXT NOT NULL DEFAULT '',
      weaknesses TEXT NOT NULL DEFAULT '',
      importance INTEGER NOT NULL DEFAULT 0,
      score_traffic INTEGER NOT NULL DEFAULT 0,
      score_conversion INTEGER NOT NULL DEFAULT 0,
      score_clarity INTEGER NOT NULL DEFAULT 0,
      score_aesthetic INTEGER NOT NULL DEFAULT 0,
      score_lighting INTEGER NOT NULL DEFAULT 0,
      score_product INTEGER NOT NULL DEFAULT 0,
      tags_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE(video_id, shot_index)
    );

    CREATE TABLE IF NOT EXISTS provider_settings (
      provider TEXT PRIMARY KEY,
      encrypted_api_key TEXT,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_memories (
      video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      category TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT 'unverified',
      evidence_weight REAL NOT NULL DEFAULT 0.35,
      features_json TEXT NOT NULL DEFAULT '{}',
      searchable_text TEXT NOT NULL DEFAULT '',
      source_updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_profiles (
      scope_type TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      labeled_count INTEGER NOT NULL DEFAULT 0,
      positive_count INTEGER NOT NULL DEFAULT 0,
      neutral_count INTEGER NOT NULL DEFAULT 0,
      negative_count INTEGER NOT NULL DEFAULT 0,
      avg_traffic INTEGER NOT NULL DEFAULT 0,
      avg_conversion INTEGER NOT NULL DEFAULT 0,
      confidence INTEGER NOT NULL DEFAULT 0,
      insights_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(scope_type, scope_key)
    );

    CREATE TABLE IF NOT EXISTS feishu_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      app_id TEXT NOT NULL DEFAULT '',
      encrypted_app_secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      public_base_url TEXT NOT NULL DEFAULT 'http://localhost:3000',
      root_folder_token TEXT NOT NULL DEFAULT '',
      root_folder_url TEXT NOT NULL DEFAULT '',
      connection_status TEXT NOT NULL DEFAULT 'disconnected',
      last_error TEXT NOT NULL DEFAULT '',
      connected_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feishu_automation_jobs (
      video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
      app_token TEXT NOT NULL,
      table_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      field_map_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feishu_targets (
      target_id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      sender_open_id TEXT NOT NULL DEFAULT '',
      last_used_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feishu_batches (
      id TEXT PRIMARY KEY,
      source_message_id TEXT UNIQUE,
      chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      sender_open_id TEXT NOT NULL DEFAULT '',
      progress_message_id TEXT,
      total INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feishu_deliveries (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      batch_id TEXT REFERENCES feishu_batches(id) ON DELETE SET NULL,
      chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      sender_open_id TEXT NOT NULL DEFAULT '',
      reply_to_message_id TEXT,
      card_message_id TEXT,
      document_id TEXT,
      document_url TEXT,
      source TEXT NOT NULL DEFAULT 'inbound',
      status TEXT NOT NULL DEFAULT 'queued',
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feishu_documents (
      video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
      report_hash TEXT NOT NULL,
      document_id TEXT NOT NULL,
      document_url TEXT NOT NULL,
      folder_token TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feishu_folders (
      scope_key TEXT PRIMARY KEY,
      folder_token TEXT NOT NULL,
      folder_url TEXT NOT NULL DEFAULT '',
      parent_token TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feishu_events (
      message_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_videos_product_created ON videos(product_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_videos_account_created ON videos(account_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
    CREATE INDEX IF NOT EXISTS idx_videos_published_at ON videos(published_at);
    CREATE INDEX IF NOT EXISTS idx_scenes_video_shot ON scenes(video_id, shot_index);
    CREATE INDEX IF NOT EXISTS idx_learning_memories_product ON learning_memories(product_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_memories_category ON learning_memories(category, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_memories_outcome ON learning_memories(outcome, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feishu_deliveries_video ON feishu_deliveries(video_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feishu_deliveries_batch ON feishu_deliveries(batch_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feishu_deliveries_status ON feishu_deliveries(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feishu_targets_used ON feishu_targets(last_used_at DESC);
  `);

  const productColumns = db.prepare("PRAGMA table_info(products)").all() as Array<Record<string, unknown>>;
  if (!productColumns.some((column) => String(column.name) === "pid")) {
    db.exec("ALTER TABLE products ADD COLUMN pid TEXT NOT NULL DEFAULT ''");
  }
  if (!productColumns.some((column) => String(column.name) === "document_id")) {
    db.exec("ALTER TABLE products ADD COLUMN document_id TEXT");
  }
  if (!productColumns.some((column) => String(column.name) === "sku")) {
    db.exec("ALTER TABLE products ADD COLUMN sku TEXT NOT NULL DEFAULT ''");
  }
  if (!productColumns.some((column) => String(column.name) === "document_url")) {
    db.exec("ALTER TABLE products ADD COLUMN document_url TEXT");
  }
  for (const [name, definition] of [
    ["core_functions_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["product_parameters", "TEXT NOT NULL DEFAULT ''"],
    ["usage_method", "TEXT NOT NULL DEFAULT ''"],
    ["usage_scenes", "TEXT NOT NULL DEFAULT ''"],
    ["source_title", "TEXT NOT NULL DEFAULT ''"],
    ["source_description", "TEXT NOT NULL DEFAULT ''"],
    ["source_image_urls_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["visual_evidence", "TEXT NOT NULL DEFAULT ''"],
    ["visual_analysis_status", "TEXT NOT NULL DEFAULT ''"],
    ["visual_analyzed_at", "TEXT"],
    ["prop_images_json", "TEXT NOT NULL DEFAULT '[]'"],
  ]) {
    if (!productColumns.some((column) => String(column.name) === name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${definition}`);
  }
  const videoColumns = db.prepare("PRAGMA table_info(videos)").all() as Array<Record<string, unknown>>;
  if (!videoColumns.some((column) => String(column.name) === "analysis_mode")) {
    db.exec("ALTER TABLE videos ADD COLUMN analysis_mode TEXT NOT NULL DEFAULT 'full'");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_products_pid ON products(pid)");

  const timestamp = now();
  const providers: Array<[ProviderName, string, string]> = [
    ["tokscript", "https://api.tokscript.com/mcp", ""],
    ["qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3.7-plus"],
  ];
  const insertProvider = db.prepare(
    "INSERT OR IGNORE INTO provider_settings(provider, base_url, model, enabled, updated_at) VALUES (?, ?, ?, 1, ?)",
  );
  providers.forEach(([provider, baseUrl, model]) => insertProvider.run(provider, baseUrl, model, timestamp));
  db.prepare("DELETE FROM provider_settings WHERE provider='openai'").run();

  db.prepare(`INSERT OR IGNORE INTO feishu_settings(
    id, public_base_url, connection_status, updated_at
  ) VALUES (1, 'http://localhost:3000', 'disconnected', ?)`)
    .run(timestamp);

  const sampleProductId = "system-unclassified";
  db.prepare(
    `INSERT OR IGNORE INTO products(
      id, name, category, market, notes, is_system, created_at, updated_at
    ) VALUES (?, '未归类样片', '待整理', '美国', '用于暂存还没有建立产品档案的视频', 1, ?, ?)`,
  ).run(sampleProductId, timestamp, timestamp);

  db.exec("PRAGMA optimize;");
}

export function getDb() {
  if (!dbGlobal.__viralDb) {
    mkdirSync(dataRoot, { recursive: true });
    dbGlobal.__viralDb = new DatabaseSync(dbPath);
    initialize(dbGlobal.__viralDb);
  }
  return dbGlobal.__viralDb;
}

export function saveFeishuAutomationJob(input: {
  videoId: string;
  appToken: string;
  tableId: string;
  recordId: string;
  fieldMap?: Record<string, string>;
}) {
  const timestamp = now();
  getDb().prepare(`INSERT INTO feishu_automation_jobs(
    video_id, app_token, table_id, record_id, field_map_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(video_id) DO UPDATE SET app_token=excluded.app_token, table_id=excluded.table_id,
    record_id=excluded.record_id, field_map_json=excluded.field_map_json, updated_at=excluded.updated_at`)
    .run(input.videoId, input.appToken, input.tableId, input.recordId, JSON.stringify(input.fieldMap || {}), timestamp, timestamp);
}

export function getFeishuAutomationJob(videoId: string) {
  const row = getDb().prepare("SELECT * FROM feishu_automation_jobs WHERE video_id=?").get(videoId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    videoId: String(row.video_id),
    appToken: String(row.app_token),
    tableId: String(row.table_id),
    recordId: String(row.record_id),
    fieldMap: json<Record<string, string>>(row.field_map_json, {}),
  };
}

export function deleteFeishuAutomationJob(videoId: string) {
  getDb().prepare("DELETE FROM feishu_automation_jobs WHERE video_id=?").run(videoId);
}

function productFromRow(row: Record<string, unknown>): Product {
  return {
    id: String(row.id),
    name: String(row.name),
    pid: String(row.pid ?? ""),
    sku: String(row.sku ?? ""),
    documentId: row.document_id ? String(row.document_id) : null,
    documentUrl: row.document_url ? String(row.document_url) : null,
    imagePath: row.image_path ? String(row.image_path) : null,
    propImages: json<string[]>(row.prop_images_json, []),
    category: String(row.category ?? ""),
    market: String(row.market ?? ""),
    price: String(row.price ?? ""),
    sellingPoints: String(row.selling_points ?? ""),
    targetAudience: String(row.target_audience ?? ""),
    painPoints: String(row.pain_points ?? ""),
    competitors: String(row.competitors ?? ""),
    productUrl: String(row.product_url ?? ""),
    coreFunctions: json<string[]>(row.core_functions_json, []),
    productParameters: String(row.product_parameters ?? ""),
    usageMethod: String(row.usage_method ?? ""),
    usageScenes: String(row.usage_scenes ?? ""),
    sourceTitle: String(row.source_title ?? ""),
    sourceDescription: String(row.source_description ?? ""),
    sourceImageUrls: json<string[]>(row.source_image_urls_json, []),
    visualEvidence: String(row.visual_evidence ?? ""),
    visualAnalysisStatus: (["completed", "unavailable"].includes(String(row.visual_analysis_status))
      ? String(row.visual_analysis_status)
      : "") as Product["visualAnalysisStatus"],
    visualAnalyzedAt: row.visual_analyzed_at ? String(row.visual_analyzed_at) : null,
    bannedTerms: String(row.banned_terms ?? ""),
    notes: String(row.notes ?? ""),
    isSystem: Boolean(row.is_system),
    videoCount: Number(row.video_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function videoFromRow(row: Record<string, unknown>): VideoRecord {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    productName: String(row.product_name ?? ""),
    sourceType: row.source_type === "upload" ? "upload" : "tiktok",
    sourceUrl: row.source_url ? String(row.source_url) : null,
    sourceFileName: row.source_file_name ? String(row.source_file_name) : null,
    title: String(row.title ?? ""),
    accountName: String(row.account_name ?? ""),
    platformVideoId: row.platform_video_id ? String(row.platform_video_id) : null,
    language: row.language ? String(row.language) : null,
    publishedAt: row.published_at ? String(row.published_at) : null,
    durationSeconds: numberOrNull(row.duration_seconds),
    originalPath: row.original_path ? String(row.original_path) : null,
    coverPath: row.cover_path ? String(row.cover_path) : null,
    remoteVideoUrl: row.remote_video_url ? String(row.remote_video_url) : null,
    status: String(row.status) as VideoStatus,
    stage: String(row.stage ?? ""),
    progress: Number(row.progress ?? 0),
    errorMessage: row.error_message ? String(row.error_message) : null,
    scores: {
      traffic: Number(row.score_traffic ?? 0),
      conversion: Number(row.score_conversion ?? 0),
      visual: Number(row.score_visual ?? 0),
      product: Number(row.score_product ?? 0),
      audio: Number(row.score_audio ?? 0),
      rhythm: Number(row.score_rhythm ?? 0),
    },
    summary: String(row.summary ?? ""),
    hookSummary: String(row.hook_summary ?? ""),
    manualLabel: (row.manual_label ? String(row.manual_label) : null) as ManualLabel,
    manualNotes: String(row.manual_notes ?? ""),
    viewCount: numberOrNull(row.view_count),
    likeCount: numberOrNull(row.like_count),
    commentCount: numberOrNull(row.comment_count),
    shareCount: numberOrNull(row.share_count),
    favoriteCount: numberOrNull(row.favorite_count),
    followerCount: numberOrNull(row.follower_count),
    statsCapturedAt: row.stats_captured_at ? String(row.stats_captured_at) : null,
    transcriptOriginal: String(row.transcript_original ?? ""),
    transcriptZh: String(row.transcript_zh ?? ""),
    analysis: json<AnalysisResult | null>(row.analysis_json, null),
    analysisMode: row.analysis_mode === "product_doc" ? "product_doc" : "full",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function sceneFromRow(row: Record<string, unknown>): SceneRecord {
  return {
    id: String(row.id),
    videoId: String(row.video_id),
    shotIndex: Number(row.shot_index),
    startSeconds: Number(row.start_seconds),
    endSeconds: Number(row.end_seconds),
    screenshotPath: row.screenshot_path ? String(row.screenshot_path) : null,
    clipPath: row.clip_path ? String(row.clip_path) : null,
    role: String(row.role ?? ""),
    visualDescription: String(row.visual_description ?? ""),
    audioDescription: String(row.audio_description ?? ""),
    transcriptOriginal: String(row.transcript_original ?? ""),
    translationZh: String(row.translation_zh ?? ""),
    strengths: String(row.strengths ?? ""),
    weaknesses: String(row.weaknesses ?? ""),
    importance: Number(row.importance ?? 0),
    scoreTraffic: Number(row.score_traffic ?? 0),
    scoreConversion: Number(row.score_conversion ?? 0),
    scoreClarity: Number(row.score_clarity ?? 0),
    scoreAesthetic: Number(row.score_aesthetic ?? 0),
    scoreLighting: Number(row.score_lighting ?? 0),
    scoreProduct: Number(row.score_product ?? 0),
    tags: json<string[]>(row.tags_json, []),
  };
}

export function listProducts() {
  return getDb()
    .prepare(`SELECT p.*, COUNT(v.id) AS video_count FROM products p
      LEFT JOIN videos v ON v.product_id = p.id
      GROUP BY p.id ORDER BY p.is_system ASC, p.updated_at DESC`)
    .all()
    .map((row) => productFromRow(row as Record<string, unknown>));
}

export function createProduct(input: Partial<Product>) {
  const id = randomUUID();
  const timestamp = now();
  getDb()
    .prepare(`INSERT INTO products(
      id, name, pid, sku, document_id, document_url, image_path, prop_images_json, category, market, price, selling_points, target_audience,
      pain_points, competitors, product_url, source_image_urls_json, visual_evidence, visual_analysis_status, visual_analyzed_at,
      banned_terms, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
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
    );
  return getProduct(id)!;
}

export function getProduct(id: string) {
  const row = getDb()
    .prepare(`SELECT p.*, COUNT(v.id) AS video_count FROM products p
      LEFT JOIN videos v ON v.product_id = p.id WHERE p.id = ? GROUP BY p.id`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? productFromRow(row) : null;
}

export function getProductByPid(pid: string) {
  const normalized = pid.trim();
  if (!normalized) return null;
  const row = getDb()
    .prepare(`SELECT p.*, COUNT(v.id) AS video_count FROM products p
      LEFT JOIN videos v ON v.product_id = p.id WHERE lower(p.pid) = lower(?) GROUP BY p.id LIMIT 1`)
    .get(normalized) as Record<string, unknown> | undefined;
  return row ? productFromRow(row) : null;
}

export function updateProduct(id: string, input: Partial<Product>) {
  const current = getProduct(id);
  if (!current) return null;
  getDb()
    .prepare(`UPDATE products SET name=?, pid=?, sku=?, document_id=?, document_url=?, image_path=?, prop_images_json=?, category=?, market=?, price=?, selling_points=?,
      target_audience=?, pain_points=?, competitors=?, product_url=?, banned_terms=?, notes=?,
      core_functions_json=?, product_parameters=?, usage_method=?, usage_scenes=?, source_title=?, source_description=?,
      source_image_urls_json=?, visual_evidence=?, visual_analysis_status=?, visual_analyzed_at=?, updated_at=? WHERE id=?`)
    .run(
      input.name ?? current.name,
      input.pid?.trim() ?? current.pid,
      input.sku ?? current.sku,
      input.documentId ?? current.documentId,
      input.documentUrl ?? current.documentUrl,
      input.imagePath ?? current.imagePath,
      JSON.stringify(input.propImages ?? current.propImages),
      input.category ?? current.category,
      input.market ?? current.market,
      input.price ?? current.price,
      input.sellingPoints ?? current.sellingPoints,
      input.targetAudience ?? current.targetAudience,
      input.painPoints ?? current.painPoints,
      input.competitors ?? current.competitors,
      input.productUrl ?? current.productUrl,
      input.bannedTerms ?? current.bannedTerms,
      input.notes ?? current.notes,
      JSON.stringify(input.coreFunctions ?? current.coreFunctions),
      input.productParameters ?? current.productParameters,
      input.usageMethod ?? current.usageMethod,
      input.usageScenes ?? current.usageScenes,
      input.sourceTitle ?? current.sourceTitle,
      input.sourceDescription ?? current.sourceDescription,
      JSON.stringify(input.sourceImageUrls ?? current.sourceImageUrls),
      input.visualEvidence ?? current.visualEvidence,
      input.visualAnalysisStatus ?? current.visualAnalysisStatus,
      input.visualAnalyzedAt === undefined ? current.visualAnalyzedAt : input.visualAnalyzedAt,
      now(),
      id,
    );
  return getProduct(id);
}

export function listVideos(filters: { search?: string; productId?: string; account?: string; date?: string } = {}) {
  const clauses = ["1=1"];
  const params: Array<string> = [];
  if (filters.productId) {
    clauses.push("v.product_id = ?");
    params.push(filters.productId);
  }
  if (filters.account) {
    clauses.push("v.account_name = ?");
    params.push(filters.account);
  }
  if (filters.date) {
    clauses.push("substr(COALESCE(v.published_at, v.created_at), 1, 10) = ?");
    params.push(filters.date);
  }
  if (filters.search) {
    clauses.push("(v.title LIKE ? OR v.account_name LIKE ? OR p.name LIKE ? OR p.pid LIKE ? OR v.transcript_original LIKE ? OR v.transcript_zh LIKE ?)");
    const term = `%${filters.search}%`;
    params.push(term, term, term, term, term, term);
  }
  return getDb()
    .prepare(`SELECT v.*, p.name AS product_name FROM videos v
      JOIN products p ON p.id = v.product_id
      WHERE ${clauses.join(" AND ")} ORDER BY v.created_at DESC`)
    .all(...params)
    .map((row) => videoFromRow(row as Record<string, unknown>));
}

export function getVideoBySourceUrl(sourceUrl: string) {
  const normalized = sourceUrl.trim();
  if (!normalized) return null;
  const row = getDb()
    .prepare("SELECT v.*, p.name AS product_name FROM videos v JOIN products p ON p.id=v.product_id WHERE v.source_url=?")
    .get(normalized) as Record<string, unknown> | undefined;
  return row ? videoFromRow(row) : null;
}

export function getVideo(id: string, withScenes = true) {
  const row = getDb()
    .prepare("SELECT v.*, p.name AS product_name FROM videos v JOIN products p ON p.id=v.product_id WHERE v.id=?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const video = videoFromRow(row);
  if (withScenes) {
    video.scenes = getDb()
      .prepare("SELECT * FROM scenes WHERE video_id=? ORDER BY shot_index")
      .all(id)
      .map((scene) => sceneFromRow(scene as Record<string, unknown>));
  }
  return video;
}

export function createVideo(input: {
  productId: string;
  sourceType: "tiktok" | "upload";
  sourceUrl?: string | null;
  sourceFileName?: string | null;
  analysisMode?: "full" | "product_doc";
  originalPath?: string | null;
  title?: string;
}) {
  const id = randomUUID();
  const timestamp = now();
  getDb()
    .prepare(`INSERT INTO videos(
      id, product_id, source_type, source_url, source_file_name, analysis_mode, original_path, title,
      status, stage, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', '已加入队列', ?, ?)`)
    .run(
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
    );
  return getVideo(id)!;
}

export function updateVideo(id: string, values: Record<string, unknown>) {
  const allowed = new Set([
    "product_id", "title", "account_name", "platform_video_id", "language", "published_at",
    "analysis_mode",
    "duration_seconds", "original_path", "cover_path", "remote_video_url", "status", "stage", "progress",
    "error_message", "score_traffic", "score_conversion", "score_visual", "score_product", "score_audio",
    "score_rhythm", "summary", "hook_summary", "manual_label", "manual_notes", "view_count", "like_count",
    "comment_count", "share_count", "favorite_count", "follower_count", "stats_captured_at",
    "transcript_original", "transcript_zh", "transcript_segments_json", "analysis_json", "provider_payload_json",
  ]);
  const entries = Object.entries(values).filter(([key]) => allowed.has(key));
  if (!entries.length) return getVideo(id);
  entries.push(["updated_at", now()]);
  getDb()
    .prepare(`UPDATE videos SET ${entries.map(([key]) => `${key}=?`).join(", ")} WHERE id=?`)
    .run(...entries.map(([, value]) => sqlValue(value)), id);
  return getVideo(id);
}

export function deleteVideoRecord(id: string) {
  const result = getDb().prepare("DELETE FROM videos WHERE id=?").run(id);
  return result.changes > 0;
}

export function replaceScenes(videoId: string, scenes: Array<Omit<SceneRecord, "id" | "videoId">>) {
  const db = getDb();
  db.prepare("DELETE FROM scenes WHERE video_id=?").run(videoId);
  const insert = db.prepare(`INSERT INTO scenes(
    id, video_id, shot_index, start_seconds, end_seconds, screenshot_path, clip_path, role,
    visual_description, audio_description, transcript_original, translation_zh, strengths, weaknesses,
    importance, score_traffic, score_conversion, score_clarity, score_aesthetic, score_lighting,
    score_product, tags_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const scene of scenes) {
    insert.run(
      randomUUID(), videoId, scene.shotIndex, scene.startSeconds, scene.endSeconds,
      scene.screenshotPath, scene.clipPath, scene.role, scene.visualDescription, scene.audioDescription,
      scene.transcriptOriginal, scene.translationZh, scene.strengths, scene.weaknesses, scene.importance,
      scene.scoreTraffic, scene.scoreConversion, scene.scoreClarity, scene.scoreAesthetic,
      scene.scoreLighting, scene.scoreProduct, JSON.stringify(scene.tags),
    );
  }
  return getVideo(videoId);
}

export function getRawProviderSetting(provider: ProviderName) {
  return getDb().prepare("SELECT * FROM provider_settings WHERE provider=?").get(provider) as
    | Record<string, unknown>
    | undefined;
}

export function listProviderSettings(): ProviderSetting[] {
  return getDb()
    .prepare("SELECT * FROM provider_settings ORDER BY provider")
    .all()
    .map((row) => {
      const item = row as Record<string, unknown>;
      return {
        provider: String(item.provider) as ProviderName,
        hasKey: Boolean(item.encrypted_api_key),
        baseUrl: String(item.base_url),
        model: String(item.model ?? ""),
        enabled: Boolean(item.enabled),
        updatedAt: String(item.updated_at),
      };
    });
}

export function saveProviderSetting(input: {
  provider: ProviderName;
  encryptedApiKey?: string | null;
  baseUrl: string;
  model?: string;
  enabled: boolean;
}) {
  const current = getRawProviderSetting(input.provider);
  const encrypted = input.encryptedApiKey === undefined
    ? current?.encrypted_api_key ? String(current.encrypted_api_key) : null
    : input.encryptedApiKey;
  getDb()
    .prepare(`UPDATE provider_settings SET encrypted_api_key=?, base_url=?, model=?, enabled=?, updated_at=? WHERE provider=?`)
    .run(encrypted, input.baseUrl, input.model || "", input.enabled ? 1 : 0, now(), input.provider);
  return listProviderSettings().find((item) => item.provider === input.provider)!;
}

export function getDashboard(filters: Parameters<typeof listVideos>[0] = {}): DashboardPayload {
  const products = listProducts();
  const videos = listVideos(filters);
  const completed = videos.filter((video) => video.status === "completed");
  const processing = videos.filter((video) => !["completed", "failed", "waiting"].includes(video.status));
  const average = (key: "traffic" | "conversion") =>
    completed.length ? Math.round(completed.reduce((sum, video) => sum + video.scores[key], 0) / completed.length) : 0;
  return {
    products,
    videos,
    providers: listProviderSettings(),
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

export function getPendingVideoIds() {
  return getDb()
    .prepare("SELECT id FROM videos WHERE status IN ('queued','downloading','transcribing','extracting','analyzing') ORDER BY created_at")
    .all()
    .map((row) => String((row as Record<string, unknown>).id));
}
