// Run inside the app container. Default is read-only; --apply authorizes model
// organization and filling empty basic fields. No supplier/page request is made
// unless --retry-public --pid explicitly requests one PID's free-source recovery.
/* eslint-disable @typescript-eslint/no-require-imports -- Node-stdin maintenance runner uses CommonJS for the TypeScript loader. */
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
const { savePrivate, cachedProduct, prepareCatalogEvidence, catalogDirectory } = require(path.join(root, "lib/products/catalog-source.ts"));
const { cachedCatalogResult, catalogFields, isMissingCatalogText } = require(path.join(root, "lib/products/catalog-types.ts"));
const { readCatalog } = require(path.join(root, "lib/products/catalog-store.ts"));
const { parseCatalogModelResponse } = require(path.join(root, "lib/products/catalog-analyzer.ts"));
const { reorganizeCatalogFromCache } = require(path.join(root, "lib/products/catalog-reorganize.ts"));
const { catalogForWrite } = require(path.join(root, "lib/products/catalog.ts"));
const labels = ["产品SKU", "产品主要功能", "产品参数", "使用方法", "适用人群", "使用场景"];
const empty = value => isMissingCatalogText(String(value || ""));
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = block => (block.text?.elements || []).map(x => x.text_run?.content || "").join("");
const decoration = String.raw`[ \t\p{Extended_Pictographic}\uFE0F\u200D•·▪▫◦●○★☆]*`;
const isBasic = block => labels.some(label => new RegExp("^" + decoration + label + "[ \\t]*[:：][^\\r\\n]*$", "u").test(text(block)));
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? "" : process.argv[i + 1]; };
const apply = process.argv.includes("--apply");
const allCache = process.argv.includes("--all-cache");
const restoreUsage = process.argv.includes("--restore-routine-usage");
const retryPublic = process.argv.includes("--retry-public");
const reorganizeMissing = process.argv.includes("--reorganize-missing");
const offlineOnly = process.argv.includes("--offline-only");
const since = arg("--since") || (allCache ? "1970-01-01" : "2026-09-25");
const onlyPid = arg("--pid");
const onlyDocumentId = arg("--document-id");
if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || (onlyPid && !/^\d{6,30}$/.test(onlyPid))) throw Error("Invalid arguments");
if (retryPublic && (!apply || !onlyPid || allCache || process.env.CHUHAIJIANG_FALLBACK_ENABLED === "true")) {
  throw Error("Free-source recovery requires --apply --pid and disabled paid fallback");
}
if (onlyDocumentId && (!retryPublic || !/^[A-Za-z0-9_-]{10,191}$/.test(onlyDocumentId))) {
  throw Error("An explicit document requires one validated PID's free-source recovery");
}
if (reorganizeMissing && (!apply || !allCache)) throw Error("Missing-field reorganization requires --all-cache --apply");
if (offlineOnly && (!apply || !allCache || retryPublic || reorganizeMissing)) throw Error("Offline recovery requires --all-cache --apply without live recovery flags");
const routineRepairId = pid => {
  const digest = createHash("sha256").update("cached-missing-routine-v1:" + pid).digest("hex").slice(0,32);
  return [digest.slice(0,8),digest.slice(8,12),digest.slice(12,16),digest.slice(16,20),digest.slice(20)].join("-");
};
const savedReplyEvidence = (pid, file, evidence) => path.dirname(file) === path.join(catalogDirectory(pid), "reorganizations", routineRepairId(pid))
  ? evidence : { ...evidence, images: [] };
const events = [];
const report = result => { events.push(result); console.log(JSON.stringify(result)); };

