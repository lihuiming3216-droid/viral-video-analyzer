import "server-only";

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/database";
import { execute, queryRow, queryRows } from "@/lib/db/query";
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
    productFolderToken: text(row.product_folder_token),
    productFolderUrl: text(row.product_folder_url),
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

export async function getRawFeishuSettings() {
  const db = await getDb();
  return (await queryRow(db, "SELECT * FROM feishu_settings WHERE id=1"))!;
}

export async function getFeishuSettings() {
  return settingsFromRow(await getRawFeishuSettings());
}

export async function saveFeishuSettings(input: {
  appId: string;
  encryptedAppSecret?: string | null;
  enabled: boolean;
  publicBaseUrl: string;
  rootFolderToken?: string;
  rootFolderUrl?: string;
  productFolderToken?: string;
  productFolderUrl?: string;
}, options: { clearReportFolderCache?: boolean } = {}) {
  const current = await getRawFeishuSettings();
  const secret = input.encryptedAppSecret === undefined
    ? current.encrypted_app_secret ? String(current.encrypted_app_secret) : null
    : input.encryptedAppSecret;
  const previousRoot = text(current.root_folder_token);
  const nextRoot = input.rootFolderToken?.trim() ?? previousRoot;
  const nextProductFolder = input.productFolderToken?.trim() ?? text(current.product_folder_token);
  const nextProductFolderUrl = input.productFolderUrl?.trim() ?? text(current.product_folder_url);
  const db = await getDb();
  await execute(
    db,
    `UPDATE feishu_settings SET
      app_id=?, encrypted_app_secret=?, enabled=?, public_base_url=?, root_folder_token=?, root_folder_url=?,
      product_folder_token=?, product_folder_url=?,
      connection_status='disconnected', last_error='', connected_at=NULL, updated_at=? WHERE id=1`,
    [
      input.appId.trim(), secret, input.enabled ? 1 : 0,
      input.publicBaseUrl.trim().replace(/\/+$/, "") || "http://localhost:3000",
      nextRoot, input.rootFolderUrl?.trim() ?? text(current.root_folder_url),
      nextProductFolder, nextProductFolderUrl, now(),
    ],
  );
  if (previousRoot !== nextRoot && options.clearReportFolderCache !== false) await clearFeishuFolderCache();
  return getFeishuSettings();
}

export async function clearFeishuFolderCache() {
  const db = await getDb();
  await execute(db, "DELETE FROM feishu_folders");
}

export async function setFeishuConnectionStatus(status: FeishuConnectionState, error = "") {
  const db = await getDb();
  await execute(
    db,
    `UPDATE feishu_settings SET connection_status=?, last_error=?, connected_at=?, updated_at=? WHERE id=1`,
    [status, error, status === "connected" ? now() : null, now()],
  );
  return getFeishuSettings();
}

export async function setFeishuRootFolder(folderToken: string, folderUrl = "") {
  const db = await getDb();
  await execute(
    db,
    "UPDATE feishu_settings SET root_folder_token=?, root_folder_url=?, updated_at=? WHERE id=1",
    [folderToken, folderUrl, now()],
  );
  return getFeishuSettings();
}

export async function setFeishuProductFolder(folderToken: string, folderUrl = "") {
  const db = await getDb();
  await execute(
    db,
    "UPDATE feishu_settings SET product_folder_token=?, product_folder_url=?, updated_at=? WHERE id=1",
    [folderToken.trim(), folderUrl.trim(), now()],
  );
  return getFeishuSettings();
}

export async function recordFeishuEvent(messageId: string, eventId = "") {
  const db = await getDb();
  const result = await execute(
    db,
    "INSERT IGNORE INTO feishu_events(message_id, event_id, created_at) VALUES (?, ?, ?)",
    [messageId, eventId, now()],
  );
  return result.affectedRows > 0;
}

