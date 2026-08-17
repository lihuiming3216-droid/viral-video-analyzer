import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/providers/tokscript.ts", import.meta.url), "utf8");

async function loadTokScriptModule() {
  const stubSource = `
    export const fetchWithProxy = (...args) => globalThis.__tokscriptSourceHooks.fetchWithProxy(...args);
    export const getProviderConfig = () => ({ enabled: true, apiKey: "test", baseUrl: "https://api.example/mcp" });
    export const requireProvider = () => ({ enabled: true, apiKey: "test", baseUrl: "https://api.example/mcp" });
    export const NO_PRODUCT_VOICEOVER_TRANSCRIPT = "背景音乐，无有效产品口播";
  `;
  const stubUrl = `data:text/javascript;base64,${Buffer.from(stubSource).toString("base64")}`;
  let compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  compiled = compiled
    .replace('import "server-only";', "")
    .replaceAll('"@/lib/network"', JSON.stringify(stubUrl))
    .replaceAll('"@/lib/provider-config"', JSON.stringify(stubUrl));
  compiled = compiled.replaceAll('"@/lib/transcript-validation"', JSON.stringify(stubUrl));
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const tokscript = await loadTokScriptModule();

async function fetchWithTranscriptToolResult(transcriptResult) {
  globalThis.__tokscriptSourceHooks = {
    fetchWithProxy: async (_url, init) => {
      const request = JSON.parse(String(init.body || "{}"));
      let result = {};
      if (request.method === "tools/list") {
        result = {
          tools: [
            { name: "download_video", inputSchema: { properties: { url: {} } } },
            { name: "get_tiktok_transcript", inputSchema: { properties: { url: {} } } },
          ],
        };
      } else if (request.method === "tools/call") {
        result = request.params.name === "download_video"
          ? { content: [{ type: "text", text: JSON.stringify({ download_url: "https://cdn.example/video.mp4" }) }] }
          : transcriptResult;
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  try {
    return await tokscript.fetchTikTok(
      "https://www.tiktok.com/@creator/video/7600715017335491895",
      undefined,
      { includeCover: false },
    );
  } finally {
    delete globalThis.__tokscriptSourceHooks;
  }
}

test("TokScript plain-text extraction diagnostics are never accepted as speech", () => {
  assert.equal(
    tokscript.tokScriptTranscriptFailure(
      "Failed to extract transcript: Neither SIGI_STATE nor __UNIVERSAL_DATA_FOR_REHYDRATION__ found",
    ),
    true,
  );
  assert.equal(tokscript.tokScriptTranscriptFailure("Unable to retrieve transcript data"), true);
  assert.equal(tokscript.tokScriptTranscriptFailure("Transcript extraction error: TikTok page unavailable"), true);
  assert.equal(tokscript.tokScriptTranscriptFailure("No transcript available for this video"), true);
  assert.equal(tokscript.tokScriptTranscriptFailure("Service unavailable; try again later"), true);
  assert.equal(tokscript.tokScriptTranscriptFailure("Rate limit exceeded"), true);
  assert.equal(tokscript.tokScriptTranscriptFailure("There is no speech."), false);
  assert.equal(tokscript.tokScriptTranscriptFailure("No voiceover, only music"), false);
  assert.equal(tokscript.tokScriptTranscriptFailure("only music"), false);
  assert.equal(tokscript.tokScriptTranscriptFailure("Transcript: (empty)"), true);
  assert.equal(tokscript.tokScriptTranscriptFailure("This monitor is easy to carry and use outdoors."), false);
});

test("short, repetitive, and soundtrack-matching text is marked as no product voiceover", () => {
  assert.equal(tokscript.tokScriptTranscriptIsNoProductVoiceover("you"), true);
  assert.equal(tokscript.tokScriptTranscriptIsNoProductVoiceover("buy now"), false);
  assert.equal(tokscript.tokScriptTranscriptIsNoProductVoiceover("you are you are you are you are"), true);
  assert.equal(
    tokscript.tokScriptTranscriptIsNoProductVoiceover(
      "I think I like when it rains, you told me that you feel the same",
      "I Think I Like When It Rains",
    ),
    true,
  );
  assert.equal(
    tokscript.tokScriptTranscriptIsNoProductVoiceover(
      "Wrap the cuff around your upper arm and press start to measure your blood pressure",
      "Original sound",
    ),
    false,
  );
});

test("a soundtrack transcript becomes the stable no-voiceover marker", async () => {
  const result = await fetchWithTranscriptToolResult({
    structuredContent: {
      transcript: "I think I like when it rains, you told me that you feel the same",
      audio: { name: "I Think I Like When It Rains" },
    },
  });
  assert.equal(result.transcript, "背景音乐，无有效产品口播");
  assert.deepEqual(result.segments, []);
});

test("only explicit structured transcript or segments fields supply speech", async () => {
  const structured = await fetchWithTranscriptToolResult({
    structuredContent: {
      transcript: "Wrap the cuff around your upper arm and press start.",
      message: "processing completed",
      text: "metadata text must not win",
      content: "metadata content must not win",
    },
  });
  assert.equal(structured.transcript, "Wrap the cuff around your upper arm and press start.");

  const segmented = await fetchWithTranscriptToolResult({
    structuredContent: {
      transcript: "",
      segments: [
        { start: 0, end: 1.5, text: "Place the cuff." },
        { start: 1.5, end: 3, text: "Press the blue button." },
      ],
      message: "processing completed",
    },
  });
  assert.equal(segmented.transcript, "Place the cuff. Press the blue button.");
  assert.deepEqual(segmented.segments, [
    { start: 0, end: 1.5, text: "Place the cuff." },
    { start: 1.5, end: 3, text: "Press the blue button." },
  ]);
});

test("TokScript Chinese transcript is preserved when returned directly", async () => {
  const result = await fetchWithTranscriptToolResult({
    structuredContent: {
      transcript: "Wrap the cuff around your upper arm and press start.",
      transcriptZh: "将袖带缠绕在上臂并按下开始键。",
    },
  });
  assert.equal(result.transcriptZh, "将袖带缠绕在上臂并按下开始键。");
});

test("structured metadata cannot replace an empty or missing transcript", async () => {
  for (const structuredContent of [
    { transcript: "", message: "Video processed successfully", text: "Success", content: "Metadata" },
    { message: "Video processed successfully", text: "Success", content: "Metadata" },
  ]) {
    await assert.rejects(
      fetchWithTranscriptToolResult({ structuredContent }),
      /TokScript 未返回有效口播文案/,
    );
  }
});

test("plain MCP text requires an explicit nonempty Transcript label", async () => {
  const result = await fetchWithTranscriptToolResult({
    content: [{
      type: "text",
      text: "Transcript: Check your blood pressure at home in under a minute.\nTitle: Home monitor demo\nViews: 1200",
    }],
  });
  assert.equal(result.transcript, "Check your blood pressure at home in under a minute.");

  await assert.rejects(
    fetchWithTranscriptToolResult({ content: [{ type: "text", text: "Video processed successfully" }] }),
    /TokScript 未返回有效口播文案/,
  );
});

test("explicit no-speech results become the stable no-voiceover marker", async () => {
  for (const transcript of ["There is no speech", "No voiceover", "only music"]) {
    const result = await fetchWithTranscriptToolResult({ structuredContent: { transcript } });
    assert.equal(result.transcript, "背景音乐，无有效产品口播");
  }
  await assert.rejects(
    fetchWithTranscriptToolResult({ content: [{ type: "text", text: "Transcript: (empty)" }] }),
    /TokScript 未返回有效口播文案/,
  );
});

test("an MCP isError result is rejected before its text can become a transcript", async () => {
  let downloadCalls = 0;
  let transcriptCalls = 0;
  globalThis.__tokscriptSourceHooks = {
    fetchWithProxy: async (_url, init) => {
      const request = JSON.parse(String(init.body || "{}"));
      let result = {};
      if (request.method === "tools/list") {
        result = {
          tools: [
            { name: "download_video", inputSchema: { properties: { url: {} } } },
            { name: "get_tiktok_transcript", inputSchema: { properties: { url: {} } } },
          ],
        };
      } else if (request.method === "tools/call") {
        if (request.params.name === "download_video") downloadCalls += 1;
        if (request.params.name === "get_tiktok_transcript") transcriptCalls += 1;
        result = request.params.name === "download_video"
          ? { content: [{ type: "text", text: JSON.stringify({ download_url: "https://cdn.example/video.mp4" }) }] }
          : { isError: true, content: [{ type: "text", text: "temporary provider issue" }] };
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  try {
    await assert.rejects(
      tokscript.fetchTikTok("https://www.tiktok.com/@creator/video/7600715017335491895", undefined, { includeCover: false }),
      (error) => {
        assert.equal(error.name, "TokScriptToolCallError");
        assert.match(error.message, /TokScript 工具返回错误/);
        assert.match(error.message, /stage=transcript/);
        assert.match(error.message, /category=provider_unavailable/);
        assert.match(error.message, /attempts=2/);
        assert.equal(
          error.message,
          "TokScript 工具返回错误（stage=transcript; category=provider_unavailable; attempts=2）：服务暂不可用",
        );
        assert.doesNotMatch(error.message, /temporary provider issue/);
        return true;
      },
    );
    assert.equal(downloadCalls, 1);
    assert.equal(transcriptCalls, 2, "the failing transcript tool is retried exactly once");
  } finally {
    delete globalThis.__tokscriptSourceHooks;
  }
});

test("a transient download tool is retried once without repeating the transcript tool", async () => {
  let downloadCalls = 0;
  let transcriptCalls = 0;
  globalThis.__tokscriptSourceHooks = {
    fetchWithProxy: async (_url, init) => {
      const request = JSON.parse(String(init.body || "{}"));
      let result = {};
      if (request.method === "tools/list") {
        result = {
          tools: [
            { name: "download_video", inputSchema: { properties: { url: {} } } },
            { name: "get_tiktok_transcript", inputSchema: { properties: { url: {} } } },
          ],
        };
      } else if (request.method === "tools/call" && request.params.name === "download_video") {
        downloadCalls += 1;
        result = downloadCalls === 1
          ? { isError: true, content: [{ type: "text", text: "service temporarily unavailable" }] }
          : { structuredContent: { download_url: "https://cdn.example/video.mp4" } };
      } else if (request.method === "tools/call") {
        transcriptCalls += 1;
        result = { structuredContent: { transcript: "This portable monitor fits in my backpack." } };
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  try {
    const result = await tokscript.fetchTikTok(
      "https://www.tiktok.com/@creator/video/7600715017335491895",
      undefined,
      { includeCover: false },
    );
    assert.equal(result.transcript, "This portable monitor fits in my backpack.");
    assert.equal(downloadCalls, 2);
    assert.equal(transcriptCalls, 1);
  } finally {
    delete globalThis.__tokscriptSourceHooks;
  }
});

test("a persistent tool error stores only fixed stage, category and system text", async () => {
  let downloadCalls = 0;
  let transcriptCalls = 0;
  globalThis.__tokscriptSourceHooks = {
    fetchWithProxy: async (_url, init) => {
      const request = JSON.parse(String(init.body || "{}"));
      let result = {};
      if (request.method === "tools/list") {
        result = {
          tools: [
            { name: "download_video", inputSchema: { properties: { url: {} } } },
            { name: "get_tiktok_transcript", inputSchema: { properties: { url: {} } } },
          ],
        };
      } else if (request.method === "tools/call" && request.params.name === "download_video") {
        downloadCalls += 1;
        result = {
          isError: true,
          content: [{
            type: "text",
            text: "Rate limit exceeded at https://signed.example/video?token=url-secret Authorization: Bearer bearer-secret api_key=api-key-value password=password-value passwd=passwd-value client_secret=client-secret-value app_secret=app-secret-value refresh_token=refresh-token-value id_token=id-token-value session=session-value cookie=cookie-value set-cookie=set-cookie-value sk-providersecret123456789",
          }],
        };
      } else if (request.method === "tools/call") {
        transcriptCalls += 1;
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  try {
    await assert.rejects(
      tokscript.fetchTikTok(
        "https://www.tiktok.com/@creator/video/7600715017335491895",
        undefined,
        { includeCover: false },
      ),
      (error) => {
        assert.equal(error.name, "TokScriptToolCallError");
        assert.match(error.message, /stage=download/);
        assert.match(error.message, /category=rate_limit/);
        assert.match(error.message, /attempts=2/);
        assert.equal(
          error.message,
          "TokScript 工具返回错误（stage=download; category=rate_limit; attempts=2）：服务请求受限",
        );
        assert.equal("cause" in error, false);
        const durableErrorSurface = `${error.name}\n${error.message}\n${JSON.stringify(error)}`;
        for (const injected of [
          "signed.example", "url-secret", "bearer-secret", "api-key-value", "password-value", "passwd-value",
          "client-secret-value", "app-secret-value", "refresh-token-value", "id-token-value", "session-value",
          "cookie-value", "set-cookie-value", "sk-providersecret123456789",
        ]) {
          assert.doesNotMatch(durableErrorSurface, new RegExp(injected));
        }
        return true;
      },
    );
    assert.equal(downloadCalls, 2);
    assert.equal(transcriptCalls, 0);
  } finally {
    delete globalThis.__tokscriptSourceHooks;
  }
});

test("a tool network exception is contained to two calls and reduced to fixed text", async () => {
  let downloadCalls = 0;
  globalThis.__tokscriptSourceHooks = {
    fetchWithProxy: async (_url, init) => {
      const request = JSON.parse(String(init.body || "{}"));
      if (request.method === "tools/call") {
        downloadCalls += 1;
        throw new TypeError("fetch failed at https://signed.example/video?token=network-secret");
      }
      const result = request.method === "tools/list"
        ? {
          tools: [
            { name: "download_video", inputSchema: { properties: { url: {} } } },
            { name: "get_tiktok_transcript", inputSchema: { properties: { url: {} } } },
          ],
        }
        : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  try {
    await assert.rejects(
      tokscript.fetchTikTok(
        "https://www.tiktok.com/@creator/video/7600715017335491895",
        undefined,
        { includeCover: false },
      ),
      (error) => {
        assert.equal(error.name, "TokScriptToolCallError");
        assert.match(error.message, /stage=download/);
        assert.match(error.message, /category=network_error/);
        assert.match(error.message, /attempts=2/);
        assert.equal(
          error.message,
          "TokScript 工具返回错误（stage=download; category=network_error; attempts=2）：服务网络异常",
        );
        assert.doesNotMatch(error.message, /fetch failed|https?:|signed\.example|network-secret/);
        return true;
      },
    );
    assert.equal(downloadCalls, 2);
  } finally {
    delete globalThis.__tokscriptSourceHooks;
  }
});

test("official TikTok short links resolve to the canonical video before TokScript", async () => {
  const requests = [];
  const result = await tokscript.resolveTokScriptVideoUrl(
    "https://www.tiktok.com/t/SHORT123/",
    undefined,
    async (url, init) => {
      requests.push({ url: String(url), redirect: init.redirect });
      return new Response(null, {
        status: 302,
        headers: { location: "https://www.tiktok.com/@creator/video/7600715017335491895?_r=1" },
      });
    },
  );
  assert.equal(result, "https://www.tiktok.com/@creator/video/7600715017335491895?_r=1");
  assert.deepEqual(requests, [{ url: "https://www.tiktok.com/t/SHORT123/", redirect: "manual" }]);
});

test("short-link resolution refuses redirects outside official TikTok hosts", async () => {
  await assert.rejects(
    tokscript.resolveTokScriptVideoUrl(
      "https://www.tiktok.com/t/SHORT123/",
      undefined,
      async () => new Response(null, { status: 302, headers: { location: "https://example.com/video/1" } }),
    ),
    /未解析到官方 TikTok 视频地址/,
  );
});

test("fetchTikTok rejects a successful MCP envelope containing an extraction error", async () => {
  const toolUrls = [];
  globalThis.__tokscriptSourceHooks = {
    fetchWithProxy: async (_url, init) => {
      const request = JSON.parse(String(init.body || "{}"));
      let result = {};
      if (request.method === "tools/list") {
        result = {
          tools: [
            { name: "download_video", inputSchema: { properties: { url: {} } } },
            { name: "get_tiktok_transcript", inputSchema: { properties: { url: {} } } },
          ],
        };
      } else if (request.method === "tools/call") {
        toolUrls.push(request.params.arguments.url);
        result = request.params.name === "download_video"
          ? { content: [{ type: "text", text: JSON.stringify({ download_url: "https://cdn.example/video.mp4" }) }] }
          : { content: [{ type: "text", text: "Failed to extract transcript: SIGI_STATE not found" }] };
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
      });
    },
  };

  try {
    await assert.rejects(
      tokscript.fetchTikTok(
        "https://www.tiktok.com/@creator/video/7600715017335491895",
        undefined,
        { includeCover: false },
      ),
      /TokScript 未返回有效口播文案/,
    );
    assert.deepEqual(toolUrls, [
      "https://www.tiktok.com/@creator/video/7600715017335491895",
      "https://www.tiktok.com/@creator/video/7600715017335491895",
    ]);
  } finally {
    delete globalThis.__tokscriptSourceHooks;
  }
});
