import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const url = code => "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const code = ts.transpileModule(await readFile(new URL("../lib/products/backfill.ts", import.meta.url), "utf8"),
  {compilerOptions:{module:ts.ModuleKind.ESNext, target:ts.ScriptTarget.ES2022}}).outputText.replace('import "server-only";', "");
const typesUrl = url(ts.transpileModule(await readFile(new URL("../lib/products/catalog-types.ts", import.meta.url), "utf8"), {compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText);
const { backfillProductCard, refreshProductCard } = await import(url(code
  .replace('"@/lib/feishu/document"', JSON.stringify(url("export const syncProductCardManagedFields=(...a)=>globalThis.__backfillSync(...a)")))
  .replace('"@/lib/products/catalog"', JSON.stringify(url("export const getProductCatalog=()=>globalThis.__backfillCatalog()")))
  .replace('"@/lib/products/catalog-reorganize"', JSON.stringify(url("export const reorganizeCatalogFromCache=(...a)=>globalThis.__backfillReorganize(...a)")))
  .replace('"@/lib/products/catalog-store"', JSON.stringify(url("export const readCatalog=async()=>globalThis.__backfillCached||null")))
  .replace('"@/lib/products/catalog-types"', JSON.stringify(typesUrl))));
const pid = "1732245915614220594";
test("backfill preserves manual basic fields, skips missing model facts and reports skipped writes as partial", async t => {
  t.after(()=>{delete globalThis.__backfillSync;delete globalThis.__backfillCatalog});
  const values = {"商品ID":pid,"产品SKU":"manual SKU"};
  globalThis.__backfillCatalog = async()=>({model:"fixture",fields:Object.fromEntries(
    ["sku","coreFunctions","productParameters","usageMethod","audience","scenes"]
      .map(key=>[key,{basis:key==="audience"?"missing":"direct",text:key}]))});
  const writes=[];
  globalThis.__backfillSync = async(_, input)=>{
    if(input.preflightOnly)return {currentValues:values,duplicateLabels:[]};
    writes.push(input);
    return {skippedLabels:["使用方法"],missingLabels:[]};
  };
  const result=await backfillProductCard({},pid,"JvOLdX2FsoQG4AxyZcXcRolYnHf");
  assert.equal(writes.length,1);
  assert.equal(writes[0].sku,undefined);
  assert.equal(writes[0].audience,undefined);
  assert.deepEqual(writes[0].expectedValues,values);
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

test("repeated failed repairs of one catalog use the same durable paid-request identity", async t => {
  t.after(()=>{delete globalThis.__backfillSync;delete globalThis.__backfillCached;delete globalThis.__backfillReorganize});
  globalThis.__backfillSync = async()=>({currentValues:{"商品ID":pid},duplicateLabels:[]});
  globalThis.__backfillCached = {fetch_state:"ready",analysis_state:"failed",updated_at:"same failed generation"};
  const requests=[];
  globalThis.__backfillReorganize = async (...args)=>{requests.push(args);throw Error("existing failed request")};
  for(let i=0;i<2;i++) await assert.rejects(backfillProductCard({},pid,"JvOLdX2FsoQG4AxyZcXcRolYnHf"),/existing failed request/);
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
    if(input.preflightOnly) return {currentValues:values,duplicateLabels:[],missingLabels:[]};
    writes.push(input); return {skippedLabels:[],missingLabels:[]};
  };
  const out = await refreshProductCard({},pid,"JvOLdX2FsoQG4AxyZcXcRolYnHf");
  assert.equal(out.body.ok,true);
  assert.equal(writes[0].sku,"sku");
  assert.equal(writes[0].usageMethod,"usageMethod");
  assert.equal(writes[0].audience,undefined);
  assert.equal(writes[0].derivedOnly,true);
  assert.equal(writes[0].preserveExistingOnMissing,true);
  assert.deepEqual(writes[0].expectedValues,values);
  globalThis.__backfillCached.analysis_state="failed";
  assert.equal((await refreshProductCard({},pid,"JvOLdX2FsoQG4AxyZcXcRolYnHf")).status,409);
  assert.equal(writes.length,1);
});