export async function upsertFeishuTarget(input: {
  targetId: string;
  targetType: "p2p" | "group";
  name?: string;
  senderOpenId?: string;
}) {
  const timestamp = now();
  const db = await getDb();
  await execute(
    db,
    `INSERT INTO feishu_targets(
      target_id, target_type, name, sender_open_id, last_used_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      target_type=VALUES(target_type),
      name=IF(VALUES(name)='', name, VALUES(name)),
      sender_open_id=IF(VALUES(sender_open_id)='', sender_open_id, VALUES(sender_open_id)),
      last_used_at=VALUES(last_used_at),
      updated_at=VALUES(updated_at)`,
    [input.targetId, input.targetType, input.name?.trim() || "", input.senderOpenId || "", timestamp, timestamp, timestamp],
  );
  return (await queryRow(db, "SELECT * FROM feishu_targets WHERE target_id=?", [input.targetId]))!;
}

export async function listFeishuTargets() {
  const db = await getDb();
  const found = await queryRows(db, "SELECT * FROM feishu_targets ORDER BY last_used_at DESC");
  return found.map(targetFromRow);
}

export async function getFeishuTarget(targetId: string) {
  const db = await getDb();
  const found = await queryRow(db, "SELECT * FROM feishu_targets WHERE target_id=?", [targetId]);
  return found ? targetFromRow(found) : null;
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

export async function createFeishuBatch(input: {
  sourceMessageId?: string | null;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId?: string;
  total: number;
}) {
  const id = randomUUID();
  const timestamp = now();
  const db = await getDb();
  await execute(
    db,
    `INSERT INTO feishu_batches(
      id, source_message_id, chat_id, chat_type, sender_open_id, total, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.sourceMessageId || null, input.chatId, input.chatType, input.senderOpenId || "", input.total, timestamp, timestamp],
  );
  return (await getFeishuBatch(id))!;
}

export async function getFeishuBatch(id: string) {
  const db = await getDb();
  const found = await queryRow(db, "SELECT * FROM feishu_batches WHERE id=?", [id]);
  return found ? batchFromRow(found) : null;
}

export async function updateFeishuBatch(id: string, values: { progressMessageId?: string | null; status?: string }) {
  const current = await getFeishuBatch(id);
  if (!current) return null;
  const db = await getDb();
  await execute(
    db,
    "UPDATE feishu_batches SET progress_message_id=?, status=?, updated_at=? WHERE id=?",
    [values.progressMessageId === undefined ? current.progressMessageId : values.progressMessageId, values.status ?? current.status, now(), id],
  );
  return getFeishuBatch(id);
}

export async function createFeishuDelivery(input: {
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
  const db = await getDb();
  await execute(
    db,
    `INSERT INTO feishu_deliveries(
      id, video_id, batch_id, chat_id, chat_type, sender_open_id, reply_to_message_id, source, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, input.videoId, input.batchId || null, input.chatId, input.chatType, input.senderOpenId || "",
      input.replyToMessageId || null, input.source || "inbound", input.status || "queued", timestamp, timestamp,
    ],
  );
  return (await getFeishuDelivery(id))!;
}

export async function getFeishuDelivery(id: string) {
  const db = await getDb();
  const found = await queryRow(db, "SELECT * FROM feishu_deliveries WHERE id=?", [id]);
  return found ? deliveryFromRow(found) : null;
}

export async function getFeishuDeliveryByCardMessage(cardMessageId: string, videoId?: string) {
  const db = await getDb();
  const found = videoId
    ? await queryRow(db, "SELECT * FROM feishu_deliveries WHERE card_message_id=? AND video_id=? ORDER BY created_at DESC LIMIT 1", [cardMessageId, videoId])
    : await queryRow(db, "SELECT * FROM feishu_deliveries WHERE card_message_id=? ORDER BY created_at DESC LIMIT 1", [cardMessageId]);
  return found ? deliveryFromRow(found) : null;
}

export async function updateFeishuDelivery(id: string, values: {
  cardMessageId?: string | null;
  documentId?: string | null;
  documentUrl?: string | null;
  status?: string;
  errorMessage?: string;
}) {
  const current = await getFeishuDelivery(id);
  if (!current) return null;
  const db = await getDb();
  await execute(
    db,
    `UPDATE feishu_deliveries SET
      card_message_id=?, document_id=?, document_url=?, status=?, error_message=?, updated_at=? WHERE id=?`,
    [
      values.cardMessageId === undefined ? current.cardMessageId : values.cardMessageId,
      values.documentId === undefined ? current.documentId : values.documentId,
      values.documentUrl === undefined ? current.documentUrl : values.documentUrl,
      values.status ?? current.status,
      values.errorMessage ?? current.errorMessage,
      now(), id,
    ],
  );
  return getFeishuDelivery(id);
}

export async function listOpenFeishuDeliveries(videoId: string) {
  const db = await getDb();
  const found = await queryRows(
    db,
    `SELECT * FROM feishu_deliveries
     WHERE video_id=? AND status NOT IN ('delivered','historical','failed','stopped') ORDER BY created_at`,
    [videoId],
  );
  return found.map(deliveryFromRow);
}

export async function listFeishuBatchDeliveries(batchId: string) {
  const db = await getDb();
  const found = await queryRows(db, "SELECT * FROM feishu_deliveries WHERE batch_id=? ORDER BY created_at", [batchId]);
  return found.map(deliveryFromRow);
}

export async function refreshFeishuBatchStats(batchId: string) {
  const deliveries = await listFeishuBatchDeliveries(batchId);
  const completed = deliveries.filter((item) => ["delivered", "historical"].includes(item.status)).length;
  const failed = deliveries.filter((item) => ["failed", "stopped"].includes(item.status)).length;
  const status = completed + failed >= deliveries.length ? (failed ? "finished_with_errors" : "completed") : "processing";
  const db = await getDb();
  await execute(
    db,
    "UPDATE feishu_batches SET total=?, completed=?, failed=?, status=?, updated_at=? WHERE id=?",
    [deliveries.length, completed, failed, status, now(), batchId],
  );
  return getFeishuBatch(batchId);
}

export async function getFeishuDocument(videoId: string) {
  const db = await getDb();
  return queryRow(db, "SELECT * FROM feishu_documents WHERE video_id=?", [videoId]);
}

export async function saveFeishuDocument(input: {
  videoId: string;
  reportHash: string;
  documentId: string;
  documentUrl: string;
  folderToken?: string;
}) {
  const timestamp = now();
  const db = await getDb();
  await execute(
    db,
    `INSERT INTO feishu_documents(
      video_id, report_hash, document_id, document_url, folder_token, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      report_hash=VALUES(report_hash), document_id=VALUES(document_id), document_url=VALUES(document_url),
      folder_token=VALUES(folder_token), updated_at=VALUES(updated_at)`,
    [input.videoId, input.reportHash, input.documentId, input.documentUrl, input.folderToken || "", timestamp, timestamp],
  );
}

export async function getFeishuFolder(scopeKey: string) {
  const db = await getDb();
  return queryRow(db, "SELECT * FROM feishu_folders WHERE scope_key=?", [scopeKey]);
}

export async function saveFeishuFolder(input: { scopeKey: string; folderToken: string; folderUrl?: string; parentToken?: string }) {
  const timestamp = now();
  const db = await getDb();
  await execute(
    db,
    `INSERT INTO feishu_folders(
      scope_key, folder_token, folder_url, parent_token, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE folder_token=VALUES(folder_token), folder_url=VALUES(folder_url),
      parent_token=VALUES(parent_token), updated_at=VALUES(updated_at)`,
    [input.scopeKey, input.folderToken, input.folderUrl || "", input.parentToken || "", timestamp, timestamp],
  );
}
