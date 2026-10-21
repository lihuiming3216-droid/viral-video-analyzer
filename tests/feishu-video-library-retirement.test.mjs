import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { loadAutomationFixture } from "./helpers/automation-fixture.mjs";
import { loadTestModule } from "./helpers/isolated-mysql.mjs";
import { moduleUrl } from "./helpers/isolated-mysql.mjs";
import { randomUUID } from "node:crypto";
import ts from "typescript";

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

test("the existing task-table endpoint retains primary defaults and can select the already configured chatgpt app",async t=>{
  const secret=process.env.FEISHU_AUTOMATION_WEBHOOK_SECRET;
  process.env.FEISHU_AUTOMATION_WEBHOOK_SECRET="offline-fixture-only";
  const key=`oldFlow_${randomUUID()}`;
  const state={claims:[],callbacks:[],mapping:{fieldMap:{videoUrl:"视频链接",videoFile:"文件",transcript:"原口播",translation:"中文翻译"}}};
  globalThis[key]=state;
  t.after(()=>{delete globalThis[key];if(secret===undefined)delete process.env.FEISHU_AUTOMATION_WEBHOOK_SECRET;else process.env.FEISHU_AUTOMATION_WEBHOOK_SECRET=secret;});
  state.automation=await loadAutomationFixture(t,{});
  const hooks=moduleUrl(`
    const state=globalThis[${JSON.stringify(key)}];
    export const NextResponse=Response, NextRequest=Request;
    export const after=fn=>state.callbacks.push(fn);
    export const getFeishuFieldMapping=async()=>state.mapping;
    export const resolveAutomationFields=(...args)=>state.automation.resolveAutomationFields(...args);
    export const isTikTokUrl=value=>value.startsWith("https://www.tiktok.com/");
    export const claimFeishuRequest=async(...args)=>{state.claims.push(args);return {id:"offline-claim",duplicate:false,identified:true};};
    export const feishuRequestReplay=()=>({code:0,duplicate:true});
    export class FeishuRequestIdentityError extends Error {}
    export const runFeishuInboxPass=async()=>{throw Error("No provider calls in offline tests");};
  `);
  const shared=await loadTestModule("lib/feishu/webhook-shared.ts");
  let code=ts.transpileModule(await read("app/api/feishu/task-table/route.ts"),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  for(const specifier of ["next/server","@/lib/database","@/lib/feishu/automation","@/lib/tiktok-product","@/lib/feishu/request-dedup","@/lib/feishu/inbox"])code=code.replaceAll(JSON.stringify(specifier),JSON.stringify(hooks));
  code=code.replaceAll('"@/lib/feishu/webhook-shared"',JSON.stringify(shared.url));
  const {POST}=await import(moduleUrl(code));
  const body={appToken:"fixtureBase",tableId:"tblFixture",recordId:"recFixture",视频链接:"https://www.tiktok.com/@fixture/video/1234567890123456789"};
  const request=(value,authorized=true,form=false)=>new Request("https://fixture.invalid/api/feishu/task-table",{method:"POST",headers:{"content-type":form?"application/x-www-form-urlencoded":"application/json",...(authorized?{"x-feishu-automation-secret":"offline-fixture-only"}:{})},body:form?new URLSearchParams(value):JSON.stringify(value)});
  assert.equal((await POST(request(body))).status,200);
  assert.equal(state.claims.at(-1)[4].credentialSource,"primary");
  assert.deepEqual(state.claims.at(-1)[3],{fields:{视频链接:body.视频链接},fieldMap:{}});
  assert.equal((await POST(request({...body,credentialSource:"chatgpt"},true,true))).status,200);
  assert.equal(state.claims.at(-1)[4].credentialSource,"chatgpt");
  assert.equal(state.claims.at(-1)[3].credentialSource,"chatgpt");
  assert.equal("credentialSource" in state.claims.at(-1)[4].fields,false);
  const count=state.claims.length;
  assert.equal((await POST(request({...body,credentialSource:"chatgpt"},false))).status,401);
  assert.equal((await POST(request({...body,credentialSource:"unknown"}))).status,400);
  state.mapping=null;
  assert.equal((await POST(request({...body,credentialSource:"chatgpt"}))).status,403);
  assert.equal(state.claims.length,count,"invalid or unauthenticated requests never enter the queue");
});
