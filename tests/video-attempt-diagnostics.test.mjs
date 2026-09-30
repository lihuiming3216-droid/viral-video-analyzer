import assert from "node:assert/strict";
import test from "node:test";
import { createIsolatedDatabase } from "./helpers/isolated-mysql.mjs";
function diagnostic(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "qwen",
    model: "qwen3.5-omni-plus",
    inputMode: "local_base64",
    fileBytes: 5527009,
    inputSha256: "1".repeat(64),
    encodedBytes: 7369348,
    durationMs: 30891,
    hasAudio: true,
    videoCodec: "hevc",
    audioCodec: "aac",
    calls: [{
        requestIndex: 1,
        clientRequestId: "39e16ca4-4c3b-4f10-b2ab-b1888d1b8f12",
        providerRequestId: "chatcmpl-safe-request-id",
        phase: "completed",
        outcome: "success",
        startedAt: "2026-08-17T12:00:00.000Z",
        headersMs: 940,
        firstTokenMs: 1350,
        totalMs: 4500,
        httpStatus: 200,
        responseSha256: "2".repeat(64),
      }],
    ...overrides,
  };
}
test("attempt diagnostics update only the exact running attempt and reject sensitive or oversized data", async (t) => {
  const { database, row } = await createIsolatedDatabase(t);
  {
    const product = await database.createProduct({ name: "diagnostic product" });
    const video = await database.createVideo({
      productId: product.id,
      sourceType: "tiktok",
      sourceUrl: "https://www.tiktok.com/t/diagnostic-test/",
    });
    const first = await database.startVideoAttempt(video.id);
    const safe = diagnostic();
    assert.equal(await database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, safe), true);
    const stored = await row("SELECT diagnostics_json FROM video_attempts WHERE id=?", [first.attemptId]);
    assert.deepEqual(stored.diagnostics_json, safe);
    assert.doesNotMatch(JSON.stringify(stored.diagnostics_json), /https?:|prompt|secret|authorization|api.?key/i);
    await assert.rejects(async () => await database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, {
      ...safe,
      prompt: "raw provider prompt",
    }), /不允许的字段 prompt/);
    await assert.rejects(async () => await database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, {
      ...safe,
      apiKey: "sk-must-never-be-stored",
    }), /不允许的字段 apiKey/);
    await assert.rejects(async () => await database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, {
      ...safe,
      model: "https://signed.example/video.mp4",
    }), /安全标识符/);
    await assert.rejects(async () => await database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, {
      ...safe,
      inputSha256: "not-a-file-hash",
    }), /inputSha256必须是64位/);
    await assert.rejects(async () => await database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, {
      ...safe,
      calls: [{ ...safe.calls[0], responseSha256: "not-a-response-hash" }],
    }), /responseSha256必须是64位/);
    await assert.rejects(async () => await database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, {
      ...safe,
      padding: "x".repeat(database.VIDEO_ATTEMPT_DIAGNOSTICS_MAX_BYTES + 1),
    }), /不能超过/);
    await database.finishVideoAttempt(first.attemptId, video.id, "completed");
    assert.equal(await database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, diagnostic({ calls: [] })), false);
    const afterFinish = await row("SELECT diagnostics_json FROM video_attempts WHERE id=?", [first.attemptId]);
    assert.deepEqual(afterFinish.diagnostics_json, safe);
    const second = await database.startVideoAttempt(video.id);
    assert.equal(await database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, diagnostic({ calls: [] })), false);
    assert.equal(await database.updateVideoAttemptDiagnostics(video.id, second.attemptNumber, diagnostic({ calls: [] })), true);
  }
});
test("repeated MySQL schema initialization preserves attempt history and diagnostics", async (t) => {
  const { database, rows, reapplySchema } = await createIsolatedDatabase(t);
  const product = await database.createProduct({ name: "migration product" });
  const video = await database.createVideo({ productId: product.id, sourceType: "tiktok", sourceUrl: "https://example.test/video" });
  const attempt = await database.startVideoAttempt(video.id);
  const initial = await rows("SELECT * FROM video_attempts WHERE id=?", [attempt.attemptId]);
  assert.deepEqual(initial[0].diagnostics_json, {});
  await reapplySchema();
  assert.deepEqual(await rows("SELECT * FROM video_attempts WHERE id=?", [attempt.attemptId]), initial);
  assert.equal(await database.updateVideoAttemptDiagnostics(video.id, attempt.attemptNumber, diagnostic({ calls: [] })), true);
});
