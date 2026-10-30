import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createIsolatedDatabase, moduleUrl } from "./helpers/isolated-mysql.mjs";

test("only finished TikTok originals past the retention window are pruned, and the row stops pointing at them", async t => {
  const f = await createIsolatedDatabase(t);
  const root = await mkdtemp(path.join(tmpdir(), "media-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const processing = moduleUrl(`
    import path from "node:path";
    const root = ${JSON.stringify(root)};
    export const getMediaRoot = () => root;
    export const resolveMediaPath = relative => path.resolve(root, relative);
  `);
  const { exports: retention } = await f.load("lib/media-retention.ts", {
    "@/lib/db/pool": moduleUrl(`export const getPool = async () => globalThis.__retentionPool;`),
    "@/lib/db/query": (await f.load("lib/db/query.ts")).url,
    "@/lib/video-processing": processing,
  });
  globalThis.__retentionPool = f.pool;
  t.after(() => { delete globalThis.__retentionPool; });

  const product = await f.database.createProduct({ name: "retention" });
  const make = async (name, { status = "completed", ageDays = 40, sourceType = "tiktok", job = false } = {}) => {
    const video = await f.database.createVideo({ productId: product.id, sourceType, sourceUrl: `https://www.tiktok.com/@a/video/${name}` });
    const relative = `${video.id}/original.mp4`;
    await mkdir(path.join(root, video.id), { recursive: true });
    await writeFile(path.join(root, relative), "video");
    const updated = new Date(Date.now() - ageDays * 86_400_000).toISOString();
    await f.pool.query("UPDATE videos SET status=?, original_path=?, updated_at=? WHERE id=?", [status, relative, updated, video.id]);
    if (job) await f.pool.query(
      "INSERT INTO feishu_automation_jobs(video_id,app_token,table_id,record_id,field_map_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      [video.id, "app", "tbl", `rec-${name}`, "{}", updated, updated]);
    return video.id;
  };
  const expired = await make("expired");
  const recent = await make("recent", { ageDays: 5 });
  const running = await make("running", { status: "processing" });
  const pending = await make("pending-delivery", { job: true });
  const upload = await make("upload", { sourceType: "upload" });

  assert.deepEqual(await retention.pruneExpiredMedia({ days: 30 }), { pruned: 1 });
  assert.equal(existsSync(path.join(root, expired)), false);
  assert.equal((await f.row("SELECT original_path FROM videos WHERE id=?", [expired])).original_path, null);
  for (const kept of [recent, running, pending, upload]) {
    assert.ok(existsSync(path.join(root, kept, "original.mp4")), kept);
    assert.ok((await f.row("SELECT original_path FROM videos WHERE id=?", [kept])).original_path);
  }
  assert.deepEqual(await retention.pruneExpiredMedia({ days: 30 }), { pruned: 0 }, "a second pass finds nothing");
  assert.deepEqual(await retention.pruneExpiredMedia({ days: 0 }), { pruned: 0 }, "0 disables pruning");
});
