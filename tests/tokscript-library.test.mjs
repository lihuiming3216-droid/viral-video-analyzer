import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const dataUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const original = "WEBVTT\n\n00:00:00 --> 00:00:01\nOpen the case.\n\n00:00:01 --> 00:00:02\nPress twice.\n";
const chinese = "WEBVTT\n\n00:00:00 --> 00:00:01\n打开盒子。\n\n00:00:01 --> 00:00:02\n按两次。\n";
const url = "https://www.tiktok.com/@sample/video/7691494301699804446";
const source = await readFile(new URL("../lib/providers/tokscript-library.ts", import.meta.url), "utf8");

async function fixture(t, changes={}) {
  const key=`library${Math.random()}`,calls=[],events=[];
  const hooks={
    call: async(name,args)=>{
      calls.push({name,args});
      if(name==="download_video")return {download_url:"https://api.tokscript.com/media/test.mp4"};
      if(name==="submit_transcript_job")return {job_id:"job-1",target_language:"zh-CN"};
      if(name==="get_job_status")return {status:"complete",transcript_ready:true,result_key:"key"};
      if(name==="get_stored_video")return {source_url:url,transcript:original};
      if(name==="export_results")return {download_url:"https://sample.r2.dev/results.json"};
      throw Error("Unexpected tool");
    },
    fetch:async()=>new Response(JSON.stringify([{source_url:url,transcript:chinese}]),{headers:{"content-type":"application/json"}}),
    ...changes,
  };
  globalThis[key]=hooks;t.after(()=>{delete globalThis[key];});
  const stub=dataUrl(`
    export const requireProvider=async()=>({baseUrl:"https://api.example/mcp",apiKey:"not-a-real-key"});
    export const fetchWithProxy=(...args)=>globalThis[${JSON.stringify(key)}].fetch(...args);
    export const resolveTokScriptVideoUrl=async url=>url;
    export const tokScriptTranscriptFailure=text=>/^Failed to|^No transcript available/i.test(text);
    export class TokScriptClient {
      async connect(){};
      async listTools(){return ["download_video","submit_transcript_job","get_job_status","get_stored_video","export_results"].map(name=>({name}));}
      async callTool(tool,url){return {structuredContent:await globalThis[${JSON.stringify(key)}].call(tool.name,{video_url:url})};}
      async callToolArguments(name,args){return {structuredContent:await globalThis[${JSON.stringify(key)}].call(name,args)};}
    }
  `);
  let code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace('import "server-only";',"");
  for(const specifier of ["@/lib/network","@/lib/provider-config","@/lib/providers/tokscript"])code=code.replaceAll(JSON.stringify(specifier),JSON.stringify(stub));
  return {api:await import(dataUrl(code)),calls,events,hooks};
}

test("full original and translated captions use separate proven sources, without any AI fallback",async t=>{
  const f=await fixture(t);
  const result=await f.api.fetchLibraryVideo(url,{onTranscript:async text=>f.events.push(["original",text]),onTranslation:async text=>f.events.push(["chinese",text]),onDownload:async()=>f.events.push(["file"])});
  assert.equal(result.transcript,"Open the case.\nPress twice.");
  assert.equal(result.translation,"打开盒子。\n按两次。");
  assert.deepEqual(result.errors,{});
  assert.equal(f.calls.filter(call=>call.name==="submit_transcript_job").length,1);
  assert.equal(f.calls.find(call=>call.name==="submit_transcript_job").args.target_language,"zh-CN");
  assert.ok(f.events.some(event=>event[0]==="original")&&f.events.some(event=>event[0]==="chinese")&&f.events.some(event=>event[0]==="file"));
  assert.doesNotMatch(source,/qwen|openai|chuhaijiang|analyzeVideo|enqueueVideos/);
});

