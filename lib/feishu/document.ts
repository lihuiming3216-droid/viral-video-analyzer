import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { getProduct, getProductByPid, getVideo, updateProduct } from "@/lib/database";
import { formatTime } from "@/lib/json-utils";
import { resolveMediaPath } from "@/lib/video-processing";
import {
  getFeishuDocument, getFeishuFolder, getFeishuSettings, saveFeishuDocument,
  saveFeishuFolder, setFeishuRootFolder,
} from "@/lib/feishu/store";
import type { Product, SceneRecord, VideoRecord } from "@/lib/types";

const defaultProductTemplateToken = "CnlfdBzruo9CFGxL9EwcoBdXnqe";

async function setCompanyEditable(client: Client, documentId: string) {
  const response = await client.request({
    url: `/open-apis/drive/v1/permissions/${encodeURIComponent(documentId)}/public`,
    method: "PATCH",
    params: { type: "docx" },
    data: { link_share_entity: "tenant_editable", share_entity: "same_tenant" },
  });
  apiError(response as { code?: number; msg?: string }, "设置文档公司内可编辑失败");
}

function apiError(response: { code?: number; msg?: string } | null | undefined, fallback: string) {
  if (response?.code && response.code !== 0) throw new Error(response.msg || fallback);
}

function safeName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 90) || "未命名";
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

export async function copyFeishuTemplateDocument(
  client: Client,
  input: { templateToken: string; name: string; folderToken?: string },
) {
  const templateToken = input.templateToken.trim();
  const name = safeName(input.name);
  if (!templateToken) throw new Error("缺少飞书模板文档 Token");

  const response = await client.request<{
    code?: number;
    msg?: string;
    data?: { file?: { token?: string; url?: string; name?: string; type?: string } };
  }>({
    url: `/open-apis/drive/v1/files/${encodeURIComponent(templateToken)}/copy`,
    method: "POST",
    data: {
      name,
      type: "docx",
      folder_token: input.folderToken?.trim() || "",
    },
  });
  apiError(response, "复制飞书产品文档模板失败");
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
  const response = await client.request<{
    code?: number;
    msg?: string;
    data?: { items?: Array<Record<string, unknown>>; page_token?: string; has_more?: boolean };
  }>({
    url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks`,
    method: "GET",
    params: { page_size: "500", document_revision_id: "-1" },
  });
  apiError(response, "读取飞书文档结构失败");
  return response.data?.items || [];
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

export async function updateFeishuTextBlock(client: Client, documentId: string, blockId: string, content: string) {
  const response = await client.docx.v1.documentBlock.patch({
    path: { document_id: documentId, block_id: blockId },
    data: { update_text_elements: { elements: [{ text_run: { content } }] } },
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

function replaceTemplateText(content: string, values: Record<string, string>) {
  return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value || ""), content);
}

export async function ensureProductDocument(
  client: Client,
  product: Product,
  input: {
    templateToken?: string;
    coreFunctions?: string[];
    productParameters?: string;
    usageMethod?: string;
    audience?: string;
    scenes?: string;
    sellingPoints?: string;
  } = {},
) {
  if (product.documentId && product.documentUrl) {
    let permissionWarning = "";
    try { await setCompanyEditable(client, product.documentId); }
    catch (error) { permissionWarning = error instanceof Error ? error.message : "设置公司内编辑权限失败"; }
    return { documentId: product.documentId, documentUrl: product.documentUrl, reused: true, permissionWarning };
  }
  if (!product.pid.trim()) throw new Error("创建产品文档前必须有 PID");

  const settings = getFeishuSettings();
  const templateToken = input.templateToken?.trim() || process.env.FEISHU_PRODUCT_TEMPLATE_TOKEN?.trim() || defaultProductTemplateToken;
  const title = safeName(`${product.name}_${product.pid}`);
  const copied = await copyFeishuTemplateDocument(client, {
    templateToken,
    name: title,
    folderToken: settings.rootFolderToken || undefined,
  });
  let permissionWarning = "";
  try { await setCompanyEditable(client, copied.documentId); }
  catch (error) { permissionWarning = error instanceof Error ? error.message : "设置公司内编辑权限失败"; }
  const blocks = await listFeishuDocumentBlocks(client, copied.documentId);
  const functions = [...(input.coreFunctions || [])].slice(0, 5);
  const values: Record<string, string> = {
    商品名称: product.name,
    产品链接: product.productUrl,
    商品ID: product.pid,
    SKU: product.sku,
    核心功能: functions[0] || "",
    核心功能A: functions[0] || "",
    核心功能B: functions[1] || "",
    核心功能C: functions[2] || "",
    核心功能D: functions[3] || "",
    核心功能E: functions[4] || "",
    产品参数: input.productParameters || "",
    使用方法: input.usageMethod || "",
    适用人群: input.audience || product.targetAudience,
    使用场景: input.scenes || "",
    产品卖点: input.sellingPoints || product.sellingPoints,
  };
  for (const block of blocks) {
    const text = block.text as { elements?: Array<{ text_run?: { content?: string } }> } | undefined;
    const content = text?.elements?.map((element) => element.text_run?.content || "").join("");
    if (!content || !content.includes("{{")) continue;
    const next = replaceTemplateText(content, values);
    if (next !== content && block.block_id) await updateFeishuTextBlock(client, copied.documentId, String(block.block_id), next);
  }
  updateProduct(product.id, { documentId: copied.documentId, documentUrl: copied.documentUrl });
  return { ...copied, reused: false, permissionWarning };
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
