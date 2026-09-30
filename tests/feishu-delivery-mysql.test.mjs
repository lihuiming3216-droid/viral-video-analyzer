import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import mysql from "mysql2/promise";
import ts from "typescript";
import { isolatedMysqlConfig } from "./helpers/isolated-mysql.mjs";

const enabled = process.env.FEISHU_DELIVERY_MYSQL_TEST === "isolated-test-only" || Boolean(process.env.PID_AUDIT_MYSQL_SOCKET);
const dataUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const read = file => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("real MySQL: additive migration, durable row pauses, recovery and generation isolation", { skip: !enabled }, async t => {
  // Deliberately fixed to the disposable CI service; never read MYSQL_* or any
  // production configuration. Refuse to reuse an existing test database.
  const config = await isolatedMysqlConfig();
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
  const openPool = () => mysql.createPool({ ...config, database: "delivery_test", multipleStatements: true, connectionLimit: 6 });
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
  const receiptCode = compile(await read("lib/feishu/request-dedup.ts")).replace('import "server-only";', "")
    .replaceAll('"@/lib/db/pool"', JSON.stringify(dataUrl("export const getPool = async () => globalThis.__feishuDeliveryTestPool;")))
    .replaceAll('"@/lib/crypto"', JSON.stringify(dataUrl('export const encryptSecret=value=>"isolated-fixture:"+Buffer.from(value).toString("base64");')));
  const receipts = await import(dataUrl(receiptCode));
  const receiptInput = [new Headers(), {requestId:"one-invocation"}, ["video","app","table","row"], {url:"same-video"}];
  const claimed = await Promise.all(Array.from({length:12},()=>receipts.claimFeishuRequest(...receiptInput)));
  assert.equal(claimed.filter(receipt=>!receipt.duplicate).length,1,"real MySQL primary key serializes competing invocations");
  await receipts.finishFeishuRequest(claimed.find(receipt=>!receipt.duplicate),"completed");
  assert.equal((await receipts.claimFeishuRequest(...receiptInput)).state,"completed");
  assert.equal((await receipts.claimFeishuRequest(new Headers(),{requestId:"new-click"},receiptInput[2],receiptInput[3])).duplicate,false);
  const durableInput = {kind:"video",credentialSource:"primary",appToken:"app",tableId:"table",recordId:"durable-row",fields:{视频链接:"https://test.invalid/video"},fieldMap:{videoUrl:"视频链接"}};
  const accepted = await Promise.all(Array.from({length:8},()=>receipts.claimFeishuRequest(new Headers(),{requestId:"durable"},["video","durable-row"],durableInput.fields,durableInput)));
  assert.equal(accepted.filter(receipt=>!receipt.duplicate).length,1);
  const [[savedInput]] = await pool.query("SELECT input_cipher,state FROM feishu_inbox_tasks WHERE id=?",[accepted[0].id]);
  assert.equal(savedInput.state,"pending");
  assert.deepEqual(JSON.parse(Buffer.from(savedInput.input_cipher.split(":")[1],"base64").toString()),durableInput);
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
  assert.equal((await receipts.claimFeishuRequest(...receiptInput)).duplicate,true,"invocation dedup survives a fresh connection");
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

  const retryKey = {...first,videoId:"new"};
  await db.incrementFeishuAutomationJobAttempts(retryKey);
  assert.equal((await db.getFeishuAutomationJobs("new"))[0].attempts,1);
  assert.ok((await db.getFeishuAutomationJobs("new"))[0].nextRetryAt > new Date().toISOString());
  assert.deepEqual(await db.listFeishuAutomationJobVideoIds(),[],"not-yet-due writes do not poll Feishu");
  for (let attempt=1;attempt<6;attempt++) await db.incrementFeishuAutomationJobAttempts(retryKey);
  assert.equal((await db.getFeishuAutomationJobs("new"))[0].blockedReason,"retry_exhausted");
  await db.saveFeishuAutomationJob({...retryKey,fieldMap:{videoFile:"文件"}});
  assert.equal((await db.getFeishuAutomationJobs("new"))[0].nextRetryAt,"");
  assert.equal(await db.prepareVideoForQueue("new"),false,"routine wakeups cannot repeat completed paid tasks");
  await db.blockFeishuAutomationJob(retryKey,"translation_failed","previous attempt failed");
  assert.equal(await db.prepareVideoForQueue("new",true),true);
  assert.equal((await db.getFeishuAutomationJobs("new"))[0].blockedReason,"","an explicit new attempt resumes its deliveries");
  const attempt = await db.startVideoAttempt("new");
  assert.equal(await db.prepareVideoForQueue("new",true),false,"manual retry cannot reset a claimed task");
  await db.recordVideoStage("new",attempt.attemptNumber,"download","completed");
  await db.recordVideoStage("new",attempt.attemptNumber,"download","failed","late abort must not erase success");
  await db.recordVideoStage("new",attempt.attemptNumber-1,"translation","completed");
  const stages = await db.listVideoStages("new",attempt.attemptNumber);
  assert.equal(stages.length,1); assert.equal(stages[0].state,"completed"); assert.equal(stages[0].error,"");

  const connection = await pool.getConnection();
  await connection.beginTransaction();
  const createdVideo = await db.createVideo({productId:"product",sourceType:"tiktok",sourceUrl:"https://test.invalid/rollback"},{connection});
  await db.saveFeishuAutomationJob({videoId:createdVideo.id,appToken:"app",tableId:"table",recordId:"rollback-row",fieldMap:{}},connection);
  await connection.rollback(); connection.release();
  assert.equal(await db.getVideo(createdVideo.id,false),null,"rolled-back receipt materialization has no orphan video");
  assert.deepEqual(await db.getFeishuAutomationJobs(createdVideo.id),[]);

  const executionCode = compile(await read("lib/video-execution.ts")).replace('import "server-only";', "")
    .replaceAll('"@/lib/db/pool"',JSON.stringify(dataUrl("export const getPool=async()=>globalThis.__feishuDeliveryTestPool;")));
  const execution = await import(dataUrl(executionCode));
  await pool.query("UPDATE videos SET status='queued',processing_started_at=NULL WHERE id IN ('old','new')");
  const one = await execution.tryAcquireVideoExecution("old",new AbortController());
  const two = await execution.tryAcquireVideoExecution("new",new AbortController());
  try {
    assert.ok(one && two);
    assert.equal(await execution.tryAcquireVideoExecution("old",new AbortController()),null,"separate real MySQL connections cannot own the same task");
    const third = await db.createVideo({productId:"product",sourceType:"tiktok",sourceUrl:"https://test.invalid/third"});
    assert.equal(await execution.tryAcquireVideoExecution(third.id,new AbortController()),null,"real DB slots cap all workers at two");
  } finally { await one?.release(); await two?.release(); }
});
