import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/tiktok-video-download.ts", import.meta.url), "utf8");
const canonical = "https://www.tiktok.com/@demo/video/7681775718816173326";
const playback = "https://v16.tiktok.com/video.mp4?token=private-signature";
const metadata = { duration: 20.33, width: 1280, height: 720, videoCodec: "h264", audioCodec: "aac" };
const dataUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tiktok-download-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], stages = [];
  const resolve = relative => {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(root + path.sep)) throw new Error("invalid test path");
    return absolute;
  };
  const put = async (id, bytes = "fixture bytes") => {
    const relative = path.join(id, "original.mp4");
    await mkdir(path.dirname(resolve(relative)), { recursive: true });
    await writeFile(resolve(relative), bytes);
    return relative;
  };
  const hooks = {
    resolveMediaPath: resolve,
    validateDownloadedVideoFile: async () => metadata,
    resolveTokScriptVideoUrl: async () => { calls.push("resolve"); return canonical; },
    downloadTikTokVideoWithYtDlp: async () => { calls.push("yt-dlp"); throw new Error("Unexpected response from webpage request https://private.invalid/?token=SECRET"); },
    fetchWithProxy: async (url, init) => {
      const parsed = new URL(url);
      calls.push({ url: parsed.toString(), init });
      if (parsed.pathname.includes("/video/")) return page();
      return media();
    },
    ...options.hooks,
  };
  globalThis.__tiktokDownloadTestHooks = hooks;
  const stub = dataUrl(`
    const h = () => globalThis.__tiktokDownloadTestHooks;
    export const resolveMediaPath = (...a) => h().resolveMediaPath(...a);
    export const validateDownloadedVideoFile = (...a) => h().validateDownloadedVideoFile(...a);
    export const resolveTokScriptVideoUrl = (...a) => h().resolveTokScriptVideoUrl(...a);
    export const downloadTikTokVideoWithYtDlp = (...a) => h().downloadTikTokVideoWithYtDlp(...a);
    export const fetchWithProxy = (...a) => h().fetchWithProxy(...a);
  `);
  let compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  compiled = compiled.replace('import "server-only";', "").replaceAll(/"@\/lib\/[^\"]+"/g, JSON.stringify(stub));
  if (options.shortTimeout) compiled = compiled.replace("AbortSignal.timeout(90_000)", "AbortSignal.timeout(30)").replace("AbortSignal.timeout(90000)", "AbortSignal.timeout(30)");
  if (options.smallVideoLimit) compiled = compiled.replace("const VIDEO_LIMIT = 600 * 1024 * 1024;", "const VIDEO_LIMIT = 16;");
  const downloader = await import(dataUrl(`${compiled}\n// ${Math.random()}`));
  const run = extra => downloader.downloadTikTokVideoWithFallback({
    videoId: "task", sourceUrl: canonical, beforeSource: async name => { stages.push(name); }, ...extra,
  });
  return { root, resolve, put, calls, hooks, stages, run };
}

function page(overrides = {}, detailOverrides = {}) {
  const item = { id: "7681775718816173326", author: { uniqueId: "demo" }, video: { playAddr: playback, duration: 20 }, ...overrides };
  return new Response(`<html><script type='application/json' id='__UNIVERSAL_DATA_FOR_REHYDRATION__'>${JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct: item }, ...detailOverrides } } })}</script></html>`, {
    headers: { "content-type": "text/html", "set-cookie": "guest=ephemeral; Secure; HttpOnly" },
  });
}

function media(body = "fixture bytes", headers = {}) {
  return new Response(body, { headers: { "content-type": "video/mp4", "content-length": String(Buffer.byteLength(body)), ...headers } });
}

async function emptyTask(f) {
  assert.deepEqual(await readdir(f.resolve("task")), []);
}

test("primary success avoids every fallback and never overwrites a prior original", async t => {
  const f = await fixture(t);
  await f.put("task", "previous original");
  const result = await f.run({ primaryDownload: id => f.put(id) });
  assert.equal(result.source, "TokScript");
  assert.deepEqual(result.failures, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.stages, ["TokScript"]);
  assert.equal(await readFile(f.resolve("task/original.mp4"), "utf8"), "previous original");
  assert.match(result.relativePath, /^task\/download-[^/]+\/0\/original.mp4$/);
});

