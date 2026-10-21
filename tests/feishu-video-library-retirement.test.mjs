import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { loadAutomationFixture } from "./helpers/automation-fixture.mjs";
import { loadTestModule } from "./helpers/isolated-mysql.mjs";

const root=new URL("../",import.meta.url);
const read=file=>readFile(new URL(file,root),"utf8");

test("the duplicate video-library implementation and deployment helper are removed",async()=>{
  for(const file of ["app/api/feishu/video-library/route.ts","lib/feishu/video-library.ts","lib/feishu/video-library-policy.ts","lib/feishu/video-library-store.ts","lib/feishu/video-library-workflows.ts","lib/providers/tokscript-library.ts","deploy/configure-video-library.cjs"]){
    await assert.rejects(access(new URL(file,root)),{code:"ENOENT"});
  }
  const {exports:auth}=await loadTestModule("lib/admin-auth.ts");
  assert.equal(auth.publicMachineRoute("/api/feishu/video-library","POST"),false);
  assert.equal(auth.publicMachineRoute("/api/feishu/task-table","POST"),true);
  assert.doesNotMatch(await read("Dockerfile"),/configure-video-library/);
});

test("fresh schema and readiness no longer require retired tables; no destructive SQL is introduced",async()=>{
  for(const file of ["lib/db/schema.sql","deploy/check-runtime.cjs"]){
    const source=await read(file);
    assert.doesNotMatch(source,/feishu_video_library/);
    assert.doesNotMatch(source,/DROP\s+TABLE|TRUNCATE\s+TABLE/i);
  }
});

test("the existing mapper supports only the four quality-library columns without new required fields",async t=>{
  const automation=await loadAutomationFixture(t,{});
  const columns=["视频链接","文件","原口播","中文翻译"];
  const client={request:async()=>({code:0,data:{items:columns.map(field_name=>({field_name})),has_more:false}})};
  const map=await automation.fitAutomationFieldMapToTable(client,{appToken:"fixtureBase",tableId:"tblFixture",fieldMap:{videoFile:"文件"}});
  assert.deepEqual(Object.entries(map).filter(([,name])=>name).sort(),Object.entries({videoUrl:"视频链接",videoFile:"文件",transcript:"原口播",translation:"中文翻译"}).sort());
  const resolved=automation.resolveAutomationFields({视频链接:{link:"https://www.tiktok.com/@fixture/video/1234567890123456789"}},map);
  assert.equal(resolved.videoUrl,"https://www.tiktok.com/@fixture/video/1234567890123456789");
  assert.equal(resolved.pid,"");
  assert.equal(resolved.productName,"");
  assert.equal(map.status,"");
  assert.equal(map.linkedSubtitle,"");
  assert.equal(map.analysis,"");
});
