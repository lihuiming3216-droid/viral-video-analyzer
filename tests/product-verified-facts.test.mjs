import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const databaseSource = await readFile(new URL("../lib/database.ts", import.meta.url), "utf8");

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
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

async function withDatabase(run, prepare) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "viral-verified-facts-"));
  const dataRoot = path.join(temporaryRoot, ".data");
  await mkdir(dataRoot, { recursive: true });
  if (prepare) await prepare(path.join(dataRoot, "viral-video-analyzer.sqlite"));
  delete globalThis.__viralDb;
  const database = await loadDatabaseModule(dataRoot);
  try {
    await run(database);
  } finally {
    database.getDb().close();
    delete globalThis.__viralDb;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("legacy products migrate with an explicitly unverified empty provenance", async () => {
  await withDatabase(async (database) => {
    const product = database.getProduct("legacy-product");
    assert.equal(product.verifiedPid, "");
    assert.equal(product.verifiedSourceUrl, "");
    assert.equal(product.evidenceVersion, "");
    assert.equal(product.factsVerifiedAt, "");
    const columns = database.getDb().prepare("PRAGMA table_info(products)").all()
      .map((column) => String(column.name));
    for (const expected of ["verified_pid", "verified_source_url", "evidence_version", "facts_verified_at"]) {
      assert.ok(columns.includes(expected), `missing migrated column ${expected}`);
    }
    assert.ok(columns.every((column) => !/(?:secret|prompt|response)/i.test(column)));
  }, async (databasePath) => {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE products (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, pid TEXT NOT NULL DEFAULT '', sku TEXT NOT NULL DEFAULT '',
      document_id TEXT, document_url TEXT, image_path TEXT, prop_images_json TEXT NOT NULL DEFAULT '[]',
      category TEXT NOT NULL DEFAULT '', market TEXT NOT NULL DEFAULT '', price TEXT NOT NULL DEFAULT '',
      selling_points TEXT NOT NULL DEFAULT '', target_audience TEXT NOT NULL DEFAULT '', pain_points TEXT NOT NULL DEFAULT '',
      competitors TEXT NOT NULL DEFAULT '', product_url TEXT NOT NULL DEFAULT '', core_functions_json TEXT NOT NULL DEFAULT '[]',
      product_parameters TEXT NOT NULL DEFAULT '', usage_method TEXT NOT NULL DEFAULT '', usage_scenes TEXT NOT NULL DEFAULT '',
      source_title TEXT NOT NULL DEFAULT '', source_description TEXT NOT NULL DEFAULT '', source_image_urls_json TEXT NOT NULL DEFAULT '[]',
      visual_evidence TEXT NOT NULL DEFAULT '', visual_analysis_status TEXT NOT NULL DEFAULT '', visual_analyzed_at TEXT,
      banned_terms TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO products(id,name,pid,core_functions_json,product_parameters,created_at,updated_at)
    VALUES ('legacy-product','旧产品','1730000000000000000','["未经验证功能"]','未经验证参数','2026-08-01','2026-08-01');`);
    legacy.close();
  });
});

test("verified partial merges preserve only the same evidence snapshot and support explicit clears", async () => {
  await withDatabase(async (database) => {
    const product = database.createProduct({ name: "室内摄像头", pid: "1731678528327946361" });
    database.updateProduct(product.id, {
      coreFunctions: ["旧的未验证功能"],
      productParameters: "旧的未验证参数",
    });
    const identity = {
      pid: product.pid,
      sourceUrl: `https://www.tiktok.com/shop/pdp/indoor-camera/${product.pid}`,
      evidenceVersion: "exact-pid-claims-v1",
    };
    const first = database.mergeVerifiedProductFacts(product.id, {
      ...identity,
      verifiedAt: "2026-08-12T08:00:00.000Z",
      coreFunctions: ["夜视"],
      productParameters: "分辨率：2.5K",
      sourceTitle: "2.5K Indoor Security Camera with Night Vision",
    });
    assert.deepEqual(first.coreFunctions, ["夜视"], "unverified shell facts must not be promoted");
    assert.equal(first.productParameters, "分辨率：2.5K");
    assert.equal(first.verifiedPid, product.pid);
    assert.equal(first.verifiedSourceUrl, identity.sourceUrl);
    assert.equal(first.evidenceVersion, identity.evidenceVersion);

    const partial = database.mergeVerifiedProductFacts(product.id, {
      ...identity,
      verifiedAt: "2026-08-12T08:01:00.000Z",
      usageMethod: "接通电源后使用",
    });
    assert.deepEqual(partial.coreFunctions, ["夜视"]);
    assert.equal(partial.productParameters, "分辨率：2.5K");
    assert.equal(partial.usageMethod, "接通电源后使用");
    assert.equal(partial.factsVerifiedAt, "2026-08-12T08:01:00.000Z");

    const cleared = database.mergeVerifiedProductFacts(product.id, {
      ...identity,
      verifiedAt: "2026-08-12T08:02:00.000Z",
      coreFunctions: ["夜视"],
      productParameters: "",
    });
    assert.equal(cleared.productParameters, "", "an explicit validated empty clears one field");
    assert.deepEqual(cleared.coreFunctions, ["夜视"], "other same-snapshot facts remain intact");

    const unverifiedEdit = database.updateProduct(product.id, { usageMethod: "未经证据合并接口的覆盖" });
    assert.equal(unverifiedEdit.verifiedPid, "", "ordinary fact writes invalidate the verified marker");
    assert.equal(unverifiedEdit.evidenceVersion, "");
  });
});

test("empty verification and identity/version changes cannot promote unrelated facts", async () => {
  await withDatabase(async (database) => {
    const product = database.createProduct({ name: "产品", pid: "1731000000000000001" });
    await assert.rejects(async () => database.mergeVerifiedProductFacts(product.id, {
      pid: product.pid,
      sourceUrl: `https://www.tiktok.com/view/product/${product.pid}`,
      evidenceVersion: "claims-v1",
      verifiedAt: "2026-08-12T08:00:00.000Z",
    }), /本次至少需要一项非空事实/);
    await assert.rejects(async () => database.mergeVerifiedProductFacts(product.id, {
      pid: product.pid,
      sourceUrl: `https://www.tiktok.com/view/product/${product.pid}`,
      evidenceVersion: "claims-v1",
      verifiedAt: "2026-08-12T08:00:00.000Z",
      sourceTitle: "只有来源标题",
      sourceDescription: "只有来源描述",
      sourceImageUrls: ["https://example.com/source.jpg"],
    }), /本次至少需要一项非空事实/, "source metadata alone is not a verified fact");
    assert.equal(database.getProduct(product.id).verifiedPid, "", "zero facts must not mark a shell verified");

    const sourceA = `https://www.tiktok.com/shop/pdp/source-a/${product.pid}`;
    database.mergeVerifiedProductFacts(product.id, {
      pid: product.pid,
      sourceUrl: sourceA,
      evidenceVersion: "claims-v1",
      verifiedAt: "2026-08-12T08:01:00.000Z",
      coreFunctions: ["功能 A"],
      productParameters: "参数 A",
    });
    const sourceB = database.mergeVerifiedProductFacts(product.id, {
      pid: product.pid,
      sourceUrl: `https://www.tiktok.com/shop/pdp/source-b/${product.pid}`,
      evidenceVersion: "claims-v1",
      verifiedAt: "2026-08-12T08:02:00.000Z",
      usageScenes: "场景 B",
    });
    assert.deepEqual(sourceB.coreFunctions, ["功能 A"], "tracking/canonical source changes preserve same-policy facts");
    assert.equal(sourceB.productParameters, "参数 A");
    assert.equal(sourceB.usageScenes, "场景 B");
    assert.match(sourceB.verifiedSourceUrl, /source-b/, "provenance advances to the current exact source URL");

    const versionTwo = database.mergeVerifiedProductFacts(product.id, {
      pid: product.pid,
      sourceUrl: sourceB.verifiedSourceUrl,
      evidenceVersion: "claims-v2",
      verifiedAt: "2026-08-12T08:03:00.000Z",
      sourceTitle: "版本二资料",
      targetAudience: "版本二人群",
    });
    assert.equal(versionTwo.usageScenes, "", "facts cannot be promoted across evidence-policy versions");
    assert.equal(versionTwo.sourceTitle, "版本二资料");
    assert.equal(versionTwo.targetAudience, "版本二人群");

    await assert.rejects(async () => database.mergeVerifiedProductFacts(product.id, {
      pid: "1731000000000000002",
      sourceUrl: sourceA,
      evidenceVersion: "claims-v2",
      verifiedAt: "2026-08-12T08:04:00.000Z",
      sourceTitle: "错误 PID",
      coreFunctions: ["错误 PID 功能"],
    }), /PID 与产品 PID 不一致/);

    const switched = database.updateProduct(product.id, { pid: "1731000000000000002" });
    assert.equal(switched.verifiedPid, "");
    assert.equal(switched.verifiedSourceUrl, "");
    assert.equal(switched.evidenceVersion, "");
    assert.equal(switched.factsVerifiedAt, "");
    assert.deepEqual(switched.coreFunctions, []);
    assert.equal(switched.usageScenes, "");
    assert.equal(switched.sourceTitle, "", "a new PID cannot inherit old verified facts");
  });
});
