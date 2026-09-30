import assert from "node:assert/strict";
import test from "node:test";
import { createIsolatedDatabase } from "./helpers/isolated-mysql.mjs";
test("Base row mappings persist without a PID; partial updates retain bindings and explicit clears", async (t) => {
  const { database, rows, row, reapplySchema } = await createIsolatedDatabase(t);
  const key = { appToken: "app-a", tableId: "table-a", recordId: "record-a" };
  const pending = await database.upsertFeishuProductCardMapping(key);
  assert.equal(pending.productId, null);
  assert.equal(pending.documentId, null);
  assert.equal(pending.lastProductPid, "");
  assert.ok(pending.createdAt);
  const product = await database.createProduct({ name: "室内摄像头", pid: "1731678528327946361",
    productUrl: "https://www.tiktok.com/view/product/1731678528327946361" });
  const bound = await database.upsertFeishuProductCardMapping({ ...key, productId: product.id,
    documentId: "doc-a", documentUrl: "https://feishu.cn/docx/doc-a", lastProductPid: product.pid,
    lastProductUrl: product.productUrl, lastProductName: product.name, managedProductPid: product.pid });
  assert.equal(bound.createdAt, pending.createdAt);
  await reapplySchema();
  assert.deepEqual(await database.getFeishuProductCardMapping(key), bound);
  const partial = await database.upsertFeishuProductCardMapping({ ...key, lastProductName: "室内安防摄像头" });
  for (const field of ["productId", "documentId", "documentUrl", "lastProductPid", "lastProductUrl", "managedProductPid"]) {
    assert.equal(partial[field], bound[field], `omitted ${field} must survive`);
  }
  assert.equal(partial.lastProductName, "室内安防摄像头");
  await database.upsertFeishuProductCardMapping({ appToken: "app-b", tableId: "table-b", recordId: "record-b",
    productId: product.id, documentId: "doc-b", documentUrl: "https://feishu.cn/docx/doc-b" });
  assert.deepEqual((await database.listFeishuProductCardMappingsByProductId(product.id)).map(m => m.documentId), ["doc-a", "doc-b"]);
  assert.deepEqual(await database.listFeishuProductCardMappingsByProductId(""), []);
  assert.equal((await database.upsertFeishuProductCardMapping({ ...key, managedProductPid: "" })).managedProductPid, "");
  assert.equal((await row("SELECT COUNT(*) AS count FROM feishu_product_card_mappings WHERE app_token=? AND table_id=? AND record_id=?", [key.appToken, key.tableId, key.recordId])).count, 1);
  const columns = (await rows("SHOW COLUMNS FROM feishu_product_card_mappings")).map(c => c.Field);
  for (const name of ["app_token", "table_id", "record_id", "product_id", "document_id", "document_url",
    "last_product_pid", "last_product_url", "last_product_name", "managed_product_pid", "created_at", "updated_at"])
    assert.ok(columns.includes(name));
  assert.ok(columns.every(name => !/secret/i.test(name)));
});
test("multiple Base rows may share the same PID document; repeated concurrent claims are idempotent", async (t) => {
  const { database, rows } = await createIsolatedDatabase(t);
  const one = { appToken: "app", tableId: "table", recordId: "one" };
  const two = { ...one, recordId: "two" };
  const document = { documentId: "shared-doc", documentUrl: "https://feishu.cn/docx/shared-doc" };
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => database.claimFeishuProductCardDocument(one, document))), Array(8).fill(true));
  assert.equal(await database.claimFeishuProductCardDocument(two, document), true);
  assert.equal((await database.getFeishuProductCardMapping(one)).documentId, document.documentId);
  assert.equal((await database.getFeishuProductCardMapping(two)).documentId, document.documentId);
  assert.equal(await database.claimFeishuProductCardDocument(two, { documentId: "new-doc", documentUrl: "https://feishu.cn/docx/new-doc" }), true);
  assert.equal((await database.getFeishuProductCardMapping(one)).documentId, document.documentId);
  assert.equal((await database.getFeishuProductCardMapping(two)).documentId, "new-doc");
  const index = (await rows("SHOW INDEX FROM feishu_product_card_mappings")).find(index => index.Key_name === "idx_fpcm_document");
  assert.equal(index.Column_name, "document_id");
  assert.equal(index.Non_unique, 1);
});