async function restoreSavedUsage(db, pid) {
  const connection = await db.getConnection();
  let locked = false;
  try {
    const [locks] = await connection.execute("SELECT GET_LOCK(?,0) AS acquired", ["catalog-reorganize:" + pid]);
    locked = Number(locks[0].acquired) === 1;
    if (!locked) return false;
    const row = await readCatalog(pid);
    if (row?.fetch_state !== "ready" || row.analysis_state !== "ready") return false;
    const current = cachedCatalogResult(typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json, pid);
    if (!current || current.fields.usageMethod.basis !== "missing") return false;
    const directory = catalogDirectory(pid);
    const [runs] = await connection.execute("SELECT id FROM product_catalog_reorganizations WHERE pid=? AND state='ready' ORDER BY updated_at DESC LIMIT 10", [pid]);
    const directories = [...runs.filter(run => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(run.id))
      .map(run => path.join(directory,"reorganizations",run.id)),directory];
    const files = directories.flatMap(dir => fs.existsSync(dir) ? fs.readdirSync(dir)
      .filter(name => /^model-response-[12]\.json$/.test(name)).sort().reverse().map(name => path.join(dir,name)) : []);
    if (!files.length) return false;
    let item;
    try { item = await cachedPublicProduct(pid); } catch { /* Only existing supplier evidence is eligible next. */ }
    item ||= await cachedProduct(pid);
    if (!item) return false;
    const evidence = await prepareCatalogEvidence(pid, item, { cacheOnly: true });
    let fact, digest;
    for (const file of files) {
      const receipt = JSON.parse(fs.readFileSync(file.replace("response", "receipt"), "utf8"));
      if (fs.statSync(file).size > 2 * 1024 * 1024) throw Error("Saved model reply too large");
      const body = fs.readFileSync(file);
      digest = createHash("sha256").update(body).digest("hex");
      if (receipt.httpStatus !== 200 || digest !== receipt.sha256) throw Error("Saved model reply checksum mismatch");
      if (receipt.model !== current.model) continue;
      // Only this reviewed repair generation is known to use the current
      // detail-only image numbering. Older replies may number main/SKU images
      // the same way, so they can be restored from text references only.
      const restored = parseCatalogModelResponse(body, savedReplyEvidence(pid, file, evidence), receipt.model, receipt.provider);
      if (restored.warnings.some(warning => warning.startsWith("使用方法含未知来源"))) continue;
      if (restored.fields.usageMethod.basis !== "missing") { fact = restored.fields.usageMethod; break; }
    }
    if (!fact) return false;
    const result = { ...current, fields: { ...current.fields, usageMethod: fact },
      warnings: [...new Set([...current.warnings, "使用方法按负责人确认的常规推断规则恢复；复用已保存模型回复，未再次请求模型"])] };
    const recovery = path.join(directory, "replays/routine-usage-v1", digest);
    if (!fs.existsSync(path.join(recovery, "before.json"))) await savePrivate(path.join(recovery, "before.json"), JSON.stringify(row));
    await savePrivate(path.join(recovery, "organized.json"), JSON.stringify(result));
    const [updated] = await connection.execute("UPDATE product_catalog_cache SET result_json=?,updated_at=? WHERE pid=? AND fetch_state='ready' AND analysis_state='ready' AND updated_at=?",
      [JSON.stringify(result), new Date().toISOString(), pid, row.updated_at]);
    if (updated.affectedRows !== 1) throw Error("Catalog changed during offline recovery; old facts preserved");
    report({ pid, state: "saved-usage-restored", source: "saved-model-reply", modelCalls: 0 });
    return true;
  } finally {
    try { if (locked) await connection.execute("SELECT RELEASE_LOCK(?)", ["catalog-reorganize:" + pid]); }
    finally { connection.release(); }
  }
}
async function main() {
  const db = await getPool();
  const current = onlyDocumentId ? await readCatalog(onlyPid) : null;
  const [rows] = onlyDocumentId ? [[{pid: onlyPid, document_id: onlyDocumentId,
    fetch_state: current?.fetch_state || "uncached", analysis_state: current?.analysis_state || "waiting"}]] : await db.execute(
    `SELECT c.pid,c.fetch_state,c.analysis_state,p.document_id,p.name FROM product_catalog_cache c
     JOIN (SELECT pid,document_id,name FROM products WHERE is_system=0
       UNION SELECT last_product_pid,document_id,last_product_name FROM feishu_product_card_mappings) p ON p.pid=c.pid
     WHERE c.created_at>=? AND p.document_id IS NOT NULL AND p.document_id<>''
       AND (?='' OR c.pid=?) ORDER BY (c.pid='1732245915614220594') DESC,c.created_at,p.document_id`,
    [since, onlyPid, onlyPid]);
  const client = getChatgptFeishuClient();
  const seen = new Set();
  const summary = { scanned: 0, unchanged: 0, repaired: 0, partial: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    const pid = row.pid, documentId = row.document_id;
    if (seen.has(documentId)) continue;
    seen.add(documentId);
    summary.scanned++;
    try {
      let receipt = null;
      try { receipt = JSON.parse(fs.readFileSync(path.join(publicCatalogDirectory(pid), "receipt.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!allCache && !retryPublic && (!receipt || (receipt.state !== "failed" && receipt.recovery !== "saved-page-pdp-components-v1"))) continue;
      if (row.analysis_state === "requested" || row.fetch_state === "requested") {
        summary.skipped++; report({pid, documentId, state: "active-task-preserved"}); continue;
      }
      if (offlineOnly && row.analysis_state !== "ready") {
        summary.skipped++; report({pid, documentId, state:"offline-recovery-needs-ready-cache"}); continue;
      }
      const pre = await syncProductCardManagedFields(client, {documentId, mode: "verified-basic", preflightOnly: true, protectRevision: true});
      if (pre.currentValues["商品ID"] !== pid || pre.duplicateLabels.length) {
        summary.skipped++;
        report({pid, documentId, state: "identity-or-template-mismatch"}); continue;
      }
      // Missing/unrecognized legacy rows are not blanks. Never charge a model
      // or replace a multi-field manual paragraph merely to normalize its layout.
      const needed = labels.filter(label => !pre.missingLabels.includes(label) && empty(pre.currentValues[label]));
      if (!needed.length) { summary.unchanged++; continue; }
      let product = null;
      if (row.analysis_state !== "ready") {
        try { product = receipt?.state === "failed" ? await recoverPublicProductFromSavedPage(pid) : await cachedPublicProduct(pid); }
        catch (error) { if (!allCache && !retryPublic) throw error; }
        if (!product) {
          try { product = await cachedProduct(pid); }
          catch (error) { if (!retryPublic) throw error; }
        }
        if (!product && !retryPublic) { summary.skipped++; report({pid,documentId,state:"no-recoverable-cache"}); continue; }
      }
      report({pid, documentId, state: apply ? "applying" : "ready-to-recover", needed,
        source: row.analysis_state === "ready" ? "organized-cache" : product?._catalog_source || (retryPublic ? "free-source-recovery" : "supplier-cache")});
      if (!apply) continue;
      if (restoreUsage && needed.includes("使用方法") && row.analysis_state === "ready") await restoreSavedUsage(db, pid);
      if (row.analysis_state === "ready") {
        const current = await readCatalog(pid);
        let cached = cachedCatalogResult(typeof current.result_json === "string" ? JSON.parse(current.result_json) : current.result_json, pid);
        cached = await catalogForWrite(cached);
        if (reorganizeMissing && needed.some(label => Object.entries(cached.fields).some(([key,fact]) => catalogFields[key] === label && fact.basis === "missing"))) {
          // A fixed repair generation prevents repeat batches from requesting
          // another paid model call when the new source still lacks a fact.
          const id = routineRepairId(pid);
          report({pid,documentId,state:"organizing-cached-missing-fields",supplierCalls:0});
          cached = await catalogForWrite(await reorganizeCatalogFromCache(pid,id,{fillMissingOnly:true}));
        }
        // Missing facts still need a visible pending marker. Backfill never
        // counts that placeholder as complete or overwrites substantive text.
      }
      const before = await listFeishuDocumentBlocks(client, documentId);
      const snapshotDir = path.join(process.cwd(), ".data/maintenance", allCache ? "cached-handcards-v1" : "pdp-components-v1", documentId);
      const snapshot = path.join(snapshotDir, "before.json");
      if (!fs.existsSync(snapshot)) await savePrivate(snapshot, JSON.stringify({pid, pre, blocks: before}));
      // This publishes only already-validated saved bytes, before normal DB claims.
      if (receipt?.state === "failed" && product?._catalog_source === "tiktok-public") await recoverPublicProductFromSavedPage(pid, true);
      const result = await backfillProductCard(client, pid, documentId);
      const post = await syncProductCardManagedFields(client, {documentId, mode: "verified-basic", preflightOnly: true, protectRevision: true});
      const after = await listFeishuDocumentBlocks(client, documentId);
      const protectedBefore = before.filter(block => !isBasic(block));
      const byId = new Map(after.map(block => [block.block_id, block]));
      const outsideUnchanged = protectedBefore.every(block => hash(block) === hash(byId.get(block.block_id)));
      const manualUnchanged = labels.filter(label => !empty(pre.currentValues[label])).every(label => pre.currentValues[label] === post.currentValues[label]);
      const missing = needed.filter(label => empty(post.currentValues[label]));
      const outcome = {pid, documentId, ...result.body, state: result.body.ok === false ? "write-failed" : missing.length ? "partial" : "verified",
        missing, outsideUnchanged, manualUnchanged};
      await savePrivate(path.join(snapshotDir, "result.json"), JSON.stringify(outcome));
      report(outcome);
      if (outcome.state === "verified") summary.repaired++;
      else if (outcome.state === "partial") summary.partial++;
      else summary.failed++;
      if (!outsideUnchanged || !manualUnchanged) throw Error("Post-write content changed; stop batch for review");
    } catch (error) {
      summary.failed++;
      const message = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[url]").slice(0,400) : "Recovery failed";
      report({pid, documentId, state:"failed", message});
      if (message.startsWith("Post-write")) throw error;
    }
  }
  const completed = { state: "cache-recovery-complete", apply, ...summary };
  report(completed);
  if (apply) await savePrivate(path.join(process.cwd(), ".data/maintenance/cached-handcards-v1/runs",
    require("node:crypto").randomUUID() + ".json"), JSON.stringify({at:new Date().toISOString(),onlyPid,onlyDocumentId,restoreUsage,retryPublic,reorganizeMissing,offlineOnly,summary:completed,events}));
}
main().catch(() => { console.error("Recovery stopped; inspect per-document reports"); process.exitCode = 1; })
  .finally(async () => { if(globalThis.__viralPool) await globalThis.__viralPool.end(); });
