import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFileSync(path.join(root, file), "utf8");
const revision = "a".repeat(40);
const previousImage = `sha256:${"b".repeat(64)}`;

test("production compose binds existing database/media resources and never publishes MySQL", () => {
  const compose = read("docker-compose.yml");
  assert.match(compose, /^name: viral-video-analyzer$/m);
  assert.match(compose, /image: mysql:8\.0\.46/);
  assert.match(compose, /MYSQL_HOST: mysql/);
  assert.match(compose, /127\.0\.0\.1:3000:3000/);
  assert.doesNotMatch(compose.split("  viral-analyzer:")[0], /\bports:/);
  for (const name of ["mysql_data", "viral_data"]) {
    assert.ok(compose.includes(`  ${name}:\n    external: true\n    name: viral-video-analyzer_${name}`));
  }
  assert.ok(compose.includes("external: true\n    name: viral-video-analyzer_default"));
  for (const name of ["MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD", "FEISHU_AUTOMATION_WEBHOOK_SECRET", "FEISHU_SUBTITLE_BRIDGE_SECRET"]) {
    assert.ok(compose.includes(`${name}: \${${name}:?`));
  }
});

test("image includes required tools, schema and readiness probe, but excludes secret files", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /FROM node:22\.23\.2-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /pnpm@11\.9\.0/);
  assert.match(dockerfile, /yt-dlp\[default\]==2026\.8\.19/);
  assert.match(dockerfile, /chromium python3-venv/);
  assert.match(dockerfile, /COPY --from=build \/app\/lib \.\/lib/);
  assert.match(dockerfile, /COPY --from=build \/app\/deploy\/check-runtime\.cjs/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision=\$VCS_REF/);
  const ignored = read(".dockerignore").split("\n");
  for (const pattern of [".env*", "**/.env*", ".data", ".git", "**/*.pem", "**/secret.key"]) {
    assert.ok(ignored.includes(pattern), pattern);
  }
});

test("workflow tests before upload and never interrupts an in-progress production release", () => {
  const workflow = read(".github/workflows/deploy.yml");
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.ok(workflow.indexOf("bash deploy/smoke-test.sh") < workflow.indexOf("uses: appleboy/scp-action"));
  assert.match(workflow, /sha256sum viral-video-analyzer\.tar\.gz docker-compose\.yml deploy\/update-server\.sh/);
  assert.match(workflow, /--check.*\n.*--apply/);
  assert.doesNotMatch(workflow + read("deploy/update-server.sh"), /reset --hard|--remove-orphans|image prune|volume prune|compose down|docker rm/);
});

// Execute the real release script with a fake Docker CLI. No daemon, credentials,
// production paths, database, model, or Feishu service are used by these tests.
const fakeTool = String.raw`#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const tool = path.basename(process.argv[1]), args = process.argv.slice(2);
const mode = process.env.RESTORE_TEST_MODE;
const log = process.env.RESTORE_TEST_LOG;
if (tool === 'sha256sum') process.exit(mode === 'checksum' ? 1 : 0);
if (tool === 'flock') process.exit(mode === 'busy' ? 1 : 0);
if (tool === 'sleep') process.exit(0);
fs.appendFileSync(log, JSON.stringify({args, image:process.env.VIRAL_APP_IMAGE})+'\n');
const calls = fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
const applied = calls.some(c=>c.args[0]==='compose' && c.args.includes('up') && c.args.includes('docker-compose.yml'));
if (args[0] === 'compose') {
  if (args.includes('config')) process.exit(mode === 'config' ? 1 : 0);
  if (args.includes('up')) process.exit(mode === 'up' && args.includes('docker-compose.yml') ? 1 : mode === 'rollback' && args.includes('previous-compose.yml') ? 1 : 0);
}
if (args[0] === 'volume' || args[0] === 'network') process.exit(mode === 'volume' ? 1 : 0);
if (args[0] === 'load' || args[0] === 'tag') process.exit(0);
if (args[0] === 'exec') process.exit(['readiness','rollback'].includes(mode) ? 1 : 0);
if (args[0] === 'image' && args[1] === 'inspect') {
  console.log(mode === 'revision' ? 'wrong-revision' : process.env.RESTORE_TEST_REVISION); process.exit(0);
}
if (args[0] === 'inspect') {
  const format=args[2], isMysql=args.at(-1)==='viral-mysql';
  if (format.includes('.Config.Labels')) console.log(mode==='owner' ? 'other/project' : 'viral-video-analyzer/'+(isMysql?'mysql':'viral-analyzer'));
  else if (format.includes('.Mounts')) console.log(mode==='mount' || (mode==='changed-mount' && applied && !isMysql) ? 'wrong-volume' : 'viral-video-analyzer_'+(isMysql?'mysql_data':'viral_data'));
  else if (format.includes('.State.Health.Status')) console.log(mode==='database' ? 'unhealthy' : 'healthy');
  else if (format.includes('.State.StartedAt')) console.log('same-mysql/same-start-time');
  else if (format.includes('.Image')) console.log('sha256:'+'b'.repeat(64));
  else process.exit(2);
  process.exit(0);
}
console.error('Unexpected fake Docker command');process.exit(2);
`;

