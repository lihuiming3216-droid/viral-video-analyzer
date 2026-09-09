import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
const deploy = await readFile(new URL("../deploy/update-server.sh", import.meta.url), "utf8");

test("deployments retain the server key and do not rewrite it from GitHub", () => {
  assert.doesNotMatch(workflow, /secrets\.OPENAI_API_KEY|envs:\s*OPENAI_API_KEY|runtime_env_tmp/);
  assert.match(deploy, /--env-file "\$env_file"/);
  assert.doesNotMatch(deploy, /source "\$env_file"|\. "\$env_file"/);
  assert.match(workflow, /appleboy\/ssh-action@[a-f0-9]{40}/);
  assert.match(workflow, /appleboy\/scp-action@[a-f0-9]{40}/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(compose, /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/);
});

test("the runtime container receives the key and a pinned default product model", () => {
  assert.match(compose, /OPENAI_API_KEY:\s*\$\{OPENAI_API_KEY:-\}/);
  assert.match(compose, /OPENAI_PRODUCT_MODEL:\s*\$\{OPENAI_PRODUCT_MODEL:-gpt-5\.6-terra\}/);
});
