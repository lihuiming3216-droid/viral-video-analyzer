// Run inside the app container. Default is read-only; --apply authorizes model
// organization and filling empty basic fields. No supplier/page request is made.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { createHash } = require("node:crypto");
const root = process.env.REPAIR_SOURCE_ROOT || process.cwd();
const load = Module._load, resolve = Module._resolveFilename;
Module._load = function (name, ...args) { return name === "server-only" ? {} : load.call(this, name, ...args); };
Module._resolveFilename = function (name, ...args) {
  return resolve.call(this, name.startsWith("@/") ? path.join(root, name.slice(2)) : name, ...args);
};
Module._extensions[".ts"] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  module._compile(code, filename);
};
// Production schema is already initialized; this maintenance process never runs DDL.
globalThis.__viralSchemaReady = Promise.resolve();
const { getPool } = require(path.join(root, "lib/db/pool.ts"));
const { recoverPublicProductFromSavedPage, cachedPublicProduct, publicCatalogDirectory } = require(path.join(root, "lib/products/tiktok-public-source.ts"));
const { getChatgptFeishuClient } = require(path.join(root, "lib/feishu/chatgpt-app.ts"));
const { listFeishuDocumentBlocks, syncProductCardManagedFields } = require(path.join(root, "lib/feishu/document.ts"));
const { backfillProductCard } = require(path.join(root, "lib/products/backfill.ts"));
const { savePrivate } = require(path.join(root, "lib/products/catalog-source.ts"));
const labels = ["产品SKU", "产品主要功能", "产品参数", "使用方法", "适用人群", "使用场景"];
const empty = value => /^(未找到|无法获取|无法分析|暂无|无)?$/.test(String(value || "").replace(/\s+/g, ""));
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = block => (block.text?.elements || []).map(x => x.text_run?.content || "").join("");
const isBasic = block => labels.some(label => new RegExp("^\\s*" + label + "\\s*[:：]").test(text(block)));
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? "" : process.argv[i + 1]; };
const apply = process.argv.includes("--apply");
const since = arg("--since") || "2026-09-25";
const onlyPid = arg("--pid");
if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || (onlyPid && !/^\d{6,30}$/.test(onlyPid))) throw Error("Invalid arguments");
const report = result => console.log(JSON.stringify(result));
async function main() {
  const db = await getPool();
  const [rows] = await db.execute(
    `SELECT c.pid,c.fetch_state,c.analysis_state,p.document_id,p.name FROM product_catalog_cache c
     JOIN products p ON p.pid=c.pid WHERE c.created_at>=? AND p.document_id IS NOT NULL
       AND (?='' OR c.pid=?) ORDER BY (c.pid='1732245915614220594') DESC,c.created_at,p.document_id`,
    [since, onlyPid, onlyPid]);
  const client = getChatgptFeishuClient();
  const seen = new Set();
  for (const row of rows) {
    const pid = row.pid, documentId = row.document_id;
    if (seen.has(documentId)) continue;
    seen.add(documentId);
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(publicCatalogDirectory(pid), "receipt.json"), "utf8"));
      if (receipt.state !== "failed" && receipt.recovery !== "saved-page-pdp-components-v1") continue;
      if (row.analysis_state === "requested" || row.analysis_state === "failed") {
        report({pid, documentId, state: "analysis-needs-review"}); continue;
      }
      const product = receipt.state === "failed"
        ? await recoverPublicProductFromSavedPage(pid) : await cachedPublicProduct(pid);
      const pre = await syncProductCardManagedFields(client, {documentId, mode: "verified-basic", preflightOnly: true, protectRevision: true});
      if (pre.currentValues["商品ID"] !== pid || pre.duplicateLabels.length) {
        report({pid, documentId, state: "identity-or-template-mismatch"}); continue;
      }
      const needed = labels.filter(label => empty(pre.currentValues[label]));
      report({pid, documentId, state: apply ? "applying" : "ready-to-recover", needed,
        descriptionChars: product.product_description.length, detailImages: product.product_detail_images.length, skus: product.product_skus.length});
      if (!apply) continue;
      const before = await listFeishuDocumentBlocks(client, documentId);
      const snapshotDir = path.join(process.cwd(), ".data/maintenance/pdp-components-v1", documentId);
      const snapshot = path.join(snapshotDir, "before.json");
      if (!fs.existsSync(snapshot)) await savePrivate(snapshot, JSON.stringify({pid, pre, blocks: before}));
      // This publishes only already-validated saved bytes, before normal DB claims.
      if (receipt.state === "failed") await recoverPublicProductFromSavedPage(pid, true);
      const result = await backfillProductCard(client, pid, documentId);
      const post = await syncProductCardManagedFields(client, {documentId, mode: "verified-basic", preflightOnly: true, protectRevision: true});
      const after = await listFeishuDocumentBlocks(client, documentId);
      const protectedBefore = before.filter(block => !isBasic(block));
      const byId = new Map(after.map(block => [block.block_id, block]));
      const outsideUnchanged = protectedBefore.every(block => hash(block) === hash(byId.get(block.block_id)));
      const manualUnchanged = labels.filter(label => !empty(pre.currentValues[label])).every(label => pre.currentValues[label] === post.currentValues[label]);
      const missing = labels.filter(label => empty(post.currentValues[label]));
      const outcome = {pid, documentId, ...result.body, state: result.body.ok === false ? "write-failed" : missing.length ? "partial" : "verified",
        missing, outsideUnchanged, manualUnchanged};
      await savePrivate(path.join(snapshotDir, "result.json"), JSON.stringify(outcome));
      report(outcome);
      if (!outsideUnchanged || !manualUnchanged) throw Error("Post-write content changed; stop batch for review");
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[url]").slice(0,400) : "Recovery failed";
      report({pid, documentId, state:"failed", message});
      if (message.startsWith("Post-write")) throw error;
    }
  }
}
main().catch(() => { console.error("Recovery stopped; inspect per-document reports"); process.exitCode = 1; })
  .finally(async () => { if(globalThis.__viralPool) await globalThis.__viralPool.end(); });
