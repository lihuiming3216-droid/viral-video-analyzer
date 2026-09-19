import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import mysql from "mysql2/promise";
import ts from "typescript";

test("real MySQL hand-card mappings serialize concurrent saves, preserve video settings and add schema safely", {
  skip: process.env.FEISHU_DELIVERY_MYSQL_TEST !== "isolated-test-only",
}, async t => {
  // Only the disposable CI database is allowed; production MYSQL_* is never read.
  const config = { host: "delivery-test-mysql", user: "root", password: "isolated-ci-only", connectTimeout: 5000 };
  const admin = await mysql.createConnection(config);
  let pool, created = false;
  t.after(async () => {
    await pool?.end(); delete globalThis.__handcardAppTestPool;
    if (created) await admin.query("DROP DATABASE handcard_app_test");
    await admin.end();
  });
  await admin.query("CREATE DATABASE handcard_app_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci");
  created = true;
  pool = mysql.createPool({ ...config, database: "handcard_app_test", multipleStatements: true, connectionLimit: 10 });
  globalThis.__handcardAppTestPool = pool;
  const schema = await readFile(new URL("../lib/db/schema.sql", import.meta.url), "utf8");
  const prior = schema.replace(/CREATE TABLE IF NOT EXISTS feishu_handcard_(?:sessions|config_audit) \([\s\S]+?;\n/g, "");
  assert.notEqual(prior, schema);
  await pool.query(prior);
  await pool.query("INSERT INTO products(id,name,created_at,updated_at) VALUES ('preserved','人工资料','t','t')");
  const before = (await pool.query("SELECT * FROM products"))[0];
  await pool.query(schema); await pool.query(schema);
  assert.deepEqual((await pool.query("SELECT * FROM products"))[0], before);
  const url = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
  const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('import "server-only";', "");
  const core = url(compile(await readFile(new URL("../lib/feishu/handcard-app/core.ts", import.meta.url), "utf8")));
  const query = url(compile(await readFile(new URL("../lib/db/query.ts", import.meta.url), "utf8")));
  const stub = url(`export const getDb=async()=>globalThis.__handcardAppTestPool;
    export const getFeishuFieldMapping=async()=>{throw Error("unexpected");};
    export const ensureFeishuConnection=async()=>{throw Error("no external network");};
    export const getConnectedFeishuChannel=ensureFeishuConnection;
    export const userApi=ensureFeishuConnection; export const currentIdentity=ensureFeishuConnection;`);
  let code = compile(await readFile(new URL("../lib/feishu/handcard-app/tables.ts", import.meta.url), "utf8"));
  for (const match of code.matchAll(/from "(@\/[^\"]+)"/g)) code = code.replaceAll(JSON.stringify(match[1]), JSON.stringify(match[1].endsWith("/core") ? core : match[1].endsWith("/query") ? query : stub));
  const tables = await import(url(code));
  const input = { appToken: "base12345", tableId: "tbl12345", tableName: "测试表", map: { pid: "PID", productName: "", productDocument: "产品手卡", productCardStatus: "" }, revision: tables.mappingRevision(null), openId: "ou_fixture" };
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => tables.saveMapping(input)));
  assert.equal(attempts.filter(item => item.status === "fulfilled").length, 1);
  assert.equal((await pool.query("SELECT COUNT(*) AS total FROM feishu_handcard_config_audit"))[0][0].total, 1);
  // MySQL may choose a deadlock victim for concurrent INSERT IGNORE. Such a
  // request must fail/roll back, never turn into a second successful save.
  const existing = { scopeKey: "base12345:tbl12345", label: "测试表", fieldMap: { ...input.map, videoFile: "视频文件" }, aliases: { videoUrl: ["参考片"] }, updatedAt: "fixture" };
  await pool.execute("UPDATE feishu_field_mappings SET field_map_json=?, aliases_json=?, updated_at=? WHERE scope_key=?",
    [JSON.stringify(existing.fieldMap), JSON.stringify(existing.aliases), existing.updatedAt, existing.scopeKey]);
  const [rows] = await pool.query("SELECT * FROM feishu_field_mappings WHERE scope_key=?", [existing.scopeKey]);
  const actual = { ...existing, fieldMap: rows[0].field_map_json, aliases: rows[0].aliases_json };
  await tables.saveMapping({ ...input, map: { ...input.map, productName: "名称" }, revision: tables.mappingRevision(actual) });
  assert.equal((await pool.query("SELECT * FROM feishu_field_mappings"))[0][0].field_map_json.videoFile, "视频文件");
  assert.deepEqual((await pool.query("SELECT * FROM feishu_field_mappings"))[0][0].aliases_json, { videoUrl: ["参考片"] });
  await assert.rejects(tables.saveMapping({ ...input, revision: "0".repeat(64) }));
  assert.equal((await pool.query("SELECT COUNT(*) AS total FROM feishu_handcard_config_audit"))[0][0].total, 2);
});
