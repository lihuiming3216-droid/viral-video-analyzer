import assert from "node:assert/strict";
import test from "node:test";
import { createIsolatedDatabase } from "./helpers/isolated-mysql.mjs";
test("MySQL failure-delivery state survives schema initialization and resets only for a new attempt", async (t) => {
  const { database, pool, row, reapplySchema } = await createIsolatedDatabase(t);
  const product = await database.createProduct({ name: "failure delivery product" });
  const video = await database.createVideo({ productId: product.id, sourceType: "tiktok",
    sourceUrl: "https://www.tiktok.com/t/failure-delivery/", analysisMode: "product_doc" });
  assert.equal(video.productDocFailureDelivered, false);
  assert.equal((await row("SELECT product_doc_failure_delivered FROM videos WHERE id=?", [video.id])).product_doc_failure_delivered, 0);
  await database.updateVideo(video.id, { product_doc_failure_delivered: true });
  await reapplySchema();
  assert.equal((await database.getVideo(video.id)).productDocFailureDelivered, true);
  const connection = await pool.getConnection();
  try {
    assert.equal((await connection.query("SELECT product_doc_failure_delivered FROM videos WHERE id=?", [video.id]))[0][0].product_doc_failure_delivered, 1);
  }
  finally {
    connection.release();
  }
  const repeated = await database.createVideo({ productId: product.id, sourceType: "tiktok", sourceUrl: video.sourceUrl });
  assert.notEqual(repeated.id, video.id);
  assert.equal((await database.getVideo(video.id)).productDocFailureDelivered, true);
  assert.equal((await database.updateVideo(video.id, { product_doc_failure_delivered: false })).productDocFailureDelivered, false);
  await database.updateVideo(video.id, { product_doc_failure_delivered: true });
  const attempt = await database.startVideoAttempt(video.id);
  assert.equal((await database.getVideo(video.id)).productDocFailureDelivered, false);
  await database.finishVideoAttempt(attempt.attemptId, video.id, "completed");
});
