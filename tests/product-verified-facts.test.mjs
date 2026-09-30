import assert from "node:assert/strict";
import test from "node:test";
import { createIsolatedDatabase } from "./helpers/isolated-mysql.mjs";
async function withDatabase(t, run) { const { database } = await createIsolatedDatabase(t); await run(database); }
test("pre-verification MySQL rows remain explicitly unverified after schema initialization", async (t) => {
  const { database, pool, rows, reapplySchema } = await createIsolatedDatabase(t);
  await pool.query("INSERT INTO products(id,name,pid,core_functions_json,product_parameters,created_at,updated_at) VALUES ('legacy-product','旧产品','1730000000000000000','[\"未经验证功能\"]','未经验证参数','2026-08-01','2026-08-01')");
  await reapplySchema();
  const product = await database.getProduct("legacy-product");
  for (const field of ["verifiedPid", "verifiedSourceUrl", "evidenceVersion", "factsVerifiedAt"])
    assert.equal(product[field], "");
  assert.deepEqual(product.factProvenance, {});
  assert.deepEqual(product.coreFunctions, ["未经验证功能"]);
  const columns = (await rows("SHOW COLUMNS FROM products")).map(column => column.Field);
  for (const expected of ["verified_pid", "verified_source_url", "evidence_version", "facts_verified_at", "fact_provenance_json"])
    assert.ok(columns.includes(expected));
  assert.ok(columns.every(column => !/(?:secret|prompt|response)/i.test(column)));
});
test("fact basis persists through partial merges and ordinary updates cannot fabricate it", async (t) => {
  await withDatabase(t, async (database) => {
    const product = await database.createProduct({ name: "室内摄像头", pid: "1731678528327946361" });
    const identity = {
      pid: product.pid,
      sourceUrl: `https://www.tiktok.com/shop/pdp/indoor-camera/${product.pid}`,
      evidenceVersion: "complete-pdp-openai-v1",
    };
    const first = await database.mergeVerifiedProductFacts(product.id, {
      ...identity,
      verifiedAt: "2026-08-12T08:00:00.000Z",
      coreFunctions: ["夜视", "辅助看护（AI推断）"],
      usageMethod: "安装后通过手机查看（AI推断）",
      factProvenance: {
        coreFunctions: [
          { value: "夜视", basis: "verified_text" },
          { value: "辅助看护（AI推断）", basis: "ai_inference" },
        ],
        usageMethod: [{ value: "安装后通过手机查看（AI推断）", basis: "ai_inference" }],
      },
    });
    assert.deepEqual(first.factProvenance.coreFunctions, [
      { value: "夜视", basis: "verified_text" },
      { value: "辅助看护（AI推断）", basis: "ai_inference" },
    ]);
    const partial = await database.mergeVerifiedProductFacts(product.id, {
      ...identity,
      verifiedAt: "2026-08-12T08:01:00.000Z",
      usageScenes: "住宅门口（AI推断）",
      factProvenance: {
        scenes: [{ value: "住宅门口（AI推断）", basis: "ai_inference" }],
      },
    });
    assert.deepEqual(partial.factProvenance.coreFunctions, first.factProvenance.coreFunctions, "same PID/version partial merges retain basis for untouched facts");
    assert.deepEqual(partial.factProvenance.scenes, [{ value: "住宅门口（AI推断）", basis: "ai_inference" }]);
    const edited = await database.updateProduct(product.id, { usageMethod: "人工编辑" });
    assert.deepEqual(edited.factProvenance, {}, "ordinary writes clear, rather than invent, provenance");
  });
});
test("verified partial merges preserve only the same evidence snapshot and support explicit clears", async (t) => {
  await withDatabase(t, async (database) => {
    const product = await database.createProduct({ name: "室内摄像头", pid: "1731678528327946361" });
    await database.updateProduct(product.id, {
      coreFunctions: ["旧的未验证功能"],
      productParameters: "旧的未验证参数",
    });
    const identity = {
      pid: product.pid,
      sourceUrl: `https://www.tiktok.com/shop/pdp/indoor-camera/${product.pid}`,
      evidenceVersion: "exact-pid-claims-v1",
    };
    const first = await database.mergeVerifiedProductFacts(product.id, {
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
    const partial = await database.mergeVerifiedProductFacts(product.id, {
      ...identity,
      verifiedAt: "2026-08-12T08:01:00.000Z",
      usageMethod: "接通电源后使用",
    });
    assert.deepEqual(partial.coreFunctions, ["夜视"]);
    assert.equal(partial.productParameters, "分辨率：2.5K");
    assert.equal(partial.usageMethod, "接通电源后使用");
    assert.equal(partial.factsVerifiedAt, "2026-08-12T08:01:00.000Z");
    const cleared = await database.mergeVerifiedProductFacts(product.id, {
      ...identity,
      verifiedAt: "2026-08-12T08:02:00.000Z",
      coreFunctions: ["夜视"],
      productParameters: "",
    });
    assert.equal(cleared.productParameters, "", "an explicit validated empty clears one field");
    assert.deepEqual(cleared.coreFunctions, ["夜视"], "other same-snapshot facts remain intact");
    const unverifiedEdit = await database.updateProduct(product.id, { usageMethod: "未经证据合并接口的覆盖" });
    assert.equal(unverifiedEdit.verifiedPid, "", "ordinary fact writes invalidate the verified marker");
    assert.equal(unverifiedEdit.evidenceVersion, "");
  });
});
test("empty verification and identity/version changes cannot promote unrelated facts", async (t) => {
  await withDatabase(t, async (database) => {
    const product = await database.createProduct({ name: "产品", pid: "1731000000000000001" });
    await assert.rejects(async () => await database.mergeVerifiedProductFacts(product.id, {
      pid: product.pid,
      sourceUrl: `https://www.tiktok.com/view/product/${product.pid}`,
      evidenceVersion: "claims-v1",
      verifiedAt: "2026-08-12T08:00:00.000Z",
    }), /本次至少需要一项非空事实/);
    await assert.rejects(async () => await database.mergeVerifiedProductFacts(product.id, {
      pid: product.pid,
      sourceUrl: `https://www.tiktok.com/view/product/${product.pid}`,
      evidenceVersion: "claims-v1",
      verifiedAt: "2026-08-12T08:00:00.000Z",
      sourceTitle: "只有来源标题",
      sourceDescription: "只有来源描述",
      sourceImageUrls: ["https://example.com/source.jpg"],
    }), /本次至少需要一项非空事实/, "source metadata alone is not a verified fact");
    assert.equal((await database.getProduct(product.id)).verifiedPid, "", "zero facts must not mark a shell verified");
    const sourceA = `https://www.tiktok.com/shop/pdp/source-a/${product.pid}`;
    await database.mergeVerifiedProductFacts(product.id, {
      pid: product.pid,
      sourceUrl: sourceA,
      evidenceVersion: "claims-v1",
      verifiedAt: "2026-08-12T08:01:00.000Z",
      coreFunctions: ["功能 A"],
      productParameters: "参数 A",
    });
    const sourceB = await database.mergeVerifiedProductFacts(product.id, {
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
    const versionTwo = await database.mergeVerifiedProductFacts(product.id, {
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
    await assert.rejects(async () => await database.mergeVerifiedProductFacts(product.id, {
      pid: "1731000000000000002",
      sourceUrl: sourceA,
      evidenceVersion: "claims-v2",
      verifiedAt: "2026-08-12T08:04:00.000Z",
      sourceTitle: "错误 PID",
      coreFunctions: ["错误 PID 功能"],
    }), /PID 与产品 PID 不一致/);
    const switched = await database.updateProduct(product.id, { pid: "1731000000000000002" });
    assert.equal(switched.verifiedPid, "");
    assert.equal(switched.verifiedSourceUrl, "");
    assert.equal(switched.evidenceVersion, "");
    assert.equal(switched.factsVerifiedAt, "");
    assert.deepEqual(switched.coreFunctions, []);
    assert.equal(switched.usageScenes, "");
    assert.equal(switched.sourceTitle, "", "a new PID cannot inherit old verified facts");
  });
});
