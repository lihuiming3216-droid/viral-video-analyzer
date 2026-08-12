import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");

test("the OpenAI key is sourced from an encrypted GitHub secret and never embedded", () => {
  assert.match(workflow, /OPENAI_API_KEY:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
  assert.match(workflow, /envs:\s*OPENAI_API_KEY/);
  assert.match(workflow, /install -m 600 "\$runtime_env_tmp" \.env/);
  assert.match(workflow, /trap 'rm -f "\$runtime_env_tmp"' EXIT/);
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
