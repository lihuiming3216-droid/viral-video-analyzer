import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const url=text=>`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const source=await readFile(new URL("../app/api/feishu/video-library/route.ts",import.meta.url),"utf8");
async function fixture(t) {
  const key=`libraryRoute${Math.random()}`,jobs=[],accepted=[];
  globalThis[key]={
    after:callback=>jobs.push(callback),
    accept:async body=>{accepted.push(body);return {accepted:true,jobId:"new-job"};},
    run:async()=>{},
  };
  t.after(()=>delete globalThis[key]);
  const stub=url(`
    export const after=callback=>globalThis[${JSON.stringify(key)}].after(callback);
    export class NextResponse {static json(value,init){return new Response(JSON.stringify(value),{...init,headers:{"content-type":"application/json"}});}}
    export const automationAuth=request=>request.headers.get("x-feishu-automation-secret")==="test-only";
    export const safeBackgroundError=()=>"请求无法处理，请核查配置";
    export const acceptVideoLibraryEvent=body=>globalThis[${JSON.stringify(key)}].accept(body);
    export const runVideoLibraryTask=id=>globalThis[${JSON.stringify(key)}].run(id);
  `);
  let code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  for(const specifier of ["next/server","@/lib/feishu/webhook-shared","@/lib/feishu/video-library"])code=code.replaceAll(JSON.stringify(specifier),JSON.stringify(stub));
  const api=await import(url(code));
  const request=(body,options={})=>new Request("http://localhost/api/feishu/video-library",{method:"POST",headers:{"content-type":"application/json","x-feishu-automation-secret":"test-only",...options},body});
  return {api,request,jobs,accepted,hooks:globalThis[key]};
}

test("native form payloads and JSON are accepted once and wake only their exact task",async t=>{
  const f=await fixture(t);let run;
  f.hooks.run=async id=>{run=id;};
  const response=await f.api.POST(f.request("recordId=recTest&sourceUrl=https%3A%2F%2Fwww.tiktok.com%2Ft%2Ftest&eventTime=1792371723000",{"content-type":"application/x-www-form-urlencoded"}));
  assert.equal(response.status,200);assert.equal(f.accepted[0].recordId,"recTest");assert.equal(f.jobs.length,1);
  await f.jobs[0]();assert.equal(run,"new-job");
  assert.doesNotMatch(source,/runFeishuInboxPass|resumePendingVideos|enqueueVideos/);
});

test("unauthenticated requests stop before reading or accepting any user input",async t=>{
  const f=await fixture(t),request={headers:new Headers(),get body(){throw Error("must not read unauthenticated input");}};
  assert.equal((await f.api.POST(request)).status,401);assert.equal(f.accepted.length,0);assert.equal(f.jobs.length,0);
});

test("oversized bodies and malformed JSON cannot create a task",async t=>{
  const f=await fixture(t);
  assert.equal((await f.api.POST(f.request("x".repeat(33000)))).status,413);
  const invalid=await f.api.POST(f.request("not-json private-value"));assert.equal(invalid.status,400);
  assert.doesNotMatch(await invalid.text(),/private-value/);assert.equal(f.accepted.length,0);assert.equal(f.jobs.length,0);
});

test("ignored historical events never wake a worker; receipt replays can recover only unstarted exact tasks",async t=>{
  const f=await fixture(t);
  f.hooks.accept=async()=>({accepted:false,ignored:"old"});
  await f.api.POST(f.request("{}"));assert.equal(f.jobs.length,0);
  f.hooks.accept=async()=>({accepted:false,duplicate:true,jobId:"same-job"});
  let run;f.hooks.run=async id=>{run=id;};
  await f.api.POST(f.request("{}"));await f.jobs[0]();assert.equal(run,"same-job");
});
