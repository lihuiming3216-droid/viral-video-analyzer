import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const databaseSource = await readFile(new URL("../lib/database.ts", import.meta.url), "utf8");

async function loadDatabase(dataRoot, nonce) {
  let compiled = ts.transpileModule(databaseSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  compiled = compiled
    .replace('import "server-only";', "")
    .replace('const dataRoot = path.join(process.cwd(), ".data");', `const dataRoot = ${JSON.stringify(dataRoot)};`);
  delete globalThis.__viralDb;
  return import(`data:text/javascript;base64,${Buffer.from(`${compiled}\n// ${nonce}`).toString("base64")}`);
}

function diagnostic(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "qwen",
    model: "qwen3.5-omni-plus",
    inputMode: "local_base64",
    fileBytes: 5_527_009,
    inputSha256: "1".repeat(64),
    encodedBytes: 7_369_348,
    durationMs: 30_891,
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
      firstTokenMs: 1_350,
      totalMs: 4_500,
      httpStatus: 200,
      responseSha256: "2".repeat(64),
    }],
    ...overrides,
  };
}

test("attempt diagnostics update only the exact running attempt and reject sensitive or oversized data", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "viral-attempt-diagnostics-"));
  const database = await loadDatabase(dataRoot, "running-guard");
  try {
    const product = database.createProduct({ name: "diagnostic product" });
    const video = database.createVideo({
      productId: product.id,
      sourceType: "tiktok",
      sourceUrl: "https://www.tiktok.com/t/diagnostic-test/",
    });
    const first = database.startVideoAttempt(video.id);
    const safe = diagnostic();
    assert.equal(database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, safe), true);

    const stored = database.getDb().prepare("SELECT diagnostics_json FROM video_attempts WHERE id=?").get(first.attemptId);
    assert.deepEqual(JSON.parse(String(stored.diagnostics_json)), safe);
    assert.doesNotMatch(String(stored.diagnostics_json), /https?:|prompt|secret|authorization|api.?key/i);

    assert.throws(() => database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, {
      ...safe,
      prompt: "raw provider prompt",
    }), /不允许的字段 prompt/);
    assert.throws(() => database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, {
      ...safe,
      apiKey: "sk-must-never-be-stored",
    }), /不允许的字段 apiKey/);
    assert.throws(() => database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, {
      ...safe,
      model: "https://signed.example/video.mp4",
    }), /安全标识符/);
    assert.throws(() => database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, {
      ...safe,
      inputSha256: "not-a-file-hash",
    }), /inputSha256必须是64位/);
    assert.throws(() => database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, {
      ...safe,
      calls: [{ ...safe.calls[0], responseSha256: "not-a-response-hash" }],
    }), /responseSha256必须是64位/);
    assert.throws(() => database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, {
      ...safe,
      padding: "x".repeat(database.VIDEO_ATTEMPT_DIAGNOSTICS_MAX_BYTES + 1),
    }), /不能超过/);

    database.finishVideoAttempt(first.attemptId, video.id, "completed");
    assert.equal(database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, diagnostic({ calls: [] })), false);
    const afterFinish = database.getDb().prepare("SELECT diagnostics_json FROM video_attempts WHERE id=?").get(first.attemptId);
    assert.deepEqual(JSON.parse(String(afterFinish.diagnostics_json)), safe);

    const second = database.startVideoAttempt(video.id);
    assert.equal(database.updateVideoAttemptDiagnostics(video.id, first.attemptNumber, diagnostic({ calls: [] })), false);
    assert.equal(database.updateVideoAttemptDiagnostics(video.id, second.attemptNumber, diagnostic({ calls: [] })), true);
  } finally {
    database.getDb().close();
    delete globalThis.__viralDb;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("an old video_attempts table gains diagnostics_json without losing attempt history", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "viral-attempt-diagnostics-migration-"));
  const databasePath = path.join(dataRoot, "viral-video-analyzer.sqlite");
  const first = await loadDatabase(dataRoot, "before-migration");
  let videoId = "";
  let attemptId = "";
  try {
    const product = first.createProduct({ name: "migration product" });
    const video = first.createVideo({ productId: product.id, sourceType: "tiktok", sourceUrl: "https://example.com/migration" });
    const attempt = first.startVideoAttempt(video.id);
    videoId = video.id;
    attemptId = attempt.attemptId;
  } finally {
    first.getDb().close();
    delete globalThis.__viralDb;
  }

  const legacy = new DatabaseSync(databasePath);
  legacy.exec("ALTER TABLE video_attempts DROP COLUMN diagnostics_json");
  assert.equal(legacy.prepare("PRAGMA table_info(video_attempts)").all().some((column) => column.name === "diagnostics_json"), false);
  legacy.close();

  const migrated = await loadDatabase(dataRoot, "after-migration");
  try {
    const columns = migrated.getDb().prepare("PRAGMA table_info(video_attempts)").all();
    assert.equal(columns.some((column) => column.name === "diagnostics_json"), true);
    const attempt = migrated.getDb().prepare("SELECT * FROM video_attempts WHERE id=?").get(attemptId);
    assert.equal(attempt.video_id, videoId);
    assert.equal(attempt.status, "running");
    assert.equal(attempt.diagnostics_json, "{}");
    assert.equal(migrated.updateVideoAttemptDiagnostics(videoId, 1, diagnostic({ calls: [] })), true);
  } finally {
    migrated.getDb().close();
    delete globalThis.__viralDb;
    await rm(dataRoot, { recursive: true, force: true });
  }
});
