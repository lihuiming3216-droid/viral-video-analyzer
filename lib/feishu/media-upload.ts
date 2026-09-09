import "server-only";

import { createReadStream, statSync } from "node:fs";
import type { Client } from "@larksuiteoapi/node-sdk";

type MediaParentType = NonNullable<Parameters<Client["drive"]["v1"]["media"]["uploadAll"]>[0]>["data"]["parent_type"];

/**
 * Shared "upload a local file, get back a file_token" primitive. Feishu uses
 * the same drive.v1.media upload family for Docx file blocks and Base
 * attachment fields — only parent_type/parent_node differ.
 */
export async function uploadFeishuMedia(client: Client, input: {
  parentType: MediaParentType;
  parentNode: string;
  absolutePath: string;
  fileName: string;
}) {
  const { parentType, parentNode, absolutePath, fileName } = input;
  const size = statSync(absolutePath).size;
  if (size <= 20 * 1024 * 1024) {
    const uploaded = await client.drive.v1.media.uploadAll({ data: {
      file_name: fileName,
      parent_type: parentType,
      parent_node: parentNode,
      size,
      file: createReadStream(absolutePath),
    } });
    if (!uploaded?.file_token) throw new Error("飞书没有返回文件 Token");
    return uploaded.file_token;
  }

  const prepared = await client.drive.v1.media.uploadPrepare({ data: {
    file_name: fileName,
    parent_type: parentType,
    parent_node: parentNode,
    size,
  } });
  const { upload_id: uploadId, block_size: blockSize, block_num: blockCount } = prepared.data || {};
  if (!uploadId || !blockSize || !blockCount) throw new Error("飞书没有返回文件分片策略");
  for (let seq = 0; seq < blockCount; seq += 1) {
    const start = seq * blockSize;
    const partSize = Math.min(blockSize, size - start);
    await client.drive.v1.media.uploadPart({ data: {
      upload_id: uploadId,
      seq,
      size: partSize,
      file: createReadStream(absolutePath, { start, end: start + partSize - 1 }),
    } });
  }
  const finished = await client.drive.v1.media.uploadFinish({
    data: { upload_id: uploadId, block_num: blockCount },
  });
  if (!finished.data?.file_token) throw new Error("飞书没有完成文件分片上传");
  return finished.data.file_token;
}

/**
 * Upload a local file as a Base (多维表格) attachment-field value.
 * Feishu's drive.v1.media upload_all docs: for parent_type "bitable_file",
 * parent_node is the Base's own app_token — not the table_id. Confirmed by a
 * direct API call after the table_id form got "parent node not exist" (code
 * 1061044); passing app_token returns a real file_token.
 */
export async function uploadBaseAttachment(client: Client, input: {
  appToken: string;
  absolutePath: string;
  fileName: string;
}) {
  const fileToken = await uploadFeishuMedia(client, {
    parentType: "bitable_file",
    parentNode: input.appToken,
    absolutePath: input.absolutePath,
    fileName: input.fileName,
  });
  return [{ file_token: fileToken }];
}
