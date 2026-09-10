import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import mysql from "mysql2/promise";
import ts from "typescript";

test("real MySQL catalog claims are atomic, migration is additive and failure survives reconnection", {
  skip: process.env.FEISHU_DELIVERY_MYSQL_TEST !== "isolated-test-only",
}, async t => {
  // Never accept production MYSQL_* configuration; only the disposable CI service.
  const config = { host: "delivery-test-mysql", user: "root", password: "isolated-ci-only", connectTimeout: 5000 };
  const admin = await mysql.createConnection(config);
  let pool, created = false;
  t.after(async () => {
    await pool?.end();
    delete globalThis.__catalogTestPool;
    if (created) await admin.query("DROP DATABASE catalog_test");
    await admin.end();
  });
  await admin.query("CREATE DATABASE catalog_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci");
  created = true;
  const openPool = () => mysql.createPool({ ...config, database: "catalog_test", multipleStatements: true, connectionLimit: 10 });
  pool = openPool();
  const schema = await readFile(new URL("../lib/db/schema.sql", import.meta.url), "utf8");
  const prior = schema.replace(/CREATE TABLE IF NOT EXISTS (?:product_catalog_cache|product_catalog_reorganizations|ai_purpose_settings) \([\s\S]+?;\n/g, "");
  assert.notEqual(prior, schema);
  await pool.query(prior);
  await pool.query("INSERT INTO products(id,name,created_at,updated_at) VALUES ('preserved','人工资料','t','t')");
  const [before] = await pool.query("SELECT * FROM products");
  await pool.query(schema); await pool.query(schema);
  assert.deepEqual((await pool.query("SELECT * FROM products"))[0], before);
  const purposeConfig = { purpose: "product", provider: "qwen", model: "qwen3.7-plus", credentialSource: "shared", baseUrl: "", retries: 0, videoAudioConfirmed: false };
  await pool.execute("INSERT INTO ai_purpose_settings(purpose,config_json,encrypted_api_key,updated_at) VALUES (?,?,?,?)", ["product", JSON.stringify(purposeConfig), null, "t"]);
  assert.deepEqual((await pool.execute("SELECT config_json FROM ai_purpose_settings WHERE purpose=?", ["product"]))[0][0].config_json, purposeConfig);
  const lockA = await pool.getConnection(), lockB = await pool.getConnection();
  try {
    assert.equal((await lockA.execute("SELECT GET_LOCK(?,0) AS acquired", ["catalog-reorganize:fixture"]))[0][0].acquired, 1);
    assert.equal((await lockB.execute("SELECT GET_LOCK(?,0) AS acquired", ["catalog-reorganize:fixture"]))[0][0].acquired, 0);
    await lockA.execute("SELECT RELEASE_LOCK(?)", ["catalog-reorganize:fixture"]);
  } finally { lockA.release(); lockB.release(); }
  await pool.execute("INSERT INTO product_catalog_reorganizations(id,pid,state,created_at,updated_at) VALUES (?,?,'requested',?,?)", ["00000000-0000-4000-8000-000000000001", "1732350695360139845", "t", "t"]);
  assert.equal((await pool.execute("SELECT state FROM product_catalog_reorganizations WHERE pid=?", ["1732350695360139845"]))[0][0].state, "requested");
  const dataUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
  const code = ts.transpileModule(await readFile(new URL("../lib/products/catalog-store.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace('import "server-only";', "").replaceAll('"@/lib/db/pool"', JSON.stringify(dataUrl("export const getPool = async () => globalThis.__catalogTestPool;")));
  globalThis.__catalogTestPool = pool;
  const store = await import(dataUrl(code));
  const pid = "1732350695360139845";
  const claims = await Promise.all(Array.from({ length: 50 }, () => store.claimCatalog(pid)));
  assert.equal(claims.filter(Boolean).length, 1);
  await store.markCatalogFetched(pid);
  assert.equal((await Promise.all(Array.from({ length: 50 }, () => store.claimCatalogAnalysis(pid)))).filter(Boolean).length, 1);
  await store.failCatalog(pid, "analysis", "已停止");
  await pool.end(); pool = openPool(); globalThis.__catalogTestPool = pool;
  assert.equal(await store.claimCatalog(pid), false);
  assert.equal(await store.claimCatalogAnalysis(pid), false);
  assert.equal((await store.readCatalog(pid)).analysis_state, "failed");
  const second = "1731886355135304543";
  await store.claimCatalog(second); await store.markCatalogFetched(second); await store.claimCatalogAnalysis(second);
  await store.finishCatalogAnalysis(second, { pid: second, fields: {}, warnings: [], model: "test", createdAt: "t" });
  assert.equal((await store.readCatalog(second)).analysis_state, "ready");
  assert.equal((await store.readCatalog(second)).result_json.pid, second);
});
