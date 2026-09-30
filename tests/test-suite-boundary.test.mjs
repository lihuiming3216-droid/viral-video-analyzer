import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = file => readFile(new URL(file, root), "utf8");
const testFiles = async directory => (await readdir(new URL(directory, root)))
  .filter(name => name.endsWith(".test.mjs")).sort();

test("default tests cover active files and explicit commands retain legacy and combined suites", async () => {
  const { scripts } = JSON.parse(await read("package.json"));
  const command = "node --test --test-concurrency=2 --test-reporter=./tests/compact-reporter.mjs";
  assert.equal(scripts.test, `${command} tests/*.test.mjs`);
  assert.equal(scripts["test:legacy"], `${command} tests/legacy/*.test.mjs`);
  assert.equal(scripts["test:all"], `${command} tests/*.test.mjs tests/legacy/*.test.mjs`);
});

test("only retired product-link suites are archived and their assertions remain enabled", async () => {
  const expected = ["openai-product-analyzer.test.mjs", "product-parser-contract.test.mjs", "product-parser-evidence.test.mjs"];
  assert.deepEqual(await testFiles("tests/legacy/"), expected);
  const active = await testFiles("tests/");
  assert.ok(expected.every(file => !active.includes(file)));
  assert.ok(active.includes("product-link-retirement.test.mjs"), "the closed-entry-point guard must stay active");
  for (const file of expected) {
    assert.doesNotMatch(await read(`tests/legacy/${file}`), /\btest\.(?:skip|todo|only)\s*\(/);
  }
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