function fixture(t, mode = "ok") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "viral-deploy-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  const release = path.join(directory, "releases", revision);
  mkdirSync(bin);
  mkdirSync(release, { recursive: true });
  for (const tool of ["docker", "sha256sum", "flock", "sleep"]) writeFileSync(path.join(bin, tool), fakeTool, { mode: 0o755 });
  writeFileSync(path.join(directory, ".env"), "KEEP_THIS_SERVER_CONFIGURATION=unchanged\n");
  writeFileSync(path.join(directory, "docker-compose.yml"), "previous server configuration\n");
  writeFileSync(path.join(release, "docker-compose.yml"), read("docker-compose.yml"));
  writeFileSync(path.join(release, "viral-video-analyzer.tar.gz"), "fake transfer archive");
  writeFileSync(path.join(release, "release.sha256"), "fake checksum fixture");
  const log = path.join(directory, "calls.jsonl");
  function run(action) {
    const result = spawnSync("bash", [path.join(root, "deploy/update-server.sh"), action, revision], {
      env: {
        PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
        VIRAL_DEPLOY_ROOT: directory,
        RESTORE_TEST_MODE: mode,
        RESTORE_TEST_REVISION: revision,
        RESTORE_TEST_LOG: log,
      },
      encoding: "utf8", timeout: 20000,
    });
    assert.equal(result.error, undefined);
    assert.equal(readFileSync(path.join(directory, ".env"), "utf8"), "KEEP_THIS_SERVER_CONFIGURATION=unchanged\n");
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
    return { ...result, calls };
  }
  return { directory, release, run };
}

test("preflight is read-only and never loads or starts a container", (t) => {
  const f = fixture(t);
  const result = f.run("--check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(f.directory, ".deploy.lock")), false);
  assert.equal(result.calls.some(c => c.args.includes("up") || c.args[0] === "load" || c.args[0] === "tag"), false);
});

for (const mode of ["checksum", "config", "volume", "owner", "mount", "database", "revision", "busy"]) {
  test(`release refuses ${mode} failure before replacing the application`, (t) => {
    const f = fixture(t, mode);
    const result = f.run("--apply");
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.some(c => c.args.includes("up")), false);
    assert.equal(readFileSync(path.join(f.directory, "docker-compose.yml"), "utf8"), "previous server configuration\n");
  });
}

test("successful release updates only the app and removes only its transfer archive", (t) => {
  const f = fixture(t);
  const result = f.run("--apply");
  assert.equal(result.status, 0, result.stderr);
  const updates = result.calls.filter(c => c.args.includes("up"));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].args.at(-1), "viral-analyzer");
  for (const flag of ["--no-deps", "--no-build", "--wait"]) assert.ok(updates[0].args.includes(flag));
  assert.equal(updates[0].image, `viral-video-analyzer:${revision}`);
  assert.equal(readFileSync(path.join(f.directory, "docker-compose.yml"), "utf8"), read("docker-compose.yml"));
  assert.equal(existsSync(path.join(f.release, "viral-video-analyzer.tar.gz")), false);
  assert.equal(existsSync(path.join(f.release, "previous-compose.yml")), true);
});

for (const mode of ["up", "readiness", "changed-mount"]) {
  test(`failed ${mode} restores previous application without touching MySQL`, (t) => {
    const f = fixture(t, mode);
    const result = f.run("--apply");
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Previous application restored/);
    const updates = result.calls.filter(c => c.args.includes("up"));
    assert.equal(updates.length, 2);
    assert.equal(updates[1].image, previousImage);
    for (const update of updates) {
      assert.equal(update.args.at(-1), "viral-analyzer");
      assert.ok(update.args.includes("--no-deps"));
    }
    assert.equal(readFileSync(path.join(f.directory, "docker-compose.yml"), "utf8"), "previous server configuration\n");
    assert.equal(existsSync(path.join(f.release, "viral-video-analyzer.tar.gz")), true);
  });
}

test("a failed rollback is reported as requiring operator attention", (t) => {
  const result = fixture(t, "rollback").run("--apply");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /operator attention required/);
  assert.doesNotMatch(result.stderr, /Previous application restored/);
});
