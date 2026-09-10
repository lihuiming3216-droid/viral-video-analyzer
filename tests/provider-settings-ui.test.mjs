import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const types = moduleUrl(compile(await readFile(new URL("../lib/ai/types.ts", import.meta.url), "utf8")));
const stub = moduleUrl("export const saveAiPurposeAction = async () => {}; export const saveProviderAction = async () => {}; export const TestConnectionButton = () => null;");
const source = compile(await readFile(new URL("../app/admin/providers/SettingsForms.tsx", import.meta.url), "utf8"))
  .replaceAll('"react"', JSON.stringify(import.meta.resolve("react")))
  .replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve("react/jsx-runtime")))
  .replaceAll('"@/lib/ai/types"', JSON.stringify(types))
  .replaceAll('"./actions"', JSON.stringify(stub)).replaceAll('"./TestConnectionButton"', JSON.stringify(stub));
export const { PurposeForm, SharedProviderForm } = await import(moduleUrl(source));

export const purposeFixtures = ["product", "video", "translation"].map(purpose => ({
  config: { purpose, provider: "qwen", model: purpose === "product" ? "qwen3.7-plus" : purpose === "video" ? "qwen3.5-omni-plus" : "qwen-plus",
    credentialSource: "shared", baseUrl: "", retries: purpose === "video" ? 1 : 0, videoAudioConfirmed: purpose === "video" },
  hasCustomKey: false, saved: false,
}));

test("actual settings components render all three purposes, retry controls and the complete-audio requirement", () => {
  const html = purposeFixtures.map(props => renderToStaticMarkup(createElement(PurposeForm, props))).join("");
  for (const label of ["商品基础资料", "手卡视频分析", "中文翻译", "qwen3.7-plus", "qwen3.5-omni-plus", "qwen-plus", "完整MP4画面及原音轨", "可能重复计费"]) assert.ok(html.includes(label), label);
  assert.equal((html.match(/name="purpose"/g) || []).length, 3);
  assert.equal((html.match(/name="retries"/g) || []).length, 3);
  assert.equal((html.match(/name="videoAudioConfirmed"/g) || []).length, 1);
  assert.doesNotMatch(html, /完整视频分析|任务安排.*分析设置/);
});

test("custom credentials are rendered as blank password fields, never as saved secret values", () => {
  const props = { ...purposeFixtures[0], config: { ...purposeFixtures[0].config, credentialSource: "custom", baseUrl: "https://fixture.example/v1" }, hasCustomKey: true, saved: true };
  const html = renderToStaticMarkup(createElement(PurposeForm, props));
  assert.match(html, /type="password"/);
  assert.match(html, /已配置，留空不修改/);
  assert.doesNotMatch(html, /name="apiKey"[^>]*value=/);
  assert.match(html, /https:\/\/fixture.example\/v1/);
});
