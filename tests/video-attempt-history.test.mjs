import assert from "node:assert/strict";
import test from "node:test";
import { createIsolatedDatabase } from "./helpers/isolated-mysql.mjs";
test("repeated MySQL schema initialization preserves attempt history", async (t) => {
  const { database, rows, reapplySchema } = await createIsolatedDatabase(t);
  const product = await database.createProduct({ name: "migration product" });
  const video = await database.createVideo({ productId: product.id, sourceType: "tiktok", sourceUrl: "https://example.test/video" });
  const attempt = await database.startVideoAttempt(video.id);
  const initial = await rows("SELECT * FROM video_attempts WHERE id=?", [attempt.attemptId]);
  assert.deepEqual(initial[0].diagnostics_json, {});
  await reapplySchema();
  assert.deepEqual(await rows("SELECT * FROM video_attempts WHERE id=?", [attempt.attemptId]), initial);
});
