/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS entrypoint used directly by Node on the legacy bridge. */
const http = require("node:http");

const targetHost = process.env.TARGET_HOST || "52.37.212.216";
const targetPort = Number(process.env.TARGET_PORT || 80);

const server = http.createServer((request, response) => {
  const headers = { ...request.headers, host: targetHost };
  const upstream = http.request({
    host: targetHost,
    port: targetPort,
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstream.setTimeout(900_000, () => upstream.destroy(new Error("Upstream timeout")));
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("New server is temporarily unavailable");
  });
  request.pipe(upstream);
});

server.requestTimeout = 900_000;
server.headersTimeout = 60_000;
server.listen(3000, "0.0.0.0");
