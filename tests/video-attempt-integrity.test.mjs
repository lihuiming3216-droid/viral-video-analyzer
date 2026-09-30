import assert from "node:assert/strict";
import test from "node:test";
import { createIsolatedDatabase } from "./helpers/isolated-mysql.mjs";
test("starting a new attempt atomically closes an orphaned running attempt", async (t) => {
  const { database, rows, pool } = await createIsolatedDatabase(t);
  const product = await database.createProduct({ name: "attempt product" });
  const video = await database.createVideo({
    productId: product.id,
    sourceType: "tiktok",
    sourceUrl: "https://www.tiktok.com/t/attempt-integrity/",
  });
  const first = await database.startVideoAttempt(video.id);
  const second = await database.startVideoAttempt(video.id);
  const attempts = await rows(`SELECT attempt_number, status, error_message, finished_at
   FROM video_attempts WHERE video_id=? ORDER BY attempt_number`, [video.id]);
  assert.equal(first.attemptNumber, 1);
  assert.equal(second.attemptNumber, 2);
  assert.deepEqual(attempts.map((attempt) => attempt.status), ["stopped", "running"]);
  assert.match(String(attempts[0].error_message), /上一轮已中断/);
  assert.ok(attempts[0].finished_at);
  assert.equal(attempts[1].finished_at, null);
  await assert.rejects(pool.query(`INSERT INTO video_attempts(
   id, video_id, attempt_number, status, started_at
  ) VALUES ('duplicate-number', ?, 2, 'running', ?)`, [video.id, second.startedAt]), { code: "ER_DUP_ENTRY" });
});
test("a stale or repeated finish cannot overwrite history or clear the current attempt timer", async (t) => {
  const { database, row } = await createIsolatedDatabase(t);
  const product = await database.createProduct({ name: "finish product" });
  const video = await database.createVideo({ productId: product.id, sourceType: "tiktok", sourceUrl: "https://example.com/video" });
  const first = await database.startVideoAttempt(video.id);
  const second = await database.startVideoAttempt(video.id);
  await database.finishVideoAttempt(first.attemptId, video.id, "failed", "late failure");
  await database.finishVideoAttempt("missing-attempt", video.id, "failed", "wrong id");
  const duringSecond = await database.getVideo(video.id, false);
  const firstRow = await row("SELECT * FROM video_attempts WHERE id=?", [first.attemptId]);
  assert.equal(duringSecond.processingStartedAt, second.startedAt);
  assert.equal(firstRow.status, "stopped");
  assert.notEqual(firstRow.error_message, "late failure");
  await database.finishVideoAttempt(second.attemptId, video.id, "completed");
  const completed = await database.getVideo(video.id, false);
  const secondRow = await row("SELECT * FROM video_attempts WHERE id=?", [second.attemptId]);
  assert.equal(completed.processingStartedAt, null);
  assert.equal(secondRow.status, "completed");
  assert.ok(secondRow.finished_at);
  await database.finishVideoAttempt(second.attemptId, video.id, "failed", "duplicate callback");
  const afterDuplicate = await row("SELECT * FROM video_attempts WHERE id=?", [second.attemptId]);
  assert.equal(afterDuplicate.status, "completed");
  assert.equal(afterDuplicate.error_message, "");
});
test("each product-document row owns one durable independent video task", async (t) => {
  const { database } = await createIsolatedDatabase(t);
  const product = await database.createProduct({ name: "document row product" });
  const first = await database.createVideo({
    productId: product.id,
    sourceType: "tiktok",
    sourceUrl: "https://www.tiktok.com/t/repeated-document-link/",
    analysisMode: "product_doc",
  });
  const second = await database.createVideo({
    productId: product.id,
    sourceType: "tiktok",
    sourceUrl: first.sourceUrl,
    analysisMode: "product_doc",
  });
  await database.saveProductDocumentVideoRow({
    documentId: "doc-a",
    linkBlockId: "row-a-link",
    productId: product.id,
    sourceUrl: first.sourceUrl,
    videoId: first.id,
  });
  await database.saveProductDocumentVideoRow({
    documentId: "doc-a",
    linkBlockId: "row-b-link",
    productId: product.id,
    sourceUrl: second.sourceUrl,
    videoId: second.id,
  });
  assert.equal((await database.getProductDocumentVideoRow("doc-a", "row-a-link")).videoId, first.id);
  assert.equal((await database.getProductDocumentVideoRow("doc-a", "row-b-link")).videoId, second.id);
  await assert.rejects(async () => await database.saveProductDocumentVideoRow({
    documentId: "doc-b",
    linkBlockId: "row-c-link",
    productId: product.id,
    sourceUrl: first.sourceUrl,
    videoId: first.id,
  }), /其他手卡行|Duplicate entry/);
  assert.equal((await database.getProductDocumentVideoRow("doc-a", "row-a-link")).videoId, first.id);
  assert.equal(await database.getProductDocumentVideoRow("doc-b", "row-c-link"), null);
  assert.equal(await database.isProductDocumentVideoRowsInitialized("doc-a"), false);
  await database.markProductDocumentVideoRowsInitialized("doc-a");
  assert.equal(await database.isProductDocumentVideoRowsInitialized("doc-a"), true);
});
