import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const url = code => "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const code = ts.transpileModule(await readFile(new URL("../lib/products/backfill.ts", import.meta.url), "utf8"),
  {compilerOptions:{module:ts.ModuleKind.ESNext, target:ts.ScriptTarget.ES2022}}).outputText.replace('import "server-only";', "");
const { backfillProductCard } = await import(url(code
  .replace('"@/lib/feishu/document"', JSON.stringify(url("export const syncProductCardManagedFields=(...a)=>globalThis.__backfillSync(...a)")))
  .replace('"@/lib/products/catalog"', JSON.stringify(url("export const getProductCatalog=()=>globalThis.__backfillCatalog()")))
  .replace('"@/lib/products/catalog-reorganize"', JSON.stringify(url("export const reorganizeCatalogFromCache=()=>{throw Error('unexpected paid retry')}")))
  .replace('"@/lib/products/catalog-store"', JSON.stringify(url("export const readCatalog=async()=>null")))
  .replace('"@/lib/products/catalog-types"', JSON.stringify(url("export const validatePid=p=>p; export const catalogFields={};")))));
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
