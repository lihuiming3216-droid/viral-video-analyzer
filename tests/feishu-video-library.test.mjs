import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const dataUrl=text=>`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const compile=code=>ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace('import "server-only";',"");
const policyUrl=dataUrl(compile(await readFile(new URL("../lib/feishu/video-library-policy.ts",import.meta.url),"utf8")));
const policy=await import(policyUrl);
const source=await readFile(new URL("../lib/feishu/video-library.ts",import.meta.url),"utf8");
const url=index=>`https://www.tiktok.com/@sample/video/76914943016998044${String(index).padStart(2,"0")}`;
const scope={...policy.VIDEO_LIBRARY_SCOPE};
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}

async function fixture(t) {
  const key=`libraryWorker${Math.random()}`,tasks=new Map(),records=new Map(),heads=new Map(),calls=[],locks=new Map();
  const gates=new Map(),entered=new Map();let counter=0;
  const fieldNames=Object.values(policy.VIDEO_LIBRARY_FIELDS);
  const hooks={
    getChatgptFeishuClient:()=>({}),libraryActivation:async()=>({enabledAfter:Date.UTC(2026,9,1)}),
    librarySourceKey:value=>new URL(value).pathname,
    safeBackgroundError:()=>"已隐藏服务异常详情",
    getBaseRecordFields:async(_client,where)=>structuredClone(records.get(where.recordId)||{}),
    listBitableTableFieldNames:async()=>fieldNames,
    patchBaseRecord:async(_client,input)=>{
      calls.push({kind:"patch",row:input.recordId,fields:structuredClone(input.fields)});
      if(hooks.beforePatch)await hooks.beforePatch(input);
      Object.assign(records.get(input.recordId),structuredClone(input.fields));
      if(hooks.afterPatch)await hooks.afterPatch(input);
    },
    withProductCardRecordLock:async(input,operation)=>{
      const old=locks.get(input.recordId)||Promise.resolve();let release;
      const tail=new Promise(done=>{release=done;});locks.set(input.recordId,tail);
      await old;try{return await operation();}finally{release();if(locks.get(input.recordId)===tail)locks.delete(input.recordId);}
    },
    claimLibraryTask:async(input)=>{
      const previousId=heads.get(input.recordId),previous=tasks.get(previousId);
      if(previous&&previous.eventMs>=input.eventMs)return {id:previous.id,previousId,accepted:false,duplicate:previous.eventMs===input.eventMs};
      const id=`task-${++counter}-${key}`;
      const baseline=policy.libraryOutputSnapshot(input.fields),resetOutputs=!previous||previous.sourceUrl!==input.sourceUrl;
      if(previous&&["accepted","running"].includes(previous.state))previous.state="superseded";
      tasks.set(id,{id,rowKey:input.recordId,...input,current:true,state:"accepted",resetOutputs,baseline,owned:resetOutputs?baseline:structuredClone(previous.owned),errors:{},original:"",translated:"",mediaPath:"",fileToken:""});
      heads.set(input.recordId,id);return {id,previousId,accepted:true,duplicate:false};
    },
    getLibraryTask:async id=>{
      const value=tasks.get(id);return value?{...structuredClone(value),current:heads.get(value.recordId)===id}:null;
    },
    startLibraryTask:async id=>{const value=tasks.get(id);if(value.state!=="accepted")return false;value.state="running";return true;},
    updateLibraryTask:async(id,values)=>{
      const value=tasks.get(id);if(value.state==="superseded")return;
      const aliases={owned_json:"owned",errors_json:"errors",original_text:"original",translated_text:"translated",media_path:"mediaPath",file_token:"fileToken"};
      for(const [name,item]of Object.entries(values))value[aliases[name]||name]=structuredClone(item);
    },
    acquireLibraryExecution:async()=>({acquired:true,valid:()=>true,release:async()=>{}}),
    downloadMedia:async id=>`${id}/original.mp4`,resolveMediaPath:value=>`/media/${value}`,
    validateDownloadedVideoFile:async()=>({audioCodec:"aac"}),
    uploadBaseAttachment:async(_client,input)=>[{file_token:input.absolutePath}],
    fetchLibraryVideo:async(source,hooks,signal)=>{
      calls.push({kind:"provider",source});entered.get(source)?.resolve();
      if(gates.has(source))await gates.get(source).promise;
      const errors={};
      for(const [kind,operation] of [
        ["download",()=>hooks.onDownload("https://api.tokscript.com/video.mp4")],
        ["transcript",()=>hooks.onTranscript(`original:${source}`)],
        ["translation",()=>hooks.onTranslation(`中文:${source}`)],
      ]) {
        if(signal.aborted)throw signal.reason;
        try{await operation();}catch{errors[kind]=`${kind} failed`;}
      }
      if(signal.aborted)throw signal.reason;
      return {transcript:`original:${source}`,translation:`中文:${source}`,downloadUrl:"https://api.tokscript.com/video.mp4",errors};
    },
  };
  globalThis[key]=hooks;t.after(()=>delete globalThis[key]);
  const importNames=["downloadMedia","resolveMediaPath","validateDownloadedVideoFile","fetchLibraryVideo","librarySourceKey","getChatgptFeishuClient","getBaseRecordFields","listBitableTableFieldNames","patchBaseRecord","withProductCardRecordLock","safeBackgroundError","uploadBaseAttachment","acquireLibraryExecution","claimLibraryTask","getLibraryTask","libraryActivation","startLibraryTask","updateLibraryTask"];
  const stub=dataUrl(importNames.map(name=>`export const ${name}=(...args)=>globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}](...args);`).join("\n"));
  let code=compile(source).replace("const global = globalThis;","const global = {};");
  for(const specifier of ["@/lib/video-processing","@/lib/providers/tokscript-library","@/lib/feishu/chatgpt-app","@/lib/feishu/automation","@/lib/feishu/webhook-shared","@/lib/feishu/media-upload","@/lib/feishu/video-library-store"])code=code.replaceAll(JSON.stringify(specifier),JSON.stringify(stub));
  code=code.replaceAll('"@/lib/feishu/video-library-policy"',JSON.stringify(policyUrl));
  const api=await import(dataUrl(code));
  const event=async(index,sourceUrl=url(index),eventTime=Date.now())=>{
    const recordId=`recTest${String(index).padStart(6,"0")}`;
    if(!records.has(recordId))records.set(recordId,{视频链接:{link:sourceUrl,text:"video"}});
    return api.acceptVideoLibraryEvent({...scope,recordId,sourceUrl,eventTime});
  };
  return {api,event,tasks,records,heads,calls,hooks,gates,entered};
}

