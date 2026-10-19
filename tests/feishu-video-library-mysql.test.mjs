import assert from "node:assert/strict";
import test from "node:test";
import { createIsolatedDatabase, loadTestModule, moduleUrl } from "./helpers/isolated-mysql.mjs";

const url="https://www.tiktok.com/@sample/video/7691494301699804446";
const second="https://www.tiktok.com/@sample/video/7691494301699804447";
const scope={appToken:"test-app",tableId:"test-table",recordId:"rec-test"};
const policy=await loadTestModule("lib/feishu/video-library-policy.ts");

async function fixture(t) {
  const db=await createIsolatedDatabase(t),key=`libraryMysql${Math.random()}`;
  globalThis[key]=db.pool;t.after(()=>delete globalThis[key]);
  const poolUrl=moduleUrl(`export const getPool=async()=>globalThis[${JSON.stringify(key)}];`);
  const provider=moduleUrl('export const librarySourceKey=url=>new URL(url).pathname;');
  const store=await loadTestModule("lib/feishu/video-library-store.ts",{
    "@/lib/db/pool":poolUrl,"@/lib/providers/tokscript-library":provider,"@/lib/feishu/video-library-policy":policy.url,
  });
  const claim=(eventMs,sourceUrl=url,recordId=scope.recordId)=>store.exports.claimLibraryTask({...scope,recordId,eventMs,sourceUrl,fields:{原口播:"old manual text",文件:[{file_token:"existing"}]}});
  return {...db,api:store.exports,claim};
}

test("concurrent delivery of one native event creates one task and retains the baseline",async t=>{
  const f=await fixture(t),time=Date.UTC(2026,9,19,1);
  const results=await Promise.all(Array.from({length:5},()=>f.claim(time)));
  assert.equal(results.filter(result=>result.accepted).length,1);
  const accepted=results.find(result=>result.accepted);
  const task=await f.api.getLibraryTask(accepted.id);
  assert.equal(task.baseline.原口播,"old manual text");assert.equal(task.resetOutputs,true);
  assert.equal((await f.rows("SELECT * FROM feishu_video_library_tasks")).length,1);
  assert.equal((await f.row("SELECT COUNT(*) AS n FROM videos")).n,0,"the old video queue is not used");
  assert.equal((await f.row("SELECT COUNT(*) AS n FROM feishu_inbox_tasks")).n,0);
});

test("A to B to A creates fresh generations and refuses delayed old events",async t=>{
  const f=await fixture(t),time=Date.UTC(2026,9,19,2);
  const a=await f.claim(time);assert.equal(await f.api.startLibraryTask(a.id),true);
  const b=await f.claim(time+1,second);assert.equal((await f.api.getLibraryTask(a.id)).state,"superseded");
  const a2=await f.claim(time+2);assert.notEqual(a.id,a2.id);
  assert.equal((await f.claim(time,url)).accepted,false);
  assert.equal((await f.api.getLibraryTask(a2.id)).current,true);
  assert.equal((await f.api.getLibraryTask(b.id)).current,false);
  await f.api.updateLibraryTask(a.id,{original_text:"late old output"});
  assert.equal((await f.api.getLibraryTask(a.id)).original,"");
});

test("completed originals and media remain in history when a row starts another video",async t=>{
  const f=await fixture(t),time=Date.UTC(2026,9,19,3);
  const one=await f.claim(time);
  await f.api.updateLibraryTask(one.id,{state:"completed",original_text:"complete original",translated_text:"完整中文",media_path:"test/original.mp4",file_token:"uploaded"});
  await f.claim(time+1,second);
  const previous=await f.api.getLibraryTask(one.id);
  assert.equal(previous.state,"completed");assert.equal(previous.original,"complete original");assert.equal(previous.fileToken,"uploaded");
});

test("five lightweight jobs obtain their own slots, with no waiting queue and no duplicate execution",async t=>{
  const f=await fixture(t),time=Date.UTC(2026,9,19,4),leases=[];
  try {
    const ids=[];
    for(let index=0;index<6;index++)ids.push((await f.claim(time,url,`rec-${index}`)).id);
    for(let index=0;index<5;index++) {
      const lease=await f.api.acquireLibraryExecution(ids[index],new AbortController());leases.push(lease);assert.equal(lease.acquired,true);
    }
    const sixth=await f.api.acquireLibraryExecution(ids[5],new AbortController());
    assert.deepEqual(sixth,{acquired:false,reason:"busy"});
    assert.deepEqual(await f.api.acquireLibraryExecution(ids[0],new AbortController()),{acquired:false,reason:"running"});
    for(const lease of leases)await lease.release();
    const next=await f.api.acquireLibraryExecution(ids[5],new AbortController());leases.push(next);assert.equal(next.acquired,true);
  } finally {
    for(const lease of leases)if(lease.acquired)await lease.release();
  }
});

test("a started invocation cannot be started again and additive schema is idempotent",async t=>{
  const f=await fixture(t);
  const receipt=await f.claim(Date.UTC(2026,9,19,5));
  assert.equal(await f.api.startLibraryTask(receipt.id),true);
  assert.equal(await f.api.startLibraryTask(receipt.id),false);
  await f.reapplySchema();
  assert.equal((await f.api.getLibraryTask(receipt.id)).state,"running");
});
