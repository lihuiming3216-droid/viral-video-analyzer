import "server-only";

import { getDb } from "@/lib/database";
import { execute, queryRow } from "@/lib/db/query";
import type { FeishuConnectionState, FeishuSettings } from "@/lib/types";

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
