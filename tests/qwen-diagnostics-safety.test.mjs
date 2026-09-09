import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const asModule = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64")}`;
const types = asModule(await readFile(new URL("../lib/types.ts", import.meta.url), "utf8"));
const pool = asModule("export const getPool = async () => globalThis.__diagnosticTestPool;");
const source = await readFile(new URL("../lib/database.ts", import.meta.url), "utf8");
const database = await import(asModule(source.replace('import "server-only";', "")
  .replace('"@/lib/db/pool"', JSON.stringify(pool))
  .replaceAll('"@/lib/types"', JSON.stringify(types))));

test("MySQL diagnostic writes accept only safe codes and target the exact unfinished attempt", async () => {
  const queries = [];
  let affectedRows = 1;
  globalThis.__diagnosticTestPool = { query: async (sql, params) => {
    queries.push({ sql, params });
    return [{ affectedRows }];
  } };
  const diagnostic = {
    schemaVersion: 1, provider: "qwen", model: "qwen3.7-plus", inputMode: "local_base64",
    fileBytes: 100, inputSha256: "1".repeat(64), encodedBytes: 136, durationMs: 1000,
    hasAudio: true, videoCodec: "h264", audioCodec: "aac",
    calls: [{ requestIndex: 1, clientRequestId: "safe-client-id", phase: "awaiting_headers",
      outcome: "timeout", startedAt: "2026-09-08T07:56:13.361Z", totalMs: 301258,
      errorCode: "UND_ERR_HEADERS_TIMEOUT" }],
  };
  try {
    assert.equal(await database.updateVideoAttemptDiagnostics("video", 1, diagnostic), true);
    const update = queries.at(-1);
    assert.match(update.sql, /video_id=\? AND attempt_number=\? AND status='running' AND finished_at IS NULL/);
    assert.deepEqual(update.params, [JSON.stringify(diagnostic), "video", 1]);
    affectedRows = 0;
    assert.equal(await database.updateVideoAttemptDiagnostics("video", 1, diagnostic), false);

    const count = queries.length;
    for (const code of ["https://signed.example/?secret=value", "sk-secret-key", "OTHER_ERROR", "", 123]) {
      await assert.rejects(database.updateVideoAttemptDiagnostics("video", 1, {
        ...diagnostic, calls: [{ ...diagnostic.calls[0], errorCode: code }],
      }), /网络错误码无效/);
    }
    for (const forbidden of ["cause", "prompt", "apiKey", "rawResponse"]) {
      await assert.rejects(database.updateVideoAttemptDiagnostics("video", 1, {
        ...diagnostic, calls: [{ ...diagnostic.calls[0], [forbidden]: "secret" }],
      }), /不允许的字段/);
    }
    await assert.rejects(database.updateVideoAttemptDiagnostics("video", 1, {
      ...diagnostic, calls: [...diagnostic.calls, ...diagnostic.calls, ...diagnostic.calls],
    }), /最多记录2/);
    await assert.rejects(database.updateVideoAttemptDiagnostics("video", 1, {
      ...diagnostic, model: "x".repeat(17 * 1024),
    }), /不能超过/);
    assert.equal(queries.length, count, "unsafe data must be rejected before any database call");
  } finally { delete globalThis.__diagnosticTestPool; }
});