test("an expired primary URL falls through to yt-dlp and cleans only its failed candidate", async t => {
  const f = await fixture(t);
  f.hooks.downloadTikTokVideoWithYtDlp = id => f.put(id);
  let failedPath;
  const result = await f.run({ primaryDownload: async id => { failedPath = await f.put(id, "partial"); throw new Error("视频下载失败（403）"); } });
  assert.equal(result.source, "yt-dlp");
  assert.deepEqual(result.failures, ["TokScript：下载失败（HTTP 403）"]);
  await assert.rejects(access(f.resolve(failedPath)));
  assert.deepEqual(f.stages, ["TokScript", "yt-dlp"]);
});

test("missing primary URL and failed yt-dlp use one webpage attempt and preserve guest headers", async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.source, "网页");
  assert.deepEqual(f.stages, ["yt-dlp", "网页"]);
  const requests = f.calls.filter(value => typeof value === "object");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://www.tiktok.com/@i/video/7681775718816173326");
  assert.equal(requests[1].init.headers.Cookie, "guest=ephemeral");
  assert.equal(requests[1].init.headers.Referer, "https://www.tiktok.com/");
  assert.equal(await readFile(f.resolve(result.relativePath), "utf8"), "fixture bytes");
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private-signature|ephemeral|https:/);
});

test("a primary file missing its audio track is not accepted as complete", async t => {
  const f = await fixture(t, { hooks: { validateDownloadedVideoFile: async (_file, _signal, options) => options?.decode === false ? { ...metadata, audioCodec: "" } : metadata } });
  const result = await f.run({ primaryDownload: id => f.put(id) });
  assert.equal(result.source, "网页");
  assert.match(result.failures[0], /缺少音频轨/);
});

test("when all audio sources fail, keep the video-only file for delivery without inventing an audio track", async t => {
  const f = await fixture(t, { hooks: {
    validateDownloadedVideoFile: async () => ({ ...metadata, audioCodec: "" }),
    fetchWithProxy: async () => new Response("unavailable", { status: 503 }),
  } });
  const result = await f.run({ primaryDownload: id => f.put(id, "video-only original") });
  assert.equal(result.source, "TokScript");
  assert.equal(await readFile(f.resolve(result.relativePath), "utf8"), "video-only original");
  assert.ok(result.failures.some(reason => reason.includes("缺少音频轨")));
  assert.deepEqual(f.stages, ["TokScript", "yt-dlp", "网页"]);
});

test("transcript-only tasks do not fetch extra sources merely because their video has no audio track", async t => {
  const f = await fixture(t, { hooks: { validateDownloadedVideoFile: async () => ({ ...metadata, audioCodec: "" }) } });
  const result = await f.run({ requireAudio: false, primaryDownload: id => f.put(id) });
  assert.equal(result.source, "TokScript");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(result.failures, []);
});

test("the official short link is resolved only once for both fallback candidates", async t => {
  const f = await fixture(t);
  const result = await f.run({ sourceUrl: "https://www.tiktok.com/t/ZP8c3ALoT/" });
  assert.equal(result.source, "网页");
  assert.equal(f.calls.filter(value => value === "resolve").length, 1);
});

test("an ordinary short-link resolver failure still lets yt-dlp try the original official link", async t => {
  const f = await fixture(t, { hooks: { resolveTokScriptVideoUrl: async () => { throw new Error("temporary resolution failure"); } } });
  const short = "https://www.tiktok.com/t/ZP8c3ALoT/";
  f.hooks.downloadTikTokVideoWithYtDlp = async (id, url) => { assert.equal(url, short); return f.put(id); };
  assert.equal((await f.run({ sourceUrl: short })).source, "yt-dlp");
});

test("cancelling short-link resolution cannot be swallowed into a yt-dlp request", async t => {
  const controller = new AbortController();
  const f = await fixture(t, { hooks: { resolveTokScriptVideoUrl: async () => { controller.abort(new Error("stop during resolution")); throw new Error("fetch failed"); } } });
  await assert.rejects(f.run({ sourceUrl: "https://www.tiktok.com/t/ZP8c3ALoT/", signal: controller.signal }), /stop during resolution/);
  assert.equal(f.calls.includes("yt-dlp"), false);
  await emptyTask(f);
});

