import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

const source = await readFile(new URL("../lib/admin-auth.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('import "server-only";', "");
const auth = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("Feishu machine routes keep their existing authentication; admin and server actions never bypass login", () => {
  for (const route of ["/api/feishu/automation", "/api/feishu/product-doc-sync", "/feishu/subtitle", "/feishu/tokscript-subtitle", "/feishu/link-subtitle"]) {
    assert.equal(auth.publicMachineRoute(route, "POST"), true);
    assert.equal(auth.publicMachineRoute(route, "POST", true), false);
    assert.equal(auth.publicMachineRoute(route + "/extra", "POST"), false);
  }
  for (const route of ["/admin/providers", "/api/settings", "/api/feishu/settings", "/api/products/ensure-document"]) {
    assert.equal(auth.publicMachineRoute(route, "GET"), false);
    assert.equal(auth.publicMachineRoute(route, "POST"), false);
  }
  assert.equal(auth.publicMachineRoute("/api/media/video/original.mp4", "GET"), true);
  assert.equal(auth.publicMachineRoute("/api/media/video/original.mp4", "POST"), false);
  assert.equal(auth.publicMachineRoute("/_next/static/chunk.js", "POST", true), false);
});

test("missing credentials fail closed; hashed login, password rotation and per-client failure limit work", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "admin-auth-test-"));
  await mkdir(path.join(directory, ".data"));
  const file = path.join(directory, ".data/admin-auth.json");
  const auth = await import(`data:text/javascript;base64,${Buffer.from(compiled.replace('process.cwd()', JSON.stringify(directory))).toString("base64")}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const header = password => "Basic " + Buffer.from("test-admin:" + password).toString("base64");
  assert.equal(await auth.checkAdminAuthorization(null), "unconfigured");
  const salt = randomBytes(16).toString("hex");
  const setPassword = password => writeFile(file, JSON.stringify({ username: "test-admin", salt, passwordHash: scryptSync(password, salt, 64).toString("hex") }), { mode: 0o600 });
  await setPassword("isolated-fixture-password");
  assert.equal(await auth.checkAdminAuthorization(null), "unauthorized");
  assert.equal(await auth.checkAdminAuthorization(header("wrong"), "wrong-client"), "unauthorized");
  assert.equal(await auth.checkAdminAuthorization(header("isolated-fixture-password"), "valid-client"), "ok");
  assert.equal(await auth.checkAdminAuthorization(header("isolated-fixture-password"), "valid-client"), "ok");
  await setPassword("changed-fixture-password");
  assert.equal(await auth.checkAdminAuthorization(header("isolated-fixture-password"), "valid-client"), "unauthorized");
  assert.equal(await auth.checkAdminAuthorization(header("changed-fixture-password"), "valid-client"), "ok");
  const wrongUser = "Basic " + Buffer.from("other-user:wrong").toString("base64");
  for (let n = 0; n < 10; n++) assert.equal(await auth.checkAdminAuthorization(wrongUser, "throttled-client"), "unauthorized");
  assert.equal(await auth.checkAdminAuthorization(wrongUser, "throttled-client"), "busy");
  assert.equal(await auth.checkAdminAuthorization(header("changed-fixture-password"), "different-client"), "ok");
});

test("the actual Next proxy rejects plaintext credentials, unauthenticated APIs and cross-site mutations", async t => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; });
  const url = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const authUrl = url(compiled);
  const stub = url(`export { publicMachineRoute } from ${JSON.stringify(authUrl)}; export const checkAdminAuthorization = async header => header === "Basic fixture" ? "ok" : "unauthorized";`);
  const source = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replaceAll('"@/lib/admin-auth"', JSON.stringify(stub)).replaceAll('"next/server"', JSON.stringify(import.meta.resolve("next/server.js")));
  const { proxy } = await import(url(code));
  const { NextRequest } = await import("next/server.js");
  assert.equal((await proxy(new NextRequest("http://localhost/admin/providers"))).status, 426);
  const noAuth = await proxy(new NextRequest("https://example.test/api/settings"));
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get("www-authenticate"), /Basic/);
  assert.equal((await proxy(new NextRequest("https://example.test/api/settings", { headers: { authorization: "Basic fixture" } }))).status, 200);
  assert.equal((await proxy(new NextRequest("https://example.test/api/settings", { method: "PUT", headers: { authorization: "Basic fixture", origin: "https://attacker.example", host: "example.test" } }))).status, 403);
  assert.equal((await proxy(new NextRequest("http://localhost/api/feishu/automation", { method: "POST" }))).status, 200);
  assert.equal((await proxy(new NextRequest("https://example.test/api/feishu/automation", { method: "POST", headers: { "next-action": "not-public" } }))).status, 401);
});

test("all three subtitle machine endpoints reject missing/wrong secrets and still accept the existing secret scheme", async t => {
  const before = process.env.FEISHU_SUBTITLE_BRIDGE_SECRET;
  t.after(() => { if (before === undefined) delete process.env.FEISHU_SUBTITLE_BRIDGE_SECRET; else process.env.FEISHU_SUBTITLE_BRIDGE_SECRET = before; });
  const url = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('import "server-only";', "");
  const shared = url(compile(await readFile(new URL("../lib/feishu/webhook-shared.ts", import.meta.url), "utf8")));
  const business = url('export const runSubtitleBridgeAudioSubtitle = () => { throw Error("BUSINESS_CALL_FORBIDDEN"); }; export const runSubtitleBridgeLinkSubtitle = runSubtitleBridgeAudioSubtitle; export const runSubtitleBridgeTokScriptTimestamps = runSubtitleBridgeAudioSubtitle;');
  const { NextRequest } = await import("next/server.js");
  for (const name of ["subtitle", "tokscript-subtitle", "link-subtitle"]) {
    const code = compile(await readFile(new URL(`../app/feishu/${name}/route.ts`, import.meta.url), "utf8"))
      .replaceAll('"@/lib/feishu/webhook-shared"', JSON.stringify(shared))
      .replaceAll('"@/lib/feishu/automation"', JSON.stringify(business))
      .replaceAll('"next/server"', JSON.stringify(import.meta.resolve("next/server.js")));
    const route = await import(url(code));
    const request = secret => new NextRequest(`https://fixture.example/feishu/${name}`, { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-subtitle-secret": secret } : {}) }, body: "{}" });
    delete process.env.FEISHU_SUBTITLE_BRIDGE_SECRET;
    assert.equal((await route.POST(request())).status, 503);
    process.env.FEISHU_SUBTITLE_BRIDGE_SECRET = "isolated-fixture";
    assert.equal((await route.POST(request("wrong"))).status, 401);
    assert.equal((await route.POST(request("isolated-fixture"))).status, 400, "authorized request reaches body validation, but never paid business work");
  }
});