test("all five tasks reach TokScript before any prior task completes",{timeout:5000},async t=>{
  const f=await fixture(t),receipts=[];
  for(let index=0;index<5;index++) {f.gates.set(url(index),deferred());f.entered.set(url(index),deferred());receipts.push(await f.event(index));}
  const running=receipts.map(receipt=>f.api.runVideoLibraryTask(receipt.jobId));
  t.after(()=>{for(const gate of f.gates.values())gate.resolve();});
  await Promise.all([...f.entered.values()].map(gate=>gate.promise));
  assert.equal(f.calls.filter(call=>call.kind==="provider").length,5);
  assert.ok([...f.tasks.values()].every(task=>task.state==="running"));
  for(const gate of f.gates.values())gate.resolve();await Promise.all(running);
  assert.ok([...f.tasks.values()].every(task=>task.state==="completed"));
});

test("duplicate native deliveries do not perform duplicate work",async t=>{
  const f=await fixture(t),time=Date.now();
  const one=await f.event(1,url(1),time),two=await f.event(1,url(1),time);
  assert.equal(two.duplicate,true);await Promise.all([f.api.runVideoLibraryTask(one.jobId),f.api.runVideoLibraryTask(two.jobId)]);
  assert.equal(f.calls.filter(call=>call.kind==="provider").length,1);
});

