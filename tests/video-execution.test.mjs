import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const dataUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const source = ts.transpileModule(await readFile(new URL("../lib/video-execution.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace('import "server-only";', "");
async function fixture(t) {
  const key = `execution${Math.random()}`, locks = new Map(), connections = [], videos = new Map();
  const hooks = {};
  globalThis[key] = { getConnection: async () => {
    const connection = new EventEmitter(); connections.push(connection);
    const id = connections.length;
    connection.destroy = () => { connection.destroyed = true; for (const [name, owner] of locks) if (owner === id) locks.delete(name); };
    connection.release = () => { connection.released = true; };
    connection.query = async (statement, args = []) => {
      const sql = statement.sql;
      if (sql.includes("DATABASE()")) return [[{name: "test"}]];
      if (sql.includes("GET_LOCK")) {
        if (locks.has(args[0])) return [[{acquired:0}]];
        locks.set(args[0],id);
        if (hooks.failAcquire) throw Error("acknowledgement lost");
        return [[{acquired:1}]];
      }
      if (sql.includes("RELEASE_LOCK")) {
        assert.equal(locks.get(args[0]),id); locks.delete(args[0]); return [[{released:1}]];
      }
      if (sql.includes("IS_USED_LOCK")) return [[{task_owned:Number(locks.get(args[0])===id),slot_owned:Number(locks.get(args[1])===id)}]];
      if (sql.includes("FROM videos")) return [[videos.get(args[0]) || {status:"queued",processing_started_at:null}]];
      throw Error(`unexpected query ${sql}`);
    };
    return connection;
  }};
  t.after(()=>{ for (const connection of connections) connection.destroy(); delete globalThis[key]; });
  const pool = dataUrl(`export const getPool=async()=>globalThis[${JSON.stringify(key)}];`);
  const api = await import(dataUrl(source.replaceAll('"@/lib/db/pool"',JSON.stringify(pool))));
  return { api, locks, connections, videos, hooks };
}

test("separate worker connections share two global slots and one owner for each video", async t => {
  const f = await fixture(t);
  const one = await f.api.tryAcquireVideoExecution("one",new AbortController());
  const two = await f.api.tryAcquireVideoExecution("two",new AbortController());
  assert.ok(one && two);
  assert.equal(await f.api.tryAcquireVideoExecution("one",new AbortController()),null);
  assert.equal(await f.api.tryAcquireVideoExecution("three",new AbortController()),null);
  assert.equal(f.locks.size,4);
  await one.release();
  const three = await f.api.tryAcquireVideoExecution("three",new AbortController());
  assert.ok(three);
  await two.release(); await three.release();
  assert.equal(f.locks.size,0);
  assert.ok(f.connections.every(c=>c.released));
});

test("an orphan can be examined while both paid execution slots are busy", async t => {
  const f = await fixture(t);
  const one = await f.api.tryAcquireVideoExecution("one",new AbortController());
  const two = await f.api.tryAcquireVideoExecution("two",new AbortController());
  f.videos.set("orphan",{status:"analyzing",processing_started_at:"previous-process"});
  const orphan = await f.api.tryAcquireVideoExecution("orphan",new AbortController());
  assert.ok(orphan); assert.equal(f.locks.size,5);
  await orphan.release(); await one.release(); await two.release();
});

test("connection loss aborts its worker and cannot return an uncertain session to the pool", async t => {
  const f = await fixture(t), controller = new AbortController();
  const lease = await f.api.tryAcquireVideoExecution("one",controller);
  f.connections[0].emit("error",Error("network lost"));
  assert.equal(controller.signal.aborted,true); assert.equal(lease.valid(),false);
  assert.equal(f.locks.size,0);
  await lease.release();
  assert.equal(f.connections[0].released,undefined); assert.equal(f.connections[0].destroyed,true);
});

test("an ambiguous GET_LOCK failure destroys its session even if the lock was actually acquired", async t => {
  const f = await fixture(t); f.hooks.failAcquire = true;
  await assert.rejects(f.api.tryAcquireVideoExecution("one",new AbortController()),/acknowledgement lost/);
  assert.equal(f.locks.size,0); assert.equal(f.connections[0].destroyed,true); assert.equal(f.connections[0].released,undefined);
});
