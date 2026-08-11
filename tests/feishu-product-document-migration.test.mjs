import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ProductDocumentMigrationBusyError,
  withProductDocumentMigrationLock,
} from "../lib/feishu/product-document-migration-lock.mjs";

const routeUrl = new URL("../app/api/feishu/product-document-migration/route.ts", import.meta.url);
const lockUrl = new URL("../lib/feishu/product-document-migration-lock.mjs", import.meta.url);

test("product document migration is authenticated and defaults to a read-only dry run", async () => {
  const route = await readFile(routeUrl, "utf8");
  assert.match(route, /FEISHU_AUTOMATION_WEBHOOK_SECRET/);
  assert.match(route, /x-feishu-automation-secret/);
  assert.match(route, /const CONFIRMATION = "move_and_transfer_all_product_documents"/);
  assert.match(route, /const dryRun = body\.confirm !== CONFIRMATION/);
  assert.match(route, /if \(dryRun\)/);
  assert.match(route, /validateProductDocumentFolder/);
  assert.ok(
    route.indexOf("if (dryRun)") < route.indexOf("await migrateProductDocument"),
    "the dry-run response must return before the first mutating call",
  );
});

test("product document migration supports one-product trials and rate-limits every move attempt", async () => {
  const route = await readFile(routeUrl, "utf8");
  assert.match(route, /availableProducts\.filter\(\(product\) => product\.id === productId\)/);
  assert.match(route, /const MIGRATION_INTERVAL_MS = 3_200/);
  assert.match(route, /if \(index > 0\) await sleep\(MIGRATION_INTERVAL_MS\)/);
  assert.match(route, /migrateProductDocument/);
  assert.match(route, /results\.push/);
  assert.match(route, /ok: true,[\s\S]*?\.\.\.migration/);
  assert.doesNotMatch(route, /ownerOpenId: target\./);
});

test("product document migration never deletes source documents", async () => {
  const route = await readFile(routeUrl, "utf8");
  assert.doesNotMatch(route, /\bDELETE\b|deleteDocument|unlink|rmSync|removeFile/i);
});

test("confirmed migrations use a global lock while dry runs stay lock-free", async () => {
  const [route, lock] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(lockUrl, "utf8"),
  ]);
  assert.match(route, /if \(dryRun\) return await handleRequest\(\)/);
  assert.ok(
    route.indexOf("if (dryRun) return await handleRequest()")
      < route.indexOf("return await withProductDocumentMigrationLock(handleRequest)"),
    "dry runs must return without acquiring the mutating lock",
  );
  assert.match(route, /ProductDocumentMigrationBusyError/);
  assert.match(route, /status: 409/);
  assert.match(lock, /globalThis/);
  assert.match(lock, /try \{/);
  assert.match(lock, /finally \{\s*release\(\)/);
});

test("migration lock rejects overlap and releases after operation failures", async () => {
  let openGate = () => {};
  const gate = new Promise((resolve) => { openGate = resolve; });
  let firstStarted = false;
  const first = withProductDocumentMigrationLock(async () => {
    firstStarted = true;
    await gate;
    return "finished";
  });
  assert.equal(firstStarted, true);

  let overlappingOperationRan = false;
  await assert.rejects(
    withProductDocumentMigrationLock(() => {
      overlappingOperationRan = true;
      return "must not run";
    }),
    ProductDocumentMigrationBusyError,
  );
  assert.equal(overlappingOperationRan, false);

  openGate();
  assert.equal(await first, "finished");
  await assert.rejects(
    withProductDocumentMigrationLock(async () => {
      throw new Error("simulated migration failure");
    }),
    /simulated migration failure/,
  );
  assert.equal(await withProductDocumentMigrationLock(() => "recovered"), "recovered");
});
