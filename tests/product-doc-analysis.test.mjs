import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/product-doc-analysis.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/import\s+[^;]+from\s+["']@\/lib\/types["'];?/, "");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { conciseProductDocAnalysis } = await import(moduleUrl);

test("product document analysis removes filler and is capped at 160 characters", () => {
  const output = conciseProductDocAnalysis({
    summary: "前3秒展示使用痛点，随后演示产品解决方案并给出使用前后对比。评分95分，转化率很高。最后用真实场景强化购买理由。",
    analysis: {
      hook: { description: "开头直接展示用户最明显的痛点，快速建立观看动机" },
      viralPoints: [
        { description: "用近景完整演示产品操作过程，让效果直观可见" },
        { description: "通过使用前后对比证明产品价值，降低理解成本" },
        { description: "结尾再次强调优惠信息并推动立即下单" },
      ],
      strengths: [
        "镜头顺序清楚，痛点、演示和效果证明衔接自然",
        "字幕与操作画面同步，用户无需声音也能理解",
        "产品露出充分",
      ],
      structureFormula: "痛点钩子—操作演示—效果对比—行动引导",
    },
  });

  assert.ok(output.length <= 160, `expected <=160 characters, got ${output.length}`);
  assert.equal(output.split("\n").length, 3);
  assert.match(output, /^核心：/);
  assert.match(output, /\n爆点：1\./);
  assert.match(output, /\n借鉴：1\./);
  assert.doesNotMatch(output, /评分|95分|转化率/);
  assert.doesNotMatch(output, /通过|进行|能够|可以|有效|有助于|让用户|观看动机|理解成本/);
  assert.doesNotMatch(output, /立即下单|产品露出充分|行动引导/);
});

test("product document analysis omits empty sections without adding blank lines", () => {
  const output = conciseProductDocAnalysis({ summary: "直接展示产品效果。", analysis: {} });
  assert.equal(output, "核心：直接展示产品效果。");
});
