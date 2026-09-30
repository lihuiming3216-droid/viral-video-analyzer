import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { loadTestModule, moduleUrl, readSource } from "./isolated-mysql.mjs";

/** Real orchestration/guards, explicit hooks for every external dependency. */
export async function loadAutomationFixture(t, hooks) {
  const key = `automationFixture_${randomUUID()}`;
  globalThis[key] = hooks;
  t.after(() => { delete globalThis[key]; });
  const types = await loadTestModule("lib/products/catalog-types.ts");
  const guard = await loadTestModule("lib/feishu/delivery-guard.ts");
  const stub = names => moduleUrl(names.map(name => `export const ${name} = (...args) => {
    const fn = globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}];
    if (!fn) throw new Error("Unconfigured offline hook: ${name}");
    return fn(...args);
  };`).join("\n"));
  let code = ts.transpileModule(await readSource("lib/feishu/automation.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace('import "server-only";', "");
  for (const [, names, specifier] of [...code.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(@\/lib\/[^\"]+)"/g)]) {
    const url = specifier === "@/lib/products/catalog-types" ? types.url
      : specifier === "@/lib/feishu/delivery-guard" ? guard.url
      : stub(names.split(",").map(name => name.trim()).filter(Boolean));
    code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(url));
  }
  code = code.replaceAll('"@/lib/products/catalog"', JSON.stringify(stub(["getProductCatalog", "getProductNameByPid", "getProductMetadataByPid"])));
  assert.doesNotMatch(code, /["']@\//);
  return import(moduleUrl(code));
}
