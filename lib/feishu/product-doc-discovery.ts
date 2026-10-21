import type { Client } from "@larksuiteoapi/node-sdk";
import type { ProductDocumentSyncTarget } from "@/lib/database";

type Result = { documents: number; found: number; queued: number; completed: number; failed: number };
const empty = (): Result => ({ documents: 0, found: 0, queued: 0, completed: 0, failed: 0 });
type Work = {
  target: ProductDocumentSyncTarget; version: string; priority: number; running: boolean;
  scan: (target: ProductDocumentSyncTarget) => Promise<Omit<Result, "documents">>;
  promise: Promise<Result>; resolve: (value: Result) => void;
};

/** Metadata discovery never waits for uploads, downloads, or the cold-start backlog. */
export class ProductDocumentDiscovery {
  private checked = new Map<string, { version: string; at: number }>();
  private work = new Map<string, Work>();
  private active = 0;

  private pump() {
    while (this.active < 4) {
      const next = [...this.work.entries()].filter(([, item]) => !item.running)
        .sort((a, b) => b[1].priority - a[1].priority)[0];
      if (!next) return;
      const [id, item] = next;
      item.running = true;
      this.active += 1;
      void (async () => {
        const total = empty();
        try {
          let version;
          do {
            version = item.version;
            const result = await item.scan(item.target);
            total.documents += 1;
            for (const key of ["found", "queued", "completed", "failed"] as const) total[key] += result[key];
            this.checked.set(id, { version, at: Date.now() });
            // An edit observed while this scan was running must get a second
            // scan, not be acknowledged as part of the older snapshot.
          } while (item.version !== version);
        } catch {
          if (item.version.endsWith(":unavailable")) this.checked.set(id, { version: item.version, at: Date.now() });
          else this.checked.delete(id);
          total.failed += 1;
          console.warn(`[product-doc-sync] 文档 ${id} 检查失败，下轮重试`);
        } finally {
          this.work.delete(id);
          this.active -= 1;
          item.resolve(total);
          this.pump();
        }
      })();
    }
  }

  async poll(client: Client, targets: ProductDocumentSyncTarget[],
    scan: Work["scan"], background = false): Promise<Result> {
    const modified = new Map<string, string>();
    // Live verified: 455 cards need three small requests, not 455 per-card
    // revision requests. Failures fall back to the existing revision reader.
    for (let index = 0; index < targets.length; index += 200) {
      try {
        const response = await client.request<{
          code?: number; data?: { metas?: Array<{ doc_token?: string; latest_modify_time?: string }> };
        }>({
          url: "/open-apis/drive/v1/metas/batch_query", method: "POST", timeout: 5_000,
          data: { request_docs: targets.slice(index, index + 200).map(target => ({ doc_token: target.documentId, doc_type: "docx" })), with_url: false },
        });
        if (response.code) continue;
        for (const meta of response.data?.metas || []) {
          if (meta.doc_token && /^\d+$/.test(meta.latest_modify_time || "")) modified.set(meta.doc_token, meta.latest_modify_time!);
        }
      } catch { /* Per-document revision checks remain the fallback. */ }
    }
    const now = Date.now();
    const ids = new Set(targets.map(target => target.documentId!));
    for (const id of this.checked.keys()) if (!ids.has(id)) this.checked.delete(id);
    for (const [id, item] of this.work) {
      if (!ids.has(id) && !item.running) { this.work.delete(id); item.resolve(empty()); }
    }
    const pending: Promise<Result>[] = [];
    for (const target of targets) {
      const id = target.documentId!;
      const metadataVersion = modified.get(id) || "unavailable";
      const version = `${target.id}:${target.pid}:${metadataVersion}`;
      const previous = this.checked.get(id);
      const modifiedMs = Number(modified.get(id) || 0) * 1_000;
      // Metadata is second-granularity. Recheck recent edits while timestamps
      // settle, and periodically audit revisions even when metadata is stable.
      const recent = modifiedMs > 0 && now - modifiedMs < 60_000;
      if (target.cachedRevision !== -1 && previous?.version === version && !recent
        && now - previous.at < (metadataVersion === "unavailable" ? 60_000 : 300_000)) continue;
      const existing = this.work.get(id);
      if (existing) {
        existing.target = target;
        existing.scan = scan;
        existing.version = version;
        existing.priority = modifiedMs;
        pending.push(existing.promise);
        continue;
      }
      let resolve!: Work["resolve"];
      const promise = new Promise<Result>(done => { resolve = done; });
      this.work.set(id, { target, version, priority: modifiedMs, running: false, scan, promise, resolve });
      pending.push(promise);
    }
    this.pump();
    if (background) return empty();
    const total = empty();
    for (const result of await Promise.all(pending)) {
      for (const key of Object.keys(total) as Array<keyof Result>) total[key] += result[key];
    }
    return total;
  }
}
