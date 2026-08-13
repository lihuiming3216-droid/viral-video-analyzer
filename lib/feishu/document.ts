import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { clearProductDocumentLink, getProduct, getVideo, updateProduct } from "@/lib/database";
import { formatTime } from "@/lib/json-utils";
import { resolveMediaPath } from "@/lib/video-processing";
import {
  getFeishuDocument, getFeishuFolder, getFeishuSettings, saveFeishuDocument,
  saveFeishuFolder, setFeishuRootFolder,
} from "@/lib/feishu/store";
import type { Product, SceneRecord, VideoRecord } from "@/lib/types";

const defaultProductTemplateToken = "B3GNdl05HoEdjnx8WPrcwC5Hnlg";

const productDocumentLockState = globalThis as typeof globalThis & {
  __viralProductDocumentLocks?: Map<string, Promise<void>>;
};
const productDocumentLocks = productDocumentLockState.__viralProductDocumentLocks
  ||= new Map<string, Promise<void>>();

async function withProductDocumentLock<T>(productId: string, operation: () => Promise<T>) {
  const previous = productDocumentLocks.get(productId) || Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  productDocumentLocks.set(productId, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (productDocumentLocks.get(productId) === tail) productDocumentLocks.delete(productId);
  }
}

export async function setCompanyManaged(client: Client, documentId: string) {
  const response = await client.drive.v2.permissionPublic.patch({
    path: { token: documentId },
    params: { type: "docx" },
    data: {
      external_access_entity: "closed",
      link_share_entity: "tenant_editable",
      share_entity: "same_tenant",
      manage_collaborator_entity: "collaborator_can_edit",
      security_entity: "anyone_can_edit",
    },
  });
  apiError(response, "设置文档公司内管理权限失败");
  return response.data?.permission_public;
}

export async function getCompanyDocumentPermission(client: Client, documentId: string) {
  const response = await client.drive.v2.permissionPublic.get({
    path: { token: documentId },
    params: { type: "docx" },
  });
  apiError(response, "读取文档权限失败");
  return response.data?.permission_public;
}

function apiError(response: { code?: number; msg?: string } | null | undefined, fallback: string) {
  if (response?.code && response.code !== 0) throw new Error(response.msg || fallback);
}

function productDocumentApiError(
  response: { code?: number; msg?: string } | null | undefined,
  action: string,
) {
  if (!response?.code || response.code === 0) return;
  const detail = response.msg?.trim() || `飞书错误码 ${response.code}`;
  const error = new Error(`${action}：${detail}`) as Error & { feishuCode?: number };
  error.feishuCode = response.code;
  throw error;
}

function feishuFailureDetails(value: unknown) {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const response = record.response && typeof record.response === "object"
    ? record.response as Record<string, unknown>
    : {};
  const data = response.data && typeof response.data === "object"
    ? response.data as Record<string, unknown>
    : {};
  const rawCode = data.code ?? record.feishuCode ?? record.code;
  const numericCode = typeof rawCode === "number" ? rawCode : Number(rawCode);
  const messages = [data.msg, data.message, record.msg, record.message]
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  return {
    code: Number.isFinite(numericCode) ? numericCode : undefined,
    message: messages.join("；"),
  };
}

function productDocumentOperationError(action: string, value: unknown) {
  const failure = feishuFailureDetails(value);
  const fallback = value instanceof Error ? value.message : String(value);
  const error = new Error(`${action}：${failure.message || fallback}`) as Error & { feishuCode?: number };
  error.feishuCode = failure.code;
  return error;
}

function isMissingProductDocumentError(value: unknown) {
  const code = feishuFailureDetails(value).code;
  return code != null && [1770002, 1770003, 1063005, 1061007].includes(code);
}

function requiredToken(value: string | null | undefined, label: string) {
  const token = value?.trim();
  if (!token) throw new Error(`缺少${label}`);
  return token;
}

function sanitizedName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

function safeName(value: string) {
  return sanitizedName(value).slice(0, 90) || "未命名";
}

export type ProductDocumentStableKey = {
  appToken: string;
  tableId: string;
  recordId: string;
};

function normalizedProductDocumentStableKey(key: ProductDocumentStableKey) {
  const appToken = key.appToken.trim();
  const tableId = key.tableId.trim();
  const recordId = key.recordId.trim();
  if (!appToken || !tableId || !recordId) {
    throw new Error("创建产品手卡文档壳需要完整的 appToken、tableId 和 recordId");
  }
  return { appToken, tableId, recordId };
}

function productDocumentShellSuffix(key: ProductDocumentStableKey) {
  const normalized = normalizedProductDocumentStableKey(key);
  const digest = createHash("sha256")
    .update(`${normalized.appToken}\0${normalized.tableId}\0${normalized.recordId}`)
    .digest("hex")
    .slice(0, 24);
  return `_手卡_${digest}`;
}

/**
 * A Base record is available before product parsing succeeds, so its resource
 * coordinates are the stable identity for a two-stage product-card shell.
 * The mutable product name is kept outside the hashed suffix and may be absent.
 */
export function productDocumentShellStableTitle(
  productName: string | null | undefined,
  key: ProductDocumentStableKey,
) {
  const suffix = productDocumentShellSuffix(key);
  const normalizedName = sanitizedName(String(productName || "")) || "待补产品";
  const prefixLength = Math.max(1, 90 - suffix.length);
  return `${normalizedName.slice(0, prefixLength)}${suffix}`;
}

/** Keep the PID suffix intact when a long product name must be truncated. */
export function productDocumentStableTitle(productName: string, pid: string) {
  const normalizedPid = sanitizedName(pid);
  if (!normalizedPid) throw new Error("创建产品文档前必须有 PID");
  const suffix = `_${normalizedPid}`;
  const normalizedName = sanitizedName(productName) || "未命名";
  const prefixLength = Math.max(1, 90 - suffix.length);
  return `${normalizedName.slice(0, prefixLength)}${suffix}`;
}

/** Rename a Docx without changing any template or user-authored blocks. */
export async function renameProductCardDocument(
  client: Client,
  documentId: string,
  productName: string,
  pid: string,
) {
  const title = productDocumentStableTitle(productName, pid);
  const response = await client.docx.v1.documentBlock.patch({
    path: { document_id: documentId, block_id: documentId },
    data: {
      update_text_elements: {
        elements: [{ text_run: { content: title } }],
      },
    },
  });
  productDocumentApiError(response, "重命名产品手卡失败");
  return title;
}