for (const cancelStage of ["primary", "yt-dlp", "web-body"]) {
  test(`cancellation at ${cancelStage} stops the chain and cleans partial files`, async t => {
    const controller = new AbortController();
    const stopped = new Error("user stopped");
    const f = await fixture(t);
    const extra = { signal: controller.signal };
    if (cancelStage === "primary") extra.primaryDownload = async id => { await f.put(id, "partial"); controller.abort(stopped); throw stopped; };
    if (cancelStage === "yt-dlp") f.hooks.downloadTikTokVideoWithYtDlp = async id => { await f.put(id, "partial"); controller.abort(stopped); throw stopped; };
    if (cancelStage === "web-body") {
      f.hooks.fetchWithProxy = async (url, init) => {
        f.calls.push(new URL(url).pathname);
        if (new URL(url).pathname.includes("/video/")) return page();
        return new Response(new ReadableStream({ start(stream) {
          stream.enqueue(new TextEncoder().encode("partial"));
          init.signal.addEventListener("abort", () => stream.error(init.signal.reason), { once: true });
          setTimeout(() => controller.abort(stopped), 10);
        } }), { headers: { "content-type": "video/mp4" } });
      };
    }
    await assert.rejects(f.run(extra), error => error === stopped);
    await emptyTask(f);
    assert.equal(f.stages.at(-1), { primary: "TokScript", "yt-dlp": "yt-dlp", "web-body": "网页" }[cancelStage]);
  });
}

test("an already stopped task makes no directories or requests", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ signal: AbortSignal.abort(new Error("already stopped")) }), /already stopped/);
  assert.deepEqual(await readdir(f.root), []);
  assert.deepEqual(f.calls, []);
});

test("an ownership failure is not swallowed as a failed download", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ beforeSource: async () => { throw new Error("newer attempt owns this task"); } }), /newer attempt/);
  assert.deepEqual(f.calls, []);
  await emptyTask(f);
});

for (const [name, response] of [
  ["different video", () => page({ id: "7681775718816173327" })],
  ["age restriction", () => page({ isContentClassified: true })],
  ["private video", () => page({ privateItem: true })],
  ["image album", () => page({ imagePost: { images: [] } })],
  ["deleted video", () => page({}, { statusCode: 10204 })],
  ["missing playback URL", () => page({ video: { duration: 20 } })],
  ["malformed detail", () => new Response("<html>challenge page</html>")],
  ["overlong video", () => page({ video: { playAddr: playback, duration: 601 } })],
  ["untrusted playback host", () => page({ video: { playAddr: "https://127.0.0.1/admin", duration: 20 } })],
  ["oversized page", () => new Response("x".repeat(8 * 1024 * 1024 + 1))],
]) {
  test(`${name} cannot become a successful download or start a CDN request`, async t => {
    const f = await fixture(t);
    let requests = 0;
    f.hooks.fetchWithProxy = async () => { requests += 1; return response(); };
    await assert.rejects(f.run(), /视频下载失败/);
    assert.equal(requests, 1);
    await emptyTask(f);
  });
}

for (const [name, response] of [
  ["HTML instead of MP4", () => media("access denied", { "content-type": "text/html" })],
  ["partial HTTP response", () => new Response("partial", { status: 206 })],
  ["media forbidden", () => new Response("blocked", { status: 403 })],
  ["truncated body", () => media("partial", { "content-length": "500" })],
  ["empty body", () => media("")],
  ["oversized media", () => media("tiny", { "content-length": String(601 * 1024 * 1024) })],
  ["offsite redirect", () => new Response(null, { status: 302, headers: { location: "https://private.invalid/?secret=SECRET" } })],
]) {
  test(`${name} fails once, removes its files and never leaks a URL`, async t => {
    const f = await fixture(t);
    let requests = 0;
    f.hooks.fetchWithProxy = async url => { requests += 1; return new URL(url).pathname.includes("/video/") ? page() : response(); };
    await assert.rejects(f.run(), error => {
      assert.match(error.message, /视频下载失败/);
      assert.doesNotMatch(error.message, /https:|SECRET|private-signature/);
      return true;
    });
    assert.equal(requests, 2);
    await emptyTask(f);
  });
}

