export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ resumePendingVideos }, { ensureFeishuConnection }, { startProductDocumentSyncWorker }] = await Promise.all([
    import("@/lib/queue"),
    import("@/lib/feishu/runtime"),
    import("@/lib/feishu/product-doc-sync"),
  ]);
  resumePendingVideos();
  startProductDocumentSyncWorker();
  void ensureFeishuConnection().catch(() => undefined);
}
