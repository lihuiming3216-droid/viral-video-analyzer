import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const text = await readFile(new URL("../lib/feishu/safe-logger.ts", import.meta.url), "utf8");
const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { safeSdkLogValues } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
test("SDK logs retain diagnostic codes without serialized request credentials", () => {
  const error = { code: "ERR_BAD_REQUEST", message: "Bearer secret-value",
    config: { headers: { Authorization: "Bearer secret-value" } },
    request: { _header: "Authorization: Bearer secret-value" },
    response: { status: 400, data: { code: 1770002, msg: "secret-value" } } };
  error.self = error;
  const result = safeSdkLogValues([[error], "Bearer secret-value"]);
  assert.deepEqual(result, [{ code: "ERR_BAD_REQUEST", status: 400, apiCode: 1770002 }]);
  assert.doesNotMatch(JSON.stringify(result), /secret-value|Authorization/);
});
