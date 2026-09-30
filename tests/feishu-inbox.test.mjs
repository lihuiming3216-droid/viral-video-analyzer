import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const dataUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('import "server-only";', "");
const source = compile(await readFile(new URL("../lib/feishu/inbox.ts", import.meta.url), "utf8"));
const input = (kind = "video") => ({ kind, credentialSource: "primary", appToken: "app", tableId: "table", recordId: "row",
  fields: { PID: "123", 产品名称: "商品", 视频链接: "https://www.tiktok.com/t/sample/" }, fieldMap: { videoUrl: "视频链接" } });

async function fixture(t, payload = input(), state = "pending") {
  const key = `inbox${Math.random()}`, tasks = new Map([["receipt", { id: "receipt", kind: payload.kind, input_cipher: JSON.stringify(payload), state }]]);
  const receipts = new Map([["receipt", { state: "accepted" }]]), videos = [], bindings = [], events = [];
  let snapshot;
  const hooks = {
    decryptSecret: text => text, safeBackgroundError: () => "处理失败，请核查后台记录",
    getConnectedFeishuChannel: () => ({ rawClient: {} }), getChatgptFeishuClient: () => ({}),
    getBaseRecordFields: async () => payload.fields,
    resolveAutomationFields: fields => ({ pid: fields.PID, productName: fields.产品名称, videoUrl: fields.视频链接, map: { videoUrl: "视频链接" } }),
    hydrateAutomationProductFields: (old, current) => ({ ...old, ...current }),
    assertDeliverySource: (expected, current) => { assert.equal(current, expected); },
    findOrCreateProduct: async () => ({ id: "product" }),
    createVideo: async (_input, options) => { assert.equal(options.connection, connection); videos.push(options.id); events.push("video"); },
    saveFeishuAutomationJob: async (job, db) => { assert.equal(db, connection); bindings.push(job); events.push("binding"); },
    enqueueVideos: async ids => { events.push("enqueue"); assert.equal(tasks.get("receipt").state, "completed"); assert.deepEqual(ids, videos); },
    handleFeishuAutomation: async () => { events.push("handcard"); return {}; },
  };
  const connection = {
    on: () => {}, removeListener: () => {},
    beginTransaction: async () => { snapshot = { tasks: structuredClone(tasks), receipts: structuredClone(receipts), videos: [...videos], bindings: [...bindings] }; events.push("begin"); },
    commit: async () => { events.push("commit"); if (hooks.commitLost) { hooks.commitLost = false; snapshot = null; throw Error("commit acknowledgement lost"); } },
    rollback: async () => {
      if (snapshot) { tasks.clear(); receipts.clear(); for (const [k,v] of snapshot.tasks) tasks.set(k,v); for (const [k,v] of snapshot.receipts) receipts.set(k,v); videos.splice(0,Infinity,...snapshot.videos); bindings.splice(0,Infinity,...snapshot.bindings); }
      events.push("rollback");
    },
    release: () => events.push("release"), destroy: () => events.push("destroy"),
    query: async () => [[{ name: "isolated_test" }]],
    execute: async (sql, args = []) => {
      if (/GET_LOCK/.test(sql)) return [[{ acquired: 1 }]];
      if (/RELEASE_LOCK/.test(sql)) return [[{ released: 1 }]];
      if (sql.startsWith("SELECT state,video_id")) return [[tasks.get(args[0])].filter(Boolean)];
      if (sql.startsWith("SELECT id,kind")) return [[...tasks.values()].filter(row => row.kind === args[0] && ["pending","running"].includes(row.state)).map(row => ({...row}))];
      if (sql.startsWith("UPDATE feishu_request_receipts")) {
        const completed = sql.includes("state='completed'"); const id = args.at(-1); const row = receipts.get(id);
        if (row.state === "accepted") row.state = completed ? "completed" : args[0];
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("UPDATE feishu_inbox_tasks")) {
        const row = tasks.get(args.at(-1));
        if (sql.includes("state='completed'")) { row.state = "completed"; row.video_id = args[0]; }
        else if (sql.includes("SET state='running'")) { if (row.state !== "pending") return [{affectedRows:0}]; row.state = "running"; }
        else { if (!["pending","running"].includes(row.state)) return [{affectedRows:0}]; row.state = args[0]; row.error_message = args[1]; }
        return [{ affectedRows: 1 }];
      }
      throw Error(`unexpected SQL: ${sql}`);
    },
  };
  hooks.getPool = async () => ({ getConnection: async () => connection });
  globalThis[key] = hooks;
  t.after(() => { delete globalThis[key]; });
  let code = source.replace("const worker = globalThis;", "const worker = {};");
  for (const [, names, module] of [...code.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(@\/lib\/[^\"]+)"/g)]) {
    const stub = names.split(",").map(name => name.trim()).filter(Boolean).map(name => `export const ${name}=(...args)=>globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}](...args);`).join("\n");
    code = code.replaceAll(JSON.stringify(module), JSON.stringify(dataUrl(stub)));
  }
  return { api: await import(dataUrl(code)), tasks, receipts, videos, bindings, events, hooks, connection };
}

test("a saved video resumes without its HTTP callback and commits its target before waking analysis", async t => {
  const f = await fixture(t);
  await f.api.runFeishuInboxKind("video");
  assert.equal(f.videos.length, 1); assert.equal(f.bindings[0].recordId, "row");
  assert.equal(f.tasks.get("receipt").state, "completed"); assert.equal(f.receipts.get("receipt").state, "completed");
  assert.ok(f.events.indexOf("binding") < f.events.indexOf("commit"));
  assert.ok(f.events.indexOf("commit") < f.events.indexOf("enqueue"));
  await f.api.runFeishuInboxKind("video");
  await f.api.materializeInboxVideo(f.connection, "receipt", input());
  assert.equal(f.videos.length, 1, "a stale worker snapshot also cannot materialize the same task twice");
});

test("binding failure rolls back the video and preserves the recoverable input and safe error", async t => {
  const f = await fixture(t);
  f.hooks.saveFeishuAutomationJob = async () => { throw Error("database failure secret=hidden"); };
  await f.api.runFeishuInboxKind("video");
  assert.deepEqual(f.videos, []); assert.deepEqual(f.bindings, []);
  assert.equal(f.tasks.get("receipt").state, "failed");
  assert.equal(f.tasks.get("receipt").input_cipher, JSON.stringify(input()));
  assert.doesNotMatch(f.tasks.get("receipt").error_message, /secret|hidden/);
  assert.ok(!f.events.includes("enqueue"));
});

test("lost commit acknowledgement or failed wakeup never reclassifies a committed task", async t => {
  for (const failure of ["commit", "enqueue"]) {
    const f = await fixture(t);
    if (failure === "commit") f.hooks.commitLost = true;
    else f.hooks.enqueueVideos = async () => { throw Error("wake-up failed"); };
    await f.api.runFeishuInboxKind("video");
    assert.equal(f.tasks.get("receipt").state, "completed", failure);
    assert.equal(f.receipts.get("receipt").state, "completed", failure);
    assert.equal(f.videos.length, 1);
    await f.api.runFeishuInboxKind("video");
    assert.equal(f.videos.length, 1);
  }
});

test("a changed row is rejected before creating a video or invoking a provider", async t => {
  for (const change of [{PID:"new-pid"}, {视频链接:"https://www.tiktok.com/t/changed/"}]) {
    const f = await fixture(t);
    f.hooks.getBaseRecordFields = async () => ({...input().fields,...change});
    await f.api.runFeishuInboxKind("video");
    assert.deepEqual(f.videos, []); assert.equal(f.tasks.get("receipt").state, "failed");
  }
});

test("unstarted handcards recover once; an interrupted handcard is paused without repeating a paid call", async t => {
  for (const state of ["pending","running"]) {
    const f = await fixture(t, input("handcard"), state);
    await f.api.runFeishuInboxKind("handcard");
    assert.equal(f.events.filter(e=>e==="handcard").length, state === "pending" ? 1 : 0);
    assert.equal(f.tasks.get("receipt").state, state === "pending" ? "completed" : "paused");
    await f.api.runFeishuInboxKind("handcard");
    assert.equal(f.events.filter(e=>e==="handcard").length, state === "pending" ? 1 : 0);
  }
});
