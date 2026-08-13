import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const databaseSource = await readFile(
  new URL("../lib/database.ts", import.meta.url),
  "utf8",
);

async function loadDatabaseModule(dataRoot) {
  let compiled = ts.transpileModule(databaseSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  compiled = compiled
    .replace('import "server-only";', "")
    .replace(
      'const dataRoot = path.join(process.cwd(), ".data");',
      `const dataRoot = ${JSON.stringify(dataRoot)};`,
    );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  return import(moduleUrl);
}

test("Base row product-card mappings migrate and upsert without requiring a PID", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "viral-card-mapping-"));
  const dataRoot = path.join(temporaryRoot, ".data");
  await mkdir(dataRoot, { recursive: true });
  const databasePath = path.join(dataRoot, "viral-video-analyzer.sqlite");

  // Simulate an early installation that already persisted the row/document
  // identity but predates product binding and last-seen product metadata.
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE feishu_product_card_mappings (
    app_token TEXT NOT NULL,
    table_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    document_id TEXT,
    document_url TEXT,
    PRIMARY KEY(app_token, table_id, record_id)
  )`);
  legacy.prepare(`INSERT INTO feishu_product_card_mappings(
    app_token, table_id, record_id, document_id, document_url
  ) VALUES (?, ?, ?, ?, ?)`)
    .run("app-legacy", "table-legacy", "record-legacy", "doc-legacy", "https://feishu.cn/docx/doc-legacy");
  legacy.close();

  delete globalThis.__viralDb;
  const database = await loadDatabaseModule(dataRoot);
  try {
    const migrated = database.getFeishuProductCardMapping({
      appToken: "app-legacy",
      tableId: "table-legacy",
      recordId: "record-legacy",
    });
    assert.deepEqual({
      productId: migrated.productId,
      documentId: migrated.documentId,
      documentUrl: migrated.documentUrl,
      lastProductPid: migrated.lastProductPid,
      lastProductUrl: migrated.lastProductUrl,
      lastProductName: migrated.lastProductName,
      managedProductPid: migrated.managedProductPid,
    }, {
      productId: null,
      documentId: "doc-legacy",
      documentUrl: "https://feishu.cn/docx/doc-legacy",
      lastProductPid: "",
      lastProductUrl: "",
      lastProductName: "",
      managedProductPid: "",
    });
    assert.ok(migrated.createdAt);
    assert.ok(migrated.updatedAt);

    const key = { appToken: "app-a", tableId: "table-a", recordId: "record-a" };
    const pending = database.upsertFeishuProductCardMapping(key);
    assert.equal(pending.productId, null);
    assert.equal(pending.documentId, null);
    assert.equal(pending.lastProductPid, "");

    const product = database.createProduct({
      name: "室内摄像头",
      pid: "1731678528327946361",
      productUrl: "https://www.tiktok.com/shop/pdp/indoor-camera/1731678528327946361",
    });
    const bound = database.upsertFeishuProductCardMapping({
      ...key,
      productId: product.id,
      documentId: "doc-a",
      documentUrl: "https://feishu.cn/docx/doc-a",
      lastProductPid: product.pid,
      lastProductUrl: product.productUrl,
      lastProductName: product.name,
      managedProductPid: product.pid,
    });
    assert.equal(bound.productId, product.id);
    assert.equal(bound.documentId, "doc-a");
    assert.equal(bound.lastProductPid, product.pid);
    assert.equal(bound.managedProductPid, product.pid);
    assert.equal(bound.createdAt, pending.createdAt, "binding a product must not recreate the row mapping");

    const partial = database.upsertFeishuProductCardMapping({ ...key, lastProductName: "室内安防摄像头" });
    assert.equal(partial.productId, product.id, "omitted bindings must be preserved");
    assert.equal(partial.documentId, "doc-a");
    assert.equal(partial.lastProductPid, product.pid);
    assert.equal(partial.lastProductName, "室内安防摄像头");
    assert.equal(partial.managedProductPid, product.pid, "omitting the managed PID must preserve it");

    database.upsertFeishuProductCardMapping({
      appToken: "app-b",
      tableId: "table-b",
      recordId: "record-b",
      productId: product.id,
      documentId: "doc-b",
      documentUrl: "https://feishu.cn/docx/doc-b",
    });
    assert.deepEqual(
      database.listFeishuProductCardMappingsByProductId(product.id).map((mapping) => mapping.documentId),
      ["doc-a", "doc-b"],
      "all Base rows bound to one product remain independently enumerable",
    );
    assert.deepEqual(database.listFeishuProductCardMappingsByProductId(""), []);

    const cleared = database.upsertFeishuProductCardMapping({ ...key, managedProductPid: "" });
    assert.equal(cleared.managedProductPid, "", "an explicit empty managed PID must clear it");

    const count = database.getDb().prepare(`SELECT COUNT(*) AS count
      FROM feishu_product_card_mappings
      WHERE app_token=? AND table_id=? AND record_id=?`)
      .get(key.appToken, key.tableId, key.recordId);
    assert.equal(Number(count.count), 1, "repeated button clicks must reuse one composite-key mapping");

    const columns = database.getDb().prepare("PRAGMA table_info(feishu_product_card_mappings)").all()
      .map((column) => String(column.name));
    for (const expected of [
      "app_token", "table_id", "record_id", "product_id", "document_id", "document_url",
      "last_product_pid", "last_product_url", "last_product_name", "managed_product_pid", "created_at", "updated_at",
    ]) assert.ok(columns.includes(expected), `missing migrated column ${expected}`);
    assert.ok(columns.every((column) => !/secret/i.test(column)), "the mapping must never persist webhook secrets");
  } finally {
    database.getDb().close();
    delete globalThis.__viralDb;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("multiple Base rows may share the same PID document mapping", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "viral-card-claim-"));
  const dataRoot = path.join(temporaryRoot, ".data");
  await mkdir(dataRoot, { recursive: true });
  const databasePath = path.join(dataRoot, "viral-video-analyzer.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE feishu_product_card_mappings (
    app_token TEXT NOT NULL,
    table_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    document_id TEXT,
    document_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(app_token, table_id, record_id)
  )`);
  const insertLegacy = legacy.prepare(`INSERT INTO feishu_product_card_mappings(
    app_token, table_id, record_id, document_id, document_url, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insertLegacy.run(
    "app", "table", "row-later", "duplicate-doc", "https://feishu.cn/docx/duplicate-doc",
    "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z",
  );
  insertLegacy.run(
    "app", "table", "row-earliest", "duplicate-doc", "https://feishu.cn/docx/duplicate-doc",
    "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z",
  );
  legacy.close();

  delete globalThis.__viralDb;
  const database = await loadDatabaseModule(dataRoot);
  try {
    const earliest = database.getFeishuProductCardMapping({ appToken: "app", tableId: "table", recordId: "row-earliest" });
    const later = database.getFeishuProductCardMapping({ appToken: "app", tableId: "table", recordId: "row-later" });
    assert.equal(earliest.documentId, "duplicate-doc");
    assert.equal(later.documentId, "duplicate-doc", "same-PID rows retain the shared document mapping");

    const laterKey = { appToken: "app", tableId: "table", recordId: "row-later" };
    assert.equal(database.claimFeishuProductCardDocument(laterKey, {
      documentId: "duplicate-doc",
      documentUrl: "https://feishu.cn/docx/duplicate-doc",
    }), true, "another row may associate the same PID document");
    assert.equal(database.claimFeishuProductCardDocument(laterKey, {
      documentId: "later-doc",
      documentUrl: "https://feishu.cn/docx/later-doc",
    }), true);
    assert.equal(database.claimFeishuProductCardDocument(laterKey, {
      documentId: "later-doc",
      documentUrl: "https://feishu.cn/docx/later-doc?source=second-call",
    }), true, "claiming the same document is idempotent");
    assert.equal(database.claimFeishuProductCardDocument(laterKey, {
      documentId: "different-doc",
      documentUrl: "https://feishu.cn/docx/different-doc",
    }), true, "a row mapping may be refreshed from the authoritative PID lookup");
    assert.equal(database.getFeishuProductCardMapping(laterKey).documentId, "different-doc");

    const newKey = { appToken: "app", tableId: "table", recordId: "new-row" };
    assert.equal(database.claimFeishuProductCardDocument(newKey, {
      documentId: "new-doc",
      documentUrl: "https://feishu.cn/docx/new-doc",
    }), true, "claim can atomically establish a previously absent row mapping");
    assert.equal(database.getFeishuProductCardMapping(newKey).documentId, "new-doc");

    const documentIndex = database.getDb().prepare(`SELECT sql FROM sqlite_master
      WHERE type='index' AND name='idx_feishu_product_card_mapping_document'`).get();
    assert.doesNotMatch(String(documentIndex.sql), /UNIQUE INDEX/i);
    assert.match(String(documentIndex.sql), /ON feishu_product_card_mappings\(document_id\)/i);
  } finally {
    database.getDb().close();
    delete globalThis.__viralDb;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