test("caption cleanup preserves repetition, numbers and complete non-caption text",async t=>{
  const {api}=await fixture(t);
  assert.equal(api.libraryCaptionText("Plain speech\nrepeat\nrepeat\n123"),"Plain speech\nrepeat\nrepeat\n123");
  assert.equal(api.libraryCaptionText("WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n123\n\n2\n00:00:02.000 --> 00:00:03.000\n<c>repeat</c>\n\n3\n00:00:03.000 --> 00:00:04.000\nrepeat"),"123\nrepeat\nrepeat");
});

test("publication captions and mismatched video exports cannot masquerade as speech",async t=>{
  const {api}=await fixture(t);
  assert.throws(()=>api.libraryStoredTranscript({source_url:url,title:"Buy now",caption:"Advertisement"},url),/原口播/);
  assert.throws(()=>api.libraryStoredTranscript({source_url:url.replace(/4446$/,"4447"),transcript:original},url),/不一致/);
  assert.throws(()=>api.libraryExportTranslation([{source_url:url.replace(/4446$/,"4447"),transcript:chinese}],url),/唯一/);
  assert.throws(()=>api.libraryExportTranslation([{source_url:url,transcript:chinese},{source_url:url,transcript:chinese}],url),/唯一/);
});

test("download failure does not block the two texts",async t=>{
  const f=await fixture(t);const originalCall=f.hooks.call;
  f.hooks.call=async(name,args)=>{if(name==="download_video")throw Error("failed");return originalCall(name,args);};
  const result=await f.api.fetchLibraryVideo(url);
  assert.ok(result.transcript&&result.translation);assert.ok(result.errors.download);assert.equal(result.downloadUrl,"");
});

test("translation failure does not block original text or the real media URL",async t=>{
  const f=await fixture(t);const originalCall=f.hooks.call;
  f.hooks.call=async(name,args)=>{if(name==="get_job_status")return {status:"failed"};return originalCall(name,args);};
  const result=await f.api.fetchLibraryVideo(url);
  assert.ok(result.transcript&&result.downloadUrl);assert.equal(result.translation,"");assert.ok(result.errors.translation);
  assert.equal(f.calls.filter(call=>call.name==="submit_transcript_job").length,1,"failed or uncertain jobs are not blindly resubmitted");
});

test("a completed upstream job with unavailable speech is not a successful translation",async t=>{
  const f=await fixture(t);const originalCall=f.hooks.call;
  f.hooks.call=async(name,args)=>{if(name==="get_job_status")return {status:"complete",transcript_ready:false,result_key:"key"};return originalCall(name,args);};
  const result=await f.api.fetchLibraryVideo(url);
  assert.equal(result.translation,"");assert.ok(result.errors.translation);assert.ok(result.downloadUrl);
});

test("reject unofficial or product/collection links before any provider request",async t=>{
  const f=await fixture(t);
  for(const invalid of ["http://www.tiktok.com/@x/video/7691494301699804446","https://www.tiktok.com.evil.test/@x/video/7691494301699804446","https://shop.tiktok.com/us/pdp/1732275546440044929","https://www.tiktok.com/@user","https://www.tiktok.com/@user/collection/123"])
    await assert.rejects(f.api.fetchLibraryVideo(invalid));
  assert.equal(f.calls.length,0);
});

test("export hosts and oversized results fail only the translation stage",async t=>{
  const f=await fixture(t);const originalCall=f.hooks.call;
  f.hooks.call=async(name,args)=>{if(name==="export_results")return {download_url:"https://127.0.0.1/private.json"};return originalCall(name,args);};
  const result=await f.api.fetchLibraryVideo(url);
  assert.ok(result.errors.translation);assert.ok(result.transcript&&result.downloadUrl);
  f.hooks.call=originalCall;
  f.hooks.fetch=async()=>new Response("not fetched",{headers:{"content-length":String(9*1024*1024)}});
  assert.ok((await f.api.fetchLibraryVideo(url)).errors.translation);
});
