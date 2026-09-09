import "server-only";

import type { Client } from "@larksuiteoapi/node-sdk";
import { uploadFeishuMedia } from "@/lib/feishu/media-upload";

type DocxBlock = {
  block_id?: string;
  block_type?: number;
  children?: string[];
  file?: { name?: string; token?: string };
};

function descendants(rootId: string, blocks: DocxBlock[]) {
  const byId = new Map(blocks.map((block) => [String(block.block_id || ""), block]));
  const pending = [...(byId.get(rootId)?.children || [])];
  const found: DocxBlock[] = [];
  const seen = new Set<string>();
  while (pending.length) {
    const id = String(pending.shift() || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const block = byId.get(id);
    if (!block) continue;
    found.push(block);
    pending.push(...(block.children || []));
  }
  return found;
}

async function uploadFile(client: Client, fileBlockId: string, absolutePath: string, fileName: string) {
  return uploadFeishuMedia(client, {
    parentType: "docx_file",
    parentNode: fileBlockId,
    absolutePath,
    fileName,
  });
}

async function deleteChild(client: Client, documentId: string, parentBlockId: string, childBlockId: string) {
  const response = await client.request<{ data?: { items?: DocxBlock[] } }>({
    url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parentBlockId)}/children`,
    method: "GET",
    params: { page_size: "100" },
  }).catch(() => null);
  const index = response?.data?.items?.findIndex((block) => block.block_id === childBlockId) ?? -1;
  if (index < 0) return;
  await client.docx.v1.documentBlockChildren.batchDelete({
    path: { document_id: documentId, block_id: parentBlockId },
    data: { start_index: index, end_index: index + 1 },
  }).catch(() => undefined);
}

/** Insert an MP4 as an inline preview (cover, play button, duration) once. */
export async function ensureFeishuVideoPreview(input: {
  client: Client;
  documentId: string;
  parentBlockId: string;
  absolutePath: string;
  fileName: string;
  blocks: DocxBlock[];
  validateBinding?: () => Promise<{ valid: boolean; documentRevisionId: number }>;
}) {
  const { client, documentId, parentBlockId, absolutePath, fileName, blocks, validateBinding } = input;
  const initialValidation = await validateBinding?.();
  if (initialValidation && !initialValidation.valid) return false;
  if (descendants(parentBlockId, blocks).some((block) => block.block_type === 23 && block.file?.name === fileName)) {
    return false;
  }

  let viewBlockId = "";
  try {
    const created = await client.docx.v1.documentBlockChildren.create({
      path: { document_id: documentId, block_id: parentBlockId },
      data: { children: [{ block_type: 23, file: { token: "", view_type: 2 } }] as never },
    });
    const view = created.data?.children?.[0];
    viewBlockId = String(view?.block_id || "");
    if (!viewBlockId) throw new Error("飞书没有创建视频预览块");

    let fileBlockId = String(view?.children?.[0] || "");
    if (!fileBlockId) {
      const response = await client.request<{ data?: { items?: DocxBlock[] } }>({
        url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(viewBlockId)}/children`,
        method: "GET",
        params: { page_size: "20" },
      });
      fileBlockId = String(response.data?.items?.find((block) => block.block_type === 23)?.block_id || "");
    }
    if (!fileBlockId) throw new Error("飞书没有创建视频文件块");

    const token = await uploadFile(client, fileBlockId, absolutePath, fileName);
    const finalValidation = await validateBinding?.();
    if (finalValidation && !finalValidation.valid) {
      await deleteChild(client, documentId, parentBlockId, viewBlockId);
      viewBlockId = "";
      return false;
    }
    const patched = await client.docx.v1.documentBlock.patch({
      path: { document_id: documentId, block_id: fileBlockId },
      data: { replace_file: { token } },
      params: finalValidation
        ? { document_revision_id: finalValidation.documentRevisionId }
        : undefined,
    });
    if (patched.code) throw new Error(patched.msg || "飞书视频附件绑定失败");
    return true;
  } catch (error) {
    if (viewBlockId) await deleteChild(client, documentId, parentBlockId, viewBlockId);
    throw error;
  }
}
