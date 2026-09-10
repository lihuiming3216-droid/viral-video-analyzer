import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = file => readFileSync(new URL("../" + file, import.meta.url), "utf8");
const workflow = read(".github/workflows/verify-handcard.yml");

test("verification only runs on explicitly named test branches, never main or arbitrary dispatch", () => {
  assert.match(workflow, /branches: \['codex\/verify-handcard-\*'\]/);
  assert.match(workflow, /if: startsWith\(github.ref, 'refs\/heads\/codex\/verify-handcard-'\)/);
  assert.doesNotMatch(workflow, /workflow_dispatch|pull_request|schedule:|repository_dispatch|branches:.*main/);
  assert.match(workflow, /timeout-minutes: 35/);
});

test("verification has read-only GitHub access and no deployment or business credentials", () => {
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /secrets\.|secrets:|environment:|ssh|scp|update-server|--apply|docker push|docker save|upload-artifact|\/opt\/viral/);
  assert.equal((workflow.match(/uses:/g) || []).length, 1, "checkout is the only invoked action");
});

test("both workflows pin the reviewed Node 24 checkout release without retaining credentials", () => {
  // actions/checkout v7.0.1 declares runs.using: node24 in its action.yml.
  const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
  for (const source of [workflow, read(".github/workflows/deploy.yml")]) {
    assert.ok(source.includes(checkout));
    assert.equal((source.match(/uses: actions\/checkout@/g) || []).length, 1);
    assert.match(source, /persist-credentials: false/);
    assert.doesNotMatch(source, /ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION|ACTIONS_RUNNER_FORCE_ACTIONS_NODE_VERSION/);
  }
});

test("verification reuses the image and smoke test while running regression containers offline", () => {
  assert.match(workflow, /docker build --build-arg VCS_REF="\$GITHUB_SHA"/);
  const runs = workflow.split("\n").filter(line => line.includes("docker run"));
  assert.equal(runs.length, 2);
  assert.ok(runs.every(line => line.includes("--network none") && line.includes("--entrypoint node")));
  assert.match(workflow, /tests\/product-doc-sync-write-protection.test.mjs/);
  assert.match(workflow, /tests\/verification-workflow.test.mjs/);
  assert.match(workflow, /bash deploy\/smoke-test.sh "viral-video-analyzer:\$GITHUB_SHA"/);
});

test("smoke containers use an internal temporary network and no production volumes", () => {
  const smoke = read("deploy/smoke-test.sh");
  assert.match(smoke, /docker network create --internal "\$network"/);
  assert.match(smoke, /network="viral-ci-\$suffix"/);
  assert.match(smoke, /--tmpfs \/app\/\.data:rw/);
  assert.doesNotMatch(smoke, /--env-file|--network host|--volumes-from|viral-video-analyzer_mysql_data|viral-video-analyzer_viral_data|\/var\/run\/docker.sock/);
});

test("production workflow remains restricted to main rather than following verification runs", () => {
  const deploy = read(".github/workflows/deploy.yml");
  assert.match(deploy, /branches: \[main\]/);
  assert.match(deploy, /if: github.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(deploy, /workflow_run|verify-handcard/);
});

test("both release paths require the download-fallback regression tests", () => {
  for (const text of [workflow, read(".github/workflows/deploy.yml")]) {
    assert.match(text, /tests\/tiktok-video-download\.test\.mjs/);
  }
});
