/** Pure validation shared by the application routes and their offline tests. */
export class HandcardAppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const handcardKeys = ["pid", "productName", "productDocument", "productCardStatus"] as const;
export type HandcardKey = typeof handcardKeys[number];
export type HandcardMap = Record<HandcardKey, string>;
export type TableField = { field_id: string; field_name: string; type: number };

export function appConfig() {
  const appId = process.env.FEISHU_HANDCARD_APP_ID?.trim() || "";
  const appSecret = process.env.FEISHU_HANDCARD_APP_SECRET?.trim() || "";
  const tenantKey = process.env.FEISHU_HANDCARD_TENANT_KEY?.trim() || "";
  let origin: URL;
  try { origin = new URL(process.env.FEISHU_HANDCARD_ORIGIN || ""); }
  catch { throw new HandcardAppError("手卡应用尚未配置，请联系管理员。", 503); }
  if (!/^cli_[A-Za-z0-9]+$/.test(appId) || !appSecret || !tenantKey
    || origin.protocol !== "https:" || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new HandcardAppError("手卡应用配置不完整，需要应用凭证、企业编号和 HTTPS 地址。", 503);
  }
  return { appId, appSecret, tenantKey, origin: origin.origin,
    callback: `${origin.origin}/feishu/handcard/auth/callback` };
}

export function parseTableLink(value: unknown) {
  let url: URL;
  try { url = new URL(typeof value === "string" ? value.trim() : ""); }
  catch { throw new HandcardAppError("请粘贴飞书多维表格链接。"); }
  if (url.href.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.port
    || !(url.hostname === "feishu.cn" || url.hostname.endsWith(".feishu.cn"))) {
    throw new HandcardAppError("仅支持飞书官方的 HTTPS 多维表格链接。");
  }
  const match = url.pathname.match(/^\/(base|wiki)\/([A-Za-z0-9]{5,100})\/?$/);
  if (!match) throw new HandcardAppError("请复制多维表格或知识库内多维表格的链接，普通电子表格不支持。");
  const tableId = url.searchParams.get("table") || "";
  if (tableId && !/^tbl[A-Za-z0-9]{5,100}$/.test(tableId)) throw new HandcardAppError("链接中的数据表编号无效。");
  return { kind: match[1], token: match[2], tableId };
}

export function validateTableId(value: unknown) {
  if (typeof value !== "string" || !/^tbl[A-Za-z0-9]{5,100}$/.test(value)) throw new HandcardAppError("请选择有效的数据表。");
  return value;
}

export function selectHandcardMap(value: unknown, fields: TableField[]): HandcardMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HandcardAppError("请选择对应字段。");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !handcardKeys.includes(key as HandcardKey))) throw new HandcardAppError("此页面只能修改手卡字段。");
  const result = {} as HandcardMap;
  const used = new Set<string>();
  for (const key of handcardKeys) {
    const id = input[key];
    if (typeof id !== "string") throw new HandcardAppError("字段选择不完整。");
    if (!id && (key === "productName" || key === "productCardStatus")) { result[key] = ""; continue; }
    const field = fields.find(item => item.field_id === id);
    if (!field) throw new HandcardAppError("字段已删除或未选择，请重新读取表格。");
    if (used.has(id)) throw new HandcardAppError("不同用途不能选择同一列。");
    used.add(id);
    if (field.type !== 1) throw new HandcardAppError(key === "pid"
      ? "PID 必须使用文本列，数字列会丢失长编号的精度。"
      : "此版本请使用文本列；不支持公式、附件或超链接类型的列。");
    result[key] = field.field_name;
  }
  return result;
}

export function assertSameOrigin(headers: Headers, origin: string) {
  if (headers.get("origin") !== origin || headers.get("sec-fetch-site") === "cross-site") {
    throw new HandcardAppError("请求来源不正确，请从飞书应用重新打开。", 403);
  }
}
