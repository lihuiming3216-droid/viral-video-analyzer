import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const databaseSource = await readFile(new URL("../lib/database.ts", import.meta.url), "utf8");

async function loadDatabase(dataRoot, nonce) {
  let compiled = ts.transpileModule(databaseSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  compiled = compiled
    .replace('import "server-only";', "")
    .replace('const dataRoot = path.join(process.cwd(), ".data");', `const dataRoot = ${JSON.stringify(dataRoot)};`);
  delete globalThis.__viralDb;
  return import(`data:text/javascript;base64,${Buffer.from(`${compiled}\n// ${nonce}`).toString("base64")}`);
}

test("product-document failure delivery state migrates, persists and survives the legacy videos rebuild", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "viral-product-doc-failure-delivery-"));
  const databasePath = path.join(dataRoot, "viral-video-analyzer.sqlite");
  let videoId = "";

  const initial = await loadDatabase(dataRoot, "initial");
  try {
    const product = initial.createProduct({ name: "failure delivery product" });
    const video = initial.createVideo({
      productId: product.id,
      sourceType: "tiktok",
      sourceUrl: "https://www.tiktok.com/t/failure-delivery/",
      analysisMode: "product_doc",
    });
    videoId = video.id;
    assert.equal(video.productDocFailureDelivered, false);
    assert.equal(initial.getDb().prepare("SELECT product_doc_failure_delivered FROM videos WHERE id=?").get(videoId).product_doc_failure_delivered, 0);
  } finally {
    initial.getDb().close();
    delete globalThis.__viralDb;
  }

  const legacy = new DatabaseSync(databasePath);
  legacy.exec("ALTER TABLE videos DROP COLUMN product_doc_failure_delivered");
  assert.equal(legacy.prepare("PRAGMA table_info(videos)").all().some((column) => column.name === "product_doc_failure_delivered"), false);
  legacy.close();

  const migrated = await loadDatabase(dataRoot, "migrated");
  try {
    const column = migrated.getDb().prepare("PRAGMA table_info(videos)").all()
      .find((candidate) => candidate.name === "product_doc_failure_delivered");
    assert.ok(column);
    assert.equal(Number(column.notnull), 1);
    assert.equal(String(column.dflt_value), "0");
    assert.equal(migrated.getVideo(videoId).productDocFailureDelivered, false);

    const updated = migrated.updateVideo(videoId, { product_doc_failure_delivered: true });
    assert.equal(updated.productDocFailureDelivered, true);
    assert.equal(migrated.getDb().prepare("SELECT product_doc_failure_delivered FROM videos WHERE id=?").get(videoId).product_doc_failure_delivered, 1);
  } finally {
    migrated.getDb().close();
    delete globalThis.__viralDb;
  }

  const uniqueLegacy = new DatabaseSync(databasePath);
  uniqueLegacy.exec("CREATE UNIQUE INDEX legacy_unique_source_url_failure_delivery ON videos(source_url)");
  uniqueLegacy.close();

  const rebuilt = await loadDatabase(dataRoot, "rebuilt");
  try {
    assert.equal(rebuilt.getVideo(videoId).productDocFailureDelivered, true);
    assert.equal(rebuilt.getDb().prepare("PRAGMA foreign_key_check").all().length, 0);
    const uniqueSourceIndexes = rebuilt.getDb().prepare("PRAGMA index_list(videos)").all()
      .filter((index) => Number(index.unique))
      .filter((index) => {
        const columns = rebuilt.getDb().prepare(`PRAGMA index_info(${JSON.stringify(String(index.name))})`).all();
        return columns.length === 1 && columns[0].name === "source_url";
      });
    assert.equal(uniqueSourceIndexes.length, 0);

    const cleared = rebuilt.updateVideo(videoId, { product_doc_failure_delivered: false });
    assert.equal(cleared.productDocFailureDelivered, false);
    assert.equal(rebuilt.getDb().prepare("SELECT product_doc_failure_delivered FROM videos WHERE id=?").get(videoId).product_doc_failure_delivered, 0);

    rebuilt.updateVideo(videoId, { product_doc_failure_delivered: true });
    const attempt = rebuilt.startVideoAttempt(videoId);
    assert.equal(rebuilt.getVideo(videoId).productDocFailureDelivered, false);
    rebuilt.finishVideoAttempt(attempt.attemptId, videoId, "completed");
  } finally {
    rebuilt.getDb().close();
    delete globalThis.__viralDb;
    await rm(dataRoot, { recursive: true, force: true });
  }
});