test("a media-stream failure is cleaned up without another webpage attempt", async t => {
  const f = await fixture(t);
  f.hooks.fetchWithProxy = async url => new URL(url).pathname.includes("/video/") ? page() : new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode("partial")); stream.error(new Error("socket failed with token=SECRET")); },
  }), { headers: { "content-type": "video/mp4" } });
  await assert.rejects(f.run(), error => !error.message.includes("SECRET"));
  await emptyTask(f);
});

test("streaming size is enforced even when the CDN omits Content-Length", async t => {
  const f = await fixture(t, { smallVideoLimit: true });
  f.hooks.fetchWithProxy = async url => new URL(url).pathname.includes("/video/") ? page() : new Response(new ReadableStream({
    start(stream) { stream.enqueue(new Uint8Array(32)); stream.close(); },
  }), { headers: { "content-type": "video/mp4" } });
  await assert.rejects(f.run(), /超过大小限制/);
  await emptyTask(f);
});

test("a video shortened relative to its page cannot pass as the full original", async t => {
  const f = await fixture(t, { hooks: { validateDownloadedVideoFile: async () => ({ ...metadata, duration: 6 }) } });
  await assert.rejects(f.run(), /时长与原页面不一致/);
  await emptyTask(f);
});

test("a web-stage timeout stops a stalled body and is not retried", { timeout: 2000 }, async t => {
  const f = await fixture(t, { shortTimeout: true });
  let requests = 0;
  f.hooks.fetchWithProxy = async (_url, init) => {
    requests += 1;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  };
  const keepAlive = setTimeout(() => {}, 1500);
  t.after(() => clearTimeout(keepAlive));
  await assert.rejects(f.run(), /网页下载超时/);
  assert.equal(requests, 1);
  await emptyTask(f);
});

test("two downloads for one task use independent files, with no cross-deletion", async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([
    f.run({ primaryDownload: id => f.put(id, "first video") }),
    f.run({ primaryDownload: id => f.put(id, "second video") }),
  ]);
  assert.notEqual(first.relativePath, second.relativePath);
  assert.equal(await readFile(f.resolve(first.relativePath), "utf8"), "first video");
  assert.equal(await readFile(f.resolve(second.relativePath), "utf8"), "second video");
});

test("a late cancelled download cannot delete a newer successful file for the same task", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let finishOld, announceStarted;
  const started = new Promise(resolve => { announceStarted = resolve; });
  const old = f.run({ signal: controller.signal, primaryDownload: async id => {
    const file = await f.put(id, "old temporary video");
    announceStarted();
    await new Promise(resolve => { finishOld = resolve; });
    return file; // Deliberately simulate an underlying operation ignoring abort.
  } }).catch(error => error);
  await started;
  const newer = await f.run({ primaryDownload: id => f.put(id, "new valid video") });
  controller.abort(new Error("old attempt stopped"));
  finishOld();
  assert.match((await old).message, /old attempt stopped/);
  assert.equal(await readFile(f.resolve(newer.relativePath), "utf8"), "new valid video");
  assert.equal((await readdir(f.resolve("task"))).length, 1);
});

test("cancelling after keeping a video-only candidate still removes that attempt's cache", async t => {
  const controller = new AbortController();
  const f = await fixture(t, { hooks: { validateDownloadedVideoFile: async () => ({ ...metadata, audioCodec: "" }) } });
  await assert.rejects(f.run({
    signal: controller.signal, primaryDownload: id => f.put(id),
    beforeSource: async source => { if (source === "yt-dlp") controller.abort(new Error("stop before fallback")); },
  }), /stop before fallback/);
  await emptyTask(f);
});

for (const url of ["http://www.tiktok.com/@demo/video/7681775718816173326", "https://tiktok.com.evil.test/video/7681775718816173326", "https://user:password@www.tiktok.com/@demo/video/7681775718816173326", "https://www.tiktok.com:8080/@demo/video/7681775718816173326"]) {
  test(`untrusted source is rejected before contacting any source: ${new URL(url).origin}`, async t => {
    const f = await fixture(t);
    await assert.rejects(f.run({ sourceUrl: url }), /下载地址不在允许/);
    assert.deepEqual(f.calls, []);
    await emptyTask(f);
  });
}
