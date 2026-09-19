import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

const source = name => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const url = value => `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
const compile = value => ts.transpileModule(value, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('import "server-only";', "");
const coreUrl = url(compile(await source("lib/feishu/handcard-app/core.ts")));
const core = await import(coreUrl);
const authRoute = await import(url(compile(await source("lib/admin-auth.ts"))));
const fields = [
  { field_id: "f1", field_name: "商品编号", type: 1 }, { field_id: "f2", field_name: "商品名", type: 1 },
  { field_id: "f3", field_name: "手卡链接", type: 1 }, { field_id: "f4", field_name: "任务进度", type: 1 },
  { field_id: "f5", field_name: "数值PID", type: 2 }, { field_id: "f6", field_name: "链接", type: 15 },
];
const selection = { pid: "f1", productName: "f2", productDocument: "f3", productCardStatus: "f4" };
const baseLink = "https://fixture.feishu.cn/base/base12345?table=tbl12345";

test("only exact app paths bypass admin auth; server actions and admin APIs never do", () => {
  for (const p of ["/feishu/handcard", "/feishu/handcard/auth/login", "/feishu/handcard/auth/callback", "/feishu/handcard/api"]) {
    assert.equal(authRoute.publicFeishuAppRoute(p, "GET"), true);
    assert.equal(authRoute.publicFeishuAppRoute(p, "GET", true), false);
    assert.equal(authRoute.publicFeishuAppRoute(`${p}/extra`, "GET"), false);
  }
  assert.equal(authRoute.publicFeishuAppRoute("/feishu/handcard/api", "POST"), true);
  assert.equal(authRoute.publicFeishuAppRoute("/feishu/handcard/api", "PUT"), false);
  assert.equal(authRoute.publicFeishuAppRoute("/admin/field-mapping", "POST"), false);
  assert.equal(authRoute.publicFeishuAppRoute("/api/feishu/settings", "GET"), false);
});

test("Base/wiki links are parsed locally; foreign URLs, credentials and ordinary sheets fail closed", () => {
  assert.deepEqual(core.parseTableLink(baseLink), { kind: "base", token: "base12345", tableId: "tbl12345" });
  assert.deepEqual(core.parseTableLink("https://fixture.feishu.cn/wiki/wiki12345"), { kind: "wiki", token: "wiki12345", tableId: "" });
  for (const link of ["http://fixture.feishu.cn/base/base12345", "https://feishu.cn.attacker.test/base/base12345", "https://user:secret@fixture.feishu.cn/base/base12345",
    "https://127.0.0.1/base/base12345", "https://fixture.feishu.cn/sheets/sheet12345", "https://fixture.feishu.cn/base/base12345?table=../../other", "not-url"]) {
    assert.throws(() => core.parseTableLink(link));
  }
  assert.throws(() => core.validateTableId("../../secret"));
});

test("field choices require PID and document text columns, permit omitted name/status and reject duplicates", () => {
  assert.deepEqual(core.selectHandcardMap(selection, fields), { pid: "商品编号", productName: "商品名", productDocument: "手卡链接", productCardStatus: "任务进度" });
  assert.equal(core.selectHandcardMap({ ...selection, productName: "", productCardStatus: "" }, fields).productName, "");
  for (const changes of [{ pid: "" }, { pid: "f5" }, { productDocument: "f6" }, { productName: "f1" }, { productDocument: "deleted" }, { videoUrl: "f2" }]) {
    assert.throws(() => core.selectHandcardMap({ ...selection, ...changes }, fields));
  }
});

test("all configuration writes require the configured origin", () => {
  const origin = "https://fixture.example";
  core.assertSameOrigin(new Headers({ origin }), origin);
  for (const headers of [new Headers(), new Headers({ origin: "https://evil.example" }), new Headers({ origin, "sec-fetch-site": "cross-site" })]) {
    assert.throws(() => core.assertSameOrigin(headers, origin), /来源/);
  }
});

async function authFixture(t) {
  const keys = ["FEISHU_HANDCARD_APP_ID", "FEISHU_HANDCARD_APP_SECRET", "FEISHU_HANDCARD_TENANT_KEY", "FEISHU_HANDCARD_ORIGIN"];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { FEISHU_HANDCARD_APP_ID: "cli_fixture", FEISHU_HANDCARD_APP_SECRET: "fixture-secret-not-real", FEISHU_HANDCARD_TENANT_KEY: "our-company", FEISHU_HANDCARD_ORIGIN: "https://fixture.example" });
  t.after(() => { for (const key of keys) if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; });
  const temp = await mkdtemp(path.join(tmpdir(), "handcard-auth-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const cryptoUrl = url(compile(await source("lib/crypto.ts")).replaceAll("process.cwd()", JSON.stringify(temp)));
  const crypto = await import(cryptoUrl);
  const key = `handcardAuth${Math.random()}`;
  const events = [];
  globalThis[key] = { events, row: null };
  t.after(() => delete globalThis[key]);
  const db = url(`export const getDb = async () => ({}); export const execute = async (...args) => { globalThis[${JSON.stringify(key)}].events.push(args); return {}; }; export const queryRow = async () => globalThis[${JSON.stringify(key)}].row;`);
  const code = compile(await source("lib/feishu/handcard-app/auth.ts"))
    .replaceAll('"@/lib/crypto"', JSON.stringify(cryptoUrl)).replaceAll('"@/lib/database"', JSON.stringify(db))
    .replaceAll('"@/lib/db/query"', JSON.stringify(db)).replaceAll('"@/lib/feishu/handcard-app/core"', JSON.stringify(coreUrl));
  const auth = await import(url(code));
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  return { auth, crypto, events, state: globalThis[key] };
}

test("OAuth uses PKCE/state, HTTPS fixed callback, separate credentials; rejects tampering/expiry", async t => {
  const { auth, crypto } = await authFixture(t);
  const login = auth.startLogin();
  const target = new URL(login.url);
  const state = target.searchParams.get("state");
  assert.equal(target.origin, "https://accounts.feishu.cn");
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  assert.equal(target.searchParams.get("redirect_uri"), "https://fixture.example/feishu/handcard/auth/callback");
  assert.doesNotMatch(login.url + login.cookie, /fixture-secret-not-real/);
  assert.equal(auth.loginVerifier(login.cookie, state).length, 43);
  assert.throws(() => auth.loginVerifier(login.cookie, "x".repeat(43)), /不匹配/);
  assert.throws(() => auth.loginVerifier(login.cookie + "tampered", state), /不匹配/);
  const stored = JSON.parse(crypto.decryptSecret(login.cookie));
  assert.throws(() => auth.loginVerifier(crypto.encryptSecret(JSON.stringify({ ...stored, expires: 1 })), state));
  assert.throws(() => auth.loginVerifier(crypto.encryptSecret(JSON.stringify({ ...stored, appId: "other" })), state));
  process.env.FEISHU_HANDCARD_ORIGIN = "http://fixture.example";
  assert.throws(() => auth.startLogin(), /HTTPS/);
});

test("foreign company identity is rejected before session persistence; upstream error details stay private", async t => {
  const { auth, events } = await authFixture(t);
  globalThis.fetch = async () => Response.json({ code: 0, data: { open_id: "ou_user", tenant_key: "other-company", name: "Foreign" } });
  await assert.rejects(auth.currentIdentity("private-token"), /本公司/);
  assert.equal(events.length, 0);
  globalThis.fetch = async () => Response.json({ code: 999, msg: "private-token request failed" });
  await assert.rejects(auth.currentIdentity("private-token"), error => !error.message.includes("private-token") && error.status === 502);
});

test("login stores only encrypted user token and hashed session, uses v3, expires by provider response", async t => {
  const { auth, crypto, events } = await authFixture(t);
  let calls = 0;
  globalThis.fetch = async (target, options) => {
    calls++;
    if (target.endsWith("/oauth/v3/token")) {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("code_verifier"), "v".repeat(43));
      assert.equal(body.get("client_id"), "cli_fixture");
      assert.equal(options.redirect, "error");
      return Response.json({ code: 0, access_token: "private-user-token", expires_in: 300 });
    }
    return Response.json({ code: 0, data: { open_id: "ou_user", tenant_key: "our-company", name: "同事" } });
  };
  const result = await auth.completeLogin("one-time-code", "v".repeat(43));
  assert.equal(calls, 2);
  assert.ok(result.maxAge <= 270 && result.maxAge > 250);
  const insert = events.find(([, sql]) => sql.includes("INSERT INTO"));
  assert.notEqual(insert[2][0], result.session);
  assert.equal(crypto.decryptSecret(insert[2][5]), "private-user-token");
  assert.doesNotMatch(JSON.stringify(events), /private-user-token|one-time-code/);
  assert.equal(auth.cookieOptions.httpOnly, true);
  assert.equal(auth.cookieOptions.secure, true);
});

test("invalid/mismatched sessions fail closed and logout deletes only the supplied session hash", async t => {
  const { auth, state, crypto, events } = await authFixture(t);
  await assert.rejects(auth.readSession(undefined), /登录/);
  await assert.rejects(auth.readSession("a".repeat(43)), /过期/);
  state.row = { app_id: "other-app", tenant_key: "our-company" };
  await assert.rejects(auth.readSession("a".repeat(43)), /过期/);
  state.row = { app_id: "cli_fixture", tenant_key: "our-company", open_id: "ou_user", display_name: "同事", encrypted_token: crypto.encryptSecret("private-user-token") };
  assert.equal((await auth.readSession("a".repeat(43))).openId, "ou_user");
  await auth.logout("a".repeat(43));
  assert.match(events.at(-1)[1], /WHERE session_hash=\?/);
  assert.notEqual(events.at(-1)[2][0], "a".repeat(43));
});

async function tableFixture(t) {
  const key = `handcardTables${Math.random()}`;
  const state = { userAllowed: true, appAllowed: true, wikiType: "bitable", existing: null, events: [], fields };
  const session = { token: "private-token", openId: "ou_internal" };
  state.userApi = async (_token, target) => {
    state.events.push(target);
    if (target.includes("get_node")) return { data: { node: { obj_type: state.wikiType, obj_token: "base12345" } } };
    if (target.includes("/members/auth")) return { data: { auth_result: state.userAllowed } };
    if (target.includes("/fields?")) return { data: { items: state.fields, has_more: false } };
    return { data: { items: [{ table_id: "tbl12345", name: "优质视频库" }], has_more: false } };
  };
  state.rawClient = { request: async ({ url: target }) => {
    state.events.push(target);
    if (target.endsWith("/members/auth")) return { code: 0, data: { auth_result: state.appAllowed } };
    return { code: 0, data: { items: state.fields, has_more: false } };
  } };
  globalThis[key] = state;
  t.after(() => delete globalThis[key]);
  const stubs = url(`const state=globalThis[${JSON.stringify(key)}];
    export const currentIdentity=async()=>({openId:"ou_internal"}); export const userApi=(...args)=>state.userApi(...args);
    export const getConnectedFeishuChannel=()=>({rawClient:state.rawClient}); export const ensureFeishuConnection=async()=>({rawClient:state.rawClient});
    export const getFeishuFieldMapping=async()=>state.existing; export const getDb=async()=>state.db;
    export const queryRow=async (...args)=>state.queryRow(...args); export const execute=async (...args)=>state.execute(...args);`);
  let code = compile(await source("lib/feishu/handcard-app/tables.ts"));
  for (const match of code.matchAll(/from "(@\/[^\"]+)"/g)) code = code.replaceAll(JSON.stringify(match[1]), JSON.stringify(match[1].endsWith("/core") ? coreUrl : stubs));
  return { tables: await import(url(code)), state, session };
}

test("pagination collects all pages and refuses missing, repeated or unbounded cursors", async t => {
  const { tables } = await tableFixture(t);
  assert.deepEqual(await tables.collectPages(async cursor => cursor ? { items: [2], has_more: false } : { items: [1], has_more: true, page_token: "next" }), [1, 2]);
  await assert.rejects(tables.collectPages(async () => ({ items: [], has_more: true })), /不完整/);
  await assert.rejects(tables.collectPages(async () => ({ items: [], has_more: true, page_token: "loop" })), /不完整/);
  await assert.rejects(tables.collectPages(async () => ({ items: [] })), /不完整/);
});

test("wiki resolves its real Base; ordinary sheets, unauthorized users and foreign table ids are rejected", async t => {
  const { tables, state, session } = await tableFixture(t);
  assert.equal((await tables.discoverTables(session, "https://fixture.feishu.cn/wiki/wiki12345")).appToken, "base12345");
  state.wikiType = "sheet";
  await assert.rejects(tables.discoverTables(session, "https://fixture.feishu.cn/wiki/wiki12345"), /不是多维表格/);
  state.userAllowed = false;
  await assert.rejects(tables.loadTable(session, baseLink, "tbl12345"), /编辑权限/);
  state.userAllowed = true;
  await assert.rejects(tables.loadTable(session, baseLink, "tbl99999"), /不属于/);
});

test("the original executing app must have edit access; field types are checked again on save", async t => {
  const { tables, state, session } = await tableFixture(t);
  state.appAllowed = false;
  await assert.rejects(tables.loadTable(session, baseLink, "tbl12345"), /原来负责/);
  state.appAllowed = true;
  const loaded = await tables.loadTable(session, baseLink, "tbl12345");
  assert.equal(loaded.tableName, "优质视频库");
  state.fields = fields.map(field => field.field_id === "f1" ? { ...field, type: 2 } : field);
  await assert.rejects(tables.saveTable(session, { link: baseLink, tableId: "tbl12345", fields: selection, revision: loaded.revision }), /精度/);
});

test("configuration save preserves video fields and aliases, audits identity and rolls back stale revisions", async t => {
  const { tables, state } = await tableFixture(t);
  state.existing = { scopeKey: "base12345:tbl12345", label: "既有配置", fieldMap: { pid: "旧PID", videoFile: "视频文件", translation: "中文翻译" }, aliases: { pid: ["旧编号"], videoUrl: ["参考片"] }, updatedAt: "old" };
  const events = [];
  const connection = { beginTransaction: async () => events.push("begin"), commit: async () => events.push("commit"), rollback: async () => events.push("rollback"), release: () => events.push("release") };
  state.db = { getConnection: async () => connection };
  state.execute = async (_db, sql, args) => { events.push([sql, args]); return { affectedRows: 0 }; };
  state.queryRow = async () => ({ label: state.existing.label, field_map_json: state.existing.fieldMap, aliases_json: state.existing.aliases, updated_at: state.existing.updatedAt });
  const input = { appToken: "base12345", tableId: "tbl12345", tableName: "名字", map: core.selectHandcardMap(selection, fields), revision: tables.mappingRevision(state.existing), openId: "ou_internal" };
  await tables.saveMapping(input);
  const update = events.find(event => Array.isArray(event) && event[0].startsWith("UPDATE"));
  assert.equal(JSON.parse(update[1][1]).videoFile, "视频文件");
  assert.deepEqual(JSON.parse(update[1][2]), { videoUrl: ["参考片"] });
  const audit = events.find(event => Array.isArray(event) && event[0].includes("INSERT INTO feishu_handcard_config_audit"));
  assert.equal(audit[1][2], "ou_internal");
  assert.ok(events.includes("commit"));
  events.length = 0;
  await assert.rejects(tables.saveMapping({ ...input, revision: "0".repeat(64) }), /其他同事/);
  assert.ok(events.includes("rollback"));
  assert.ok(!events.includes("commit"));
});

test("HTTP rejects large/invalid bodies, rate limits and hides internal errors", async () => {
  const code = compile(await source("lib/feishu/handcard-app/http.ts"))
    .replaceAll('"@/lib/feishu/handcard-app/core"', JSON.stringify(coreUrl)).replaceAll('"next/server"', JSON.stringify(import.meta.resolve("next/server.js")));
  const http = await import(url(code));
  const request = body => new Request("https://fixture.example", { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.deepEqual(await http.smallJson(request('{"action":"load"}')), { action: "load" });
  await assert.rejects(http.smallJson(request("x".repeat(8193))), error => error.status === 413);
  await assert.rejects(http.smallJson(request("[]")));
  for (let i = 0; i < 20; i++) http.rateLimit("fixture");
  assert.throws(() => http.rateLimit("fixture"), error => error.status === 429);
  const result = http.appError(Error("secret-value"));
  assert.equal(result.status, 500);
  assert.doesNotMatch(await result.text(), /secret-value/);
});

test("application data routes reject missing login/cross-origin writes before touching tables and never return tokens", async t => {
  await authFixture(t);
  const key = `appRoutes${Math.random()}`;
  const state = { hasSession: false, touched: 0 };
  globalThis[key] = state;
  t.after(() => delete globalThis[key]);
  const stub = url(`import { HandcardAppError } from ${JSON.stringify(coreUrl)};
    const s=globalThis[${JSON.stringify(key)}];
    export const readSession=async()=>{if(!s.hasSession) throw new HandcardAppError("请登录",401);return {name:"同事",openId:"ou_internal",token:"private-token"};};
    export const sessionCookie="session"; export const cookieOptions={}; export const logout=async()=>{};
    export const discoverTables=async()=>{s.touched++; return {tables:[]};}; export const loadTable=discoverTables; export const saveTable=discoverTables;`);
  const http = url(compile(await source("lib/feishu/handcard-app/http.ts"))
    .replaceAll('"@/lib/feishu/handcard-app/core"', JSON.stringify(coreUrl)).replaceAll('"next/server"', JSON.stringify(import.meta.resolve("next/server.js"))));
  let code = compile(await source("app/feishu/handcard/api/route.ts"));
  for (const match of code.matchAll(/from "(@\/[^\"]+)"/g)) code = code.replaceAll(JSON.stringify(match[1]), JSON.stringify(match[1].endsWith("/core") ? coreUrl : match[1].endsWith("/http") ? http : stub));
  code = code.replaceAll('"next/server"', JSON.stringify(import.meta.resolve("next/server.js")));
  const route = await import(url(code));
  const { NextRequest } = await import("next/server.js");
  const request = (origin = "https://fixture.example") => new NextRequest("https://fixture.example/feishu/handcard/api", {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: '{"action":"discover"}',
  });
  assert.equal((await route.POST(request())).status, 401);
  state.hasSession = true;
  assert.equal((await route.POST(request("https://evil.example"))).status, 403);
  assert.equal(state.touched, 0);
  assert.equal((await route.POST(request())).status, 200);
  assert.equal(state.touched, 1);
  const response = await route.GET(new NextRequest("https://fixture.example/feishu/handcard/api"));
  assert.deepEqual(await response.json(), { name: "同事" });
});

test("button request hydrates custom PID/name columns using the saved mapping before asynchronous processing", async t => {
  const key = `buttonRoutes${Math.random()}`;
  const state = { tasks: [], input: null, mapping: { pid: "商品编号", productName: "", productDocument: "手卡链接", productCardStatus: "" } };
  globalThis[key] = state;
  t.after(() => delete globalThis[key]);
  const stub = url(`const s=globalThis[${JSON.stringify(key)}];
    export const getFeishuFieldMapping=async scope=>{if(scope!=="base12345:tbl12345")throw Error("wrong scope"); return {fieldMap:s.mapping};};
    const channel={rawClient:{request:async()=>({code:0,data:{record:{fields:{商品编号:"1731886355135304543",视频链接:"must-not-analyze"}}}})}};
    export const getConnectedFeishuChannel=()=>channel; export const ensureFeishuConnection=async()=>channel;
    export const resolveAutomationFields=(fields,map)=>({pid:fields[map.pid]||"",productName:fields[map.productName]||""});
    export const hydrateAutomationProductFields=(fields,latest,map)=>({...fields,[map.pid]:latest[map.pid]});
    export const handleFeishuAutomation=async input=>{s.input=input;return {};}; export const updateProductCardStatus=async()=>{};
    export const automationAuth=()=>true; export const payloadFields=()=>({}); export const payloadFieldMap=()=>({}); export const safeBackgroundError=()=>"safe";`);
  const next = url(`export { NextRequest,NextResponse } from ${JSON.stringify(import.meta.resolve("next/server.js"))}; export const after=task=>globalThis[${JSON.stringify(key)}].tasks.push(task);`);
  let code = compile(await source("app/api/feishu/automation/route.ts"));
  for (const match of code.matchAll(/from "(@\/[^\"]+)"/g)) code = code.replaceAll(JSON.stringify(match[1]), JSON.stringify(stub));
  code = code.replaceAll('"next/server"', JSON.stringify(next));
  const route = await import(url(code));
  const { NextRequest } = await import("next/server.js");
  const response = await route.POST(new NextRequest("https://fixture.example/api/feishu/automation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appToken: "base12345", tableId: "tbl12345", recordId: "rec123" }) }));
  assert.equal(response.status, 200);
  assert.equal(state.input, null);
  await state.tasks[0]();
  assert.deepEqual(state.input.fields, { 商品编号: "1731886355135304543" });
  assert.deepEqual(state.input.fieldMap, state.mapping);
});
