import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/transcript-validation.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const validation = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("a nonempty TokScript transcript cannot be accepted as no voiceover", () => {
  const transcript = "This cuff fits around your upper arm and starts measuring automatically.";
  for (const translation of ["无口播", "该视频没有口播。", "没有旁白，只有背景音乐", "No voice-over."]) {
    assert.equal(validation.transcriptAndTranslationAgree(transcript, translation), false, translation);
  }
  assert.equal(validation.transcriptAndTranslationAgree(transcript, "将袖带套在上臂并自动开始测量。"), true);
});

test("an empty TokScript transcript may still represent a genuinely silent video", () => {
  assert.equal(validation.transcriptAndTranslationAgree("", "无口播"), true);
});
