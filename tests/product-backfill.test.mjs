import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
const url = code => "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const code = ts.transpileModule(await readFile(new URL("../lib/products/backfill.ts", import.meta.url), "utf8"),
  {compilerOptions:{module:ts.ModuleKind.ESNext, target:ts.ScriptTarget.ES2022}}).outputText.replace('import "server-only";', "");
const typesUrl = url(ts.transpileModule(await readFile(new URL("../lib/products/catalog-types.ts", import.meta.url), "utf8"), {compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText);
const { backfillProductCard, refreshProductCard } = await import(url(code
  .replace('"@/lib/feishu/document"', JSON.stringify(url("export const syncProductCardManagedFields=(...a)=>globalThis.__backfillSync(...a)")))
  .replace('"@/lib/products/catalog"', JSON.stringify(url("export const getProductCatalog=()=>globalThis.__backfillCatalog(); export const catalogForWrite=value=>globalThis.__backfillCatalogForWrite?.(value)||value")))
  .replace('"@/lib/products/catalog-reorganize"', JSON.stringify(url("export const reorganizeCatalogFromCache=(...a)=>globalThis.__backfillReorganize(...a)")))
  .replace('"@/lib/products/catalog-store"', JSON.stringify(url("export const readCatalog=async()=>globalThis.__backfillCached||null")))
  .replace('"@/lib/products/catalog-types"', JSON.stringify(typesUrl))));
const pid = "1732245915614220594";
test("backfill preserves manual facts, marks unsupported blanks pending and reports skipped writes as partial", async t => {
  t.after(()=>{delete globalThis.__backfillSync;delete globalThis.__backfillCatalog});
  const values = {"商品ID":pid,"产品SKU":"manual SKU"};
  globalThis.__backfillCatalog = async()=>({model:"fixture",fields:Object.fromEntries(
    ["sku","coreFunctions","productParameters","usageMethod","audience","scenes"]
      .map(key=>[key,{basis:key==="audience"?"missing":"direct",text:key}]))});
  const writes=[];
  globalThis.__backfillSync = async(_, input)=>{
    if(input.preflightOnly)return {currentValues:{...values},duplicateLabels:[]};
    writes.push(input);
    Object.assign(values,{"产品主要功能":input.coreFunctions?.join("；"),"产品参数":input.productParameters,"使用场景":input.scenes});
    return {skippedLabels:["使用方法"],missingLabels:[]};
  };
  const result=await backfillProductCard({},pid,"JvOLdX2FsoQG4AxyZcXcRolYnHf");
  assert.equal(writes.length,1);
  assert.equal(writes[0].sku,undefined);
  assert.equal(writes[0].audience,"待补齐");
  assert.deepEqual(writes[0].expectedValues,{"商品ID":pid,"产品SKU":"manual SKU"});
  assert.equal(writes[0].derivedOnly,true);
  assert.equal(result.body.state,"partial");
  assert.deepEqual(result.body.filled,["产品主要功能","产品参数","使用场景"]);
});
test("wrong document PID is rejected before model or writes", async t=>{
  t.after(()=>{delete globalThis.__backfillSync;delete globalThis.__backfillCatalog});
  globalThis.__backfillCatalog=()=>{throw Error("must not analyze")};
  globalThis.__backfillSync=async()=>({currentValues:{"商品ID":"99999999"},duplicateLabels:[]});
  assert.equal((await backfillProductCard({},pid,"JvOLdX2FsoQG4AxyZcXcRolYnHf")).status,409);
});

test("missing document PID cannot charge a model or write uncertain product identity", async t => {
  t.after(()=>{delete globalThis.__backfillSync;delete globalThis.__backfillCatalog});
  globalThis.__backfillSync = async()=>({currentValues:{},duplicateLabels:[]});
  globalThis.__backfillCatalog = ()=>{throw Error("must not analyze")};
  assert.equal((await backfillProductCard({},pid,"JvOLdX2FsoQG4AxyZcXcRolYnHf")).status,409);
});

test("repeated failed repairs use one durable paid-request identity and write pending without false completion", async t => {
  t.after(()=>{delete globalThis.__backfillSync;delete globalThis.__backfillCached;delete globalThis.__backfillReorganize});
  const writes=[];
  globalThis.__backfillSync = async(_,input)=> input.preflightOnly
    ? {currentValues:{"商品ID":pid},duplicateLabels:[],missingLabels:[]}
    : (writes.push(input), {skippedLabels:[],missingLabels:[]});
  globalThis.__backfillCached = {fetch_state:"ready",analysis_state:"failed",updated_at:"same failed generation"};
  const requests=[];
  globalThis.__backfillReorganize = async (...args)=>{requests.push(args);throw Error("existing failed request")};
  for(let i=0;i<2;i++) {
    const out=await backfillProductCard({},pid,"JvOLdX2FsoQG4AxyZcXcRolYnHf");
    assert.equal(out.body.state,"partial");
    assert.deepEqual(out.body.filled,[]);
    assert.match(out.body.sourceError,/商品资料处理失败/);
  }
  assert.equal(writes[0].sku,"待补齐");
  assert.deepEqual(requests[0],requests[1]);
  assert.match(requests[0][1],/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
});

test("explicit refresh uses only organized cache and never calls a provider; unsupported fields keep their old values", async t => {
  t.after(() => { delete globalThis.__backfillSync; delete globalThis.__backfillCached; delete globalThis.__backfillCatalog; delete globalThis.__backfillReorganize; });
  const catalog = {pid,model:"fixture",createdAt:"t",warnings:[],fields:Object.fromEntries(
    ["sku","coreFunctions","productParameters","usageMethod","audience","scenes"].map(key=>[key,{text:key,basis:key==="audience"?"missing":"direct",evidence:["product-text"]}]))};
  globalThis.__backfillCached = {fetch_state:"ready",analysis_state:"ready",result_json:JSON.stringify(catalog)};
  globalThis.__backfillCatalog = globalThis.__backfillReorganize = () => { throw Error("no paid calls allowed"); };
  const values={"商品ID":pid,"产品SKU":"人工SKU","使用方法":"人工步骤"};
  const writes=[];
  globalThis.__backfillSync = async (_,input) => {
    if(input.preflightOnly) return {currentValues:{...values},duplicateLabels:[],missingLabels:[]};
    writes.push(input);
    Object.assign(values,{"产品SKU":input.sku,"产品主要功能":input.coreFunctions?.join("；"),"产品参数":input.productParameters,"使用方法":input.usageMethod,"使用场景":input.scenes});
    return {skippedLabels:[],missingLabels:[]};
  };
  const out = await refreshProductCard({},pid,"JvOLdX2FsoQG4AxyZcXcRolYnHf");
  assert.equal(out.body.ok,true);
  assert.equal(writes[0].sku,"sku");
  assert.equal(writes[0].usageMethod,"usageMethod");
  assert.equal(writes[0].audience,"待补齐");
  assert.equal(writes[0].derivedOnly,true);
  assert.equal(writes[0].preserveExistingOnMissing,true);
  assert.deepEqual(writes[0].expectedValues,{"商品ID":pid,"产品SKU":"人工SKU","使用方法":"人工步骤"});
  globalThis.__backfillCached.analysis_state="failed";
  assert.equal((await refreshProductCard({},pid,"JvOLdX2FsoQG4AxyZcXcRolYnHf")).status,409);
  assert.equal(writes.length,1);
});

test("a write acknowledgement without visible text stays partial, and changed PID is rejected", async t => {
  t.after(()=>{delete globalThis.__backfillSync;delete globalThis.__backfillCatalog});
  globalThis.__backfillCatalog = async()=>({model:"fixture",fields:Object.fromEntries(
    ["sku","coreFunctions","productParameters","usageMethod","audience","scenes"].map(key=>[key,{basis:"direct",text:key}]))});
  let identity=pid;
  globalThis.__backfillSync = async(_,input)=> input.preflightOnly
    ? {currentValues:{"商品ID":identity},duplicateLabels:[],missingLabels:[]}
    : {skippedLabels:[],missingLabels:[]};
  const out=await backfillProductCard({},pid,"JvOLdX2FsoQG4AxyZcXcRolYnHf");
  assert.equal(out.body.state,"partial");
  assert.equal(out.body.missing.length,6);
  assert.deepEqual(out.body.filled,[]);
  globalThis.__backfillSync = async(_,input)=> {
    if(input.preflightOnly)return {currentValues:{"商品ID":identity},duplicateLabels:[],missingLabels:[]};
    identity="99999999";
    return {skippedLabels:[],missingLabels:[]};
  };
  const changed=await backfillProductCard({},pid,"JvOLdX2FsoQG4AxyZcXcRolYnHf");
  assert.equal(changed.status,409);
  assert.equal(changed.body.ok,false);
});

test("maintenance preservation recognizes emoji labels but protects multiline manual and video blocks", async () => {
  const source = await readFile(new URL("../deploy/recover-public-handcards.cjs", import.meta.url), "utf8");
  const helpers = source.slice(source.indexOf('const labels ='), source.indexOf('const arg ='));
  const basic = vm.runInNewContext(helpers + ";isBasic", {createHash:()=>({update:()=>({digest:()=>''})})});
  const block = content => ({text:{elements:[{text_run:{content}}]}});
  assert.equal(basic(block("🐾产品SKU：")),true);
  assert.equal(basic(block("🧴使用方法：推断：摆放在平稳表面。")),true);
  assert.equal(basic(block("使用方法：人工说明\n视频分析：其他内容")),false);
  assert.equal(basic(block("商品ID：1732364299482009895")),false);
  assert.equal(basic(block("视频分析：原内容必须保持")),false);
});

test("offline recovery cannot reinterpret historical main/SKU image numbers as current detail images", async () => {
  const source = await readFile(new URL("../deploy/recover-public-handcards.cjs", import.meta.url), "utf8");
  const helpers = source.slice(source.indexOf('const routineRepairId ='), source.indexOf('const events ='));
  const directory = "/private/catalog/" + pid;
  const {routineRepairId,savedReplyEvidence} = vm.runInNewContext(helpers + ";({routineRepairId,savedReplyEvidence})", {
    createHash,path,catalogDirectory:()=>directory,
  });
  const evidence = {pid,text:"商品文字",images:[{id:"image-1",label:"详情图1"}],warnings:[]};
  assert.equal(savedReplyEvidence(pid,path.join(directory,"reorganizations",routineRepairId(pid),"model-response-1.json"),evidence),evidence);
  assert.equal(savedReplyEvidence(pid,path.join(directory,"model-response-1.json"),evidence).images.length,0);
  assert.equal(savedReplyEvidence(pid,path.join(directory,"reorganizations","other-old-run","model-response-1.json"),evidence).images.length,0);
  assert.match(source,/if \(offlineOnly && row.analysis_state !== "ready"\)/);
});
