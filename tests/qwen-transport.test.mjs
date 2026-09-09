import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { Agent, fetch } from "undici";
import ts from "typescript";

const source = await readFile(new URL("../lib/providers/qwen-transport.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace('import "server-only";', "")
  .replace('"undici"', JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("undici")).href));
// Expose teardown only in the test module, not in the application's API.
const transport = await import(`data:text/javascript;base64,${Buffer.from(`${compiled}\nexport const close = () => dispatcher.close();`).toString("base64")}`);
after(() => transport.close());

async function endpoint(t, handler) {
  const timers = [];
  const server = createServer((req, res) => {
    req.resume();
    handler(res, (fn, ms) => timers.push(setTimeout(fn, ms)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    timers.forEach(clearTimeout);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
}

test("Qwen removes the hidden header/body ceiling without altering global fetch", async (t) => {
  assert.match(source, /new Agent\(\{ headersTimeout: 0, bodyTimeout: 0 \}\)/);
  assert.doesNotMatch(source, /setGlobalDispatcher|RetryAgent/);
  const globalFetch = globalThis.fetch;
  const fast = new Agent({ headersTimeout: 30, bodyTimeout: 30 });
  t.after(() => fast.close());
  // Undici's parser uses coarse ~500 ms ticks even with a tiny configured
  // ceiling. Leave enough headroom to exercise the real timer, not a race.
  const headers = await endpoint(t, (res, later) => later(() => res.end("headers arrived"), 1500));
  await assert.rejects(fetch(headers, { dispatcher: fast }), error => error.cause?.code === "UND_ERR_HEADERS_TIMEOUT");
  const response = await transport.fetchQwen(headers, { signal: AbortSignal.timeout(5000) });
  assert.equal(await response.text(), "headers arrived");

  const body = await endpoint(t, (res, later) => {
    res.write("first ");
    later(() => res.end("last"), 1500);
  });
  const shortResponse = await fetch(body, { dispatcher: fast });
  await assert.rejects(shortResponse.text(), error => error.cause?.code === "UND_ERR_BODY_TIMEOUT");
  const fullResponse = await transport.fetchQwen(body, { signal: AbortSignal.timeout(5000) });
  assert.equal(await fullResponse.text(), "first last");
  assert.equal(globalThis.fetch, globalFetch);
});

for (const phase of ["headers", "body"]) {
  test(`the caller deadline really aborts a stalled ${phase} over HTTP`, async (t) => {
    let requests = 0;
    const url = await endpoint(t, res => {
      requests += 1;
      if (phase === "body") res.write("data: ");
    });
    const signal = AbortSignal.timeout(150);
    await assert.rejects(async () => {
      const response = await transport.fetchQwen(url, { signal });
      await response.text();
    }, error => error.name === "TimeoutError");
    assert.equal(requests, 1, "transport must never replay the paid request");
    assert.equal(signal.aborted, true);
  });
}

test("an explicit stop cancels a streaming body", async (t) => {
  const url = await endpoint(t, res => res.write("data: "));
  const controller = new AbortController();
  const response = await transport.fetchQwen(url, { signal: controller.signal });
  const body = response.text();
  const stopped = new Error("user stopped");
  controller.abort(stopped);
  await assert.rejects(body, error => error === stopped);
});
