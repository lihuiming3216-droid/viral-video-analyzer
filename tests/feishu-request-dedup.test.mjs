import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const url = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const read = file => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const source = ts.transpileModule(await read("lib/feishu/request-dedup.ts"), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace('import "server-only";', "");
async function fixture(t) {
  const key=`receipt${Math.random()}`,rows=new Map(),inbox=new Map();
  globalThis[key]={execute:async(sql,args)=>{
    if(sql.startsWith("INSERT IGNORE")){if(rows.has(args[0]))return[{affectedRows:0}];rows.set(args[0],{payload_sha256:args[1],state:"accepted"});return[{affectedRows:1}];}
    if(sql.startsWith("INSERT INTO feishu_inbox_tasks")){if(globalThis[key].failInsert)throw Error("disk unavailable");inbox.set(args[0],{kind:args[1],cipher:args[2]});return[{affectedRows:1}];}
    if(sql.startsWith("SELECT"))return[[rows.get(args[0])].filter(Boolean)];
    if(sql.startsWith("UPDATE")){const row=rows.get(args[2]);if(row.state==="accepted")row.state=args[0];return[{affectedRows:1}];}
    throw Error("unexpected SQL");
  }};
  let snapshot;
  Object.assign(globalThis[key], {getConnection:async()=>globalThis[key],beginTransaction:async()=>{snapshot=new Map(rows);},commit:async()=>{},
    rollback:async()=>{rows.clear();for(const [k,v] of snapshot)rows.set(k,v);},release:()=>{}});
  t.after(()=>{delete globalThis[key];});
  const stub=url(`export const getPool=async()=>globalThis[${JSON.stringify(key)}];`);
  const crypto=url('export const encryptSecret=value=>"test-cipher:"+Buffer.from(value).toString("base64");');
  return {api:await import(url(source.replaceAll('"@/lib/db/pool"',JSON.stringify(stub)).replaceAll('"@/lib/crypto"',JSON.stringify(crypto)))),rows,inbox,pool:globalThis[key]};
}

test("one invocation is claimed once concurrently; replays persist, new operations and rows remain independent", async t=>{
  const {api,rows}=await fixture(t),headers=new Headers(),body={requestId:"operation-1"},scope=["video","app","table","row"];
  const claims=await Promise.all(Array.from({length:20},()=>api.claimFeishuRequest(headers,body,scope,{url:"same-video"})));
  assert.equal(claims.filter(r=>!r.duplicate).length,1);
  const first=claims.find(r=>!r.duplicate);
  await api.finishFeishuRequest(first,"failed");
  const replay=await api.claimFeishuRequest(headers,body,scope,{url:"same-video"});
  assert.equal(replay.duplicate,true);assert.equal(replay.state,"failed");
  assert.match(api.feishuRequestReplay(replay).msg,/主动重试/);
  assert.equal((await api.claimFeishuRequest(headers,{requestId:"operation-2"},scope,{url:"same-video"})).duplicate,false);
  assert.equal((await api.claimFeishuRequest(headers,body,["video","app","table","another-row"],{url:"same-video"})).duplicate,false);
  assert.equal(rows.size,3);
});

test("same id with different contents fails closed; key order and matching header/body IDs are stable", async t=>{
  const {api}=await fixture(t),scope=["handcard","app","table","row"];
  const headers=new Headers({"x-idempotency-key":"same"});
  await api.claimFeishuRequest(headers,{request_id:"same"},scope,{a:1,b:2});
  assert.equal((await api.claimFeishuRequest(headers,{},scope,{b:2,a:1})).duplicate,true);
  await assert.rejects(api.claimFeishuRequest(headers,{},scope,{a:3}),error=>error.status===409);
  await assert.rejects(api.claimFeishuRequest(headers,{requestId:"different"},scope,{}),error=>error.status===400);
  await assert.rejects(api.claimFeishuRequest(new Headers(),{requestId:123},scope,{}),error=>error.status===400);
});

test("old callers without operation IDs remain compatible and are not falsely deduplicated by URL", async t=>{
  const {api,rows}=await fixture(t);
  for(let i=0;i<2;i++)assert.equal(await api.claimFeishuRequest(new Headers(),{},["video","row"],{url:"same"}),null);
  assert.equal(rows.size,0);
});

test("every Base endpoint claims before scheduling work and reports missing operation IDs", async()=>{
  for(const file of ["automation","task-table","app-actions/handcard","app-actions/video"]){
    const code=await read(`app/api/feishu/${file}/route.ts`);
    assert.ok(code.indexOf("const receipt = await claimFeishuRequest")<code.indexOf("after("),file);
    assert.match(code,/receipt\?\.duplicate/);
    assert.match(code,/runFeishuInboxPass/);
    assert.match(code,/credentialSource:/);
    assert.doesNotMatch(code,/createVideo\(/);
    assert.match(code,/request_id_missing/);
  }
  const actions=await read("app/admin/products/actions.ts");
  assert.match(actions,/await requireAdmin\(\)/);
  assert.match(actions,/confirmOverwrite/);
  const page=await read("app/admin/products/page.tsx");
  assert.match(page,/<RefreshCardForm productId=\{product.id\}/);
  const form=await read("app/admin/products/RefreshCardForm.tsx");
  assert.match(form,/window.confirm/);
  assert.match(form,/刷新基础资料/);
});

test("acknowledged inputs survive without a callback; failed inbox inserts roll back their receipt", async t=>{
  const {api,rows,inbox,pool}=await fixture(t);
  const input={kind:"video",credentialSource:"primary",appToken:"app",tableId:"table",recordId:"row",fields:{视频链接:"https://video.test/"},fieldMap:{videoUrl:"视频链接"}};
  const one=await api.claimFeishuRequest(new Headers(),{requestId:"accepted",secret:"do-not-store"},["video","row"],input.fields,input);
  assert.equal(rows.size,1);assert.equal(inbox.size,1);assert.equal(one.identified,true);
  assert.doesNotMatch(inbox.get(one.id).cipher,/do-not-store|https:/);
  assert.deepEqual(JSON.parse(Buffer.from(inbox.get(one.id).cipher.split(":")[1],"base64").toString()),input);
  const oldCaller=await api.claimFeishuRequest(new Headers(),{},["video","row"],input.fields,input);
  assert.equal(oldCaller.identified,false);assert.equal(inbox.size,2);
  pool.failInsert=true;
  await assert.rejects(api.claimFeishuRequest(new Headers(),{requestId:"rollback"},["video","row"],input.fields,input),/disk unavailable/);
  assert.equal(rows.size,2,"never leave an accepted receipt without its recoverable input");
  pool.failInsert=false;
  assert.equal((await api.claimFeishuRequest(new Headers(),{requestId:"rollback"},["video","row"],input.fields,input)).duplicate,false);
});
