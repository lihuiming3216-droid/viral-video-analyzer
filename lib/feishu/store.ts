import "server-only";

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/database";
import type { FeishuConnectionState, FeishuDelivery, FeishuSettings, FeishuTarget } from "@/lib/types";

function now() {
  return new Date().toISOString();
}

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function nullable(value: unknown) {
  return value == null || value === "" ? null : String(value);
}

function settingsFromRow(row: Record<string, unknown>): FeishuSettings {
  return {
    appId: text(row.app_id),
    hasAppSecret: Boolean(row.encrypted_app_secret),
    enabled: Boolean(row.enabled),
    publicBaseUrl: text(row.public_base_url) || "http://localhost:3000",
    rootFolderToken: text(row.root_folder_token),
    rootFolderUrl: text(row.root_folder_url),
    connectionStatus: text(row.connection_status || "disconnected") as FeishuConnectionState,
    lastError: text(row.last_error),
    connectedAt: nullable(row.connected_at),
    updatedAt: text(row.updated_at),
  };
}

function targetFromRow(row: Record<string, unknown>): FeishuTarget {
  return {
    targetId: text(row.target_id),
    targetType: row.target_type === "p2p" ? "p2p" : "group",
    name: text(row.name),
    senderOpenId: text(row.sender_open_id),
    lastUsedAt: text(row.last_used_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function deliveryFromRow(row: Record<string, unknown>): FeishuDelivery {
  return {
    id: text(row.id),
    videoId: text(row.video_id),
    batchId: nullable(row.batch_id),
    chatId: text(row.chat_id),
    chatType: row.chat_type === "p2p" ? "p2p" : "group",
    senderOpenId: text(row.sender_open_id),
    replyToMessageId: nullable(row.reply_to_message_id),
    cardMessageId: nullable(row.card_message_id),
    documentId: nullable(row.document_id),
    documentUrl: nullable(row.document_url),
    source: row.source === "web" ? "web" : "inbound",
    status: text(row.status),
    errorMessage: text(row.error_message),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export function getRawFeishuSettings() {
  return getDb().prepare("SELECT * FROM feishu_settings WHERE id=1").get() as Record<string, unknown>;
}

export function getFeishuSettings() {
  return settingsFromRow(getRawFeishuSettings());
}

export function saveFeishuSettings(input: {
  appId: string;
  encryptedAppSecret?: string | null;
  enabled: boolean;
  publicBaseUrl: string;
  rootFolderToken?: string;
  rootFolderUrl?: string;
}) {
  const current = getRawFeishuSettings();
  const secret = input.encryptedAppSecret === undefined
    ? current.encrypted_app_secret ? String(current.encrypted_app_secret) : null
    : input.encryptedAppSecret;
  const previousRoot = text(current.root_folder_token);
  const nextRoot = input.rootFolderToken?.trim() ?? previousRoot;
  getDb().prepare(`UPDATE feishu_settings SET
    app_id=?, encrypted_app_secret=?, enabled=?, public_base_url=?, root_folder_token=?, root_folder_url=?,
    connection_status='disconnected', last_error='', connected_at=NULL, updated_at=? WHERE id=1`)
    .run(
      input.appId.trim(), secret, input.enabled ? 1 : 0,
      input.publicBaseUrl.trim().replace(/\/+$/, "") || "http://localhost:3000",
      nextRoot, input.rootFolderUrl?.trim() ?? text(current.root_folder_url), now(),
    );
  if (previousRoot !== nextRoot) getDb().prepare("DELETE FROM feishu_folders").run();
  return getFeishuSettings();
}

export function setFeishuConnectionStatus(status: FeishuConnectionState, error = "") {
  getDb().prepare(`UPDATE feishu_settings SET connection_status=?, last_error=?, connected_at=?, updated_at=? WHERE id=1`)
    .run(status, error, status === "connected" ? now() : null, now());
  return getFeishuSettings();
}

export function setFeishuRootFolder(folderToken: string, folderUrl = "") {
  getDb().prepare("UPDATE feishu_settings SET root_folder_token=?, root_folder_url=?, updated_at=? WHERE id=1")
    .run(folderToken, folderUrl, now());
  return getFeishuSettings();
}

export function recordFeishuEvent(messageId: string, eventId = "") {
  const result = getDb().prepare("INSERT OR IGNORE INTO feishu_events(message_id, event_id, created_at) VALUES (?, ?, ?)")
    .run(messageId, eventId, now());
  return result.changes > 0;
}

export function upsertFeishuTarget(input: {
  targetId: string;
  targetType: "p2p" | "group";
  name?: string;
  senderOpenId?: string;
}) {
  const timestamp = now();
  getDb().prepare(`INSERT INTO feishu_targets(
    target_id, target_type, name, sender_open_id, last_used_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(target_id) DO UPDATE SET
    target_type=excluded.target_type,
    name=CASE WHEN excluded.name='' THEN feishu_targets.name ELSE excluded.name END,
    sender_open_id=CASE WHEN excluded.sender_open_id='' THEN feishu_targets.sender_open_id ELSE excluded.sender_open_id END,
    last_used_at=excluded.last_used_at,
    updated_at=excluded.updated_at`)
    .run(input.targetId, input.targetType, input.name?.trim() || "", input.senderOpenId || "", timestamp, timestamp, timestamp);
  return getDb().prepare("SELECT * FROM feishu_targets WHERE target_id=?").get(input.targetId) as Record<string, unknown>;
}

export function listFeishuTargets() {
  return getDb().prepare("SELECT * FROM feishu_targets ORDER BY last_used_at DESC").all()
    .map((row) => targetFromRow(row as Record<string, unknown>));
}

export function getFeishuTarget(targetId: string) {
  const row = getDb().prepare("SELECT * FROM feishu_targets WHERE target_id=?").get(targetId) as Record<string, unknown> | undefined;
  return row ? targetFromRow(row) : null;
}

export interface FeishuBatch {
  id: string;
  sourceMessageId: string | null;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  progressMessageId: string | null;
  total: number;
  completed: number;
  failed: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function batchFromRow(row: Record<string, unknown>): FeishuBatch {
  return {
    id: text(row.id),
    sourceMessageId: nullable(row.source_message_id),
    chatId: text(row.chat_id),
    chatType: row.chat_type === "p2p" ? "p2p" : "group",
    senderOpenId: text(row.sender_open_id),
    progressMessageId: nullable(row.progress_message_id),
    total: Number(row.total || 0),
    completed: Number(row.completed || 0),
    failed: Number(row.failed || 0),
    status: text(row.status),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export function createFeishuBatch(input: {
  sourceMessageId?: string | null;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId?: string;
  total: number;
}) {
  const id = randomUUID();
  const timestamp = now();
  getDb().prepare(`INSERT INTO feishu_batches(
    id, source_message_id, chat_id, chat_type, sender_open_id, total, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.sourceMessageId || null, input.chatId, input.chatType, input.senderOpenId || "", input.total, timestamp, timestamp);
  return getFeishuBatch(id)!;
}

export function getFeishuBatch(id: string) {
  const row = getDb().prepare("SELECT * FROM feishu_batches WHERE id=?").get(id) as Record<string, unknown> | undefined;
  return row ? batchFromRow(row) : null;
}

export function updateFeishuBatch(id: string, values: { progressMessageId?: string | null; status?: string }) {
  const current = getFeishuBatch(id);
  if (!current) return null;
  getDb().prepare("UPDATE feishu_batches SET progress_message_id=?, status=?, updated_at=? WHERE id=?")
    .run(values.progressMessageId === undefined ? current.progressMessageId : values.progressMessageId, values.status ?? current.status, now(), id);
  return getFeishuBatch(id);
}

export function createFeishuDelivery(input: {
  videoId: string;
  batchId?: string | null;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId?: string;
  replyToMessageId?: string | null;
  source?: "inbound" | "web";
  status?: string;
}) {
  const id = randomUUID();
  const timestamp = now();
  getDb().prepare(`INSERT INTO feishu_deliveries(
    id, video_id, batch_id, chat_id, chat_type, sender_open_id, reply_to_message_id, source, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, input.videoId, input.batchId || null, input.chatId, input.chatType, input.senderOpenId || "",
      input.replyToMessageId || null, input.source || "inbound", input.status || "queued", timestamp, timestamp,
    );
  return getFeishuDelivery(id)!;
}

export function getFeishuDelivery(id: string) {
  const row = getDb().prepare("SELECT * FROM feishu_deliveries WHERE id=?").get(id) as Record<string, unknown> | undefined;
  return row ? deliveryFromRow(row) : null;
}

export function getFeishuDeliveryByCardMessage(cardMessageId: string, videoId?: string) {
  const row = videoId
    ? getDb().prepare("SELECT * FROM feishu_deliveries WHERE card_message_id=? AND video_id=? ORDER BY created_at DESC LIMIT 1").get(cardMessageId, videoId)
    : getDb().prepare("SELECT * FROM feishu_deliveries WHERE card_message_id=? ORDER BY created_at DESC LIMIT 1").get(cardMessageId);
  return row ? deliveryFromRow(row as Record<string, unknown>) : null;
}

export function updateFeishuDelivery(id: string, values: {
  cardMessageId?: string | null;
  documentId?: string | null;
  documentUrl?: string | null;
  status?: string;
  errorMessage?: string;
}) {
  const current = getFeishuDelivery(id);
  if (!current) return null;
  getDb().prepare(`UPDATE feishu_deliveries SET
    card_message_id=?, document_id=?, document_url=?, status=?, error_message=?, updated_at=? WHERE id=?`)
    .run(
      values.cardMessageId === undefined ? current.cardMessageId : values.cardMessageId,
      values.documentId === undefined ? current.documentId : values.documentId,
      values.documentUrl === undefined ? current.documentUrl : values.documentUrl,
      values.status ?? current.status,
      values.errorMessage ?? current.errorMessage,
      now(), id,
    );
  return getFeishuDelivery(id);
}

export function listOpenFeishuDeliveries(videoId: string) {
  return getDb().prepare(`SELECT * FROM feishu_deliveries
    WHERE video_id=? AND status NOT IN ('delivered','historical','failed','stopped') ORDER BY created_at`)
    .all(videoId).map((row) => deliveryFromRow(row as Record<string, unknown>));
}

export function listFeishuBatchDeliveries(batchId: string) {
  return getDb().prepare("SELECT * FROM feishu_deliveries WHERE batch_id=? ORDER BY created_at")
    .all(batchId).map((row) => deliveryFromRow(row as Record<string, unknown>));
}

export function refreshFeishuBatchStats(batchId: string) {
  const deliveries = listFeishuBatchDeliveries(batchId);
  const completed = deliveries.filter((item) => ["delivered", "historical"].includes(item.status)).length;
  const failed = deliveries.filter((item) => ["failed", "stopped"].includes(item.status)).length;
  const status = completed + failed >= deliveries.length ? (failed ? "finished_with_errors" : "completed") : "processing";
  getDb().prepare("UPDATE feishu_batches SET total=?, completed=?, failed=?, status=?, updated_at=? WHERE id=?")
    .run(deliveries.length, completed, failed, status, now(), batchId);
  return getFeishuBatch(batchId);
}

export function getFeishuDocument(videoId: string) {
  return getDb().prepare("SELECT * FROM feishu_documents WHERE video_id=?").get(videoId) as Record<string, unknown> | undefined;
}

export function saveFeishuDocument(input: {
  videoId: string;
  reportHash: string;
  documentId: string;
  documentUrl: string;
  folderToken?: string;
}) {
  const timestamp = now();
  getDb().prepare(`INSERT INTO feishu_documents(
    video_id, report_hash, document_id, document_url, folder_token, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(video_id) DO UPDATE SET
    report_hash=excluded.report_hash, document_id=excluded.document_id, document_url=excluded.document_url,
    folder_token=excluded.folder_token, updated_at=excluded.updated_at`)
    .run(input.videoId, input.reportHash, input.documentId, input.documentUrl, input.folderToken || "", timestamp, timestamp);
}

export function getFeishuFolder(scopeKey: string) {
  return getDb().prepare("SELECT * FROM feishu_folders WHERE scope_key=?").get(scopeKey) as Record<string, unknown> | undefined;
}

export function saveFeishuFolder(input: { scopeKey: string; folderToken: string; folderUrl?: string; parentToken?: string }) {
  const timestamp = now();
  getDb().prepare(`INSERT INTO feishu_folders(
    scope_key, folder_token, folder_url, parent_token, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(scope_key) DO UPDATE SET folder_token=excluded.folder_token, folder_url=excluded.folder_url,
    parent_token=excluded.parent_token, updated_at=excluded.updated_at`)
    .run(input.scopeKey, input.folderToken, input.folderUrl || "", input.parentToken || "", timestamp, timestamp);
}
