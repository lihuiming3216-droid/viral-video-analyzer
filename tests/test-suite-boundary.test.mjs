import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = file => readFile(new URL(file, root), "utf8");
const testFiles = async directory => (await readdir(new URL(directory, root)))
  .filter(name => name.endsWith(".test.mjs")).sort();

test("the default command runs every test file and no archived suites remain", async () => {
  const { scripts } = JSON.parse(await read("package.json"));
  const command = "node --test --test-concurrency=2 --test-reporter=./tests/compact-reporter.mjs";
  assert.equal(scripts.test, `${command} tests/*.test.mjs`);
  assert.equal(scripts["test:legacy"], undefined);
  assert.equal(scripts["test:all"], undefined);
  await assert.rejects(readdir(new URL("tests/legacy/", root)), { code: "ENOENT" });
});

test("verification and deployment both run every active test file", async () => {
  const active = (await testFiles("tests/")).map(file => `tests/${file}`);
  const smoke = await read("deploy/smoke-test.sh");
  for (const file of [".github/workflows/verify-handcard.yml", ".github/workflows/deploy.yml"]) {
    const scripts = `${await read(file)}\n${smoke}`;
    const testCommands = scripts.replace(/\\\r?\n[ \t]*/g, " ").split("\n")
      .filter(line => line.trim().startsWith("docker run ") && /\s--test(?:\s|=)/.test(line));
    const listed = new Set(testCommands.join("\n").match(/\btests\/[A-Za-z0-9_.-]+\.test\.mjs\b/g) || []);
    assert.deepEqual(active.filter(path => !listed.has(path)), [], `${file}: active tests missing from CI`);
    assert.deepEqual([...listed].filter(path => !active.includes(path)), [], `${file}: obsolete or misspelled test path`);
    assert.ok(testCommands.every(line => /--network (?:none|"\$network")/.test(line)), "test containers must be offline or on the isolated MySQL network");
  }
});
