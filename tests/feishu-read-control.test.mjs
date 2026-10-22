import assert from "node:assert/strict";
import test from "node:test";
import { readControlUrl } from "./helpers/feishu-read-control.mjs";

const { FeishuReadControl, isFeishuRateLimit } = await import(readControlUrl);
const revision = { method: "GET", url: "https://open.feishu.cn/open-apis/docx/v1/documents/doc-a" };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function clock(t) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  return async ms => { t.mock.timers.tick(ms); await settle(); };
}

test("recognizes numeric/string API codes and HTTP 429 even when Axios supplies its own code", () => {
  for (const error of [{ code: 99991400 }, { code: "99991400" }, { feishuCode: 99991400 },
    { status: 429 }, { response: { status: 429 } },
    { code: "ERR_BAD_REQUEST", response: { status: 400, data: { code: 99991400 } } }]) {
    assert.equal(isFeishuRateLimit(error), true);
  }
  for (const error of [null, "429", { code: 1770003 }, { response: { status: 403 } }, Error("network timeout")]) {
    assert.equal(isFeishuRateLimit(error), false);
  }
});

test("cold-start reads share a paced budget across documents, without serializing response completion", async t => {
  const advance = clock(t), reads = new FeishuReadControl(), calls = [], releases = [];
  const jobs = Array.from({ length: 5 }, (_, i) => reads.run({ ...revision, url: revision.url + i }, () => {
    calls.push(Date.now()); return new Promise(resolve => releases.push(resolve));
  }));
  await settle(); assert.equal(calls.length, 1);
  await advance(499); assert.equal(calls.length, 1);
  for (let i = 0; i < 4; i++) await advance(i === 0 ? 1 : 500);
  assert.deepEqual(calls.map(v => v - calls[0]), [0, 500, 1000, 1500, 2000]);
  releases.forEach(resolve => resolve({ code: 0 }));
  await Promise.all(jobs);
});

test("different apps and metadata/revision/block endpoints have independent budgets", async t => {
  clock(t);
  const reads = new FeishuReadControl(), calls = [];
  await Promise.all([
    { ...revision, headers: { Authorization: "app-a-private-token" } },
    { ...revision, headers: { authorization: "app-b-private-token" } },
    { method: "GET", url: revision.url + "/blocks" },
    { method: "POST", url: "/open-apis/drive/v1/metas/batch_query" },
  ].map(options => reads.run(options, async () => { calls.push(Date.now()); return { code: 0 }; })));
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls).size, 1);
  assert.doesNotMatch(JSON.stringify([...reads.budgets.keys()]), /private-token/);
});

test("HTTP rate limiting shares Retry-After with queued reads, retries once, then fails closed", async t => {
  const advance = clock(t), reads = new FeishuReadControl(), calls = [];
  const error = { code: "ERR_BAD_REQUEST", response: { status: 400, data: { code: 99991400 }, headers: { "retry-after": "3" } } };
  const first = reads.run(revision, async () => { calls.push(Date.now()); throw error; });
  const rejected = assert.rejects(first, value => value === error);
  await settle();
  let secondCalls = 0;
  const second = reads.run(revision, async () => { secondCalls++; return { code: 0 }; });
  await advance(2999); assert.equal(calls.length, 1); assert.equal(secondCalls, 0);
  await advance(1); await rejected;
  assert.equal(calls.length, 2, "only one retry is allowed");
  await advance(3000); await second;
  assert.equal(secondCalls, 1, "the last rejection also extends the shared cooldown");
});

test("a code-only rate-limit response is retried after a bounded cooldown", async t => {
  const advance = clock(t), reads = new FeishuReadControl(); let calls = 0;
  const job = reads.run(revision, async () => ++calls === 1 ? { code: 99991400 } : { code: 0 });
  await settle(); assert.equal(calls, 1);
  await advance(2000); assert.deepEqual(await job, { code: 0 });
  assert.equal(calls, 2);
});

test("abort while queued removes the wait without sending a late request", async t => {
  const advance = clock(t), reads = new FeishuReadControl(), controller = new AbortController();
  await reads.run(revision, async () => ({ code: 0 }));
  let calls = 0;
  const stopped = reads.run({ ...revision, signal: controller.signal }, async () => { calls++; return {}; });
  const rejected = assert.rejects(stopped, /stopped/);
  controller.abort(Error("stopped")); await rejected;
  await advance(10000); assert.equal(calls, 0);
});

test("deadline cancellation during cooldown prevents a second network request", async t => {
  const advance = clock(t), reads = new FeishuReadControl(), controller = new AbortController(); let calls = 0;
  const job = reads.run({ ...revision, signal: controller.signal }, async () => { calls++; throw { status: 429 }; });
  const rejected = assert.rejects(job, /deadline/);
  await settle(); controller.abort(Error("deadline")); await rejected;
  await advance(20000); assert.equal(calls, 1);
});

test("writes, uploads, unrelated GETs, permission failures and network errors are not retried", async t => {
  clock(t);
  const reads = new FeishuReadControl();
  for (const options of [{ ...revision, method: "PATCH" }, { ...revision, method: "POST" },
    { method: "POST", url: "/open-apis/drive/v1/medias/upload_all" },
    { method: "GET", url: "/open-apis/bitable/v1/apps/app/tables/table/records" }]) {
    let calls = 0;
    await assert.rejects(reads.run(options, async () => { calls++; throw { status: 429 }; }));
    assert.equal(calls, 1);
  }
  for (const error of [{ status: 403 }, Error("network failure")]) {
    let calls = 0;
    await assert.rejects(new FeishuReadControl().run(revision, async () => { calls++; throw error; }));
    assert.equal(calls, 1);
  }
});

test("Retry-After HTTP dates are honored and malformed or extreme headers stay bounded", async t => {
  const advance = clock(t);
  for (const [header, expected] of [
    [new Date(Date.now() + 5000).toUTCString(), 5000], ["invalid", 2000], ["-999", 2000], ["999999999", 60000],
  ]) {
    const reads = new FeishuReadControl(); let calls = 0;
    const job = reads.run(revision, async () => {
      if (++calls === 1) throw { response: { status: 429, headers: { "retry-after": header } } };
      return { code: 0 };
    });
    await settle(); await advance(expected - 1); assert.equal(calls, 1);
    await advance(1); await job; assert.equal(calls, 2);
  }
});

test("new credentials prune idle budget keys instead of retaining historical token fingerprints forever", async t => {
  const advance = clock(t), reads = new FeishuReadControl();
  await reads.run({ ...revision, headers: { Authorization: "old-private-token" } }, async () => ({}));
  await advance(61000);
  await reads.run({ ...revision, headers: { Authorization: "new-private-token" } }, async () => ({}));
  assert.equal(reads.budgets.size, 1);
  assert.doesNotMatch(JSON.stringify([...reads.budgets.keys()]), /private-token/);
});
