import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/feishu/docx-file.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source.replace('import "server-only";', ""), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const preview = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

function clientHarness(events, options = {}) {
  return {
    request: async () => ({ data: { items: options.children || [] } }),
    drive: { v1: { media: {
      uploadAll: async ({ data }) => {
        events.push(["upload", data.file_name, data.parent_node, data.size]);
        return { file_token: "file-token" };
      },
      uploadPrepare: async () => ({ data: {
        upload_id: "upload-1",
        block_size: 4 * 1024 * 1024,
        block_num: 6,
      } }),
      uploadPart: async ({ data }) => {
        events.push(["part", data.seq, data.size]);
        data.file.destroy();
        return {};
      },
      uploadFinish: async () => ({ data: { file_token: "large-token" } }),
    } } },
    docx: { v1: {
      documentBlockChildren: {
        create: async ({ data }) => {
          events.push(["create", data.children[0].file.view_type]);
          return { data: { children: [{ block_id: "view-1", block_type: 33, children: ["file-1"] }] } };
        },
        batchDelete: async ({ data }) => events.push(["delete", data.start_index, data.end_index]),
      },
      documentBlock: {
        patch: async ({ path: inputPath, data }) => {
          events.push(["patch", inputPath.block_id, data.replace_file.token]);
          return { code: options.patchCode || 0 };
        },
      },
    } },
  };
}

test("creates a cover preview once for a small MP4", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "feishu-preview-"));
  const absolutePath = path.join(directory, "original.mp4");
  await writeFile(absolutePath, Buffer.alloc(1024, 7));
  const events = [];
  try {
    const input = {
      client: clientHarness(events),
      documentId: "document-1",
      parentBlockId: "status-cell",
      absolutePath,
      fileName: "TokScript视频-video-1.mp4",
      blocks: [{ block_id: "status-cell", children: ["status-text"] }],
    };
    assert.equal(await preview.ensureFeishuVideoPreview(input), true);
    assert.deepEqual(events, [
      ["create", 2],
      ["upload", input.fileName, "file-1", 1024],
      ["patch", "file-1", "file-token"],
    ]);

    input.blocks.push(
      { block_id: "view-existing", block_type: 33, children: ["file-existing"] },
      { block_id: "file-existing", block_type: 23, file: { name: input.fileName, token: "existing" } },
    );
    input.blocks[0].children.push("view-existing");
    events.length = 0;
    assert.equal(await preview.ensureFeishuVideoPreview(input), false);
    assert.deepEqual(events, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses multipart upload for MP4 files over twenty megabytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "feishu-preview-large-"));
  const absolutePath = path.join(directory, "original.mp4");
  await writeFile(absolutePath, "");
  await truncate(absolutePath, 21 * 1024 * 1024);
  const events = [];
  try {
    await preview.ensureFeishuVideoPreview({
      client: clientHarness(events),
      documentId: "document-large",
      parentBlockId: "status-cell",
      absolutePath,
      fileName: "TokScript视频-large.mp4",
      blocks: [{ block_id: "status-cell", children: ["status-text"] }],
    });
    assert.deepEqual(events.filter((event) => event[0] === "part"), [
      ["part", 0, 4 * 1024 * 1024], ["part", 1, 4 * 1024 * 1024],
      ["part", 2, 4 * 1024 * 1024], ["part", 3, 4 * 1024 * 1024],
      ["part", 4, 4 * 1024 * 1024], ["part", 5, 1024 * 1024],
    ]);
    assert.deepEqual(events.at(-1), ["patch", "file-1", "large-token"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removes the empty preview when binding the uploaded file fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "feishu-preview-failure-"));
  const absolutePath = path.join(directory, "original.mp4");
  await writeFile(absolutePath, Buffer.alloc(32));
  const events = [];
  try {
    await assert.rejects(
      preview.ensureFeishuVideoPreview({
        client: clientHarness(events, {
          patchCode: 1,
          children: [{ block_id: "view-1", block_type: 33 }],
        }),
        documentId: "document-failure",
        parentBlockId: "status-cell",
        absolutePath,
        fileName: "TokScript视频-failure.mp4",
        blocks: [{ block_id: "status-cell", children: ["status-text"] }],
      }),
      /飞书视频附件绑定失败/,
    );
    assert.deepEqual(events.at(-1), ["delete", 0, 1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
