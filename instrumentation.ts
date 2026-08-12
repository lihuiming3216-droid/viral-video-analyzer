export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [
    { resumePendingVideos },
    { ensureFeishuConnection },
    { startProductDocumentSyncWorker },
    { startFeishuAutomationDeliveryWorker },
  ] = await Promise.all([
    import("@/lib/queue"),
    import("@/lib/feishu/runtime"),
    import("@/lib/feishu/product-doc-sync"),
    import("@/lib/feishu/automation"),
  ]);
  resumePendingVideos();
  startProductDocumentSyncWorker();
  startFeishuAutomationDeliveryWorker();
  void ensureFeishuConnection().catch(() => undefined);
}
