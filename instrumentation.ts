export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [
    { startVideoQueueWorker },
    { ensureFeishuConnection },
    { startProductDocumentSyncWorker },
    { startFeishuAutomationDeliveryWorker },
    { startFeishuInboxWorker },
    { startMediaRetentionWorker },
  ] = await Promise.all([
    import("@/lib/queue"),
    import("@/lib/feishu/runtime"),
    import("@/lib/feishu/product-doc-sync"),
    import("@/lib/feishu/automation"),
    import("@/lib/feishu/inbox"),
    import("@/lib/media-retention"),
  ]);
  startVideoQueueWorker();
  startProductDocumentSyncWorker();
  startFeishuAutomationDeliveryWorker();
  startFeishuInboxWorker();
  startMediaRetentionWorker();
  void ensureFeishuConnection().catch(() => undefined);
}
