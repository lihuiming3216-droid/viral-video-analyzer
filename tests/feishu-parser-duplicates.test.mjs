import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/feishu/parser.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const parser = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("the same TikTok link repeated in one Feishu message creates independent submissions", () => {
  const url = "https://www.tiktok.com/t/ZTESTREPEAT/";
  const parsed = parser.parseFeishuSubmission(`血压仪 PID：1732000000000000000\n${url}\n${url}`);
  assert.equal(parsed.error, "");
  assert.deepEqual(parsed.urls, [url, url]);
});

test("lookalike non-TikTok hosts are rejected", () => {
  const parsed = parser.parseFeishuSubmission("产品：测试 https://eviltiktok.com/video/1");
  assert.equal(parsed.urls.length, 0);
  assert.equal(parsed.unsupportedUrls.length, 1);
  assert.match(parsed.error, /只支持 TikTok/);
});
