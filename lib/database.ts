import "server-only";

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
      verified_pid TEXT NOT NULL DEFAULT '',
      verified_source_url TEXT NOT NULL DEFAULT '',
      evidence_version TEXT NOT NULL DEFAULT '',
      facts_verified_at TEXT NOT NULL DEFAULT '',
      fact_provenance_json TEXT NOT NULL DEFAULT '{}',
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
      source_url TEXT,
      source_file_name TEXT,
      analysis_mode TEXT NOT NULL DEFAULT 'full',
      product_doc_failure_delivered INTEGER NOT NULL DEFAULT 0,
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
      processing_started_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
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
      product_folder_token TEXT NOT NULL DEFAULT '',
      product_folder_url TEXT NOT NULL DEFAULT '',
      connection_status TEXT NOT NULL DEFAULT 'disconnected',
      last_error TEXT NOT NULL DEFAULT '',
      connected_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feishu_automation_jobs (
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      app_token TEXT NOT NULL,
      table_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      field_map_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(video_id, app_token, table_id, record_id)
    );

    CREATE INDEX IF NOT EXISTS idx_feishu_automation_jobs_row
      ON feishu_automation_jobs(app_token, table_id, record_id, updated_at);

    CREATE TABLE IF NOT EXISTS product_document_video_rows (
      document_id TEXT NOT NULL,
      link_block_id TEXT NOT NULL,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL,
      video_id TEXT NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(document_id, link_block_id)
    );

    CREATE INDEX IF NOT EXISTS idx_product_document_video_rows_product_url
      ON product_document_video_rows(product_id, source_url, updated_at DESC);

    CREATE TABLE IF NOT EXISTS product_document_video_scan_state (
      document_id TEXT PRIMARY KEY,
      initialized_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feishu_product_card_mappings (
      app_token TEXT NOT NULL,
      table_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
      document_id TEXT,
      document_url TEXT,
      last_product_pid TEXT NOT NULL DEFAULT '',
      last_product_url TEXT NOT NULL DEFAULT '',
      last_product_name TEXT NOT NULL DEFAULT '',
      managed_product_pid TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(app_token, table_id, record_id)
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
    ["verified_pid", "TEXT NOT NULL DEFAULT ''"],
    ["verified_source_url", "TEXT NOT NULL DEFAULT ''"],
    ["evidence_version", "TEXT NOT NULL DEFAULT ''"],
    ["facts_verified_at", "TEXT NOT NULL DEFAULT ''"],
    ["fact_provenance_json", "TEXT NOT NULL DEFAULT '{}'"],
    ["prop_images_json", "TEXT NOT NULL DEFAULT '[]'"],
  ]) {
    if (!productColumns.some((column) => String(column.name) === name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${definition}`);
  }
  const videoColumns = db.prepare("PRAGMA table_info(videos)").all() as Array<Record<string, unknown>>;
  if (!videoColumns.some((column) => String(column.name) === "analysis_mode")) {
    db.exec("ALTER TABLE videos ADD COLUMN analysis_mode TEXT NOT NULL DEFAULT 'full'");
  }
  if (!videoColumns.some((column) => String(column.name) === "product_doc_retry_count")) {
    db.exec("ALTER TABLE videos ADD COLUMN product_doc_retry_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!videoColumns.some((column) => String(column.name) === "product_doc_failure_delivered")) {
    db.exec("ALTER TABLE videos ADD COLUMN product_doc_failure_delivered INTEGER NOT NULL DEFAULT 0");
  }
  if (!videoColumns.some((column) => String(column.name) === "processing_started_at")) {
    db.exec("ALTER TABLE videos ADD COLUMN processing_started_at TEXT");
  }
  if (!videoColumns.some((column) => String(column.name) === "attempt_count")) {
    db.exec("ALTER TABLE videos ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0");
  }

  // Older databases made source_url globally unique. A repeated submission is
  // a new task with its own timeout, error history and result, so rebuild the
  // table once without that legacy constraint. Foreign-key rows keep referring
  // to the same video ids throughout the in-place migration.
  const sourceUrlUniqueIndex = (db.prepare("PRAGMA index_list(videos)").all() as Array<Record<string, unknown>>)
    .find((index) => {
      if (!Number(index.unique)) return false;
      const columns = db.prepare(`PRAGMA index_info(${JSON.stringify(String(index.name))})`).all() as Array<Record<string, unknown>>;
      return columns.length === 1 && String(columns[0]?.name) === "source_url";
    });
  if (sourceUrlUniqueIndex) {
    const columns = (db.prepare("PRAGMA table_info(videos)").all() as Array<Record<string, unknown>>)
      .map((column) => String(column.name));
    const columnList = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(", ");
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE videos_next (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
          source_type TEXT NOT NULL,
          source_url TEXT,
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
          product_doc_retry_count INTEGER NOT NULL DEFAULT 0,
          product_doc_failure_delivered INTEGER NOT NULL DEFAULT 0,
          processing_started_at TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO videos_next (${columnList}) SELECT ${columnList} FROM videos;
        DROP TABLE videos;
        ALTER TABLE videos_next RENAME TO videos;
        COMMIT;
      `);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_videos_product_created ON videos(product_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_videos_account_created ON videos(account_name, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
      CREATE INDEX IF NOT EXISTS idx_videos_published_at ON videos(published_at);
      CREATE INDEX IF NOT EXISTS idx_videos_source_url ON videos(source_url, created_at DESC);
    `);
  } else {
    db.exec("CREATE INDEX IF NOT EXISTS idx_videos_source_url ON videos(source_url, created_at DESC)");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS video_attempts (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT NOT NULL DEFAULT '',
      diagnostics_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_video_attempts_video_started
      ON video_attempts(video_id, started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_attempts_video_number
      ON video_attempts(video_id, attempt_number);
  `);
  const videoAttemptColumns = db.prepare("PRAGMA table_info(video_attempts)").all() as Array<Record<string, unknown>>;
  if (!videoAttemptColumns.some((column) => String(column.name) === "diagnostics_json")) {
    db.exec("ALTER TABLE video_attempts ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '{}'");
  }
  const feishuSettingsColumns = db.prepare("PRAGMA table_info(feishu_settings)").all() as Array<Record<string, unknown>>;
  for (const [name, definition] of [
    ["product_folder_token", "TEXT NOT NULL DEFAULT ''"],
    ["product_folder_url", "TEXT NOT NULL DEFAULT ''"],
  ]) {
    if (!feishuSettingsColumns.some((column) => String(column.name) === name)) {
      db.exec(`ALTER TABLE feishu_settings ADD COLUMN ${name} ${definition}`);
    }
  }
  // The first automation-job schema used video_id as its sole primary key.
  // That silently replaced the previous Base row whenever the same video URL
  // was submitted from another row. Rebuild it with a per-row delivery key;
  // the INSERT preserves every legacy pending job during an in-place upgrade.
  const automationJobColumns = db.prepare("PRAGMA table_info(feishu_automation_jobs)").all() as Array<Record<string, unknown>>;
  const automationJobPrimaryKey = automationJobColumns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => String(column.name));
  if (automationJobPrimaryKey.join(",") !== "video_id,app_token,table_id,record_id") {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE feishu_automation_jobs_next (
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        app_token TEXT NOT NULL,
        table_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        field_map_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(video_id, app_token, table_id, record_id)
      );
      INSERT OR IGNORE INTO feishu_automation_jobs_next(
        video_id, app_token, table_id, record_id, field_map_json, created_at, updated_at
      )
      SELECT video_id, app_token, table_id, record_id, field_map_json, created_at, updated_at
      FROM feishu_automation_jobs;
      DROP TABLE feishu_automation_jobs;
      ALTER TABLE feishu_automation_jobs_next RENAME TO feishu_automation_jobs;
      COMMIT;
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_feishu_automation_jobs_video
      ON feishu_automation_jobs(video_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_feishu_automation_jobs_row
      ON feishu_automation_jobs(app_token, table_id, record_id, updated_at);
  `);
  // Older installations do not have this mapping table. CREATE TABLE above
  // handles that case; the column migration also tolerates an early/partial
  // schema so upgrading never loses an already-associated document.
  const productCardMappingColumns = db.prepare("PRAGMA table_info(feishu_product_card_mappings)").all() as Array<Record<string, unknown>>;
  for (const [name, definition] of [
    ["product_id", "TEXT REFERENCES products(id) ON DELETE SET NULL"],
    ["document_id", "TEXT"],
    ["document_url", "TEXT"],
    ["last_product_pid", "TEXT NOT NULL DEFAULT ''"],
    ["last_product_url", "TEXT NOT NULL DEFAULT ''"],
    ["last_product_name", "TEXT NOT NULL DEFAULT ''"],
    ["managed_product_pid", "TEXT NOT NULL DEFAULT ''"],
    ["created_at", "TEXT NOT NULL DEFAULT ''"],
    ["updated_at", "TEXT NOT NULL DEFAULT ''"],
  ]) {
    if (!productCardMappingColumns.some((column) => String(column.name) === name)) {
      db.exec(`ALTER TABLE feishu_product_card_mappings ADD COLUMN ${name} ${definition}`);
    }
  }
  const mappingTimestamp = now();
  db.prepare(`UPDATE feishu_product_card_mappings
    SET created_at=CASE WHEN COALESCE(created_at, '')='' THEN ? ELSE created_at END,
        updated_at=CASE WHEN COALESCE(updated_at, '')='' THEN ? ELSE updated_at END
    WHERE COALESCE(created_at, '')='' OR COALESCE(updated_at, '')=''`)
    .run(mappingTimestamp, mappingTimestamp);
  db.exec(`
    DROP INDEX IF EXISTS idx_feishu_product_card_mapping_document;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_product_card_mapping_row
      ON feishu_product_card_mappings(app_token, table_id, record_id);
    CREATE INDEX IF NOT EXISTS idx_feishu_product_card_mapping_document
      ON feishu_product_card_mappings(document_id);
    CREATE INDEX IF NOT EXISTS idx_feishu_product_card_mapping_product
      ON feishu_product_card_mappings(product_id);
    CREATE INDEX IF NOT EXISTS idx_feishu_product_card_mapping_pid
      ON feishu_product_card_mappings(last_product_pid);
  `);
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

function requiredMappingKey(value: unknown, label: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`缺少飞书产品手卡映射${label}`);
  return normalized;
}

function nullableMappingValue(value: string | null | undefined) {
  if (value == null) return null;
  return value.trim() || null;
}

function productCardMappingFromRow(row: Record<string, unknown>): FeishuProductCardMapping {
  return {
    appToken: String(row.app_token),
    tableId: String(row.table_id),
    recordId: String(row.record_id),
    productId: row.product_id ? String(row.product_id) : null,
    documentId: row.document_id ? String(row.document_id) : null,
    documentUrl: row.document_url ? String(row.document_url) : null,
    lastProductPid: String(row.last_product_pid || ""),
    lastProductUrl: String(row.last_product_url || ""),
    lastProductName: String(row.last_product_name || ""),
    managedProductPid: String(row.managed_product_pid || ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function getFeishuProductCardMapping(key: FeishuProductCardMappingKey) {
  const appToken = requiredMappingKey(key.appToken, " App Token");
  const tableId = requiredMappingKey(key.tableId, " Table ID");
  const recordId = requiredMappingKey(key.recordId, " Record ID");
  const row = getDb().prepare(`SELECT * FROM feishu_product_card_mappings
    WHERE app_token=? AND table_id=? AND record_id=?`)
    .get(appToken, tableId, recordId) as Record<string, unknown> | undefined;
  return row ? productCardMappingFromRow(row) : null;
}

/** All row-owned product-card documents currently bound to one internal product. */
export function listFeishuProductCardMappingsByProductId(productId: string) {
  const normalized = productId.trim();
  if (!normalized) return [];
  const rows = getDb().prepare(`SELECT * FROM feishu_product_card_mappings
    WHERE product_id=? AND document_id IS NOT NULL AND TRIM(document_id)<>''
    ORDER BY created_at, app_token, table_id, record_id`)
    .all(normalized) as Array<Record<string, unknown>>;
  return rows.map(productCardMappingFromRow);
}

export function upsertFeishuProductCardMapping(
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
  getDb().prepare(`INSERT INTO feishu_product_card_mappings(
      app_token, table_id, record_id, product_id, document_id, document_url,
      last_product_pid, last_product_url, last_product_name, managed_product_pid, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(app_token, table_id, record_id) DO UPDATE SET
      product_id=CASE WHEN ?=1 THEN excluded.product_id ELSE feishu_product_card_mappings.product_id END,
      document_id=CASE WHEN ?=1 THEN excluded.document_id ELSE feishu_product_card_mappings.document_id END,
      document_url=CASE WHEN ?=1 THEN excluded.document_url ELSE feishu_product_card_mappings.document_url END,
      last_product_pid=CASE WHEN ?=1 THEN excluded.last_product_pid ELSE feishu_product_card_mappings.last_product_pid END,
      last_product_url=CASE WHEN ?=1 THEN excluded.last_product_url ELSE feishu_product_card_mappings.last_product_url END,
      last_product_name=CASE WHEN ?=1 THEN excluded.last_product_name ELSE feishu_product_card_mappings.last_product_name END,
      managed_product_pid=CASE WHEN ?=1 THEN excluded.managed_product_pid ELSE feishu_product_card_mappings.managed_product_pid END,
      updated_at=excluded.updated_at`)
    .run(
      appToken, tableId, recordId, productId, documentId, documentUrl,
      lastProductPid, lastProductUrl, lastProductName, managedProductPid, timestamp, timestamp,
      input.productId !== undefined ? 1 : 0,
      input.documentId !== undefined ? 1 : 0,
      input.documentUrl !== undefined ? 1 : 0,
      input.lastProductPid !== undefined ? 1 : 0,
      input.lastProductUrl !== undefined ? 1 : 0,
      input.lastProductName !== undefined ? 1 : 0,
      input.managedProductPid !== undefined ? 1 : 0,
    );
  return getFeishuProductCardMapping({ appToken, tableId, recordId })!;
}

export function claimFeishuProductCardDocument(
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
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare(`SELECT document_id FROM feishu_product_card_mappings
      WHERE app_token=? AND table_id=? AND record_id=?`)
      .get(appToken, tableId, recordId) as Record<string, unknown> | undefined;
    const timestamp = now();
    if (current) {
      db.prepare(`UPDATE feishu_product_card_mappings
        SET document_id=?, document_url=?, updated_at=?
        WHERE app_token=? AND table_id=? AND record_id=?`)
        .run(documentId, documentUrl, timestamp, appToken, tableId, recordId);
    } else {
      db.prepare(`INSERT INTO feishu_product_card_mappings(
        app_token, table_id, record_id, document_id, document_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(appToken, tableId, recordId, documentId, documentUrl, timestamp, timestamp);
    }
    db.exec("COMMIT");
    return true;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the transaction has already ended */ }
    throw error;
  }
}

export interface FeishuAutomationJobKey {
  videoId: string;
  appToken: string;
  tableId: string;
  recordId: string;
}

export interface FeishuAutomationJob extends FeishuAutomationJobKey {
  fieldMap: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

const feishuAutomationFieldMapKeys = new Set([
  "productUrl", "pid", "productName", "productDocument", "productCardStatus",
  "videoUrl", "analysis", "translation", "status",
]);

function safeFeishuAutomationFieldMap(value: Record<string, string> | undefined) {
  return Object.fromEntries(Object.entries(value || {}).filter(([key, fieldName]) => (
    feishuAutomationFieldMapKeys.has(key)
    && typeof fieldName === "string"
    && fieldName.trim().length > 0
  )).map(([key, fieldName]) => [key, fieldName.trim()]));
}

function feishuAutomationJobFromRow(row: Record<string, unknown>): FeishuAutomationJob {
  return {
    videoId: String(row.video_id),
    appToken: String(row.app_token),
    tableId: String(row.table_id),
    recordId: String(row.record_id),
    fieldMap: json<Record<string, string>>(row.field_map_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function saveFeishuAutomationJob(input: {
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
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    // A Base row has exactly one current delivery generation. A later click
    // supersedes every older task for that row, while the same video may still
    // deliver independently to other Base rows.
    db.prepare(`DELETE FROM feishu_automation_jobs
      WHERE app_token=? AND table_id=? AND record_id=? AND video_id<>?`)
      .run(appToken, tableId, recordId, videoId);
    db.prepare(`INSERT INTO feishu_automation_jobs(
      video_id, app_token, table_id, record_id, field_map_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id, app_token, table_id, record_id) DO UPDATE SET
      field_map_json=excluded.field_map_json, updated_at=excluded.updated_at`)
      .run(
        videoId, appToken, tableId, recordId,
        JSON.stringify(safeFeishuAutomationFieldMap(input.fieldMap)), timestamp, timestamp,
      );
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

export function getFeishuAutomationJob(videoId: string) {
  return getFeishuAutomationJobs(videoId)[0] || null;
}

export function getFeishuAutomationJobs(videoId: string) {
  const rows = getDb().prepare(`SELECT * FROM feishu_automation_jobs
    WHERE video_id=? ORDER BY created_at, app_token, table_id, record_id`)
    .all(videoId) as Array<Record<string, unknown>>;
  return rows.map(feishuAutomationJobFromRow);
}

export function listFeishuAutomationJobVideoIds() {
  const rows = getDb().prepare(`SELECT video_id, MIN(created_at) AS first_created_at
    FROM feishu_automation_jobs
    GROUP BY video_id
    ORDER BY first_created_at, video_id`).all() as Array<Record<string, unknown>>;
  return rows.map((row) => String(row.video_id));
}

export function deleteFeishuAutomationJob(key: FeishuAutomationJobKey | string) {
  if (typeof key === "string") {
    // Kept for callers from older builds. New completion code always passes a
    // composite key so one successful row cannot delete another pending row.
    return getDb().prepare("DELETE FROM feishu_automation_jobs WHERE video_id=?").run(key);
  }
  return getDb().prepare(`DELETE FROM feishu_automation_jobs
    WHERE video_id=? AND app_token=? AND table_id=? AND record_id=?`)
    .run(key.videoId, key.appToken, key.tableId, key.recordId);
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
    verifiedPid: String(row.verified_pid ?? ""),
    verifiedSourceUrl: String(row.verified_source_url ?? ""),
    evidenceVersion: String(row.evidence_version ?? ""),
    factsVerifiedAt: String(row.facts_verified_at ?? ""),
    factProvenance: json<ProductFactProvenance>(row.fact_provenance_json, {}),
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
    productDocRetryCount: Number(row.product_doc_retry_count ?? 0),
    productDocFailureDelivered: Boolean(Number(row.product_doc_failure_delivered ?? 0)),
    processingStartedAt: row.processing_started_at ? String(row.processing_started_at) : null,
    attemptCount: Number(row.attempt_count ?? 0),
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
  const nextPid = input.pid?.trim() ?? current.pid;
  const pidChanged = nextPid !== current.pid;
  const verifiedFactWasWritten = [
    "sku", "coreFunctions", "productParameters", "usageMethod", "targetAudience",
    "usageScenes", "sourceTitle", "sourceDescription", "sourceImageUrls",
    "visualEvidence", "visualAnalysisStatus", "visualAnalyzedAt", "factProvenance",
  ].some((key) => input[key as keyof Product] !== undefined);
  const keepVerifiedState = !pidChanged && !verifiedFactWasWritten;
  getDb()
    .prepare(`UPDATE products SET name=?, pid=?, sku=?, document_id=?, document_url=?, image_path=?, prop_images_json=?, category=?, market=?, price=?, selling_points=?,
      target_audience=?, pain_points=?, competitors=?, product_url=?, banned_terms=?, notes=?,
      core_functions_json=?, product_parameters=?, usage_method=?, usage_scenes=?, source_title=?, source_description=?,
      source_image_urls_json=?, visual_evidence=?, visual_analysis_status=?, visual_analyzed_at=?,
      verified_pid=?, verified_source_url=?, evidence_version=?, facts_verified_at=?, fact_provenance_json=?, updated_at=? WHERE id=?`)
    .run(
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
export function mergeVerifiedProductFacts(id: string, input: VerifiedProductFactsMergeInput) {
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

  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM products WHERE id=?").get(productId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("产品不存在");
    const current = productFromRow({ ...row, video_count: 0 });
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
    db.prepare(`UPDATE products SET
      sku=?, core_functions_json=?, product_parameters=?, usage_method=?, target_audience=?, usage_scenes=?,
      source_title=?, source_description=?, source_image_urls_json=?, visual_evidence=?,
      visual_analysis_status=?, visual_analyzed_at=?, verified_pid=?, verified_source_url=?,
      evidence_version=?, facts_verified_at=?, fact_provenance_json=?, updated_at=?
      WHERE id=? AND pid=?`)
      .run(
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
      );
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the transaction has already ended */ }
    throw error;
  }
  return getProduct(productId)!;
}

/** Explicitly clear a stale Feishu document link; updateProduct's ?? semantics intentionally cannot do this. */
export function clearProductDocumentLink(id: string) {
  getDb()
    .prepare("UPDATE products SET document_id=NULL, document_url=NULL, updated_at=? WHERE id=?")
    .run(now(), id);
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

export interface ProductDocumentVideoRow {
  documentId: string;
  linkBlockId: string;
  productId: string;
  sourceUrl: string;
  videoId: string;
  createdAt: string;
  updatedAt: string;
}

function productDocumentVideoRowFromDb(row: Record<string, unknown>): ProductDocumentVideoRow {
  return {
    documentId: String(row.document_id),
    linkBlockId: String(row.link_block_id),
    productId: String(row.product_id),
    sourceUrl: String(row.source_url),
    videoId: String(row.video_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function getProductDocumentVideoRow(documentId: string, linkBlockId: string) {
  const row = getDb().prepare(`SELECT * FROM product_document_video_rows
    WHERE document_id=? AND link_block_id=?`).get(documentId.trim(), linkBlockId.trim()) as Record<string, unknown> | undefined;
  return row ? productDocumentVideoRowFromDb(row) : null;
}

export function getProductDocumentVideoRowByVideoId(videoId: string) {
  const row = getDb().prepare("SELECT * FROM product_document_video_rows WHERE video_id=?")
    .get(videoId.trim()) as Record<string, unknown> | undefined;
  return row ? productDocumentVideoRowFromDb(row) : null;
}

export function saveProductDocumentVideoRow(input: {
  documentId: string;
  linkBlockId: string;
  productId: string;
  sourceUrl: string;
  videoId: string;
}) {
  const timestamp = now();
  getDb().prepare(`INSERT INTO product_document_video_rows(
    document_id, link_block_id, product_id, source_url, video_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(document_id, link_block_id) DO UPDATE SET
    product_id=excluded.product_id,
    source_url=excluded.source_url,
    video_id=excluded.video_id,
    updated_at=excluded.updated_at`)
    .run(
      input.documentId.trim(), input.linkBlockId.trim(), input.productId.trim(),
      input.sourceUrl.trim(), input.videoId.trim(), timestamp, timestamp,
    );
  return getProductDocumentVideoRow(input.documentId, input.linkBlockId)!;
}

export function deleteProductDocumentVideoRow(documentId: string, linkBlockId: string) {
  return getDb().prepare(`DELETE FROM product_document_video_rows
    WHERE document_id=? AND link_block_id=?`).run(documentId.trim(), linkBlockId.trim());
}

export function isProductDocumentVideoRowsInitialized(documentId: string) {
  return Boolean(getDb().prepare("SELECT 1 FROM product_document_video_scan_state WHERE document_id=?")
    .get(documentId.trim()));
}

export function markProductDocumentVideoRowsInitialized(documentId: string) {
  getDb().prepare(`INSERT INTO product_document_video_scan_state(document_id, initialized_at)
    VALUES (?, ?) ON CONFLICT(document_id) DO NOTHING`).run(documentId.trim(), now());
}

export function getVideoBySourceUrl(sourceUrl: string, productId?: string) {
  const normalized = sourceUrl.trim();
  if (!normalized) return null;
  const row = productId
    ? getDb().prepare(`SELECT v.*, p.name AS product_name FROM videos v JOIN products p ON p.id=v.product_id
        WHERE v.source_url=? AND v.product_id=? ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1`)
      .get(normalized, productId) as Record<string, unknown> | undefined
    : getDb().prepare(`SELECT v.*, p.name AS product_name FROM videos v JOIN products p ON p.id=v.product_id
        WHERE v.source_url=? ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1`)
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

export const VIDEO_ATTEMPT_DIAGNOSTICS_MAX_BYTES = 16 * 1024;

const videoAttemptDiagnosticKeys = new Set([
  "schemaVersion", "provider", "model", "inputMode", "fileBytes", "inputSha256", "encodedBytes", "durationMs",
  "hasAudio", "videoCodec", "audioCodec", "calls",
]);
const videoAttemptCallDiagnosticKeys = new Set([
  "requestIndex", "clientRequestId", "providerRequestId", "phase", "outcome", "startedAt",
  "headersMs", "firstTokenMs", "totalMs", "httpStatus", "responseSha256",
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
export function updateVideoAttemptDiagnostics(
  videoId: string,
  attemptNumber: number,
  diagnostics: VideoAttemptDiagnostics,
) {
  const normalizedVideoId = videoId.trim();
  if (!normalizedVideoId) throw new Error("videoId不能为空");
  if (!Number.isInteger(attemptNumber) || attemptNumber <= 0) throw new Error("attemptNumber必须是正整数");
  const serialized = serializeVideoAttemptDiagnostics(diagnostics);
  const result = getDb().prepare(`UPDATE video_attempts SET diagnostics_json=?
    WHERE video_id=? AND attempt_number=? AND status='running' AND finished_at IS NULL`)
    .run(serialized, normalizedVideoId, attemptNumber);
  return result.changes > 0;
}

export function startVideoAttempt(videoId: string) {
  const db = getDb();
  const timestamp = now();
  const attemptId = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT attempt_count FROM videos WHERE id=?").get(videoId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("视频不存在");
    const attemptNumber = Number(row.attempt_count || 0) + 1;
    db.prepare(`UPDATE video_attempts
      SET status='stopped', error_message='新一轮处理启动，上一轮已中断', finished_at=?
      WHERE video_id=? AND status='running' AND finished_at IS NULL`)
      .run(timestamp, videoId);
    db.prepare(`UPDATE videos
      SET attempt_count=?, processing_started_at=?, product_doc_failure_delivered=0, updated_at=?
      WHERE id=?`)
      .run(attemptNumber, timestamp, timestamp, videoId);
    db.prepare(`INSERT INTO video_attempts(
      id, video_id, attempt_number, status, error_message, started_at, finished_at
    ) VALUES (?, ?, ?, 'running', '', ?, NULL)`).run(attemptId, videoId, attemptNumber, timestamp);
    db.exec("COMMIT");
    return { attemptId, attemptNumber, startedAt: timestamp };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

export function finishVideoAttempt(
  attemptId: string,
  videoId: string,
  status: "completed" | "failed" | "stopped",
  errorMessage = "",
) {
  const db = getDb();
  const timestamp = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const attempt = db.prepare(`SELECT started_at FROM video_attempts
      WHERE id=? AND video_id=? AND status='running' AND finished_at IS NULL`)
      .get(attemptId, videoId) as Record<string, unknown> | undefined;
    if (attempt) {
      const result = db.prepare(`UPDATE video_attempts
        SET status=?, error_message=?, finished_at=?
        WHERE id=? AND video_id=? AND status='running' AND finished_at IS NULL`)
        .run(status, errorMessage, timestamp, attemptId, videoId);
      if (result.changes > 0) {
        db.prepare(`UPDATE videos SET processing_started_at=NULL, updated_at=?
          WHERE id=? AND processing_started_at=?`)
          .run(timestamp, videoId, String(attempt.started_at));
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

export function finishOpenVideoAttempts(videoId: string, status: "failed" | "stopped", errorMessage: string) {
  const timestamp = now();
  getDb().prepare(`UPDATE video_attempts SET status=?, error_message=?, finished_at=?
    WHERE video_id=? AND status='running' AND finished_at IS NULL`)
    .run(status, errorMessage, timestamp, videoId);
}

export function getStaleProcessingVideoIds(cutoffIso: string) {
  return getDb().prepare(`SELECT id FROM videos
    WHERE status IN ('downloading','transcribing','extracting','analyzing')
      AND COALESCE(NULLIF(processing_started_at, ''), updated_at) < ?
    ORDER BY COALESCE(NULLIF(processing_started_at, ''), updated_at)`)
    .all(cutoffIso)
    .map((row) => String((row as Record<string, unknown>).id));
}
