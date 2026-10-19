import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source=await readFile(new URL("../lib/feishu/video-library-policy.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const api=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const policyUrl=`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const workflowSource=await readFile(new URL("../lib/feishu/video-library-workflows.ts",import.meta.url),"utf8");
const workflowCompiled=ts.transpileModule(workflowSource,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
  .replaceAll('"@/lib/feishu/video-library-policy"',JSON.stringify(policyUrl));
const workflows=await import(`data:text/javascript;base64,${Buffer.from(workflowCompiled).toString("base64")}`);

test("a stable native trigger timestamp is normalized independently of server timezone",()=>{
  const time=Date.UTC(2026,9,19,1,2,3);
  for(const value of [time,String(time),time/1000,String(time/1000),new Date(time).toISOString(),{timestamp:time},[time]])assert.equal(api.libraryEventTime(value),time);
  for(const value of [null,"",0,"2026-10-19 09:02:03",Date.now()+120000])assert.throws(()=>api.libraryEventTime(value));
});

test("unchanged managed values can update while manual edits stay untouched",()=>{
  const patch=api.libraryOwnedPatch({原口播:"manual",中文翻译:"old",文件:[]},{原口播:"previous",中文翻译:"old",文件:[]},{原口播:"new",中文翻译:"中文",文件:[{file_token:"new-file"}]});
  assert.deepEqual(patch.fields,{中文翻译:"中文",文件:[{file_token:"new-file"}]});assert.deepEqual(patch.conflicts,["原口播"]);
});

test("expired download URLs and rich-text wrappers do not misidentify managed contents",()=>{
  assert.equal(api.librarySameValue([{file_token:"file",tmp_url:"old"}],[{file_token:"file",tmp_url:"new"}]),true);
  assert.equal(api.librarySameValue([{text:"原口播"}],"原口播"),true);
  assert.equal(api.librarySameValue([],undefined),true);
  assert.equal(api.librarySameValue([{file_token:"a"}],[{file_token:"b"}]),false);
});

test("managed patches cannot mutate source, product info, or unrelated columns",()=>{
  assert.deepEqual(api.libraryOwnedPatch({}, {}, {视频链接:"https://example.com",产品名称:"guess",日期:"today",处理状态:"bad"}),{fields:{},conflicts:[]});
});

test("native triggers watch only source-link additions/changes and do not exclude bulk pastes",()=>{
  const options={tableName:"数据表",sourceFieldId:"fldo5Xf5YH",eventTimeFieldId:"fldEventTime",outputFieldIds:{transcript:"fldOriginal",translation:"fldTranslation",file:"fldFile"},endpoint:"https://52.37.212.216/api/feishu/video-library",secret:"fixture-only"};
  const add=workflows.videoLibraryWorkflow({...options,kind:"add"}),change=workflows.videoLibraryWorkflow({...options,kind:"change"});
  assert.equal(add.steps[0].type,"AddRecordTrigger");assert.equal(add.steps[0].data.watched_field_name,"视频链接");
  assert.equal(change.steps[0].type,"SetRecordTrigger");assert.deepEqual(change.steps[0].data.field_watch_info,[{field_name:"视频链接",operator:"isNotEmpty",value:[]}]);
  for(const workflow of [add,change]) {
    assert.ok(!workflow.steps[0].data.trigger_control_list.includes("pasteUpdate"));
    assert.doesNotMatch(JSON.stringify(workflow.steps[0]),/中文翻译|原口播|文件|TimerTrigger/);
    const http=workflow.steps[1].data;
    assert.ok(http.form_body.some(item=>item.key==="eventTime"&&item.value[0].value==="$.step_trigger.fldEventTime.timestamp"));
    assert.ok(!JSON.stringify(http).includes('$.step_trigger.recordModifiedTime'),"native minute-formatted dates cannot identify rapid link edits");
    assert.ok(http.headers.some(item=>item.key==="x-feishu-automation-secret"));
    assert.ok(!JSON.stringify(http.form_body).includes("fixture-only"));
  }
});

test("workflow credentials cannot be configured to leave the confirmed HTTPS server",()=>{
  const options={kind:"add",tableName:"数据表",sourceFieldId:"fldo5Xf5YH",eventTimeFieldId:"fldEventTime",outputFieldIds:{transcript:"fldOriginal",translation:"fldTranslation",file:"fldFile"},secret:"fixture-only"};
  for(const endpoint of ["http://52.37.212.216/api/feishu/video-library","https://evil.example/api/feishu/video-library","https://52.37.212.216/api/feishu/video-library?secret=exposed"])
    assert.throws(()=>workflows.videoLibraryWorkflow({...options,endpoint}));
});

test("native snapshots accept both JSON and comma-separated file token lists without retaining signed URLs",()=>{
  const base={snapshotTranscript:"old original",snapshotTranslation:"旧中文"};
  for(const snapshotFileTokens of [["fileOne","fileTwo"],'["fileOne","fileTwo"]',"fileOne,fileTwo"])
    assert.deepEqual(api.libraryTriggerSnapshot({...base,snapshotFileTokens}).文件,[{file_token:"fileOne"},{file_token:"fileTwo"}]);
  assert.throws(()=>api.libraryTriggerSnapshot(base),/快照/);
  assert.throws(()=>api.libraryTriggerSnapshot({...base,snapshotFileTokens:"https://example.test/file"}),/快照格式无效/);
});

test("workflow creation persists the required client token before its only POST",async()=>{
  const setup=await readFile(new URL("../deploy/configure-video-library.cjs",import.meta.url),"utf8");
  assert.match(setup,/clientToken:crypto\.randomUUID\(\)/);
  assert.match(setup,/client_token:manifest\.createAttempt\.clientToken/);
  assert.ok(setup.indexOf("await privateSave(manifestFile,manifest,true)")<setup.indexOf("client_token:manifest.createAttempt.clientToken"));
  assert.match(setup,/Prior workflow creation outcome is uncertain/);
});
