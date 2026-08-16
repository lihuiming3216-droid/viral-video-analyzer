import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const databaseSource = await readFile(new URL("../lib/database.ts", import.meta.url), "utf8");

async function withDatabase(run) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "viral-video-attempts-"));
  let compiled = ts.transpileModule(databaseSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  compiled = compiled
    .replace('import "server-only";', "")
    .replace('const dataRoot = path.join(process.cwd(), ".data");', `const dataRoot = ${JSON.stringify(dataRoot)};`);
  delete globalThis.__viralDb;
  const database = await import(`data:text/javascript;base64,${Buffer.from(`${compiled}\n// ${Math.random()}`).toString("base64")}`);
  try {
    await run(database);
  } finally {
    database.getDb().close();
    delete globalThis.__viralDb;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test("starting a new attempt atomically closes an orphaned running attempt", async () => {
  await withDatabase(async (database) => {
    const product = database.createProduct({ name: "attempt product" });
    const video = database.createVideo({
      productId: product.id,
      sourceType: "tiktok",
      sourceUrl: "https://www.tiktok.com/t/attempt-integrity/",
    });
    const first = database.startVideoAttempt(video.id);
    const second = database.startVideoAttempt(video.id);
    const attempts = database.getDb().prepare(`SELECT attempt_number, status, error_message, finished_at
      FROM video_attempts WHERE video_id=? ORDER BY attempt_number`).all(video.id);

    assert.equal(first.attemptNumber, 1);
    assert.equal(second.attemptNumber, 2);
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["stopped", "running"]);
    assert.match(String(attempts[0].error_message), /上一轮已中断/);
    assert.ok(attempts[0].finished_at);
    assert.equal(attempts[1].finished_at, null);
    assert.throws(() => database.getDb().prepare(`INSERT INTO video_attempts(
      id, video_id, attempt_number, status, started_at
    ) VALUES ('duplicate-number', ?, 2, 'running', ?)`)
      .run(video.id, second.startedAt), /UNIQUE constraint failed/);
  });
});

test("a stale or repeated finish cannot overwrite history or clear the current attempt timer", async () => {
  await withDatabase(async (database) => {
    const product = database.createProduct({ name: "finish product" });
    const video = database.createVideo({ productId: product.id, sourceType: "tiktok", sourceUrl: "https://example.com/video" });
    const first = database.startVideoAttempt(video.id);
    const second = database.startVideoAttempt(video.id);

    database.finishVideoAttempt(first.attemptId, video.id, "failed", "late failure");
    database.finishVideoAttempt("missing-attempt", video.id, "failed", "wrong id");
    const duringSecond = database.getVideo(video.id, false);
    const firstRow = database.getDb().prepare("SELECT * FROM video_attempts WHERE id=?").get(first.attemptId);
    assert.equal(duringSecond.processingStartedAt, second.startedAt);
    assert.equal(firstRow.status, "stopped");
    assert.notEqual(firstRow.error_message, "late failure");

    database.finishVideoAttempt(second.attemptId, video.id, "completed");
    const completed = database.getVideo(video.id, false);
    const secondRow = database.getDb().prepare("SELECT * FROM video_attempts WHERE id=?").get(second.attemptId);
    assert.equal(completed.processingStartedAt, null);
    assert.equal(secondRow.status, "completed");
    assert.ok(secondRow.finished_at);

    database.finishVideoAttempt(second.attemptId, video.id, "failed", "duplicate callback");
    const afterDuplicate = database.getDb().prepare("SELECT * FROM video_attempts WHERE id=?").get(second.attemptId);
    assert.equal(afterDuplicate.status, "completed");
    assert.equal(afterDuplicate.error_message, "");
  });
});

test("each product-document row owns one durable independent video task", async () => {
  await withDatabase(async (database) => {
    const product = database.createProduct({ name: "document row product" });
    const first = database.createVideo({
      productId: product.id,
      sourceType: "tiktok",
      sourceUrl: "https://www.tiktok.com/t/repeated-document-link/",
      analysisMode: "product_doc",
    });
    const second = database.createVideo({
      productId: product.id,
      sourceType: "tiktok",
      sourceUrl: first.sourceUrl,
      analysisMode: "product_doc",
    });
    database.saveProductDocumentVideoRow({
      documentId: "doc-a",
      linkBlockId: "row-a-link",
      productId: product.id,
      sourceUrl: first.sourceUrl,
      videoId: first.id,
    });
    database.saveProductDocumentVideoRow({
      documentId: "doc-a",
      linkBlockId: "row-b-link",
      productId: product.id,
      sourceUrl: second.sourceUrl,
      videoId: second.id,
    });
    assert.equal(database.getProductDocumentVideoRow("doc-a", "row-a-link").videoId, first.id);
    assert.equal(database.getProductDocumentVideoRow("doc-a", "row-b-link").videoId, second.id);
    assert.throws(() => database.saveProductDocumentVideoRow({
      documentId: "doc-b",
      linkBlockId: "row-c-link",
      productId: product.id,
      sourceUrl: first.sourceUrl,
      videoId: first.id,
    }), /UNIQUE constraint failed/);
    assert.equal(database.isProductDocumentVideoRowsInitialized("doc-a"), false);
    database.markProductDocumentVideoRowsInitialized("doc-a");
    assert.equal(database.isProductDocumentVideoRowsInitialized("doc-a"), true);
  });
});
