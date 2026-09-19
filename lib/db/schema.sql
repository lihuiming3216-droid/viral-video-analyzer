-- 爆片分析 · MySQL schema
-- 从 lib/database.ts 的 node:sqlite 实现（真实生产表结构，2026-08-18 镜像）翻译而来。
-- 18 张表，逐一对应原 SQLite 表；*_json 字段改用原生 JSON 类型。

SET NAMES utf8mb4;

-- A PID is charged at most once automatically, across rows/cards/processes.
-- Requested/failed states are deliberately never recycled on restart/timeout.
-- Raw responses and image bytes live in the persistent private .data directory.
CREATE TABLE IF NOT EXISTS product_catalog_cache (
  pid VARCHAR(30) PRIMARY KEY,
  country CHAR(2) NOT NULL DEFAULT 'us',
  fetch_state VARCHAR(16) NOT NULL,
  analysis_state VARCHAR(16) NOT NULL,
  result_json JSON,
  error_message VARCHAR(500) NOT NULL DEFAULT '',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS product_catalog_reorganizations (
  id CHAR(36) PRIMARY KEY,
  pid VARCHAR(30) NOT NULL,
  state VARCHAR(16) NOT NULL,
  error_message VARCHAR(500) NOT NULL DEFAULT '',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_catalog_reorganization_pid (pid, state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 时间戳全部沿用原来 SQLite 里 now() 产生的 ISO-8601 字符串（如 2026-08-30T09:57:10.484Z），
-- 不改存 MySQL 原生 DATETIME，省去时区/格式转换，直接保持和现有业务代码一致。VARCHAR 索引排序
-- 对定长 ISO-8601 UTC 字符串等价于按时间排序。
--
-- TEXT/JSON 字段的 DEFAULT 必须用括号表达式写法（MySQL 8.0.13+），例如 DEFAULT ('')、
-- DEFAULT ('[]')、DEFAULT ('{}')；VARCHAR/INT 等定长类型可以直接写 DEFAULT '' 不需要括号。

CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  pid VARCHAR(191) NOT NULL DEFAULT '',
  sku VARCHAR(191) NOT NULL DEFAULT '',
  document_id VARCHAR(191),
  document_url TEXT,
  image_path TEXT,
  prop_images_json JSON NOT NULL DEFAULT ('[]'),
  category VARCHAR(191) NOT NULL DEFAULT '',
  market VARCHAR(191) NOT NULL DEFAULT '',
  price VARCHAR(191) NOT NULL DEFAULT '',
  selling_points TEXT NOT NULL DEFAULT (''),
  target_audience TEXT NOT NULL DEFAULT (''),
  pain_points TEXT NOT NULL DEFAULT (''),
  competitors TEXT NOT NULL DEFAULT (''),
  product_url TEXT NOT NULL DEFAULT (''),
  core_functions_json JSON NOT NULL DEFAULT ('[]'),
  product_parameters TEXT NOT NULL DEFAULT (''),
  usage_method TEXT NOT NULL DEFAULT (''),
  usage_scenes TEXT NOT NULL DEFAULT (''),
  source_title TEXT NOT NULL DEFAULT (''),
  source_description TEXT NOT NULL DEFAULT (''),
  source_image_urls_json JSON NOT NULL DEFAULT ('[]'),
  visual_evidence TEXT NOT NULL DEFAULT (''),
  visual_analysis_status VARCHAR(32) NOT NULL DEFAULT '',
  visual_analyzed_at VARCHAR(32),
  verified_pid VARCHAR(191) NOT NULL DEFAULT '',
  verified_source_url TEXT NOT NULL DEFAULT (''),
  evidence_version VARCHAR(64) NOT NULL DEFAULT '',
  facts_verified_at VARCHAR(64) NOT NULL DEFAULT '',
  fact_provenance_json JSON NOT NULL DEFAULT ('{}'),
  banned_terms TEXT NOT NULL DEFAULT (''),
  notes TEXT NOT NULL DEFAULT (''),
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_products_pid (pid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS videos (
  id VARCHAR(36) PRIMARY KEY,
  product_id VARCHAR(36) NOT NULL,
  source_type VARCHAR(16) NOT NULL,
  source_url VARCHAR(1024),
  source_file_name VARCHAR(512),
  analysis_mode VARCHAR(16) NOT NULL DEFAULT 'full',
  product_doc_retry_count INT NOT NULL DEFAULT 0,
  product_doc_failure_delivered TINYINT(1) NOT NULL DEFAULT 0,
  title VARCHAR(512) NOT NULL DEFAULT '',
  account_name VARCHAR(191) NOT NULL DEFAULT '',
  platform_video_id VARCHAR(191),
  language VARCHAR(16),
  published_at VARCHAR(32),
  duration_seconds DOUBLE,
  original_path TEXT,
  cover_path TEXT,
  remote_video_url TEXT,
  status VARCHAR(24) NOT NULL DEFAULT 'waiting',
  stage VARCHAR(64) NOT NULL DEFAULT '等待分析',
  progress INT NOT NULL DEFAULT 0,
  error_message TEXT,
  score_traffic INT NOT NULL DEFAULT 0,
  score_conversion INT NOT NULL DEFAULT 0,
  score_visual INT NOT NULL DEFAULT 0,
  score_product INT NOT NULL DEFAULT 0,
  score_audio INT NOT NULL DEFAULT 0,
  score_rhythm INT NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT (''),
  hook_summary TEXT NOT NULL DEFAULT (''),
  manual_label VARCHAR(16),
  manual_notes TEXT NOT NULL DEFAULT (''),
  view_count BIGINT,
  like_count BIGINT,
  comment_count BIGINT,
  share_count BIGINT,
  favorite_count BIGINT,
  follower_count BIGINT,
  stats_captured_at VARCHAR(32),
  transcript_original LONGTEXT NOT NULL DEFAULT (''),
  transcript_zh LONGTEXT NOT NULL DEFAULT (''),
  transcript_segments_json JSON NOT NULL DEFAULT ('[]'),
  analysis_json JSON,
  provider_payload_json JSON,
  processing_started_at VARCHAR(32),
  attempt_count INT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_videos_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  INDEX idx_videos_product_created (product_id, created_at DESC),
  INDEX idx_videos_account_created (account_name, created_at DESC),
  INDEX idx_videos_status (status),
  INDEX idx_videos_published_at (published_at),
  INDEX idx_videos_source_url (source_url(255), created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS scenes (
  id VARCHAR(36) PRIMARY KEY,
  video_id VARCHAR(36) NOT NULL,
  shot_index INT NOT NULL,
  start_seconds DOUBLE NOT NULL,
  end_seconds DOUBLE NOT NULL,
  screenshot_path TEXT,
  clip_path TEXT,
  role VARCHAR(64) NOT NULL DEFAULT '',
  visual_description TEXT NOT NULL DEFAULT (''),
  audio_description TEXT NOT NULL DEFAULT (''),
  transcript_original TEXT NOT NULL DEFAULT (''),
  translation_zh TEXT NOT NULL DEFAULT (''),
  strengths TEXT NOT NULL DEFAULT (''),
  weaknesses TEXT NOT NULL DEFAULT (''),
  importance INT NOT NULL DEFAULT 0,
  score_traffic INT NOT NULL DEFAULT 0,
  score_conversion INT NOT NULL DEFAULT 0,
  score_clarity INT NOT NULL DEFAULT 0,
  score_aesthetic INT NOT NULL DEFAULT 0,
  score_lighting INT NOT NULL DEFAULT 0,
  score_product INT NOT NULL DEFAULT 0,
  tags_json JSON NOT NULL DEFAULT ('[]'),
  CONSTRAINT fk_scenes_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  UNIQUE KEY uq_scenes_video_shot (video_id, shot_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS video_attempts (
  id VARCHAR(36) PRIMARY KEY,
  video_id VARCHAR(36) NOT NULL,
  attempt_number INT NOT NULL,
  status VARCHAR(24) NOT NULL,
  error_message TEXT NOT NULL DEFAULT (''),
  diagnostics_json JSON NOT NULL DEFAULT ('{}'),
  started_at VARCHAR(32) NOT NULL,
  finished_at VARCHAR(32),
  CONSTRAINT fk_video_attempts_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  UNIQUE KEY uq_video_attempts_video_number (video_id, attempt_number),
  INDEX idx_video_attempts_video_started (video_id, started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Independent settings; additive only, no migration rewrites existing paid caches.
CREATE TABLE IF NOT EXISTS ai_purpose_settings (
  purpose VARCHAR(32) PRIMARY KEY,
  config_json JSON NOT NULL,
  encrypted_api_key TEXT NULL,
  updated_at VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS provider_settings (
  provider VARCHAR(32) PRIMARY KEY,
  encrypted_api_key TEXT,
  base_url VARCHAR(512) NOT NULL,
  model VARCHAR(128) NOT NULL DEFAULT '',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS learning_memories (
  video_id VARCHAR(36) PRIMARY KEY,
  product_id VARCHAR(36) NOT NULL,
  category VARCHAR(191) NOT NULL DEFAULT '',
  outcome VARCHAR(24) NOT NULL DEFAULT 'unverified',
  evidence_weight DOUBLE NOT NULL DEFAULT 0.35,
  features_json JSON NOT NULL DEFAULT ('{}'),
  searchable_text LONGTEXT NOT NULL DEFAULT (''),
  source_updated_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_learning_memories_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  CONSTRAINT fk_learning_memories_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  INDEX idx_learning_memories_product (product_id, updated_at DESC),
  INDEX idx_learning_memories_category (category, updated_at DESC),
  INDEX idx_learning_memories_outcome (outcome, updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS learning_profiles (
  scope_type VARCHAR(32) NOT NULL,
  scope_key VARCHAR(191) NOT NULL,
  sample_count INT NOT NULL DEFAULT 0,
  labeled_count INT NOT NULL DEFAULT 0,
  positive_count INT NOT NULL DEFAULT 0,
  neutral_count INT NOT NULL DEFAULT 0,
  negative_count INT NOT NULL DEFAULT 0,
  avg_traffic INT NOT NULL DEFAULT 0,
  avg_conversion INT NOT NULL DEFAULT 0,
  confidence INT NOT NULL DEFAULT 0,
  insights_json JSON NOT NULL DEFAULT ('{}'),
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (scope_type, scope_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS feishu_settings (
  id TINYINT NOT NULL PRIMARY KEY,
  app_id VARCHAR(191) NOT NULL DEFAULT '',
  encrypted_app_secret TEXT,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  public_base_url VARCHAR(512) NOT NULL DEFAULT 'http://localhost:3000',
  root_folder_token VARCHAR(191) NOT NULL DEFAULT '',
  root_folder_url TEXT NOT NULL DEFAULT (''),
  product_folder_token VARCHAR(191) NOT NULL DEFAULT '',
  product_folder_url TEXT NOT NULL DEFAULT (''),
  connection_status VARCHAR(24) NOT NULL DEFAULT 'disconnected',
  last_error TEXT NOT NULL DEFAULT (''),
  connected_at VARCHAR(32),
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT chk_feishu_settings_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS feishu_automation_jobs (
  video_id VARCHAR(36) NOT NULL,
  app_token VARCHAR(191) NOT NULL,
  table_id VARCHAR(191) NOT NULL,
  record_id VARCHAR(191) NOT NULL,
  field_map_json JSON NOT NULL DEFAULT ('{}'),
  -- Counts failed delivery passes for this row. Only gates the expensive
  -- Qwen subtitle-generation retry (see completeFeishuAutomation) — the
  -- transient text-field failures stay retryable; confirmed permanent delivery
  -- errors are paused separately in feishu_automation_delivery_blocks.
  attempts INT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (video_id, app_token, table_id, record_id),
  CONSTRAINT fk_feishu_automation_jobs_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  INDEX idx_feishu_automation_jobs_video (video_id, updated_at),
  INDEX idx_feishu_automation_jobs_row (app_token, table_id, record_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Durable pauses are separate from attempts: changing a mapping/new submission
-- can resume delivery, while missing rows/columns must not retry indefinitely.
CREATE TABLE IF NOT EXISTS feishu_automation_delivery_blocks (
  video_id VARCHAR(36) NOT NULL,
  app_token VARCHAR(191) NOT NULL,
  table_id VARCHAR(191) NOT NULL,
  record_id VARCHAR(191) NOT NULL,
  reason VARCHAR(64) NOT NULL,
  message VARCHAR(512) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (video_id, app_token, table_id, record_id),
  CONSTRAINT fk_feishu_delivery_block_job FOREIGN KEY (video_id, app_token, table_id, record_id)
    REFERENCES feishu_automation_jobs(video_id, app_token, table_id, record_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS product_document_video_rows (
  document_id VARCHAR(191) NOT NULL,
  link_block_id VARCHAR(191) NOT NULL,
  product_id VARCHAR(36) NOT NULL,
  source_url VARCHAR(1024) NOT NULL,
  video_id VARCHAR(36) NOT NULL UNIQUE,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (document_id, link_block_id),
  CONSTRAINT fk_pdv_rows_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_pdv_rows_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  INDEX idx_pdv_rows_product_url (product_id, source_url(255), updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS product_document_video_scan_state (
  document_id VARCHAR(191) PRIMARY KEY,
  initialized_at VARCHAR(32) NOT NULL,
  -- 20秒扫描SLA优化（审计12.3节建议）：缓存上次看到的文档 revision_id，没变就跳过整份文档的
  -- 表格深读（block分页拉取是这个流程里最贵的调用），从而能在同样的API预算下扫更多文档。
  last_revision_id BIGINT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS feishu_product_card_mappings (
  app_token VARCHAR(191) NOT NULL,
  table_id VARCHAR(191) NOT NULL,
  record_id VARCHAR(191) NOT NULL,
  product_id VARCHAR(36),
  document_id VARCHAR(191),
  document_url TEXT,
  last_product_pid VARCHAR(191) NOT NULL DEFAULT '',
  last_product_url TEXT NOT NULL DEFAULT (''),
  last_product_name VARCHAR(512) NOT NULL DEFAULT '',
  managed_product_pid VARCHAR(191) NOT NULL DEFAULT '',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (app_token, table_id, record_id),
  CONSTRAINT fk_fpcm_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
  INDEX idx_fpcm_document (document_id),
  INDEX idx_fpcm_product (product_id),
  INDEX idx_fpcm_pid (last_product_pid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS feishu_targets (
  target_id VARCHAR(191) PRIMARY KEY,
  target_type VARCHAR(24) NOT NULL,
  name VARCHAR(191) NOT NULL DEFAULT '',
  sender_open_id VARCHAR(191) NOT NULL DEFAULT '',
  last_used_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_feishu_targets_used (last_used_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS feishu_batches (
  id VARCHAR(36) PRIMARY KEY,
  source_message_id VARCHAR(191) UNIQUE,
  chat_id VARCHAR(191) NOT NULL,
  chat_type VARCHAR(16) NOT NULL,
  sender_open_id VARCHAR(191) NOT NULL DEFAULT '',
  progress_message_id VARCHAR(191),
  total INT NOT NULL DEFAULT 0,
  completed INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  status VARCHAR(24) NOT NULL DEFAULT 'queued',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS feishu_deliveries (
  id VARCHAR(36) PRIMARY KEY,
  video_id VARCHAR(36) NOT NULL,
  batch_id VARCHAR(36),
  chat_id VARCHAR(191) NOT NULL,
  chat_type VARCHAR(16) NOT NULL,
  sender_open_id VARCHAR(191) NOT NULL DEFAULT '',
  reply_to_message_id VARCHAR(191),
  card_message_id VARCHAR(191),
  document_id VARCHAR(191),
  document_url TEXT,
  source VARCHAR(16) NOT NULL DEFAULT 'inbound',
  status VARCHAR(24) NOT NULL DEFAULT 'queued',
  error_message TEXT NOT NULL DEFAULT (''),
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_feishu_deliveries_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  CONSTRAINT fk_feishu_deliveries_batch FOREIGN KEY (batch_id) REFERENCES feishu_batches(id) ON DELETE SET NULL,
  INDEX idx_feishu_deliveries_video (video_id, updated_at DESC),
  INDEX idx_feishu_deliveries_batch (batch_id, updated_at DESC),
  INDEX idx_feishu_deliveries_status (status, updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS feishu_documents (
  video_id VARCHAR(36) PRIMARY KEY,
  report_hash VARCHAR(191) NOT NULL,
  document_id VARCHAR(191) NOT NULL,
  document_url TEXT NOT NULL,
  folder_token VARCHAR(191) NOT NULL DEFAULT '',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_feishu_documents_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS feishu_folders (
  scope_key VARCHAR(191) PRIMARY KEY,
  folder_token VARCHAR(191) NOT NULL,
  folder_url TEXT NOT NULL DEFAULT (''),
  parent_token VARCHAR(191) NOT NULL DEFAULT '',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS feishu_events (
  message_id VARCHAR(191) PRIMARY KEY,
  event_id VARCHAR(191) NOT NULL DEFAULT '',
  created_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 按用途分别配置 Qwen 模型：完整视频分析、产品手卡精简分析、口播翻译原来共用 provider_settings.qwen
-- 里那一个 model 字段，现在允许每个用途单独覆盖（比如翻译用更便宜的纯文本模型，视频分析用能听
-- 音轨的 omni 模型）。留空的用途继续 fallback 到 provider_settings.qwen.model。
CREATE TABLE IF NOT EXISTS qwen_purpose_models (
  purpose VARCHAR(32) PRIMARY KEY,
  model VARCHAR(128) NOT NULL DEFAULT '',
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Prompt 调试台：提示词模板（带版本历史）+ 真实请求输入负载留存，供运维后台重放测试。
-- 用户已明确要求这两张表不做脱敏/加密处理——跟 video_attempts.diagnostics_json 那种刻意精简、
-- 禁止存 prompt/原始输入的诊断表是两回事，这里就是要存完整真实数据方便调试。

CREATE TABLE IF NOT EXISTS prompt_templates (
  slug VARCHAR(64) PRIMARY KEY,
  label VARCHAR(191) NOT NULL,
  template LONGTEXT NOT NULL,
  current_version INT NOT NULL DEFAULT 1,
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS prompt_template_versions (
  id VARCHAR(36) PRIMARY KEY,
  slug VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  template LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_prompt_template_versions_slug FOREIGN KEY (slug) REFERENCES prompt_templates(slug) ON DELETE CASCADE,
  UNIQUE KEY uq_prompt_template_versions (slug, version),
  INDEX idx_prompt_template_versions_slug (slug, version DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 字段映射的持久化配置：按"appToken:tableId"分组，覆盖 lib/feishu/automation.ts 里硬编码的
-- 默认字段名和别名列表。审计技术债第5条"字段别名分散在代码里，表格改名会静默失效"——这张表让运维
-- 后台可以直接在线加别名/改字段名，不用每次都改代码重新部署。
CREATE TABLE IF NOT EXISTS feishu_field_mappings (
  scope_key VARCHAR(191) PRIMARY KEY,
  label VARCHAR(191) NOT NULL DEFAULT '',
  field_map_json JSON NOT NULL DEFAULT ('{}'),
  aliases_json JSON NOT NULL DEFAULT ('{}'),
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS prompt_debug_captures (
  id VARCHAR(36) PRIMARY KEY,
  video_id VARCHAR(36) NOT NULL,
  attempt_number INT NOT NULL,
  template_slug VARCHAR(64) NOT NULL,
  inputs_json JSON NOT NULL DEFAULT ('{}'),
  qwen_video_path VARCHAR(1024),
  created_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_prompt_debug_captures_video FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  INDEX idx_prompt_debug_captures_slug (template_slug, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
