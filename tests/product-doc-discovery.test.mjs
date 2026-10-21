import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/feishu/product-doc-discovery.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { ProductDocumentDiscovery } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const result = () => ({ found: 1, queued: 0, completed: 1, failed: 0 });
const targets = n => Array.from({ length: n }, (_, i) => ({ id: `p-${i}`, pid: `pid-${i}`, name: "fixture", documentId: `doc-${i}`, documentUrl: "", cachedRevision: 7 }));
const gate = () => { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function metadataHarness(docs) {
  const versions = new Map(docs.map(d => [d.documentId, "100"]));
  const requests = [];
  return { versions, requests, client: { request: async ({ url, method, data }) => {
    assert.equal(url, "/open-apis/drive/v1/metas/batch_query");
    assert.equal(method, "POST");
    requests.push(data.request_docs.length);
    return { code: 0, data: { metas: data.request_docs.filter(d => versions.has(d.doc_token))
      .map(d => ({ doc_token: d.doc_token, latest_modify_time: versions.get(d.doc_token) })) } };
  } } };
}

test("checks all 455 cards in three requests and detects an edit to the last card on the next poll", async () => {
  const docs = targets(455), h = metadataHarness(docs), worker = new ProductDocumentDiscovery();
  const scans = []; let active = 0, maxActive = 0;
  const scan = async target => { active++; maxActive = Math.max(maxActive, active); await tick(); scans.push(target.documentId); active--; return result(); };
  assert.equal((await worker.poll(h.client, docs, scan)).documents, 455);
  assert.deepEqual(h.requests, [200, 200, 55]);
  assert.equal(maxActive, 4);
  scans.length = 0;
  assert.equal((await worker.poll(h.client, docs, scan)).documents, 0);
  h.versions.set("doc-454", "101");
  assert.equal((await worker.poll(h.client, docs, scan)).documents, 1);
  assert.deepEqual(scans, ["doc-454"]);
  assert.deepEqual(h.requests, [200, 200, 55, 200, 200, 55, 200, 200, 55]);
});

test("a slow cold-start scan cannot block metadata polling and a newly edited card jumps the backlog", async () => {
  const docs = targets(10), h = metadataHarness(docs), worker = new ProductDocumentDiscovery();
  const gates = Array.from({ length: 4 }, gate), starts = [];
  const scan = async target => { starts.push(target.documentId); const i = Number(target.documentId.slice(4)); if (i < 4) await gates[i].promise; return result(); };
  await worker.poll(h.client, docs, scan, true);
  assert.equal(starts.length, 4);
  h.versions.set("doc-9", "102");
  await worker.poll(h.client, docs, scan, true);
  assert.equal(h.requests.length, 2, "the second poll finishes while the initial scans remain blocked");
  gates[0].release();
  await tick();
  assert.equal(starts[4], "doc-9");
  for (const item of gates) item.release();
  await worker.poll(h.client, docs, scan);
  assert.equal(starts.length, 10, "one card must not get duplicate queued scans");
});

test("an edit observed during an in-flight scan causes exactly one fresh scan before acknowledgement", async () => {
  const docs = targets(1), h = metadataHarness(docs), worker = new ProductDocumentDiscovery(), first = gate();
  let calls = 0;
  const scan = async () => { calls++; if (calls === 1) await first.promise; return result(); };
  await worker.poll(h.client, docs, scan, true);
  h.versions.set("doc-0", "101");
  const next = worker.poll(h.client, docs, scan);
  await tick(); first.release(); await next;
  assert.equal(calls, 2);
  await worker.poll(h.client, docs, scan);
  assert.equal(calls, 2);
});

test("missing metadata falls back safely and cached -1 keeps a failed delivery retryable", async () => {
  const docs = targets(2), h = metadataHarness(docs), worker = new ProductDocumentDiscovery(), scans = [];
  h.versions.delete("doc-1");
  const scan = async d => { scans.push(d.documentId); return result(); };
  await worker.poll(h.client, docs, scan);
  assert.equal(scans.length, 2);
  docs[0].cachedRevision = -1;
  await worker.poll(h.client, docs, scan);
  assert.deepEqual(scans, ["doc-0", "doc-1", "doc-0"]);
  h.versions.set("doc-1", "103");
  docs[0].cachedRevision = 8;
  await worker.poll(h.client, docs, scan);
  assert.equal(scans.at(-1), "doc-1");
});

test("same-second edits are revision-audited during the settling window", async () => {
  const docs = targets(1), h = metadataHarness(docs), worker = new ProductDocumentDiscovery();
  h.versions.set("doc-0", String(Math.floor(Date.now() / 1000)));
  let scans = 0;
  const scan = async () => { scans++; return result(); };
  await worker.poll(h.client, docs, scan);
  await worker.poll(h.client, docs, scan);
  assert.equal(scans, 2);
});

test("a failed scan is not acknowledged and a change of product ownership invalidates the watermark", async () => {
  const docs = targets(1), h = metadataHarness(docs), worker = new ProductDocumentDiscovery();
  let scans = 0;
  const scan = async () => { scans++; if (scans === 1) throw Error("fixture failure"); return result(); };
  assert.equal((await worker.poll(h.client, docs, scan)).failed, 1);
  await worker.poll(h.client, docs, scan);
  assert.equal(scans, 2);
  docs[0].id = "replacement-product";
  await worker.poll(h.client, docs, scan);
  assert.equal(scans, 3);
});
