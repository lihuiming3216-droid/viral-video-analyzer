import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const routeSource = await readFile(new URL("app/api/products/parse-public/route.ts", root), "utf8");
const compiled = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replaceAll('"next/server"', JSON.stringify(import.meta.resolve("next/server.js")));
const route = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("retired product-link endpoint returns 410 for normal, debug, empty, and invalid bodies", async (t) => {
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", () => {
    networkCalls += 1;
    throw new Error("Retired entry point must not call any external service");
  });
  for (const body of [
    JSON.stringify({ productUrl: "https://shop.tiktok.com/us/pdp/item/1731290195231281426" }),
    JSON.stringify({ pid: "1731290195231281426", debug: "capture" }),
    JSON.stringify({ productUrl: "https://example.com/", force: true, refresh: true }),
    "{}", "null", "", "not-json",
  ]) {
    const request = new Request("http://localhost/api/products/parse-public", {
      method: "POST", body,
    });
    const response = await route.POST(request);
    assert.equal(response.status, 410);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(request.bodyUsed, false, "retirement must happen before reading the request body");
    assert.deepEqual(await response.json(), {
      ok: false,
      code: "PRODUCT_LINK_ANALYSIS_RETIRED",
      error: "商品链接分析入口已停用，请通过飞书表格的补录手卡按钮按 PID 获取商品资料",
    });
  }
  assert.equal(networkCalls, 0);
});

test("old model selection flag cannot re-enable the retired entry point", async () => {
  const previous = process.env.OPENAI_PRODUCT_ANALYSIS_ENABLED;
  try {
    for (const value of [undefined, "true", "false"]) {
      if (value === undefined) delete process.env.OPENAI_PRODUCT_ANALYSIS_ENABLED;
      else process.env.OPENAI_PRODUCT_ANALYSIS_ENABLED = value;
      const response = await route.POST(new Proxy({}, {
        get() { throw new Error("Retired handler must not inspect input"); },
      }));
      assert.equal(response.status, 410);
    }
  } finally {
    if (previous === undefined) delete process.env.OPENAI_PRODUCT_ANALYSIS_ENABLED;
    else process.env.OPENAI_PRODUCT_ANALYSIS_ENABLED = previous;
  }
});

test("retired route loads no parser or provider and exposes no alternative action", () => {
  const parsed = ts.createSourceFile("route.ts", routeSource, ts.ScriptTarget.Latest, true);
  const imports = parsed.statements.filter(ts.isImportDeclaration)
    .map(item => item.moduleSpecifier.text);
  assert.deepEqual(imports, ["next/server"]);
  assert.deepEqual(Object.keys(route).sort(), ["POST", "runtime"]);
});

test("active application modules do not import or re-export the archived product-link analyzers", async () => {
  const archived = new Set(["lib/product-parser.ts", "lib/openai-product-analyzer.ts"]);
  const violations = [];
  async function inspect(directory) {
    for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
      const file = `${directory}${entry.name}`;
      if (entry.isDirectory()) {
        await inspect(`${file}/`);
        continue;
      }
      if (archived.has(file) || !/\.[cm]?[jt]sx?$/.test(file)) continue;
      const source = await readFile(new URL(file, root), "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      function visit(node) {
        const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
            ? node.arguments[0] : undefined;
        if (specifier && ts.isStringLiteralLike(specifier)
          && /(?:^|\/)(?:product-parser|openai-product-analyzer)(?:\.[cm]?[jt]s)?$/.test(specifier.text)) {
          violations.push(`${file}: ${specifier.text}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(parsed);
    }
  }
  await inspect("app/");
  await inspect("lib/");
  assert.deepEqual(violations, [], "archived analysis must not be reachable through a new entry point");
});