test("only post-activation native events can start tasks, and unrelated tables are rejected",async t=>{
  const f=await fixture(t);
  assert.equal((await f.event(1,url(1),Date.UTC(2026,8,1))).accepted,false);assert.equal(f.tasks.size,0);
  await assert.rejects(f.api.acceptVideoLibraryEvent({...scope,tableId:"other",recordId:"recTest000001",sourceUrl:url(1),eventTime:Date.now()}),/未授权/);
  assert.equal(f.calls.length,0);assert.equal(f.tasks.size,0);
});

test("a new link clears old outputs and a late old task cannot overwrite the new video",{timeout:5000},async t=>{
  const f=await fixture(t),time=Date.now(),recordId="recTest000001";
  f.records.set(recordId,{视频链接:{link:url(1)},原口播:"old text",中文翻译:"旧译文",文件:[{file_token:"old-video"}]});
  f.gates.set(url(1),deferred());f.entered.set(url(1),deferred());
  const a=await f.event(1,url(1),time),old=f.api.runVideoLibraryTask(a.jobId);
  t.after(()=>f.gates.get(url(1)).resolve());await f.entered.get(url(1)).promise;
  assert.equal(f.records.get(recordId).原口播,"");assert.deepEqual(f.records.get(recordId).文件,[]);
  f.records.get(recordId).视频链接={link:url(2)};
  const b=await f.event(1,url(2),time+1);await f.api.runVideoLibraryTask(b.jobId);
  f.gates.get(url(1)).resolve();await old;
  assert.equal(f.records.get(recordId).原口播,`original:${url(2)}`);
  assert.equal(f.records.get(recordId).中文翻译,`中文:${url(2)}`);
  assert.equal(f.tasks.get(a.jobId).state,"superseded");assert.equal(f.tasks.get(b.jobId).state,"completed");
  assert.equal(f.tasks.get(a.jobId).baseline.原口播,"old text","the replaced previous contents remain recoverable");
});

test("manual edits made during processing are preserved and visible as partial success",{timeout:5000},async t=>{
  const f=await fixture(t),recordId="recTest000001";
  f.gates.set(url(1),deferred());f.entered.set(url(1),deferred());
  const receipt=await f.event(1),running=f.api.runVideoLibraryTask(receipt.jobId);
  t.after(()=>f.gates.get(url(1)).resolve());await f.entered.get(url(1)).promise;
  f.records.get(recordId).原口播="人工修正文本";f.gates.get(url(1)).resolve();await running;
  const row=f.records.get(recordId);assert.equal(row.原口播,"人工修正文本");assert.ok(row.中文翻译&&row.文件.length);
  assert.equal(row.处理状态,"部分完成");assert.match(row.失败原因,/人工修改/);
});

test("failed media upload retains both complete text outputs and records a readable error",async t=>{
  const f=await fixture(t);f.hooks.uploadBaseAttachment=async()=>{throw Error("upload failed credential=not-real");};
  const receipt=await f.event(1);await f.api.runVideoLibraryTask(receipt.jobId);
  const row=f.records.get("recTest000001");assert.ok(row.原口播&&row.中文翻译);assert.deepEqual(row.文件||[],[]);
  assert.equal(row.处理状态,"部分完成");assert.match(row.失败原因,/未完成|failed/);assert.doesNotMatch(row.失败原因,/credential/);
});

test("the post-write source check removes only just-written stale content",async t=>{
  const f=await fixture(t),recordId="recTest000001";
  let raced=false;
  f.hooks.afterPatch=async input=>{
    if(!raced&&input.fields.原口播?.startsWith("original:")){raced=true;f.records.get(recordId).视频链接={link:url(2)};}
  };
  const receipt=await f.event(1);await f.api.runVideoLibraryTask(receipt.jobId);
  const row=f.records.get(recordId);assert.equal(row.视频链接.link,url(2));assert.equal(row.原口播,"");
  assert.equal(f.tasks.get(receipt.jobId).state,"superseded");
});

test("library code never invokes historical recovery, models, product generation or a scan loop",()=>{
  assert.doesNotMatch(source,/enqueueVideos|runFeishuInboxPass|resumePendingVideos|getPendingVideoIds|analyzeVideo|qwen|openai|setInterval|ensureProductCard/);
});
