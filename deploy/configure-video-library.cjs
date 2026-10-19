// Default is read-only. --prepare stages the two exact workflows disabled;
// --enable activates them with an explicit post-deployment event cutoff.
// Never prints tokens, workflow headers or raw API errors.
/* eslint-disable @typescript-eslint/no-require-imports -- Direct CommonJS maintenance entrypoint in the runtime container. */
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
const mysql = require('mysql2/promise');
const emit = value => console.log(JSON.stringify(value));
const scope = { appToken: 'GujZbD0psaRxBrs6WSJc5d6anud', tableId: 'tblgmuFeWjhWXfRd' };
const workflowB = 'wkfZBX5AYjmkFCVU';
const manifestFile = '/app/.data/feishu-video-library-workflows.json';
const activationFile = '/app/.data/feishu-video-library.json';
async function privateSave(file,value,replace=false) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  const handle = await fs.open(temporary,'wx',0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  if (!replace) try { await fs.access(file); throw Error('Private receipt already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.rename(temporary,file);
}
async function main() {
  const prepare = process.argv.includes('--prepare'), enable = process.argv.includes('--enable');
  if (prepare && enable) throw Error('Choose prepare or enable, never both');
  const appId = process.env.FEISHU_CHATGPT_APP_ID || 'cli_aabd673313b85be3';
  const appSecret = process.env.FEISHU_CHATGPT_APP_SECRET;
  const secret = process.env.FEISHU_AUTOMATION_WEBHOOK_SECRET;
  if (!appSecret || !secret) throw Error('Required existing application configuration is missing');
  const db = await mysql.createConnection({host:process.env.MYSQL_HOST,port:Number(process.env.MYSQL_PORT||3306),user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE});
  try {
    const [[oldInbox]] = await db.query("SELECT COUNT(*) AS n FROM feishu_inbox_tasks WHERE state IN ('pending','running')");
    const [[oldVideos]] = await db.query("SELECT COUNT(*) AS n FROM videos WHERE status NOT IN ('completed','failed','stopped','waiting')");
    if (enable && (Number(oldInbox.n) || Number(oldVideos.n))) throw Error('Existing tasks are active; inspect before enabling');
  } finally { await db.end(); }
  const auth = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({app_id:appId,app_secret:appSecret}),redirect:'error',signal:AbortSignal.timeout(20000),
  }).then(response=>response.json());
  if(auth.code!==0||!auth.tenant_access_token)throw Error('Feishu application authentication failed');
  const api = async (method,endpoint,data) => {
    const response=await fetch('https://open.feishu.cn/open-apis'+endpoint,{
      method,headers:{Authorization:'Bearer '+auth.tenant_access_token,'X-App-Id':appId,'content-type':'application/json'},
      ...(data?{body:JSON.stringify(data)}:{}),redirect:'error',signal:AbortSignal.timeout(25000),
    });
    const result=await response.json();
    if(result.code!==0){
      const diagnostic='/app/.data/maintenance/quality-video-library-20261019/api-error-'+crypto.randomUUID()+'.json';
      await privateSave(diagnostic,{method,endpoint,httpStatus:response.status,result});
      throw Error('Feishu operation rejected: HTTP '+response.status+' code '+result.code+'; private diagnostic '+diagnostic);
    }
    return result.data;
  };
  const base='/base/v3/bases/'+scope.appToken+'/workflows/';
  const fieldsPath='/bitable/v1/apps/'+scope.appToken+'/tables/'+scope.tableId+'/fields';
  let fieldList=await api('GET',fieldsPath+'?page_size=100');
  if(fieldList.has_more)throw Error('Field pagination requires manual verification');
  const fields=new Map(fieldList.items.map(field=>[field.field_name,field]));
  for(const [name,type] of [['视频链接',15],['文件',17],['原口播',1],['中文翻译',1]])if(fields.get(name)?.type!==type)throw Error('Core field missing or unexpected type: '+name);
  const before=await api('GET',base+workflowB);
  if(enable){
    const legacy=await api('GET','/bitable/v1/apps/'+scope.appToken+'/workflows?page_size=100');
    const old=(legacy.workflows||[]).find(workflow=>workflow.workflow_id==='7687285007543045108');
    if(old&&/^(?:enable|enabled)$/i.test(old.status))throw Error('The existing legacy automation is still active; user must confirm its cutover before enabling');
  }
  let manifest;
  try{manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!prepare&&!enable){emit({state:'read-only',fields:fieldList.items.map(field=>({name:field.field_name,type:field.type,id:field.field_id})),workflowBStatus:before.status,hasPreparedManifest:Boolean(manifest)});return;}
  const directory='/app/.data/maintenance/quality-video-library-20261019/setup-'+crypto.randomUUID();
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  await privateSave(directory+'/workflow-b-before.json',before);
  const oldLoad=Module._load,oldResolve=Module._resolveFilename;
  Module._load=function(name,...args){return name==='server-only'?{}:oldLoad.call(this,name,...args);};
  Module._resolveFilename=function(name,...args){return oldResolve.call(this,name.startsWith('@/')?path.join(process.cwd(),name.slice(2)):name,...args);};
  Module._extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(syncFs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
  const {videoLibraryWorkflow}=require('../lib/feishu/video-library-workflows.ts');
  const outputFieldIds={transcript:fields.get('原口播').field_id,translation:fields.get('中文翻译').field_id,file:fields.get('文件').field_id};
  const definitions=Object.fromEntries(['add','change'].map(kind=>[kind,videoLibraryWorkflow({kind,tableName:'数据表',sourceFieldId:fields.get('视频链接').field_id,outputFieldIds,endpoint:'https://52.37.212.216/api/feishu/video-library',secret})]));
  const signature=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const definition = value => ({title:value.title,steps:value.steps});
  if(prepare){
    if(before.status!=='disabled')throw Error('Workflow B is active; inspect before replacing its definition');
    for(const name of ['处理状态','失败原因']){
      if(fields.has(name)&&fields.get(name).type!==1)throw Error('Existing result field has unexpected type: '+name);
      if(!fields.has(name))await api('POST',fieldsPath,{field_name:name,type:1});
    }
    let workflowA=manifest?.workflowA;
    if(workflowA){
      const existing=await api('GET',base+workflowA);
      if(existing.status!=='disabled')throw Error('Workflow A is active; no definition was overwritten');
      await privateSave(directory+'/workflow-a-before.json',existing);
      await api('PUT',base+workflowA,definitions.add);
    }else{
      if(manifest?.createAttempt)throw Error('Prior workflow creation outcome is uncertain; inspect native workflows before retrying');
      manifest={...scope,workflowB,createAttempt:{at:new Date().toISOString(),title:definitions.add.title,clientToken:crypto.randomUUID(),snapshot:directory}};
      await privateSave(manifestFile,manifest,true);
      // Feishu requires client_token; persist it before the request so an
      // ambiguous creation can be reconciled without creating a second flow.
      const created=await api('POST',base.slice(0,-1),{...definitions.add,client_token:manifest.createAttempt.clientToken});
      workflowA=created.workflow_id||created.id;
      if(!workflowA)throw Error('Created workflow did not return an identifier; no blind retry allowed');
    }
    await api('PUT',base+workflowB,definitions.change);
    const afterA=await api('GET',base+workflowA),afterB=await api('GET',base+workflowB);
    await privateSave(directory+'/workflow-a-after.json',afterA);await privateSave(directory+'/workflow-b-after.json',afterB);
    if(afterA.status!=='disabled'||afterB.status!=='disabled')throw Error('Prepared workflows are not both disabled');
    manifest={...scope,workflowA,workflowB,signatureA:signature(definition(afterA)),signatureB:signature(definition(afterB)),preparedAt:new Date().toISOString(),snapshot:directory};
    await privateSave(manifestFile,manifest,true);
    emit({state:'prepared-disabled',workflowA,workflowB,snapshot:directory});return;
  }
  if(!manifest?.workflowA||manifest.appToken!==scope.appToken||manifest.tableId!==scope.tableId)throw Error('No verified prepared workflow manifest');
  const currentA=await api('GET',base+manifest.workflowA),currentB=await api('GET',base+workflowB);
  if(signature(definition(currentA))!==manifest.signatureA||signature(definition(currentB))!==manifest.signatureB)throw Error('Workflow definitions changed since preparation; activation refused');
  let activation;
  try{activation=JSON.parse(await fs.readFile(activationFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(activation&&(activation.version!==1||activation.appToken!==scope.appToken||activation.tableId!==scope.tableId||!Number.isFinite(Date.parse(activation.enabledAfter))))throw Error('Existing activation file does not match the confirmed table');
  if(activation?.enabled!==true){activation={version:1,...scope,enabled:true,enabledAfter:new Date().toISOString()};await privateSave(activationFile,activation,true);}
  for(const [id,value] of [[manifest.workflowA,currentA],[workflowB,currentB]])if(value.status!=='enabled')await api('PATCH',base+id+'/enable');
  const finalA=await api('GET',base+manifest.workflowA),finalB=await api('GET',base+workflowB);
  await privateSave(directory+'/activation.json',{activation,statusA:finalA.status,statusB:finalB.status});
  if(finalA.status!=='enabled'||finalB.status!=='enabled')throw Error('Workflow activation not fully confirmed');
  emit({state:'enabled',workflowA:manifest.workflowA,workflowB,enabledAfter:activation.enabledAfter,snapshot:directory});
}
main().catch(error=>{emit({state:'stopped',message:String(error.message||'Setup failed').replace(/https?:\/\/\S+/g,'[url]').replace(/Bearer\s+\S+/gi,'[hidden]').slice(0,180)});process.exitCode=1;});
