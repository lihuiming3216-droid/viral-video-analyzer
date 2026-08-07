export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureFeishuConnection } = await import("@/lib/feishu/runtime");
  void ensureFeishuConnection().catch(() => undefined);
}
