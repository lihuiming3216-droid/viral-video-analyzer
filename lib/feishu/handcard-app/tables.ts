import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getDb, getFeishuFieldMapping, type FeishuFieldMappingConfig } from "@/lib/database";
import { execute, queryRow } from "@/lib/db/query";
import { ensureFeishuConnection, getConnectedFeishuChannel } from "@/lib/feishu/runtime";
import { currentIdentity, userApi } from "@/lib/feishu/handcard-app/auth";
import { HandcardAppError, parseTableLink, validateTableId, selectHandcardMap, handcardKeys, type TableField, type HandcardMap } from "@/lib/feishu/handcard-app/core";

type Session = { token: string; openId: string };
type Page<T> = { items?: T[]; has_more?: boolean; page_token?: string };
type Table = { table_id: string; name: string };
const segment = encodeURIComponent;

/** Stop on incomplete/cyclic pagination instead of silently showing a partial schema. */
export async function collectPages<T>(load: (cursor: string) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor = "";
  for (let n = 0; n < 20; n++) {
    const page = await load(cursor);
    if (!Array.isArray(page?.items)) throw new HandcardAppError("飞书未返回完整表格信息，请稍后重新读取。", 502);
    items.push(...page.items);
    if (page.has_more === false) return items;
    if (page.has_more !== true || !page.page_token || seen.has(page.page_token)) break;
    seen.add(page.page_token);
    cursor = page.page_token;
  }
  throw new HandcardAppError("飞书分页信息不完整，未保存任何配置，请重新读取。", 502);
}

export async function discoverTables(session: Session, link: unknown) {
  const user = await currentIdentity(session.token);
  if (user.openId !== session.openId) throw new HandcardAppError("登录身份发生变化，请重新登录。", 401);
  const parsed = parseTableLink(link);
  let appToken = parsed.token;
  if (parsed.kind === "wiki") {
    const { data } = await userApi<{ node?: { obj_type: string; obj_token?: string } }>(session.token,
      `/open-apis/wiki/v2/spaces/get_node?token=${segment(parsed.token)}`);
    if (data?.node?.obj_type !== "bitable" || !data.node.obj_token) throw new HandcardAppError("此知识库链接不是多维表格，请复制正确链接。");
    appToken = data.node.obj_token;
  }
  if (!/^[A-Za-z0-9]{5,100}$/.test(appToken)) throw new HandcardAppError("飞书返回的表格编号无效。", 502);
  const permissionPath = `/open-apis/drive/v1/permissions/${segment(appToken)}/members/auth?type=bitable&action=edit`;
  const permission = await userApi<{ auth_result: boolean }>(session.token, permissionPath);
  if (permission.data?.auth_result !== true) throw new HandcardAppError("你没有此多维表格的编辑权限，不能修改配置。", 403);
  const tables = await collectPages<Table>(async cursor => (await userApi<Page<Table>>(session.token,
    `/open-apis/bitable/v1/apps/${segment(appToken)}/tables?page_size=100${cursor ? `&page_token=${segment(cursor)}` : ""}`)).data);
  return { appToken, tables, suggestedTableId: parsed.tableId };
}

/** Check the actual executor, not just the new login application's access. */
export async function executorFields(appToken: string, tableId: string) {
  const channel = getConnectedFeishuChannel() || await ensureFeishuConnection();
  if (!channel) throw new HandcardAppError("原手卡服务未连接，请联系管理员。", 503);
  const permission = await channel.rawClient.request<{ code?: number; data?: { auth_result?: boolean } }>({
    url: `/open-apis/drive/v1/permissions/${segment(appToken)}/members/auth`, method: "GET", params: { type: "bitable", action: "edit" },
  }).catch(() => null);
  if (!permission || permission.code !== 0 || permission.data?.auth_result !== true) {
    throw new HandcardAppError("请先给原来负责生成手卡的飞书应用添加此表格的编辑权限，再重新读取。", 403);
  }
  return collectPages<TableField>(async cursor => {
    const result = await channel.rawClient.request<{ code?: number; data?: Page<TableField> }>({
      url: `/open-apis/bitable/v1/apps/${segment(appToken)}/tables/${segment(tableId)}/fields`, method: "GET",
      params: { page_size: 100, ...(cursor ? { page_token: cursor } : {}) },
    }).catch(() => null);
    if (!result || result.code !== 0 || !result.data) throw new HandcardAppError("原手卡应用无法读取该数据表，请检查高级权限和字段授权。", 403);
    return result.data;
  });
}

export function mappingRevision(mapping: FeishuFieldMappingConfig | null) {
  return createHash("sha256").update(JSON.stringify(mapping)).digest("hex");
}