function md(value: string | null | undefined) {
  return String(value || "—").replace(/([\\`*_{}\[\]()#+.!|>~-])/g, "\\$1");
}

function reportHash(video: VideoRecord) {
  return createHash("sha256").update(JSON.stringify({
    analysis: video.analysis,
    original: video.transcriptOriginal,
    translation: video.transcriptZh,
    scenes: video.scenes,
    scores: video.scores,
  })).digest("hex");
}

function sceneTime(scene: SceneRecord) {
  return `${formatTime(scene.startSeconds)}–${formatTime(scene.endSeconds)}`;
}

function buildReportMarkdown(video: VideoRecord) {
  const analysis = video.analysis;
  const scenes = video.scenes || [];
  const viral = analysis?.viralPoints?.map((point) => `- **${md(point.timeRange)}** ${md(point.description)}：${md(point.reason)}`).join("\n") || "暂无明确爆点记录。";
  const strengths = analysis?.strengths?.map((item) => `- ${md(item)}`).join("\n") || "暂无。";
  const weaknesses = analysis?.weaknesses?.map((item) => `- ${md(item)}`).join("\n") || "暂无。";
  const timeline = scenes.map((scene) => `### 镜头 ${scene.shotIndex}｜${sceneTime(scene)}｜${md(scene.role)}

**画面：** ${md(scene.visualDescription)}

**声音：** ${md(scene.audioDescription)}

**原文案：** ${md(scene.transcriptOriginal)}

**中文翻译：** ${md(scene.translationZh)}

**拍得好的地方：** ${md(scene.strengths)}

**需要改进：** ${md(scene.weaknesses)}

**镜头评分：** 流量 ${scene.scoreTraffic}｜转化 ${scene.scoreConversion}｜清晰度 ${scene.scoreClarity}｜美感 ${scene.scoreAesthetic}｜光线 ${scene.scoreLighting}｜产品主体 ${scene.scoreProduct}`).join("\n\n---\n\n");

  return `# 核心结论

${md(video.summary || "分析已完成")}

**产品：** ${md(video.productName)}

**账号：** ${md(video.accountName ? `@${video.accountName}` : "待获取")}

**发布时间：** ${md(video.publishedAt?.slice(0, 10) || "待获取")}

**识别语言：** ${md(video.language || "待识别")}

**原视频：** ${video.sourceUrl ? `[打开 TikTok 原视频](${video.sourceUrl})` : "本地上传视频"}

## 六维评分

- 流量潜力：**${video.scores.traffic}**
- 带货转化：**${video.scores.conversion}**
- 画面质量：**${video.scores.visual}**
- 产品展示：**${video.scores.product}**
- 声音情绪：**${video.scores.audio}**
- 节奏完播：**${video.scores.rhythm}**

## 前 3 秒钩子

**${md(analysis?.hook?.timeRange || "00:00–00:03")}｜${md(analysis?.hook?.type || "开场钩子")}**

${md(analysis?.hook?.description || video.hookSummary)}

${md(analysis?.hook?.whyItWorks)}

## 爆点与成交点

${viral}

## 拍得好的地方

${strengths}

## 问题与改进方向

${weaknesses}

## 爆款结构

${md(analysis?.structureFormula)}

## 原语言文案

${md(video.transcriptOriginal || "暂无原文案")}

## 中文翻译

${md(video.transcriptZh || "暂无中文翻译")}

## 逐镜头画面与声音分析

${timeline || "暂无逐镜头记录。"}

## 关键截图与爆点片段

以下素材由爆片分析自动提取并保存在本报告中。`;
}

function keyScenes(video: VideoRecord) {
  const scenes = video.scenes || [];
  const selected = scenes.filter((scene) => /钩子|爆点|hook|viral/i.test(`${scene.role} ${scene.tags.join(" ")}`));
  const fallback = [...scenes].sort((a, b) => b.importance - a.importance);
  return [...new Map([...selected, ...fallback].map((scene) => [scene.id, scene])).values()].slice(0, 4);
}

async function throttle() {
  await new Promise((resolve) => setTimeout(resolve, 380));
}

async function rootFolderToken(client: Client) {
  const cached = getFeishuFolder("drive-root");
  if (cached?.folder_token) return String(cached.folder_token);
  const response = await client.request<{ code?: number; msg?: string; data?: { token?: string; url?: string } }>({
    url: "/open-apis/drive/explorer/v2/root_folder/meta",
    method: "GET",
  });
  apiError(response, "无法获取飞书云空间根目录");
  const token = response.data?.token;
  if (!token) throw new Error("飞书没有返回云空间根目录 Token");
  saveFeishuFolder({ scopeKey: "drive-root", folderToken: token, folderUrl: response.data?.url || "" });
  return token;
}

async function findChildFolder(client: Client, parentToken: string, name: string) {
  const response = await client.drive.v1.file.list({ params: { folder_token: parentToken, page_size: 200 } });
  apiError(response, "读取飞书报告文件夹失败");
  return response.data?.files?.find((item) => item.type === "folder" && item.name === name) || null;
}

async function ensureFolder(client: Client, scopeKey: string, parentToken: string, name: string) {
  const cached = getFeishuFolder(scopeKey);
  if (cached?.folder_token) return String(cached.folder_token);
  const existing = await findChildFolder(client, parentToken, name);
  if (existing?.token) {
    saveFeishuFolder({ scopeKey, folderToken: existing.token, folderUrl: existing.url, parentToken });
    return existing.token;
  }
  const response = await client.drive.v1.file.createFolder({ data: { name, folder_token: parentToken } });
  apiError(response, `创建飞书文件夹“${name}”失败`);
  const token = response.data?.token;
  if (!token) throw new Error(`飞书没有返回文件夹“${name}”的 Token`);
  saveFeishuFolder({ scopeKey, folderToken: token, folderUrl: response.data?.url, parentToken });
  return token;
}

async function ensureArchiveFolder(client: Client, video: VideoRecord) {
  const settings = getFeishuSettings();
  let base = settings.rootFolderToken;
  if (!base) {
    const root = await rootFolderToken(client);
    const scopeKey = `report-root:${root}`;
    base = await ensureFolder(client, scopeKey, root, "爆片分析报告");
    const reportFolder = getFeishuFolder(scopeKey);
    setFeishuRootFolder(base, reportFolder?.folder_url ? String(reportFolder.folder_url) : "");
  }
  const product = await ensureFolder(client, `product:${base}:${video.productId}`, base, safeName(video.productName));
  const monthName = (video.publishedAt || video.createdAt || new Date().toISOString()).slice(0, 7);
  return ensureFolder(client, `month:${product}:${monthName}`, product, monthName);
}

function sanitizeConvertedBlocks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeConvertedBlocks);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "merge_info")
    .map(([key, child]) => [key, sanitizeConvertedBlocks(child)]));
}

async function addMarkdown(client: Client, documentId: string, content: string) {
  const converted = await client.docx.v1.document.convert({ data: { content_type: "markdown", content } });
  apiError(converted, "飞书报告内容转换失败");
  const childrenId = converted.data?.first_level_block_ids || [];
  const descendants = sanitizeConvertedBlocks(converted.data?.blocks || []) as NonNullable<Parameters<typeof client.docx.v1.documentBlockDescendant.create>[0]>["data"]["descendants"];
  if (!childrenId.length || !descendants.length) return;
  const created = await client.docx.v1.documentBlockDescendant.create({
    path: { document_id: documentId, block_id: documentId },
    data: { children_id: childrenId, descendants },
  });
  apiError(created, "写入飞书报告失败");
}

async function addSceneMedia(client: Client, documentId: string, scene: SceneRecord) {
  const children: Array<Record<string, unknown>> = [{
    block_type: 2,
    text: { elements: [{ text_run: { content: `镜头 ${scene.shotIndex}｜${sceneTime(scene)}｜${scene.role}` } }] },
  }];
  if (scene.screenshotPath) children.push({ block_type: 27, image: { caption: { content: `镜头 ${scene.shotIndex} 关键画面` } } });
  if (scene.clipPath) children.push({ block_type: 23, file: { view_type: 1 } });
  const created = await client.docx.v1.documentBlockChildren.create({
    path: { document_id: documentId, block_id: documentId },
    params: { client_token: randomUUID() },
    data: { children: children as never },
  });
  apiError(created, "创建飞书报告媒体位置失败");
  const blocks = created.data?.children || [];
  let blockIndex = 1;

  if (scene.screenshotPath) {
    const imageBlock = blocks[blockIndex++];
    if (imageBlock?.block_id) {
      const absolute = resolveMediaPath(scene.screenshotPath);
      const size = statSync(absolute).size;
      if (size <= 20 * 1024 * 1024) {
        const uploaded = await client.drive.v1.media.uploadAll({ data: {
          file_name: path.basename(absolute), parent_type: "docx_image", parent_node: imageBlock.block_id,
          size, file: createReadStream(absolute),
        } });
        if (uploaded?.file_token) {
          await throttle();
          const patched = await client.docx.v1.documentBlock.patch({
            path: { document_id: documentId, block_id: imageBlock.block_id },
            data: { replace_image: { token: uploaded.file_token } },
          });
          apiError(patched, "插入关键截图失败");
        }
      }
    }
  }

  if (scene.clipPath) {
    const fileBlock = blocks[blockIndex];
    if (fileBlock?.block_id) {
      const absolute = resolveMediaPath(scene.clipPath);
      const size = statSync(absolute).size;
      if (size <= 20 * 1024 * 1024) {
        const uploaded = await client.drive.v1.media.uploadAll({ data: {
          file_name: `镜头-${scene.shotIndex}-爆点片段${path.extname(absolute) || ".mp4"}`,
          parent_type: "docx_file", parent_node: fileBlock.block_id, size, file: createReadStream(absolute),
        } });
        if (uploaded?.file_token) {
          await throttle();
          const patched = await client.docx.v1.documentBlock.patch({
            path: { document_id: documentId, block_id: fileBlock.block_id },
            data: { replace_file: { token: uploaded.file_token } },
          });
          apiError(patched, "插入爆点片段失败");
        }
      }
    }
  }
}

async function documentUrl(client: Client, documentId: string) {
  const meta = await client.drive.v1.meta.batchQuery({
    params: { user_id_type: "open_id" },
    data: { request_docs: [{ doc_token: documentId, doc_type: "docx" }], with_url: true },
  });
  apiError(meta, "读取飞书报告链接失败");
  return meta.data?.metas?.[0]?.url || `https://feishu.cn/docx/${documentId}`;
}

type ProductFolderOwner = {
  folderToken: string;
  folderName: string;
  ownerId: string;
  ownerMemberType: "openid";
  ownerSource: "input" | "environment";
  folderMetaOwnerId: string;
};

function resolveProductDocumentOwnerOpenId(inputOwnerOpenId?: string) {
  const input = inputOwnerOpenId?.trim();
  const ownerOpenId = input || process.env.FEISHU_PRODUCT_DOCUMENT_OWNER_OPEN_ID?.trim();
  if (!ownerOpenId) {
    throw new Error("缺少产品文档所有者 OpenID，请配置 FEISHU_PRODUCT_DOCUMENT_OWNER_OPEN_ID");
  }
  if (!/^ou_[A-Za-z0-9_-]+$/.test(ownerOpenId)) {
    throw new Error("产品文档所有者 OpenID 格式不正确，应以 ou_ 开头");
  }
  return { ownerOpenId, ownerSource: input ? "input" as const : "environment" as const };
}

/** Verify folder access and the exact user/group permissions needed by automation. */
export async function validateProductDocumentFolder(
  client: Client,
  folderTokenValue: string,
  inputOwnerOpenId?: string,
): Promise<ProductFolderOwner> {
  const folderToken = requiredToken(folderTokenValue, "飞书产品文档文件夹 Token");
  const { ownerOpenId, ownerSource } = resolveProductDocumentOwnerOpenId(inputOwnerOpenId);
  let response: {
    code?: number;
    msg?: string;
    data?: { id?: string; name?: string; token?: string; ownUid?: string };
  };
  try {
    response = await client.request({
      url: `/open-apis/drive/explorer/v2/folder/${encodeURIComponent(folderToken)}/meta`,
      method: "GET",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`读取飞书产品文档文件夹信息失败：${detail}`);
  }
  productDocumentApiError(response, "读取飞书产品文档文件夹信息失败");
  let membersResponse: Awaited<ReturnType<typeof client.drive.v1.permissionMember.list>>;
  try {
    membersResponse = await client.drive.v1.permissionMember.list({
      path: { token: folderToken },
      params: { type: "folder", fields: "name,type" },
    });
  } catch (error) {
    throw productDocumentOperationError("读取产品文档文件夹协作者失败", error);
  }
  productDocumentApiError(membersResponse, "读取产品文档文件夹协作者失败");
  const members = membersResponse.data?.items || [];
  const ownerMember = members.find((member) => member.member_type === "openid"
    && member.type === "user"
    && member.member_id === ownerOpenId
    && member.perm === "full_access");
  if (!ownerMember) {
    throw new Error("产品文档所有者 OpenID 不是该文件夹的直接可管理用户，请在飞书分享中将该用户设为“可管理”");
  }
  const managingGroup = members.find((member) => member.member_type === "openchat"
    && member.type === "chat"
    && member.perm === "full_access");
  if (!managingGroup) {
    throw new Error("产品文档文件夹缺少可管理群协作者，请将包含“爆片拆解”机器人的群设为“可管理”");
  }
  return {
    folderToken,
    folderName: response.data?.name?.trim() || "产品说明文档",
    ownerId: ownerOpenId,
    ownerMemberType: "openid",
    ownerSource,
    // Kept only for diagnostics. ownUid is not accepted by transfer_owner.
    folderMetaOwnerId: response.data?.ownUid?.trim() || "",
  };
}

async function resolveProductFolderOwner(
  client: Client,
  folderToken: string,
  ownerOpenId?: string,
): Promise<ProductFolderOwner> {
  return validateProductDocumentFolder(client, folderToken, ownerOpenId);
}

async function getProductDocumentOwner(
  client: Client,
  documentTokenValue: string,
) {
  const documentToken = requiredToken(documentTokenValue, "飞书产品文档 Token");
  let response: Awaited<ReturnType<typeof client.drive.v1.meta.batchQuery>>;
  try {
    response = await client.drive.v1.meta.batchQuery({
      params: { user_id_type: "open_id" },
      data: { request_docs: [{ doc_token: documentToken, doc_type: "docx" }] },
    });
  } catch (error) {
    throw productDocumentOperationError("读取飞书产品文档所有者失败", error);
  }
  productDocumentApiError(response, "读取飞书产品文档所有者失败");
  const failed = response.data?.failed_list?.find((item) => item.token === documentToken);
  if (failed) {
    throw productDocumentOperationError("读取飞书产品文档所有者失败", {
      code: failed.code,
      msg: `文档元数据查询失败（${failed.code}）`,
    });
  }
  const ownerId = response.data?.metas?.find((item) => item.doc_token === documentToken)?.owner_id?.trim();
  if (!ownerId) throw new Error("飞书产品文档没有返回所有者 ID，无法确认所有权状态");
  return ownerId;
}

async function isProductDocumentInFolder(client: Client, documentToken: string, folderToken: string) {
  let pageToken: string | undefined;
  do {
    let response: Awaited<ReturnType<typeof client.drive.v1.file.list>>;
    try {
      response = await client.drive.v1.file.list({
        params: { folder_token: folderToken, page_size: 200, ...(pageToken ? { page_token: pageToken } : {}) },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`检查产品文档所在文件夹失败：${detail}`);
    }
    productDocumentApiError(response, "检查产品文档所在文件夹失败");
    if (response.data?.files?.some((file) => file.token === documentToken && file.type === "docx")) return true;
    if (!response.data?.has_more) return false;
    pageToken = response.data.next_page_token?.trim();
    if (!pageToken) throw new Error("检查产品文档所在文件夹失败：飞书分页结果缺少下一页 Token");
  } while (pageToken);
  return false;
}

async function findProductDocumentByTitle(client: Client, folderToken: string, title: string) {
  let pageToken: string | undefined;
  do {
    let response: Awaited<ReturnType<typeof client.drive.v1.file.list>>;
    try {
      response = await client.drive.v1.file.list({
        params: {
          folder_token: folderToken,
          page_size: 200,
          order_by: "EditedTime",
          direction: "DESC",
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
    } catch (error) {
      throw productDocumentOperationError("查找已有同名产品文档失败", error);
    }
    productDocumentApiError(response, "查找已有同名产品文档失败");
    const match = response.data?.files?.find((file) => file.type === "docx" && file.name === title);
    if (match?.token) {
      return {
        documentId: match.token,
        documentUrl: match.url || `https://feishu.cn/docx/${match.token}`,
        title: match.name || title,
        type: "docx",
      };
    }
    if (!response.data?.has_more) return null;
    pageToken = response.data.next_page_token?.trim();
    if (!pageToken) throw new Error("查找已有同名产品文档失败：飞书分页结果缺少下一页 Token");
  } while (pageToken);
  return null;
}

async function findProductDocumentByTitleSuffix(client: Client, folderToken: string, titleSuffix: string) {
  let pageToken: string | undefined;
  do {
    let response: Awaited<ReturnType<typeof client.drive.v1.file.list>>;
    try {
      response = await client.drive.v1.file.list({
        params: {
          folder_token: folderToken,
          page_size: 200,
          order_by: "EditedTime",
          direction: "DESC",
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
    } catch (error) {
      throw productDocumentOperationError("按记录稳定键查找产品手卡失败", error);
    }
    productDocumentApiError(response, "按记录稳定键查找产品手卡失败");
    const matches = response.data?.files?.filter((file) => file.type === "docx"
      && Boolean(file.token)
      && Boolean(file.name?.endsWith(titleSuffix))) || [];
    if (matches.length > 1) throw new Error("同一记录稳定键匹配到多个产品手卡，已停止自动选择");
    const match = matches[0];
    if (match?.token) {
      return {
        documentId: match.token,
        documentUrl: match.url || `https://feishu.cn/docx/${match.token}`,
        title: match.name || `待补产品${titleSuffix}`,
        type: "docx",
      };
    }
    if (!response.data?.has_more) return null;
    pageToken = response.data.next_page_token?.trim();
    if (!pageToken) throw new Error("按记录稳定键查找产品手卡失败：飞书分页结果缺少下一页 Token");
  } while (pageToken);
  return null;
}

function productDocumentTokenFromUrl(documentUrl: string) {
  try {
    const url = new URL(documentUrl);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:"
      || !(host === "feishu.cn" || host.endsWith(".feishu.cn")
        || host === "larksuite.com" || host.endsWith(".larksuite.com"))) return "";
    return decodeURIComponent(url.pathname.match(/\/docx\/([A-Za-z0-9_-]+)/)?.[1] || "");
  } catch {
    return "";
  }
}

export type EnsureProductCardShellInput = {
  recordKey?: ProductDocumentStableKey;
  existingDocumentId?: string | null;
  existingDocumentUrl?: string | null;
  name?: string;
  productUrl?: string;
  pid?: string;
  templateToken?: string;
  ownerOpenId?: string;
  /** Let a two-stage caller clear stale derived fields before changing identity. */
  deferIdentity?: boolean;
};

function suppliedProductCardDocument(input: EnsureProductCardShellInput) {
  const documentId = String(input.existingDocumentId || "").trim();
  const documentUrl = String(input.existingDocumentUrl || "").trim();
  const urlDocumentId = documentUrl ? productDocumentTokenFromUrl(documentUrl) : "";
  if (documentUrl && !urlDocumentId) throw new Error("已有产品手卡链接不是有效的飞书 docx 链接");
  if (documentId && urlDocumentId && documentId !== urlDocumentId) {
    throw new Error("已有产品手卡的 documentId 与链接 Token 不一致");
  }
  const resolvedId = documentId || urlDocumentId;
  return resolvedId ? {
    documentId: resolvedId,
    documentUrl: documentUrl || `https://feishu.cn/docx/${resolvedId}`,
  } : null;
}

/**
 * Stage one of product-card automation. It creates or adopts a stable template
 * document before any product-page parsing and does not require a PID or URL.
 */
export async function ensureProductCardShell(
  client: Client,
  input: EnsureProductCardShellInput,
) {
  const supplied = suppliedProductCardDocument(input);
  if (!supplied && !input.recordKey) {
    throw new Error("创建产品手卡文档壳需要记录稳定键或已有文档 ID/链接");
  }
  const stableSuffix = input.recordKey ? productDocumentShellSuffix(input.recordKey) : "";
  const lockKey = stableSuffix ? `record${stableSuffix}` : `document_${supplied!.documentId}`;
  return withProductDocumentLock(lockKey, async () => {
    const settings = getFeishuSettings();
    const productFolderToken = requiredToken(
      settings.productFolderToken,
      "飞书产品文档文件夹配置，请先配置“产品说明文档”文件夹",
    );
    const stableTitle = input.recordKey
      ? productDocumentShellStableTitle(input.name, input.recordKey)
      : safeName(input.name || "待补产品");
    let document: { documentId: string; documentUrl: string; title: string; type: string } | null = null;
    let reused = false;
    let ownershipWarning = "";

    if (supplied) {
      try {
        await getProductDocumentOwner(client, supplied.documentId);
        document = { ...supplied, title: stableTitle, type: "docx" };
        reused = true;
      } catch (error) {
        if (isMissingProductDocumentError(error)) {
          if (!input.recordKey) throw error;
        } else {
          // Metadata/owner lookup is advisory here. The already-known shell URL
          // must survive transient Drive and permission errors; the repair is
          // retried below and the warning remains visible to the caller.
          document = { ...supplied, title: stableTitle, type: "docx" };
          reused = true;
          ownershipWarning = error instanceof Error
            ? error.message
            : "读取产品手卡所有者失败";
        }
      }
    }
    if (!document && input.recordKey) {
      const existing = await findProductDocumentByTitleSuffix(client, productFolderToken, stableSuffix);
      document = existing || await copyFeishuTemplateDocument(client, {
        templateToken: input.templateToken?.trim()
          || process.env.FEISHU_PRODUCT_TEMPLATE_TOKEN?.trim()
          || defaultProductTemplateToken,
        name: stableTitle,
        folderToken: productFolderToken,
      });
      reused = Boolean(existing);
    }
    if (!document) throw new Error("创建或复用产品手卡文档壳失败");

    let permissionWarning = "";
    try { await setCompanyManaged(client, document.documentId); }
    catch (error) { permissionWarning = error instanceof Error ? error.message : "设置公司内管理权限失败"; }
    let identityWarning = "";
    if (!input.deferIdentity) {
      try {
        const identitySync = await syncProductCardManagedFields(client, {
          documentId: document.documentId,
          mode: "identity",
          name: input.name || "待补产品",
          productUrl: input.productUrl || "",
          pid: input.pid || "",
        });
        if (identitySync.missingLabels.length) {
          identityWarning = `产品手卡模板缺少基础字段：${identitySync.missingLabels.join("、")}`;
        }
      } catch (error) {
        // The shell already exists. Return its URL so callers can persist it and
        // surface the field-sync failure without losing the newly created card.
        identityWarning = error instanceof Error ? error.message : "写入产品手卡身份信息失败";
      }
    }
    let migration = {
      moved: false,
      ownershipTransferred: false,
      ownerId: "",
      ownerMemberType: "" as "" | "openid",
      ownerSource: "" as "" | "input" | "environment",
      folderName: "",
    };
    try {
      const owner = await resolveProductFolderOwner(client, productFolderToken, input.ownerOpenId);
      const ownershipTransferred = await ensureProductDocumentOwner(client, document.documentId, owner);
      migration = {
        moved: false,
        ownershipTransferred,
        ownerId: owner.ownerId,
        ownerMemberType: owner.ownerMemberType,
        ownerSource: owner.ownerSource,
        folderName: owner.folderName,
      };
    } catch (error) {
      // Ownership can be repaired on the next click. Do not hide a document
      // that has already been created successfully from the Base row.
      const repairWarning = error instanceof Error ? error.message : "设置产品手卡所有者失败";
      ownershipWarning = [ownershipWarning, repairWarning].filter(Boolean).join("；");
    }
    return {
      ...document,
      reused,
      permissionWarning,
      identityWarning,
      ownershipWarning,
      migration,
    };
  });
}

async function moveProductDocument(client: Client, documentToken: string, folderToken: string) {
  let response: Awaited<ReturnType<typeof client.drive.v1.file.move>>;
  try {
    response = await client.drive.v1.file.move({
      path: { file_token: documentToken },
      data: { type: "docx", folder_token: folderToken },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`移动产品文档到“产品说明文档”文件夹失败：${detail}`);
  }
  productDocumentApiError(response, "移动产品文档到“产品说明文档”文件夹失败");
}

async function transferProductDocumentOwner(
  client: Client,
  documentToken: string,
  owner: ProductFolderOwner,
) {
  let response: Awaited<ReturnType<typeof client.drive.v1.permissionMember.transferOwner>>;
  try {
    response = await client.drive.v1.permissionMember.transferOwner({
      path: { token: documentToken },
      params: {
        type: "docx",
        need_notification: false,
        stay_put: true,
        remove_old_owner: false,
        old_owner_perm: "full_access",
      },
      data: { member_type: owner.ownerMemberType, member_id: owner.ownerId },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`将产品文档所有者转为目标文件夹所有者失败：${detail}`);
  }
  productDocumentApiError(response, "将产品文档所有者转为目标文件夹所有者失败");
}

async function ensureProductDocumentOwner(
  client: Client,
  documentToken: string,
  owner: ProductFolderOwner,
) {
  const currentOwnerId = await getProductDocumentOwner(client, documentToken);
  if (currentOwnerId === owner.ownerId) return false;
  await transferProductDocumentOwner(client, documentToken, owner);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await throttle();
    const verifiedOwnerId = await getProductDocumentOwner(client, documentToken);
    if (verifiedOwnerId === owner.ownerId) return true;
  }
  throw new Error("飞书返回所有权转移成功，但复核时文档所有者仍未变更");
}

/** Explicit, idempotent migration used by the administrative migration API. */
export async function migrateProductDocument(
  client: Client,
  input: { documentToken: string; folderToken: string; ownerOpenId?: string },
) {
  const documentToken = requiredToken(input.documentToken, "飞书产品文档 Token");
  const folderToken = requiredToken(input.folderToken, "飞书产品文档文件夹 Token");
  const owner = await resolveProductFolderOwner(client, folderToken, input.ownerOpenId);
  const alreadyInFolder = await isProductDocumentInFolder(client, documentToken, folderToken);
  if (!alreadyInFolder) {
    await moveProductDocument(client, documentToken, folderToken);
    let moveVerified = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await throttle();
      if (await isProductDocumentInFolder(client, documentToken, folderToken)) {
        moveVerified = true;
        break;
      }
    }
    if (!moveVerified) {
      throw new Error("飞书返回文档移动成功，但复核时目标文件夹中仍未找到该文档");
    }
  }
  const ownershipTransferred = await ensureProductDocumentOwner(client, documentToken, owner);
  return {
    moved: !alreadyInFolder,
    ownershipTransferred,
    ownerId: owner.ownerId,
    ownerMemberType: owner.ownerMemberType,
    ownerSource: owner.ownerSource,
    folderName: owner.folderName,
  };
}

export async function copyFeishuTemplateDocument(
  client: Client,
  input: { templateToken: string; name: string; folderToken?: string },
) {
  const templateToken = input.templateToken.trim();
  const name = safeName(input.name);
  if (!templateToken) throw new Error("缺少飞书模板文档 Token");

  let response: {
    code?: number;
    msg?: string;
    data?: { file?: { token?: string; url?: string; name?: string; type?: string } };
  };
  try {
    response = await client.request({
      url: `/open-apis/drive/v1/files/${encodeURIComponent(templateToken)}/copy`,
      method: "POST",
      data: {
        name,
        type: "docx",
        folder_token: input.folderToken?.trim() || "",
      },
    });
  } catch (error) {
    throw productDocumentOperationError("复制飞书产品文档模板失败", error);
  }
  productDocumentApiError(response, "复制飞书产品文档模板失败");
  const file = response.data?.file;
  if (!file?.token) throw new Error("飞书复制模板成功，但没有返回新文档 Token");
  return {
    documentId: file.token,
    documentUrl: file.url || `https://feishu.cn/docx/${file.token}`,
    title: file.name || name,
    type: file.type || "docx",
  };
}

export async function listFeishuDocumentBlocks(client: Client, documentId: string) {
  const blocks: Array<Record<string, unknown>> = [];
  const seenPageTokens = new Set<string>();
  let pageToken = "";
  do {
    const response = await client.request<{
      code?: number;
      msg?: string;
      data?: { items?: Array<Record<string, unknown>>; page_token?: string; has_more?: boolean };
    }>({
      url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks`,
      method: "GET",
      params: {
        page_size: "500",
        document_revision_id: "-1",
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    apiError(response, "读取飞书文档结构失败");
    blocks.push(...(response.data?.items || []));
    if (!response.data?.has_more) break;
    const nextPageToken = response.data.page_token?.trim();
    if (!nextPageToken) throw new Error("读取飞书文档结构失败：分页结果缺少下一页 Token");
    if (seenPageTokens.has(nextPageToken)) throw new Error("读取飞书文档结构失败：分页 Token 重复");
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  } while (pageToken);
  return blocks;
}

/** Normalize the legacy product-template header in place. */
export async function normalizeProductTemplate(client: Client, documentId: string) {
  const blocks = await listFeishuDocumentBlocks(client, documentId);
  let updated = 0;
  for (const block of blocks) {
    const text = block.text as { elements?: Array<{ text_run?: { content?: string } }> } | undefined;
    const content = text?.elements?.map((element) => element.text_run?.content || "").join("") || "";
    const isLegacyHeader = content.includes("原口播文案") || content.trim() === "文案";
    if (!isLegacyHeader || !block.block_id) continue;
    const next = content.includes("原口播文案")
      ? content.replaceAll("原口播文案", "中文翻译")
      : content.replace(/^\s*文案\s*$/, "中文翻译");
    if (next !== content) {
      await updateFeishuTextBlock(client, documentId, String(block.block_id), next);
      updated += 1;
    }
  }
  return { scanned: blocks.length, updated };
}

export async function getFeishuDocumentBlock(client: Client, documentId: string, blockId: string) {
  const response = await client.request<{ code?: number; msg?: string; data?: { block?: Record<string, unknown> } }>({
    url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`,
    method: "GET",
    params: { document_revision_id: "-1" },
  });
  apiError(response, "读取飞书文档单元格失败");
  return response.data?.block || {};
}

export async function updateFeishuTextBlock(
  client: Client,
  documentId: string,
  blockId: string,
  content: string,
  options: { documentRevisionId?: number } = {},
) {
  return updateFeishuTextBlockElements(
    client,
    documentId,
    blockId,
    [{ text_run: { content } }],
    options,
  );
}

type FeishuTextElement = {
  text_run: {
    content: string;
    text_element_style?: {
      bold?: boolean;
      link?: { url: string };
    };
  };
};

export async function updateFeishuTextBlockElements(
  client: Client,
  documentId: string,
  blockId: string,
  elements: FeishuTextElement[],
  options: { documentRevisionId?: number } = {},
) {
  const response = await client.docx.v1.documentBlock.patch({
    path: { document_id: documentId, block_id: blockId },
    data: { update_text_elements: { elements } },
    params: options.documentRevisionId === undefined
      ? undefined
      : { document_revision_id: options.documentRevisionId },
  });
  apiError(response, "更新飞书文档文本失败");
}

export async function insertFeishuTableColumn(client: Client, documentId: string, tableBlockId: string, columnIndex: number) {
  const response = await client.docx.v1.documentBlock.patch({
    path: { document_id: documentId, block_id: tableBlockId },
    data: { insert_table_column: { column_index: columnIndex } },
  });
  apiError(response, "新增飞书文档表格列失败");
}

export async function deleteFeishuChildRange(
  client: Client,
  documentId: string,
  parentBlockId: string,
  startIndex: number,
  endIndex: number,
) {
  const response = await client.docx.v1.documentBlockChildren.batchDelete({
    path: { document_id: documentId, block_id: parentBlockId },
    data: { start_index: startIndex, end_index: endIndex },
  });
  apiError(response, "删除飞书文档内容失败");
}

function feishuBlockText(block: Record<string, unknown>) {
  const text = block.text as { elements?: Array<{ text_run?: { content?: string } }> } | undefined;
  return text?.elements?.map((element) => element.text_run?.content || "").join("").trim() || "";
}

/** Add the employee-maintained three-image prop area to a product-card template. */
export async function insertProductPropsSection(
  client: Client,
  documentId: string,
  parentBlockId: string,
  index: number,
) {
  const existingBlocks = await listFeishuDocumentBlocks(client, documentId);
  const existingHeading = existingBlocks.find((block) => feishuBlockText(block).includes("道具列表"));
  const existingTable = existingBlocks.find((block) => {
    const table = block.table as { property?: { row_size?: number; column_size?: number } } | undefined;
    return table?.property?.row_size === 1 && table.property.column_size === 3;
  });
  if (existingHeading && existingTable) {
    return { reused: true, tableBlockId: String(existingTable.block_id || "") };
  }

  const created = await client.docx.v1.documentBlockChildren.create({
    path: { document_id: documentId, block_id: parentBlockId },
    params: { client_token: randomUUID() },
    data: {
      index,
      children: [
        {
          block_type: 2,
          text: {
            style: { background_color: "LightPurpleBackground" },
            elements: [{
              text_run: {
                content: "🧰 道具列表（员工手动录入）",
                text_element_style: { bold: true },
              },
            }],
          },
        },
        {
          block_type: 31,
          table: {
            property: {
              row_size: 1,
              column_size: 3,
              column_width: [292, 292, 292],
            },
          },
        },
      ],
    },
  });
  apiError(created, "创建道具列表失败");
  await throttle();

  const blocks = await listFeishuDocumentBlocks(client, documentId);
  const tableBlockId = created.data?.children?.find((block) => block.block_type === 31)?.block_id;
  const tableBlock = blocks.find((block) => block.block_id === tableBlockId)
    || [...blocks].reverse().find((block) => {
      const table = block.table as { property?: { row_size?: number; column_size?: number } } | undefined;
      return table?.property?.row_size === 1 && table.property.column_size === 3;
    });
  const table = tableBlock?.table as { cells?: string[] } | undefined;
  if (!tableBlock?.block_id || table?.cells?.length !== 3) throw new Error("道具列表已创建，但没有找到三个图片单元格");

  const blockMap = new Map(blocks.map((block) => [String(block.block_id || ""), block]));
  for (let cellIndex = 0; cellIndex < table.cells.length; cellIndex += 1) {
    const cellId = table.cells[cellIndex];
    const cachedCell = blockMap.get(cellId);
    const cell = cachedCell || await getFeishuDocumentBlock(client, documentId, cellId);
    const childId = String((cell.children as string[] | undefined)?.[0] || "");
    if (!childId) throw new Error(`道具图片 ${cellIndex + 1} 单元格缺少可编辑文本块`);
    await updateFeishuTextBlock(
      client,
      documentId,
      childId,
      `图片${cellIndex + 1}\n请在此粘贴道具图片`,
    );
    if (cellIndex < table.cells.length - 1) await throttle();
  }
  return { reused: false, tableBlockId: String(tableBlock.block_id) };
}

function replaceTemplateText(content: string, values: Record<string, string>) {
  return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value || ""), content);
}

const PRODUCT_CARD_IDENTITY_LABELS = ["商品名称", "产品链接", "商品ID"] as const;
const PRODUCT_CARD_DERIVED_LABELS = [
  "产品SKU", "产品主要功能", "产品参数", "使用方法", "适用人群", "使用场景",
] as const;
const PRODUCT_CARD_MANAGED_LABELS = [
  ...PRODUCT_CARD_IDENTITY_LABELS,
  ...PRODUCT_CARD_DERIVED_LABELS,
] as const;
type ProductCardManagedLabel = typeof PRODUCT_CARD_MANAGED_LABELS[number];

export type ProductCardManagedMode = "identity" | "verified-basic";

export type ProductCardManagedFieldsInput = {
  documentId: string;
  mode: ProductCardManagedMode;
  name?: string;
  productUrl?: string;
  pid?: string;
  sku?: string;
  coreFunctions?: string[];
  productParameters?: string;
  usageMethod?: string;
  audience?: string;
  scenes?: string;
  /** Clear omitted derived fields after a fresh, verified parse. */
  clearDerived?: boolean;
  /** Restrict a preflight clear to derived labels; identity is handled next. */
  derivedOnly?: boolean;
  /** Validate the complete managed template structure without patching blocks. */
  preflightOnly?: boolean;
};

const PRODUCT_FIELD_LEADING_DECORATION = String.raw`[ \t\p{Extended_Pictographic}\uFE0F\u200D•·▪▫◦●○★☆]*`;

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match one exact template field at the beginning of the text block. */
function matchProductFieldLine(content: string, label: string) {
  const pattern = new RegExp(
    `^(${PRODUCT_FIELD_LEADING_DECORATION}${escapeRegex(label)}[ \\t]*[:：][ \\t]*)([^\\r\\n]*)$`,
    "u",
  );
  const match = content.match(pattern);
  return match ? { prefix: match[1], value: match[2], tail: "" } : null;
}

function matchedManagedProductField(content: string) {
  for (const label of PRODUCT_CARD_MANAGED_LABELS) {
    const line = matchProductFieldLine(content, label);
    if (line) return { label, ...line };
  }
  return null;
}

function hasOwn(value: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function productCardManagedValues(input: Omit<ProductCardManagedFieldsInput, "documentId">) {
  const values = new Map<ProductCardManagedLabel, string>();
  if (hasOwn(input, "name")) {
    const displayName = String(input.name || "").replace(/\s+/g, " ").trim();
    values.set("商品名称", displayName);
  }
  if (hasOwn(input, "productUrl")) values.set("产品链接", String(input.productUrl || "").trim());
  if (hasOwn(input, "pid")) values.set("商品ID", String(input.pid || "").trim());
  if (input.mode !== "verified-basic") return values;

  const derived: Array<[ProductCardManagedLabel, keyof ProductCardManagedFieldsInput, string]> = [
    ["产品SKU", "sku", String(input.sku || "").trim()],
    ["产品主要功能", "coreFunctions", (Array.isArray(input.coreFunctions) ? input.coreFunctions : [])
      .map((item) => String(item || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 5)
      .join("；")],
    ["产品参数", "productParameters", String(input.productParameters || "").trim()],
    ["使用方法", "usageMethod", String(input.usageMethod || "").trim()],
    ["适用人群", "audience", String(input.audience || "").trim()],
    ["使用场景", "scenes", String(input.scenes || "").trim()],
  ];
  for (const [label, key, value] of derived) {
    if (input.clearDerived || hasOwn(input, key)) values.set(label, value);
  }
  return values;
}

/** Pure block-level helper used by both the API and dynamic behavior tests. */
export function syncProductCardManagedBlockText(
  content: string,
  input: Omit<ProductCardManagedFieldsInput, "documentId">,
) {
  const matched = matchedManagedProductField(content);
  if (!matched) return content;
  const values = productCardManagedValues(input);
  if (!values.has(matched.label)) return content;
  return `${matched.prefix}${values.get(matched.label) || ""}${matched.tail}`;
}

function replaceLabeledValue(content: string, label: string, value: string, allowEmpty = false) {
  if (!value && !allowEmpty) return content;
  const matched = matchProductFieldLine(content, label);
  return matched ? `${matched.prefix}${value}${matched.tail}` : content;
}

function syncProductFieldText(content: string, values: Record<string, string>) {
  let next = replaceTemplateText(content, values).replaceAll("原口播文案", "中文翻译");
  const labels: Array<[string, string, boolean?]> = [
    ["商品名称", values.商品名称],
    ["产品链接", values.产品链接],
    ["商品ID", values.商品ID],
    ["产品主要功能", values.核心功能, true],
    ["产品SKU", values.SKU, true],
    ["产品参数", values.产品参数, true],
    ["使用方法", values.使用方法, true],
    ["适用人群", values.适用人群, true],
    ["使用场景", values.使用场景, true],
    ["产品卖点", "", true],
  ];
  for (const [label, value, allowEmpty] of labels) next = replaceLabeledValue(next, label, value, allowEmpty);
  const ranked = next.match(/^(\s*([A-E])[.．、:：]\s*).*$/i);
  if (ranked) {
    const value = values[`核心功能${ranked[2].toUpperCase()}`] || "";
    next = `${ranked[1]}${value}`;
  }
  return next;
}

function styledProductFieldElements(content: string, productUrl: string): FeishuTextElement[] {
  const labels = [...PRODUCT_CARD_MANAGED_LABELS, "产品卖点"];
  const matched = labels
    .map((label) => ({ label, line: matchProductFieldLine(content, label) }))
    .find((item) => Boolean(item.line));
  if (!matched?.line) return [{ text_run: { content } }];
  const label = matched.label;
  const prefixEnd = matched.line.prefix.length;
  const elements: FeishuTextElement[] = [];
  if (prefixEnd > 0) {
    elements.push({ text_run: { content: content.slice(0, prefixEnd), text_element_style: { bold: true } } });
  }
  const suffix = content.slice(prefixEnd);
  if (label === "产品链接" && /^https:\/\//i.test(productUrl)) {
    const linkIndex = suffix.indexOf(productUrl);
    if (linkIndex >= 0) {
      if (linkIndex > 0) elements.push({ text_run: { content: suffix.slice(0, linkIndex) } });
      elements.push({ text_run: { content: productUrl, text_element_style: { link: { url: productUrl } } } });
      if (linkIndex + productUrl.length < suffix.length) {
        elements.push({ text_run: { content: suffix.slice(linkIndex + productUrl.length) } });
      }
      return elements;
    }
  }
  if (suffix) elements.push({ text_run: { content: suffix } });
  return elements;
}

/**
 * Update only exact, single-line managed template fields. Blocks containing a
 * mention of a label, a mid-line label, A-E rows, or any other manual content
 * are deliberately ignored.
 */
export async function syncProductCardManagedFields(
  client: Client,
  input: ProductCardManagedFieldsInput,
) {
  const documentId = requiredToken(input.documentId, "飞书产品文档 Token");
  const blocks = await listFeishuDocumentBlocks(client, documentId);
  const values = productCardManagedValues(input);
  const expectedLabels = input.preflightOnly && input.mode === "verified-basic"
    ? [...PRODUCT_CARD_MANAGED_LABELS]
    : [...values.keys()].filter((label) => !input.derivedOnly
      || PRODUCT_CARD_DERIVED_LABELS.includes(label as typeof PRODUCT_CARD_DERIVED_LABELS[number]));
  type ManagedBlock = {
    block: Record<string, unknown>;
    elements: Array<{
      text_run?: {
        content?: string;
        text_element_style?: { link?: { url?: string } };
      };
    }>;
    content: string;
    matched: NonNullable<ReturnType<typeof matchedManagedProductField>>;
  };
  const occurrences = new Map<ProductCardManagedLabel, ManagedBlock[]>(
    expectedLabels.map((label) => [label, []]),
  );
  for (const block of blocks) {
    const text = block.text as {
      elements?: Array<{
        text_run?: {
          content?: string;
          text_element_style?: { link?: { url?: string } };
        };
      }>;
    } | undefined;
    const elements = text?.elements || [];
    const content = elements.map((element) => element.text_run?.content || "").join("");
    const matched = matchedManagedProductField(content);
    if (!matched || !occurrences.has(matched.label)) continue;
    occurrences.get(matched.label)!.push({ block, elements, content, matched });
  }
  const matchedLabels = expectedLabels.filter((label) => (occurrences.get(label)?.length || 0) > 0);
  const missingLabels = expectedLabels.filter((label) => {
    const matches = occurrences.get(label) || [];
    return matches.length === 0 || (matches.length === 1 && !matches[0].block.block_id);
  });
  const duplicateLabels = expectedLabels.filter((label) => (occurrences.get(label)?.length || 0) > 1);
  const currentValues = Object.fromEntries(expectedLabels.flatMap((label) => {
    const matches = occurrences.get(label) || [];
    return matches.length === 1
      ? [[label, matches[0].matched.value.trim()]]
      : [];
  })) as Partial<Record<ProductCardManagedLabel, string>>;

  // Structural validation is deliberately completed before the first patch.
  // A partial update would be worse than a visible, retryable template error.
  if (input.preflightOnly) {
    return {
      scanned: blocks.length,
      updated: 0,
      matchedLabels,
      missingLabels,
      duplicateLabels,
      currentValues,
    };
  }
  if (duplicateLabels.length) {
    throw new Error(`产品手卡模板基础字段重复：${duplicateLabels.join("、")}`);
  }
  if (missingLabels.length) {
    return {
      scanned: blocks.length,
      updated: 0,
      matchedLabels,
      missingLabels,
      duplicateLabels,
      currentValues,
    };
  }

  let updated = 0;
  const managedBlocks = expectedLabels
    .flatMap((label) => occurrences.get(label) || [])
    .sort((left, right) => {
    // Identity is always committed before derived facts regardless of the
    // physical block order in an old/rearranged template.
    const leftDerived = PRODUCT_CARD_DERIVED_LABELS.includes(left.matched.label as typeof PRODUCT_CARD_DERIVED_LABELS[number]);
    const rightDerived = PRODUCT_CARD_DERIVED_LABELS.includes(right.matched.label as typeof PRODUCT_CARD_DERIVED_LABELS[number]);
    return Number(leftDerived) - Number(rightDerived);
  });
  for (const { block, elements, content, matched } of managedBlocks) {
    const next = syncProductCardManagedBlockText(content, input);
    const expectedProductUrl = matched.label === "产品链接" ? values.get("产品链接") || "" : "";
    const expectedLink = /^https:\/\//i.test(expectedProductUrl) ? expectedProductUrl : "";
    const currentLinks = elements
      .map((element) => element.text_run?.text_element_style?.link?.url || "")
      .filter(Boolean);
    const linkStyleMatches = matched.label !== "产品链接" || (expectedLink
      ? currentLinks.length === 1 && currentLinks[0] === expectedLink
      : currentLinks.length === 0);
    if (next === content && linkStyleMatches) continue;
    await updateFeishuTextBlockElements(
      client,
      documentId,
      String(block.block_id),
      styledProductFieldElements(next, expectedProductUrl),
    );
    updated += 1;
  }
  return {
    scanned: blocks.length,
    updated,
    matchedLabels,
    missingLabels,
    duplicateLabels,
    currentValues,
  };
}

type EnsureProductDocumentInput = {
  templateToken?: string;
  coreFunctions?: string[];
  productParameters?: string;
  usageMethod?: string;
  audience?: string;
  scenes?: string;
  sellingPoints?: string;
  propImages?: string[];
  /** Move an already-linked legacy document; normal refreshes never move it. */
  migrateExisting?: boolean;
  /** Explicit target owner; otherwise FEISHU_PRODUCT_DOCUMENT_OWNER_OPEN_ID is required. */
  ownerOpenId?: string;
};

export async function ensureProductDocument(
  client: Client,
  product: Product,
  input: EnsureProductDocumentInput = {},
) {
  return withProductDocumentLock(product.id, () => ensureProductDocumentUnlocked(client, product, input));
}

async function ensureProductDocumentUnlocked(
  client: Client,
  product: Product,
  input: EnsureProductDocumentInput,
) {
  if (!product.pid.trim()) throw new Error("创建产品文档前必须有 PID");

  let currentProduct = product;
  const settings = getFeishuSettings();
  const productFolderToken = requiredToken(
    settings.productFolderToken,
    "飞书产品文档文件夹配置，请先配置“产品说明文档”文件夹",
  );
  const owner = await resolveProductFolderOwner(client, productFolderToken, input.ownerOpenId);
  const stableTitle = productDocumentStableTitle(currentProduct.name, currentProduct.pid);
  let copied: { documentId: string; documentUrl: string; title: string; type: string } | null = null;
  let reused = false;

  if (currentProduct.documentId && currentProduct.documentUrl) {
    try {
      await getProductDocumentOwner(client, currentProduct.documentId);
      copied = {
        documentId: currentProduct.documentId,
        documentUrl: currentProduct.documentUrl,
        title: stableTitle,
        type: "docx",
      };
      reused = true;
    } catch (error) {
      if (!isMissingProductDocumentError(error)) throw error;
      const cleared = clearProductDocumentLink(currentProduct.id);
      if (!cleared) throw new Error("清理已删除的飞书产品文档关联失败：产品不存在");
      currentProduct = cleared;
    }
  } else if (currentProduct.documentId || currentProduct.documentUrl) {
    const cleared = clearProductDocumentLink(currentProduct.id);
    if (!cleared) throw new Error("清理不完整的飞书产品文档关联失败：产品不存在");
    currentProduct = cleared;
  }

  if (!copied) {
    const existing = await findProductDocumentByTitle(client, productFolderToken, stableTitle);
    copied = existing || await copyFeishuTemplateDocument(client, {
      templateToken: input.templateToken?.trim() || process.env.FEISHU_PRODUCT_TEMPLATE_TOKEN?.trim() || defaultProductTemplateToken,
      name: stableTitle,
      folderToken: productFolderToken,
    });
    reused = Boolean(existing);
    // Persist an adopted/copy result before any later API call. If the copy
    // response itself is lost, the next attempt adopts the stable-title file.
    updateProduct(currentProduct.id, { documentId: copied.documentId, documentUrl: copied.documentUrl });
  }
  let permissionWarning = "";
  try { await setCompanyManaged(client, copied.documentId); }
  catch (error) { permissionWarning = error instanceof Error ? error.message : "设置公司内管理权限失败"; }
  const blocks = await listFeishuDocumentBlocks(client, copied.documentId);
  const functions = [...(input.coreFunctions || [])].slice(0, 5);
  const values: Record<string, string> = {
    商品名称: currentProduct.name,
    产品链接: currentProduct.productUrl,
    商品ID: currentProduct.pid,
    SKU: currentProduct.sku,
    核心功能: functions.join("；"),
    // “产品主要功能”已经展示同一组信息，A-E 暂时统一留空。
    核心功能A: "",
    核心功能B: "",
    核心功能C: "",
    核心功能D: "",
    核心功能E: "",
    产品参数: input.productParameters || "",
    使用方法: input.usageMethod || "",
    适用人群: input.audience || currentProduct.targetAudience,
    使用场景: input.scenes || "",
    产品卖点: "",
    道具列表: "图片1：员工手动录入\n图片2：员工手动录入\n图片3：员工手动录入",
    图片1: input.propImages?.[0] || currentProduct.propImages?.[0] || "",
    图片2: input.propImages?.[1] || currentProduct.propImages?.[1] || "",
    图片3: input.propImages?.[2] || currentProduct.propImages?.[2] || "",
  };
  for (const block of blocks) {
    const text = block.text as { elements?: Array<{ text_run?: { content?: string; text_element_style?: { link?: { url?: string } } } }> } | undefined;
    const content = text?.elements?.map((element) => element.text_run?.content || "").join("");
    // Keep the template compatible with the previous header while standardizing
    // the field name used by all future tables.
    if (!content) continue;
    const next = syncProductFieldText(content, values);
    const matchedField = matchedManagedProductField(next);
    const isProductLink = matchedField?.label === "产品链接"
      && matchedField.value === currentProduct.productUrl;
    const hasExpectedLink = text?.elements?.some((element) => element.text_run?.text_element_style?.link?.url === currentProduct.productUrl);
    if ((next !== content || isProductLink && !hasExpectedLink) && block.block_id) {
      await updateFeishuTextBlockElements(
        client,
        copied.documentId,
        String(block.block_id),
        styledProductFieldElements(next, currentProduct.productUrl),
      );
    }
  }
  // Ownership changes happen only after every template field has been written.
  // A reused legacy document may be moved only through the explicit migration
  // switch/API, while an ordinary refresh merely repairs ownership if needed.
  let migration: Awaited<ReturnType<typeof migrateProductDocument>> | undefined;
  if (reused && input.migrateExisting) {
    migration = await migrateProductDocument(client, {
      documentToken: copied.documentId,
      folderToken: productFolderToken,
      ownerOpenId: input.ownerOpenId,
    });
  } else {
    const ownershipTransferred = await ensureProductDocumentOwner(client, copied.documentId, owner);
    migration = {
      moved: false,
      ownershipTransferred,
      ownerId: owner.ownerId,
      ownerMemberType: owner.ownerMemberType,
      ownerSource: owner.ownerSource,
      folderName: owner.folderName,
    };
  }
  if (reused) {
    updateProduct(currentProduct.id, { documentId: copied.documentId, documentUrl: copied.documentUrl });
  }
  return { ...copied, reused, permissionWarning, migration };
}

export async function insertFeishuTextBlocks(
  client: Client,
  documentId: string,
  parentBlockId: string,
  index: number,
  contents: string[],
) {
  const response = await client.docx.v1.documentBlockChildren.create({
    path: { document_id: documentId, block_id: parentBlockId },
    data: {
      index,
      children: contents.map((content) => ({
        block_type: 2,
        text: { elements: [{ text_run: { content } }] },
      })),
    },
  });
  apiError(response, "插入飞书文档文本失败");
  return response.data?.children || [];
}

export async function grantReportAccess(client: Client, documentId: string, input: {
  chatType: "p2p" | "group";
  chatId: string;
  senderOpenId?: string;
}) {
  const memberType = input.chatType === "group" ? "openchat" : "openid";
  const memberId = input.chatType === "group" ? input.chatId : input.senderOpenId;
  if (!memberId) return;
  const response = await client.drive.v1.permissionMember.create({
    path: { token: documentId },
    params: { type: "docx", need_notification: false },
    data: { member_type: memberType, member_id: memberId, perm: "view", type: input.chatType === "group" ? "chat" : "user" },
  });
  if (response.code && ![0, 1062791].includes(response.code)) throw new Error(response.msg || "授权查看飞书报告失败");
}

export async function ensureFeishuReportDocument(client: Client, videoId: string) {
  const video = getVideo(videoId);
  if (!video || video.status !== "completed") throw new Error("视频尚未完成分析");
  const hash = reportHash(video);
  const cached = getFeishuDocument(videoId);
  if (cached && String(cached.report_hash) === hash) {
    return { documentId: String(cached.document_id), documentUrl: String(cached.document_url), reused: true };
  }
  const product = getProduct(video.productId);
  if (!product) throw new Error("产品档案不存在");
  let folderToken = "";
  try {
    folderToken = await ensureArchiveFolder(client, video);
  } catch {
    // 文件夹权限不足时仍可在机器人根目录创建报告，避免影响消息交付。
  }
  const title = safeName(`${video.productName}｜${video.title || "TikTok视频"}｜${(video.publishedAt || video.createdAt).slice(0, 10)}`);
  const created = await client.docx.v1.document.create({ data: { title, ...(folderToken ? { folder_token: folderToken } : {}) } });
  apiError(created, "创建飞书分析文档失败");
  const documentId = created.data?.document?.document_id;
  if (!documentId) throw new Error("飞书没有返回报告文档 ID");
  await addMarkdown(client, documentId, buildReportMarkdown(video));
  for (const scene of keyScenes(video)) {
    await throttle();
    await addSceneMedia(client, documentId, scene).catch(() => undefined);
  }
  const url = await documentUrl(client, documentId);
  saveFeishuDocument({ videoId, reportHash: hash, documentId, documentUrl: url, folderToken });
  return { documentId, documentUrl: url, reused: false };
}
