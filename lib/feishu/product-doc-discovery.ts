import type { Client } from "@larksuiteoapi/node-sdk";
import type { ProductDocumentSyncTarget } from "@/lib/database";
import { isFeishuRateLimit } from "@/lib/feishu/read-control";

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
  private failures = new Map<string, { version: string; attempts: number; nextAt: number }>();
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
            let result;
            try { result = await item.scan(item.target); }
            catch (error) {
              // A failure from an older snapshot must not delay a newer edit.
              if (item.version !== version) continue;
              throw error;
            }
            total.documents += 1;
            for (const key of ["found", "queued", "completed", "failed"] as const) total[key] += result[key];
            this.checked.set(id, { version, at: Date.now() });
            this.failures.delete(id);
            // An edit observed while this scan was running must get a second
            // scan, not be acknowledged as part of the older snapshot.
          } while (item.version !== version);
        } catch {
          this.checked.delete(id);
          const previous = this.failures.get(id);
          const attempts = previous?.version === item.version ? previous.attempts + 1 : 1;
          const base = item.version.endsWith(":unavailable") ? 60_000 : 20_000;
          this.failures.set(id, { version: item.version, attempts,
            nextAt: Date.now() + Math.min(300_000, base * 2 ** Math.min(attempts - 1, 4)) });
          total.failed += 1;
          console.warn(`[product-doc-sync] 文档 ${id} 检查失败，已延迟重试`);
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
    const deferred = new Set<string>();
    // Live verified: 455 cards need three small requests, not 455 per-card
    // revision requests. Failures fall back to the existing revision reader.
    for (let index = 0; index < targets.length; index += 200) {
      const batch = targets.slice(index, index + 200);
      try {
        const response = await client.request<{
          code?: number; data?: { metas?: Array<{ doc_token?: string; latest_modify_time?: string }> };
        }>({
          url: "/open-apis/drive/v1/metas/batch_query", method: "POST", timeout: 5_000,
          data: { request_docs: batch.map(target => ({ doc_token: target.documentId, doc_type: "docx" })), with_url: false },
        });
        if (isFeishuRateLimit(response)) { batch.forEach(target => deferred.add(target.documentId!)); continue; }
        if (response.code) continue;
        for (const meta of response.data?.metas || []) {
          if (meta.doc_token && /^\d+$/.test(meta.latest_modify_time || "")) modified.set(meta.doc_token, meta.latest_modify_time!);
        }
      } catch (error) {
        // Do not turn one throttled metadata batch into 200 individual reads.
        if (isFeishuRateLimit(error)) batch.forEach(target => deferred.add(target.documentId!));
      }
    }
    const now = Date.now();
    const ids = new Set(targets.map(target => target.documentId!));
    for (const id of this.checked.keys()) if (!ids.has(id)) this.checked.delete(id);
    for (const id of this.failures.keys()) if (!ids.has(id)) this.failures.delete(id);
    for (const [id, item] of this.work) {
      if (!ids.has(id) && !item.running) { this.work.delete(id); item.resolve(empty()); }
    }
    const pending: Promise<Result>[] = [];
    for (const target of targets) {
      const id = target.documentId!;
      if (deferred.has(id)) continue;
      const metadataVersion = modified.get(id) || "unavailable";
      const version = `${target.id}:${target.pid}:${metadataVersion}`;
      const previous = this.checked.get(id);
      const failure = this.failures.get(id);
      if (failure?.version === version && failure.nextAt > now) continue;
      const modifiedMs = Number(modified.get(id) || 0) * 1_000;
      // Metadata is second-granularity. Recheck recent edits while timestamps
      // settle, and periodically audit revisions even when metadata is stable.
      const recent = modifiedMs > 0 && modifiedMs <= now && now - modifiedMs < 60_000;
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