export async function loadTable(session: Session, link: unknown, selected: unknown) {
  const discovered = await discoverTables(session, link);
  const tableId = validateTableId(selected || discovered.suggestedTableId);
  const table = discovered.tables.find(item => item.table_id === tableId);
  if (!table) throw new HandcardAppError("所选数据表不属于这个多维表格，或你无权访问。", 403);
  const { appToken } = discovered;
  const userFields = await collectPages<TableField>(async cursor => (await userApi<Page<TableField>>(session.token,
    `/open-apis/bitable/v1/apps/${segment(appToken)}/tables/${segment(tableId)}/fields?page_size=100${cursor ? `&page_token=${segment(cursor)}` : ""}`)).data);
  const executionFields = await executorFields(appToken, tableId);
  const fields = userFields.filter(field => executionFields.some(other => other.field_id === field.field_id && other.type === field.type && other.field_name === field.field_name));
  const existing = await getFeishuFieldMapping(`${appToken}:${tableId}`);
  const defaults = { pid: "商品ID", productName: "产品名称", productDocument: "产品手卡", productCardStatus: "手卡状态" };
  const selectedFields = Object.fromEntries(handcardKeys.map(key => {
    const name = existing?.fieldMap[key] ?? defaults[key];
    const field = fields.find(item => item.field_name === name) || (key === "pid" && !existing?.fieldMap.pid ? fields.find(item => item.field_name === "PID") : undefined);
    return [key, field?.field_id || ""];
  }));
  return { appToken, tableId, tableName: table.name, fields, selectedFields, revision: mappingRevision(existing) };
}

/** Transaction + row lock preserves unrelated video mappings and prevents stale saves. */
export async function saveMapping(input: { appToken: string; tableId: string; tableName: string; map: HandcardMap; revision: string; openId: string }) {
  const db = await getDb();
  const connection = await db.getConnection();
  const scope = `${input.appToken}:${input.tableId}`;
  try {
    await connection.beginTransaction();
    // INSERT IGNORE serializes the initially-absent row without replacing existing data.
    const inserted = await execute(connection, `INSERT IGNORE INTO feishu_field_mappings
      (scope_key, label, field_map_json, aliases_json, updated_at) VALUES (?, '', '{}', '{}', '')`, [scope]);
    const row = await queryRow(connection, "SELECT * FROM feishu_field_mappings WHERE scope_key=? FOR UPDATE", [scope]);
    const decode = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value || {};
    const existing = inserted.affectedRows ? null : {
      scopeKey: scope, label: String(row!.label), fieldMap: decode(row!.field_map_json), aliases: decode(row!.aliases_json), updatedAt: String(row!.updated_at),
    } satisfies FeishuFieldMappingConfig;
    if (mappingRevision(existing) !== input.revision) throw new HandcardAppError("其他同事刚修改了配置，请重新读取后再保存。", 409);
    const fieldMap = { ...existing?.fieldMap, ...input.map };
    // Explicit selection must not retain old aliases for these four fields.
    const aliases = { ...existing?.aliases };
    for (const key of handcardKeys) delete aliases[key];
    const updatedAt = new Date().toISOString();
    await execute(connection, `UPDATE feishu_field_mappings SET label=?, field_map_json=?, aliases_json=?, updated_at=? WHERE scope_key=?`,
      [existing?.label || input.tableName, JSON.stringify(fieldMap), JSON.stringify(aliases), updatedAt, scope]);
    await execute(connection, `INSERT INTO feishu_handcard_config_audit
      (id, scope_key, open_id, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), scope, input.openId, JSON.stringify(existing), JSON.stringify({ fieldMap, aliases }), updatedAt]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    if (code === "ER_LOCK_DEADLOCK" || code === "ER_LOCK_WAIT_TIMEOUT") {
      throw new HandcardAppError("其他同事正在修改配置，请重新读取后再保存。", 409);
    }
    throw error;
  }
  finally { connection.release(); }
}

export async function saveTable(session: Session, input: Record<string, unknown>) {
  if (typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision)) throw new HandcardAppError("请先读取表格，再保存配置。");
  // Recheck identity, permissions and real column types for EVERY save.
  const table = await loadTable(session, input.link, input.tableId);
  const map = selectHandcardMap(input.fields, table.fields);
  await saveMapping({ ...table, map, revision: input.revision, openId: session.openId });
  return { appToken: table.appToken, tableId: table.tableId, message: "配置已保存。请在对应表格设置按钮自动化；保存配置不会自动生成手卡。" };
}
