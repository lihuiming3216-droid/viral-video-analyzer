import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import mysql from "mysql2/promise";
import ts from "typescript";

const enabled = process.env.FEISHU_DELIVERY_MYSQL_TEST === "isolated-test-only";
const dataUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const read = file => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("real MySQL: additive migration, durable row pauses, recovery and generation isolation", { skip: !enabled }, async t => {
  // Deliberately fixed to the disposable CI service; never read MYSQL_* or any
  // production configuration. Refuse to reuse an existing test database.
  const config = { host: "delivery-test-mysql", user: "root", password: "isolated-ci-only", connectTimeout: 5000 };
  const admin = await mysql.createConnection(config);
  let pool;
  let created = false;
  t.after(async () => {
    await pool?.end();
    delete globalThis.__feishuDeliveryTestPool;
    if (created) await admin.query("DROP DATABASE delivery_test");
    await admin.end();
  });
  await admin.query("CREATE DATABASE delivery_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci");
  created = true;
  const openPool = () => mysql.createPool({ ...config, database: "delivery_test", multipleStatements: true, connectionLimit: 2 });
  pool = openPool();
  const schema = await read("lib/db/schema.sql");
  const withoutBlocks = schema.replace(/CREATE TABLE IF NOT EXISTS feishu_automation_delivery_blocks \([\s\S]+?;\n/, "");
  assert.notEqual(withoutBlocks, schema);
  await pool.query(withoutBlocks);
  await pool.query("INSERT INTO products(id,name,created_at,updated_at) VALUES ('product','test','t','t')");
  await pool.query("INSERT INTO videos(id,product_id,source_type,source_url,title,status,created_at,updated_at) VALUES ('old','product','url','https://example.test/video','retained','completed','t','t'), ('new','product','url','https://example.test/new','new','completed','t','t')");
  await pool.query("INSERT INTO feishu_automation_jobs(video_id,app_token,table_id,record_id,field_map_json,attempts,created_at,updated_at) VALUES ('old','app','table','row',?,7,'t','t')", [JSON.stringify({ videoFile: "文件" })]);
  const [before] = await pool.query("SELECT * FROM feishu_automation_jobs");
  await pool.query(schema);
  await pool.query(schema);
  const [after] = await pool.query("SELECT * FROM feishu_automation_jobs");
  assert.deepEqual(after, before, "migration and repeated startup preserve existing jobs");

  globalThis.__feishuDeliveryTestPool = pool;
  const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  let code = compile(await read("lib/database.ts")).replace('import "server-only";', "");
  code = code.replaceAll('"@/lib/db/pool"', JSON.stringify(dataUrl("export const getPool = async () => globalThis.__feishuDeliveryTestPool;")));
  code = code.replaceAll('"@/lib/types"', JSON.stringify(dataUrl(compile(await read("lib/types.ts")))));
  const db = await import(dataUrl(code));
  const first = { videoId: "old", appToken: "app", tableId: "table", recordId: "row" };
  const second = { ...first, recordId: "other-row" };
  await db.saveFeishuAutomationJob({ ...second, fieldMap: { videoFile: "文件" } });
  await db.blockFeishuAutomationJob(first, "field_missing", "😀".repeat(800));
  await db.blockFeishuAutomationJob(first, "field_missing", "😀".repeat(800));
  assert.equal((await db.getFeishuAutomationJobs("old")).find(j => j.recordId === "row").attempts, 7);
  assert.deepEqual(await db.listFeishuAutomationJobVideoIds(), ["old"], "another row remains runnable");
  const [[block]] = await pool.query("SELECT message FROM feishu_automation_delivery_blocks");
  assert.equal(Array.from(block.message).length, 512);
  await db.blockFeishuAutomationJob(second, "record_missing", "目标行不存在");
  await pool.end();
  pool = openPool();
  globalThis.__feishuDeliveryTestPool = pool;
  assert.deepEqual(await db.listFeishuAutomationJobVideoIds(), [], "pauses survive a fresh connection");
  assert.equal((await db.getFeishuAutomationJobs("old")).filter(j => j.blockedReason).length, 2);
  await db.saveFeishuAutomationJob({ ...first, fieldMap: { videoFile: "文件", status: "" } });
  const resumed = (await db.getFeishuAutomationJobs("old")).find(j => j.recordId === "row");
  assert.equal(resumed.blockedReason, "");
  assert.equal(resumed.attempts, 0);
  assert.equal(resumed.fieldMap.status, "");
  assert.deepEqual(await db.listFeishuAutomationJobVideoIds(), ["old"]);
  await db.blockFeishuAutomationJob(first, "source_changed", "旧任务暂停");
  await db.saveFeishuAutomationJob({ ...first, videoId: "new", fieldMap: { videoFile: "文件" } });
  await db.blockFeishuAutomationJob(first, "field_missing", "不能复活已移除的任务");
  assert.deepEqual((await db.getFeishuAutomationJobs("old")).map(j => j.recordId), ["other-row"]);
  assert.deepEqual(await db.listFeishuAutomationJobVideoIds(), ["new"]);
  await db.deleteFeishuAutomationJob(second);
  const [[remaining]] = await pool.query("SELECT COUNT(*) AS count FROM feishu_automation_delivery_blocks");
  assert.equal(remaining.count, 0, "only removed jobs lose their blocks; active records remain intact");
  assert.equal((await db.getFeishuAutomationJobs("new")).length, 1);
});
